function toBase64Url(value) {
  return Buffer.from(value, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(value) {
  const input = String(value || '');
  const padded = input.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(input.length / 4) * 4, '=');
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

function compareCollectionEntries(a, b, timeKey, idKey) {
  if (a.sequence && b.sequence) return a.sequence - b.sequence;
  if (a.sequence) return -1;
  if (b.sequence) return 1;
  return compareOrderedRecords(a.record, b.record, timeKey, idKey);
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
    .sort((a, b) => compareCollectionEntries(a, b, timeKey, idKey));

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
    createdAt: '',
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

export class SyncStoreError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'SyncStoreError';
    this.status = status;
  }
}

function ensureBackend(backend) {
  if (!backend || typeof backend.loadVault !== 'function' || typeof backend.saveVault !== 'function') {
    throw new Error('Sync store requires a backend with loadVault() and saveVault().');
  }
}

function queueVaultTask(chains, vaultId, task) {
  const previous = chains.get(vaultId) || Promise.resolve();
  const run = previous.then(task, task);
  const settled = run.catch(() => {});
  chains.set(vaultId, settled);
  return run.finally(() => {
    if (chains.get(vaultId) === settled) chains.delete(vaultId);
  });
}

export function createSyncStore(backend) {
  ensureBackend(backend);
  const vaultChains = new Map();

  async function loadVault(vaultId) {
    const vault = await backend.loadVault(vaultId);
    return vault ? normalizeVault(vault) : null;
  }

  async function saveVault(vaultId, vault) {
    await backend.saveVault(vaultId, normalizeVault(vault));
  }

  function ensureWritableVault(vaultId, auth, vault) {
    if (!auth.writeKey) {
      throw new SyncStoreError(401, 'X-Vault-Write-Key is required.');
    }

    if (!vault) {
      if (!auth.readKey) {
        throw new SyncStoreError(401, 'X-Vault-Read-Key is required when creating a vault.');
      }
      return normalizeVault({
        readKey: auth.readKey,
        writeKey: auth.writeKey,
        createdAt: new Date().toISOString()
      });
    }

    if (vault.writeKey !== auth.writeKey) {
      throw new SyncStoreError(403, 'Invalid write key.');
    }

    if (auth.readKey && vault.readKey !== auth.readKey) {
      throw new SyncStoreError(403, 'Invalid read key.');
    }

    return vault;
  }

  function requireReadableVault(vaultId, auth, vault) {
    if (!auth.readKey) {
      throw new SyncStoreError(401, 'X-Vault-Read-Key is required.');
    }

    if (!vault) {
      throw new SyncStoreError(404, 'Vault not found.');
    }

    if (vault.readKey !== auth.readKey) {
      throw new SyncStoreError(403, 'Invalid read key.');
    }

    return vault;
  }

  async function upsertRecords(vaultId, auth, collectionName, idKey, timeKey, records) {
    return queueVaultTask(vaultChains, vaultId, async () => {
      const vault = ensureWritableVault(vaultId, auth, await loadVault(vaultId));
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

      await saveVault(vaultId, vault);
      return {
        cursor: encodeCursor(currentSequence(vault, sequenceKey)),
        accepted
      };
    });
  }

  async function readRecords(vaultId, auth, collectionName, idKey, timeKey, since) {
    return queueVaultTask(vaultChains, vaultId, async () => {
      const vault = requireReadableVault(vaultId, auth, await loadVault(vaultId));
      const cursor = decodeCursor(since);
      const sequenceKey = collectionName === 'events' ? 'nextEventSequence' : 'nextArtifactSequence';
      const sinceSequence = resolveCursorSequence(vault[collectionName], cursor, timeKey, idKey);
      const records = sortRecords(vault[collectionName], timeKey, idKey, sinceSequence);

      return {
        cursor: encodeCursor(currentSequence(vault, sequenceKey)),
        records
      };
    });
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
