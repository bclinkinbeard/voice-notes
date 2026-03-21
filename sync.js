'use strict';

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

export function createVaultInvite(vaultDescriptor) {
  return encodeJson({
    vaultId: vaultDescriptor.id,
    name: vaultDescriptor.name,
    relayUrl: vaultDescriptor.relayUrl || '',
    readKey: vaultDescriptor.readKey,
    writeKey: vaultDescriptor.writeKey
  });
}

export function parseVaultInvite(value) {
  try {
    const decoded = decodeJson(String(value || '').trim());
    if (!decoded || !decoded.vaultId || !decoded.readKey || !decoded.writeKey) return null;
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

export function createHttpSyncTransport(vaultDescriptor) {
  return {
    async push(events, syncState) {
      if (!vaultDescriptor.relayUrl) {
        throw new Error('Configure a relay URL before syncing.');
      }

      const encrypted = [];
      for (const event of events) {
        encrypted.push(await encryptEnvelope(vaultDescriptor.writeKey, event));
      }

      const response = await fetch(vaultDescriptor.relayUrl.replace(/\/$/, '') + '/v1/vaults/' + encodeURIComponent(vaultDescriptor.id) + '/events', {
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
      if (!vaultDescriptor.relayUrl) {
        throw new Error('Configure a relay URL before syncing.');
      }

      const url = new URL(vaultDescriptor.relayUrl.replace(/\/$/, '') + '/v1/vaults/' + encodeURIComponent(vaultDescriptor.id) + '/events');
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
        events.push(await decryptEnvelope(vaultDescriptor.readKey, record));
      }

      return {
        cursor: payload.cursor || '',
        events
      };
    }
  };
}
