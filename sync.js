'use strict';

import { isRetiredDerivedEvent } from './storage.js';

function toBase64Url(bytes) {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(value) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(padded, 'base64'));
  }
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function encodeJson(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return toBase64Url(bytes);
}

function decodeJson(value) {
  const bytes = fromBase64Url(value);
  return JSON.parse(new TextDecoder().decode(bytes));
}

async function deriveAesKey(secret) {
  const input = new TextEncoder().encode(secret);
  const hash = await crypto.subtle.digest('SHA-256', input);
  return crypto.subtle.importKey('raw', hash, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

function requireSyncCapability(vaultDescriptor, options = {}) {
  if (!vaultDescriptor || !vaultDescriptor.relayUrl) {
    throw new Error('Configure a relay URL before syncing.');
  }
  if (!vaultDescriptor.vaultKey) {
    throw new Error('This vault is missing its encryption key. Reapply a current invite.');
  }
  if (!vaultDescriptor.readKey) {
    throw new Error('This vault is missing its read capability.');
  }
  if (options.writeRequired && !vaultDescriptor.writeKey) {
    throw new Error('This vault is read-only.');
  }
}

function buildVaultUrl(vaultDescriptor, resource) {
  return vaultDescriptor.relayUrl.replace(/\/$/, '') + '/v1/vaults/' + encodeURIComponent(vaultDescriptor.id) + '/' + resource;
}

export function createVaultInvite(vaultDescriptor) {
  return encodeJson({
    vaultId: vaultDescriptor.id,
    name: vaultDescriptor.name,
    relayUrl: vaultDescriptor.relayUrl || '',
    vaultKey: vaultDescriptor.vaultKey,
    readKey: vaultDescriptor.readKey,
    writeKey: vaultDescriptor.writeKey
  });
}

export function parseVaultInvite(value) {
  try {
    const decoded = decodeJson(String(value || '').trim());
    if (!decoded || !decoded.vaultId || !decoded.vaultKey || !decoded.readKey || !decoded.writeKey) return null;
    return decoded;
  } catch (error) {
    return null;
  }
}

export async function encryptEnvelope(secret, envelope) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveAesKey(secret);
  const plaintext = new TextEncoder().encode(JSON.stringify(envelope));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
  return {
    eventId: envelope.eventId,
    recordedAt: envelope.recordedAt,
    iv: toBase64Url(iv),
    payload: toBase64Url(new Uint8Array(ciphertext))
  };
}

export async function decryptEnvelope(secret, encryptedRecord) {
  const key = await deriveAesKey(secret);
  const iv = fromBase64Url(encryptedRecord.iv);
  const payload = fromBase64Url(encryptedRecord.payload);
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, payload);
  return JSON.parse(new TextDecoder().decode(new Uint8Array(decrypted)));
}

async function serializeArtifact(artifact) {
  const payload = {
    ...artifact
  };
  delete payload.blob;

  if (artifact && artifact.blob) {
    if (typeof artifact.blob.arrayBuffer === 'function') {
      const bytes = new Uint8Array(await artifact.blob.arrayBuffer());
      payload.blobData = toBase64Url(bytes);
    } else {
      payload.blobValue = artifact.blob;
    }
  }

  return payload;
}

function deserializeArtifact(payload) {
  const artifact = {
    ...payload
  };

  if (payload.blobData) {
    artifact.blob = new Blob([fromBase64Url(payload.blobData)], {
      type: payload.mimeType || 'application/octet-stream'
    });
  } else if (Object.prototype.hasOwnProperty.call(payload, 'blobValue')) {
    artifact.blob = payload.blobValue;
  }

  delete artifact.blobData;
  delete artifact.blobValue;
  return artifact;
}

export async function encryptArtifact(secret, artifact) {
  const serialized = await serializeArtifact(artifact);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveAesKey(secret);
  const plaintext = new TextEncoder().encode(JSON.stringify(serialized));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
  return {
    artifactId: artifact.artifactId,
    createdAt: artifact.createdAt,
    iv: toBase64Url(iv),
    payload: toBase64Url(new Uint8Array(ciphertext))
  };
}

