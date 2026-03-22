import { get as getBlob, list as listBlobs, put as putBlob } from '@vercel/blob';

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

function defaultClient() {
  return {
    get: getBlob,
    list: listBlobs,
    put: putBlob
  };
}

export function createBlobSyncBackend(options = {}) {
  const client = options.client || defaultClient();
  const token = options.token || process.env.BLOB_READ_WRITE_TOKEN || '';
  const access = options.access || 'private';
  const prefix = String(options.prefix || 'vaults').replace(/^\/+|\/+$/g, '') || 'vaults';
  const requestOptions = token ? { token } : {};
  const cache = new Map();

  if (!options.client && !token) {
    throw new Error('Blob backend selected but BLOB_READ_WRITE_TOKEN is not configured.');
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
    const result = await client.get(path, {
      access,
      ...requestOptions
    });
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
      const page = await client.list({
        prefix: prefixPath,
        cursor,
        ...requestOptions
      });
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
      if (cache.has(vaultId)) {
        return clone(cache.get(vaultId));
      }

      const meta = await getJson(metaPath(vaultId));
      if (!meta) return null;

      const eventIndex = (await getJson(indexPath(vaultId, 'events'))) || {};
      const artifactIndex = (await getJson(indexPath(vaultId, 'artifacts'))) || {};
      const vault = {
        ...meta,
        events: await loadCollection(vaultId, 'events', 'eventId', eventIndex.sequences || {}),
        artifacts: await loadCollection(vaultId, 'artifacts', 'artifactId', artifactIndex.sequences || {})
      };

      cache.set(vaultId, clone(vault));
      return clone(vault);
    },

    async saveVault(vaultId, vault) {
      const nextVault = clone(vault);
      const previousVault = cache.get(vaultId) || null;

      await writeCollection(vaultId, previousVault, nextVault, 'events', 'eventId');
      await writeCollection(vaultId, previousVault, nextVault, 'artifacts', 'artifactId');
      await putJson(metaPath(vaultId), buildMeta(nextVault));

      cache.set(vaultId, clone(nextVault));
    }
  };
}
