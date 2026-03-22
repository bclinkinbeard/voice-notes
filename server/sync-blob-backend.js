function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function encodePathSegment(value) {
  return encodeURIComponent(String(value || ''));
}

function parseJson(text, path) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Malformed sync blob at ${path}: ${error.message}`);
  }
}

function compareBlobItems(a, b) {
  const aTime = Date.parse(a.uploadedAt || 0) || 0;
  const bTime = Date.parse(b.uploadedAt || 0) || 0;
  if (aTime !== bTime) return aTime - bTime;
  return String(a.pathname || '').localeCompare(String(b.pathname || ''));
}

function mergeCollection(latestCollection = {}, nextCollection = {}) {
  const merged = { ...clone(latestCollection) };
  for (const [recordId, entry] of Object.entries(nextCollection || {})) {
    if (!entry || !entry.record) continue;
    merged[recordId] = clone(entry);
  }
  return merged;
}

function mergeVaults(latestVault, nextVault) {
  if (!latestVault) return clone(nextVault);
  return {
    ...clone(latestVault),
    ...clone(nextVault),
    events: mergeCollection(latestVault.events, nextVault.events),
    artifacts: mergeCollection(latestVault.artifacts, nextVault.artifacts),
    nextEventSequence: Math.max(Number(latestVault.nextEventSequence) || 1, Number(nextVault.nextEventSequence) || 1),
    nextArtifactSequence: Math.max(Number(latestVault.nextArtifactSequence) || 1, Number(nextVault.nextArtifactSequence) || 1)
  };
}

export function createBlobSyncBackend(options = {}) {
  const client = options.client;
  const token = options.token || process.env.BLOB_READ_WRITE_TOKEN || '';
  const access = options.access || 'private';
  const prefix = String(options.prefix || 'vaults').replace(/^\/+|\/+$/g, '') || 'vaults';
  const requestOptions = token ? { token } : {};

  if (!client) {
    throw new Error('Blob backend selected but no blob client was provided.');
  }

  function vaultBasePath(vaultId) {
    return `${prefix}/${encodePathSegment(vaultId)}`;
  }

  function metaPath(vaultId) {
    return `${vaultBasePath(vaultId)}/meta.json`;
  }

  function indexPath(vaultId, collectionName) {
    return `${vaultBasePath(vaultId)}/${collectionName}/index.json`;
  }

  function recordPath(vaultId, collectionName, recordId) {
    return `${vaultBasePath(vaultId)}/${collectionName}/${encodePathSegment(recordId)}.json`;
  }

  async function getJson(path) {
    const result = await client.get(path, { access, ...requestOptions });
    if (!result || result.statusCode !== 200 || !result.stream) return null;
    const text = await new Response(result.stream).text();
    if (!text) return null;
    return parseJson(text, path);
  }

  async function putJson(path, payload) {
    await client.put(path, JSON.stringify(payload), {
      access,
      allowOverwrite: true,
      contentType: 'application/json; charset=utf-8',
      ...requestOptions
    });
  }

  async function listAll(prefixPath) {
    const blobs = [];
    let cursor;
    let hasMore = true;
    while (hasMore) {
      const page = await client.list({ prefix: prefixPath, cursor, ...requestOptions });
      blobs.push(...(page.blobs || []));
      hasMore = Boolean(page.hasMore);
      cursor = page.cursor;
    }
    return blobs;
  }

  async function loadCollection(vaultId, collectionName, idKey, sequenceMap) {
    const collectionPrefix = `${vaultBasePath(vaultId)}/${collectionName}/`;
    const sequenceById = { ...sequenceMap };
    const blobs = (await listAll(collectionPrefix))
      .filter((blob) => blob.pathname !== indexPath(vaultId, collectionName))
      .sort(compareBlobItems);
    const loaded = await Promise.all(blobs.map(async (blob) => ({
      blob,
      record: await getJson(blob.pathname)
    })));

    const records = {};
    let fallbackSequence = Math.max(0, ...Object.values(sequenceById).map((value) => Number(value) || 0)) + 1;
    for (const entry of loaded) {
      if (!entry.record || !entry.record[idKey]) continue;
      const recordId = entry.record[idKey];
      const sequence = Number(sequenceById[recordId]) || fallbackSequence++;
      records[recordId] = {
        record: entry.record,
        sequence
      };
    }
    return records;
  }

  function buildMeta(vault) {
    return {
      readKey: String(vault.readKey || ''),
      writeKey: String(vault.writeKey || ''),
      createdAt: String(vault.createdAt || ''),
      nextEventSequence: Number(vault.nextEventSequence) || 1,
      nextArtifactSequence: Number(vault.nextArtifactSequence) || 1
    };
  }

  function buildIndex(vault, collectionName, idKey) {
    return {
      sequences: Object.fromEntries(
        Object.values(vault[collectionName] || {})
          .filter((entry) => entry && entry.record && entry.record[idKey])
          .map((entry) => [entry.record[idKey], Number(entry.sequence) || 0])
      )
    };
  }

  async function writeCollection(vaultId, previousVault, nextVault, collectionName, idKey) {
    const nextCollection = nextVault[collectionName] || {};
    const previousCollection = previousVault?.[collectionName] || {};

    for (const entry of Object.values(nextCollection)) {
      if (!entry || !entry.record || !entry.record[idKey]) continue;
      const recordId = entry.record[idKey];
      const previousEntry = previousCollection[recordId];
      if (previousEntry && JSON.stringify(previousEntry.record) === JSON.stringify(entry.record)) continue;
      await putJson(recordPath(vaultId, collectionName, recordId), entry.record);
    }

    await putJson(indexPath(vaultId, collectionName), buildIndex(nextVault, collectionName, idKey));
  }

  return {
    async loadVault(vaultId) {
      const meta = await getJson(metaPath(vaultId));
      const eventIndex = (await getJson(indexPath(vaultId, 'events'))) || {};
      const artifactIndex = (await getJson(indexPath(vaultId, 'artifacts'))) || {};
      const hasIndexedData = Object.keys(eventIndex.sequences || {}).length > 0 || Object.keys(artifactIndex.sequences || {}).length > 0;

      if (!meta && !hasIndexedData) return null;

      const vault = {
        readKey: String(meta?.readKey || ''),
        writeKey: String(meta?.writeKey || ''),
        createdAt: String(meta?.createdAt || ''),
        nextEventSequence: Number(meta?.nextEventSequence) || 1,
        nextArtifactSequence: Number(meta?.nextArtifactSequence) || 1,
        events: await loadCollection(vaultId, 'events', 'eventId', eventIndex.sequences || {}),
        artifacts: await loadCollection(vaultId, 'artifacts', 'artifactId', artifactIndex.sequences || {})
      };

      return clone(vault);
    },

    async saveVault(vaultId, vault) {
      const latestVault = await this.loadVault(vaultId);
      const nextVault = mergeVaults(latestVault, vault);
      await putJson(metaPath(vaultId), buildMeta(nextVault));
      await writeCollection(vaultId, latestVault, nextVault, 'events', 'eventId');
      await writeCollection(vaultId, latestVault, nextVault, 'artifacts', 'artifactId');
    }
  };
}