export async function decryptArtifact(secret, encryptedRecord) {
  const key = await deriveAesKey(secret);
  const iv = fromBase64Url(encryptedRecord.iv);
  const payload = fromBase64Url(encryptedRecord.payload);
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, payload);
  return deserializeArtifact(JSON.parse(new TextDecoder().decode(new Uint8Array(decrypted))));
}

export function createHttpSyncTransport(vaultDescriptor) {
  return {
    async push(events, syncState) {
      requireSyncCapability(vaultDescriptor, { writeRequired: true });

      const durableEvents = (events || []).filter((event) => event && event.eventId && !isRetiredDerivedEvent(event));
      if (durableEvents.length === 0) {
        return {
          cursor: syncState.lastPushCursor || '',
          accepted: 0
        };
      }

      const encrypted = [];
      for (const event of durableEvents) {
        encrypted.push(await encryptEnvelope(vaultDescriptor.vaultKey, event));
      }

      const response = await fetch(buildVaultUrl(vaultDescriptor, 'events'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Vault-Read-Key': vaultDescriptor.readKey,
          'X-Vault-Write-Key': vaultDescriptor.writeKey
        },
        body: JSON.stringify({
          cursor: syncState.lastPushCursor || '',
          events: encrypted
        })
      });

      if (!response.ok) {
        throw new Error('Push failed with ' + response.status + '.');
      }

      return response.json();
    },

    async pull(syncState) {
      requireSyncCapability(vaultDescriptor);

      const url = new URL(buildVaultUrl(vaultDescriptor, 'events'));
      if (syncState.lastPullCursor) url.searchParams.set('since', syncState.lastPullCursor);

      const response = await fetch(url.toString(), {
        headers: {
          'X-Vault-Read-Key': vaultDescriptor.readKey
        }
      });

      if (!response.ok) {
        throw new Error('Pull failed with ' + response.status + '.');
      }

      const payload = await response.json();
      const events = [];
      for (const record of payload.events || []) {
        events.push(await decryptEnvelope(vaultDescriptor.vaultKey, record));
      }

      return {
        cursor: payload.cursor || '',
        events
      };
    },

    async pushArtifacts(artifacts, syncState) {
      requireSyncCapability(vaultDescriptor, { writeRequired: true });

      const currentArtifacts = (artifacts || []).filter((artifact) => artifact && artifact.artifactId);
      if (currentArtifacts.length === 0) {
        return {
          cursor: syncState.lastArtifactPushCursor || '',
          accepted: 0
        };
      }

      const encrypted = [];
      for (const artifact of currentArtifacts) {
        encrypted.push(await encryptArtifact(vaultDescriptor.vaultKey, artifact));
      }

      const response = await fetch(buildVaultUrl(vaultDescriptor, 'artifacts'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Vault-Read-Key': vaultDescriptor.readKey,
          'X-Vault-Write-Key': vaultDescriptor.writeKey
        },
        body: JSON.stringify({
          cursor: syncState.lastArtifactPushCursor || '',
          artifacts: encrypted
        })
      });

      if (!response.ok) {
        throw new Error('Artifact push failed with ' + response.status + '.');
      }

      return response.json();
    },

    async pullArtifacts(syncState) {
      requireSyncCapability(vaultDescriptor);

      const url = new URL(buildVaultUrl(vaultDescriptor, 'artifacts'));
      if (syncState.lastArtifactPullCursor) url.searchParams.set('since', syncState.lastArtifactPullCursor);

      const response = await fetch(url.toString(), {
        headers: {
          'X-Vault-Read-Key': vaultDescriptor.readKey
        }
      });

      if (!response.ok) {
        throw new Error('Artifact pull failed with ' + response.status + '.');
      }

      const payload = await response.json();
      const artifacts = [];
      for (const record of payload.artifacts || []) {
        artifacts.push(await decryptArtifact(vaultDescriptor.vaultKey, record));
      }

      return {
        cursor: payload.cursor || '',
        artifacts
      };
    }
  };
}
