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
  if (!record || (!record[timeKey] && !record[idKey])) return '';
  return toBase64Url(JSON.stringify({
    time: String(record[timeKey] || ''),
    id: String(record[idKey] || '')
  }));
}

function decodeCursor(cursor) {
  if (!cursor) return null;
  try {
    const decoded = JSON.parse(fromBase64Url(cursor));
    return {
      time: String(decoded.time || ''),
      id: String(decoded.id || '')
    };
  } catch {
    return null;
  }
}

function compareCursor(record, cursor, timeKey, idKey) {
  if (!cursor) return 1;
  const timeCompare = String(record[timeKey] || '').localeCompare(String(cursor.time || ''));
  if (timeCompare !== 0) return timeCompare;
  return String(record[idKey] || '').localeCompare(String(cursor.id || ''));
}

function sortRecords(records, timeKey, idKey) {
  return [...records].sort((a, b) => compareOrderedRecords(a, b, timeKey, idKey));
}

export class RelayStoreError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'RelayStoreError';
    this.status = status;
  }
}

export function createRelayStore(backend) {
  async function ensureWritableVault(vaultId, auth) {
    if (!auth.writeKey) {
      throw new RelayStoreError(401, 'X-Vault-Write-Key is required.');
    }

    let meta = await backend.getVaultMeta(vaultId);
    if (!meta) {
      if (!auth.readKey) {
        throw new RelayStoreError(401, 'X-Vault-Read-Key is required when creating a vault.');
      }
      meta = {
        readKey: auth.readKey,
        writeKey: auth.writeKey,
        createdAt: new Date().toISOString()
      };
      await backend.createVault(vaultId, meta);
      return meta;
    }

    if (meta.writeKey !== auth.writeKey) {
      throw new RelayStoreError(403, 'Invalid write key.');
    }

    if (auth.readKey && meta.readKey !== auth.readKey) {
      throw new RelayStoreError(403, 'Invalid read key.');
    }

    return meta;
  }

  async function requireReadableVault(vaultId, auth) {
    if (!auth.readKey) {
      throw new RelayStoreError(401, 'X-Vault-Read-Key is required.');
    }

    const meta = await backend.getVaultMeta(vaultId);
    if (!meta) {
      throw new RelayStoreError(404, 'Vault not found.');
    }

    if (meta.readKey !== auth.readKey) {
      throw new RelayStoreError(403, 'Invalid read key.');
    }

    return meta;
  }

  async function upsertRecords(vaultId, auth, collectionName, idKey, timeKey, records) {
    await ensureWritableVault(vaultId, auth);
    const existingRecords = await backend.listRecords(vaultId, collectionName);
    const existingIds = new Set(existingRecords.map((record) => String(record?.[idKey] || '')).filter(Boolean));
    let accepted = 0;

    for (const record of records || []) {
      const recordId = String(record?.[idKey] || '');
      if (!recordId || existingIds.has(recordId)) continue;
      await backend.putRecord(vaultId, collectionName, recordId, record);
      existingIds.add(recordId);
      accepted += 1;
    }

    const orderedRecords = sortRecords(await backend.listRecords(vaultId, collectionName), timeKey, idKey);
    return {
      cursor: encodeCursor(orderedRecords.at(-1), timeKey, idKey),
      accepted
    };
  }

  async function readRecords(vaultId, auth, collectionName, idKey, timeKey, since) {
    await requireReadableVault(vaultId, auth);
    const cursor = decodeCursor(since);
    const orderedRecords = sortRecords(await backend.listRecords(vaultId, collectionName), timeKey, idKey);
    const records = cursor
      ? orderedRecords.filter((record) => compareCursor(record, cursor, timeKey, idKey) > 0)
      : orderedRecords;

    return {
      cursor: encodeCursor(orderedRecords.at(-1), timeKey, idKey),
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
