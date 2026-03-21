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

function encodeCursor(sequence) {
  if (!Number.isFinite(sequence) || sequence <= 0) return '';
  return toBase64Url(JSON.stringify({
    sequence
  }));
}

function decodeCursor(cursor) {
  if (!cursor) return null;
  try {
    const decoded = JSON.parse(fromBase64Url(cursor));
    if (Number.isFinite(decoded.sequence)) {
      return {
        sequence: Number(decoded.sequence)
      };
    }
    return {
      time: decoded.time || '',
      id: decoded.id || ''
    };
  } catch (error) {
    return null;
  }
}

function normalizeCollection(records, timeKey, idKey) {
  const normalized = {};
  const entries = Object.values(records || {})
    .map((entry) => {
      if (!entry) return null;
      if (entry.record) {
        return {
          record: entry.record,
          sequence: Number(entry.sequence) || 0
        };
      }
      return {
        record: entry,
        sequence: 0
      };
    })
    .filter((entry) => entry && entry.record && entry.record[idKey])
    .sort((a, b) => {
      if (a.sequence && b.sequence) return a.sequence - b.sequence;
      if (a.sequence) return -1;
      if (b.sequence) return 1;
      return compareOrderedRecords(a.record, b.record, timeKey, idKey);
    });

  let nextSequence = 1;
  for (const entry of entries) {
    const sequence = entry.sequence > 0 ? entry.sequence : nextSequence;
    normalized[entry.record[idKey]] = {
      record: entry.record,
      sequence
    };
    nextSequence = Math.max(nextSequence, sequence + 1);
  }

  return {
    records: normalized,
    nextSequence
  };
}

function normalizeVault(vault) {
  const normalizedVault = {
    readKey: '',
    writeKey: '',
    events: {},
    artifacts: {},
    nextEventSequence: 1,
    nextArtifactSequence: 1,
    ...vault
  };
  const normalizedEvents = normalizeCollection(normalizedVault.events, 'recordedAt', 'eventId');
  const normalizedArtifacts = normalizeCollection(normalizedVault.artifacts, 'createdAt', 'artifactId');
  normalizedVault.events = normalizedEvents.records;
  normalizedVault.artifacts = normalizedArtifacts.records;
  normalizedVault.nextEventSequence = Math.max(Number(normalizedVault.nextEventSequence) || 0, normalizedEvents.nextSequence);
  normalizedVault.nextArtifactSequence = Math.max(Number(normalizedVault.nextArtifactSequence) || 0, normalizedArtifacts.nextSequence);
  return normalizedVault;
}

function currentSequence(vault, sequenceKey) {
  const nextSequence = Number(vault[sequenceKey]) || 1;
  return Math.max(0, nextSequence - 1);
}

function resolveCursorSequence(collection, cursor, timeKey, idKey) {
  if (!cursor) return 0;
  if (Number.isFinite(cursor.sequence)) return cursor.sequence;
  if (cursor.time || cursor.id) {
    for (const entry of Object.values(collection || {})) {
      if (!entry || !entry.record) continue;
      if (String(entry.record[timeKey] || '') === String(cursor.time || '') && String(entry.record[idKey] || '') === String(cursor.id || '')) {
        return Number(entry.sequence) || 0;
      }
    }
  }
  return 0;
}

function sortRecords(collection, timeKey, idKey, sinceSequence = 0) {
  return Object.values(collection || {})
    .filter((entry) => (Number(entry.sequence) || 0) > sinceSequence)
    .map((entry) => entry.record)
    .sort((a, b) => compareOrderedRecords(a, b, timeKey, idKey));
}

export class RelayStoreError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'RelayStoreError';
    this.status = status;
  }
}

export function createRelayStore(filePath) {
  // File-backed JSON keeps the relay self-contained for local/dev use and acts as the contract reference implementation.
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
    state = {
      vaults: Object.fromEntries(
        Object.entries((state && state.vaults) || {}).map(([vaultId, vault]) => [vaultId, normalizeVault(vault)])
      )
    };
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
        artifacts: {},
        nextEventSequence: 1,
        nextArtifactSequence: 1
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
    const sequenceKey = collectionName === 'events' ? 'nextEventSequence' : 'nextArtifactSequence';
    let accepted = 0;

    for (const record of records || []) {
      if (!record || !record[idKey]) continue;
      if (vault[collectionName][record[idKey]]) continue;
      accepted += 1;
      vault[collectionName][record[idKey]] = {
        record,
        sequence: Number(vault[sequenceKey]) || 1
      };
      vault[sequenceKey] = (Number(vault[sequenceKey]) || 1) + 1;
    }

    await persist();
    return {
      cursor: encodeCursor(currentSequence(vault, sequenceKey)),
      accepted
    };
  }

  async function readRecords(vaultId, auth, collectionName, idKey, timeKey, since) {
    await ensureLoaded();
    const vault = requireReadableVault(vaultId, auth);
    const cursor = decodeCursor(since);
    const sequenceKey = collectionName === 'events' ? 'nextEventSequence' : 'nextArtifactSequence';
    const sinceSequence = resolveCursorSequence(vault[collectionName], cursor, timeKey, idKey);
    const records = sortRecords(vault[collectionName], timeKey, idKey, sinceSequence);

    return {
      cursor: encodeCursor(currentSequence(vault, sequenceKey)),
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
