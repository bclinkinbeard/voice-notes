import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

function emptyState() {
  return {
    vaults: {}
  };
}

function toBase64Url(value) {
  return Buffer.from(value, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(value) {
  const padded = String(value || '').replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(String(value || '').length / 4) * 4, '=');
  return Buffer.from(padded, 'base64').toString('utf8');
}

function compareOrderedRecords(a, b, timeKey, idKey) {
  const aTime = Date.parse(a[timeKey] || 0) || 0;
  const bTime = Date.parse(b[timeKey] || 0) || 0;
  if (aTime !== bTime) return aTime - bTime;
  return String(a[idKey] || '').localeCompare(String(b[idKey] || ''));
}

function encodeCursor(record, timeKey, idKey) {
  if (!record) return '';
  return toBase64Url(JSON.stringify({
    time: record[timeKey] || '',
    id: record[idKey] || ''
  }));
}

function decodeCursor(cursor) {
  if (!cursor) return null;
  try {
    const decoded = JSON.parse(fromBase64Url(cursor));
    return {
      time: decoded.time || '',
      id: decoded.id || ''
    };
  } catch (error) {
    return null;
  }
}

function isAfterCursor(record, cursor, timeKey, idKey) {
  if (!cursor) return true;
  const recordTime = Date.parse(record[timeKey] || 0) || 0;
  const cursorTime = Date.parse(cursor.time || 0) || 0;
  if (recordTime !== cursorTime) return recordTime > cursorTime;
  return String(record[idKey] || '').localeCompare(String(cursor.id || '')) > 0;
}

function sortRecords(records, timeKey, idKey) {
  return Object.values(records || {}).sort((a, b) => compareOrderedRecords(a, b, timeKey, idKey));
}

export class RelayStoreError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'RelayStoreError';
    this.status = status;
  }
}

export function createRelayStore(filePath) {
  let loaded = false;
  let state = emptyState();
  let persistChain = Promise.resolve();

  async function ensureLoaded() {
    if (loaded) return;
    try {
      state = JSON.parse(await readFile(filePath, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      state = emptyState();
    }
    loaded = true;
  }

  async function persist() {
    persistChain = persistChain.then(async () => {
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, JSON.stringify(state, null, 2));
    });
    return persistChain;
  }

  function getVault(vaultId) {
    return state.vaults[vaultId] || null;
  }

  function ensureWritableVault(vaultId, auth) {
    if (!auth.writeKey) {
      throw new RelayStoreError(401, 'X-Vault-Write-Key is required.');
    }

    let vault = getVault(vaultId);
    if (!vault) {
      if (!auth.readKey) {
        throw new RelayStoreError(401, 'X-Vault-Read-Key is required when creating a vault.');
      }
      vault = {
        readKey: auth.readKey,
        writeKey: auth.writeKey,
        events: {},
        artifacts: {}
      };
      state.vaults[vaultId] = vault;
      return vault;
    }

    if (vault.writeKey !== auth.writeKey) {
      throw new RelayStoreError(403, 'Invalid write key.');
    }

    if (auth.readKey && vault.readKey !== auth.readKey) {
      throw new RelayStoreError(403, 'Invalid read key.');
    }

    return vault;
  }

  function requireReadableVault(vaultId, auth) {
    if (!auth.readKey) {
      throw new RelayStoreError(401, 'X-Vault-Read-Key is required.');
    }

    const vault = getVault(vaultId);
    if (!vault) {
      throw new RelayStoreError(404, 'Vault not found.');
    }

    if (vault.readKey !== auth.readKey) {
      throw new RelayStoreError(403, 'Invalid read key.');
    }

    return vault;
  }

  async function upsertRecords(vaultId, auth, collectionName, idKey, timeKey, records) {
    await ensureLoaded();
    const vault = ensureWritableVault(vaultId, auth);
    let accepted = 0;

    for (const record of records || []) {
      if (!record || !record[idKey]) continue;
      if (vault[collectionName][record[idKey]]) continue;
      accepted += 1;
      vault[collectionName][record[idKey]] = record;
    }

    await persist();
    const ordered = sortRecords(vault[collectionName], timeKey, idKey);
    return {
      cursor: encodeCursor(ordered[ordered.length - 1], timeKey, idKey),
      accepted
    };
  }

  async function readRecords(vaultId, auth, collectionName, idKey, timeKey, since) {
    await ensureLoaded();
    const vault = requireReadableVault(vaultId, auth);
    const cursor = decodeCursor(since);
    const ordered = sortRecords(vault[collectionName], timeKey, idKey);
    const records = cursor
      ? ordered.filter((record) => isAfterCursor(record, cursor, timeKey, idKey))
      : ordered;

    return {
      cursor: encodeCursor(ordered[ordered.length - 1], timeKey, idKey),
      records
    };
  }

  return {
    async upsertEvents(vaultId, auth, events) {
      return upsertRecords(vaultId, auth, 'events', 'eventId', 'recordedAt', events);
    },

    async readEvents(vaultId, auth, since) {
      return readRecords(vaultId, auth, 'events', 'eventId', 'recordedAt', since);
    },

    async upsertArtifacts(vaultId, auth, artifacts) {
      return upsertRecords(vaultId, auth, 'artifacts', 'artifactId', 'createdAt', artifacts);
    },

    async readArtifacts(vaultId, auth, since) {
      return readRecords(vaultId, auth, 'artifacts', 'artifactId', 'createdAt', since);
    }
  };
}
