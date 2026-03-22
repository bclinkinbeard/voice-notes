async function defaultBlobClient() {
  try {
    return await import('@vercel/blob');
  } catch {
    throw new Error('Blob backend selected, but @vercel/blob is not installed. Add @vercel/blob to use Vercel Blob persistence.');
  }
}

function blobPath(vaultId, suffix) {
  return `vaults/${encodeURIComponent(vaultId)}/${suffix}`;
}

async function readJsonFromBlob(fetchImpl, url) {
  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new Error(`Failed to read blob ${url}: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

export function createBlobRelayBackend(options = {}) {
  const getClient = options.getClient || defaultBlobClient;
  const fetchImpl = options.fetchImpl || fetch;
  const clientPromise = Promise.resolve().then(() => getClient());
  const token = options.token || process.env.BLOB_READ_WRITE_TOKEN || '';
  const listOptions = token ? { token } : {};
  const writeOptions = token ? { token, access: 'private', allowOverwrite: false, addRandomSuffix: false } : { access: 'private', allowOverwrite: false, addRandomSuffix: false };

  async function findByPath(pathname) {
    const client = await clientPromise;
    const result = await client.list({ prefix: pathname, limit: 2, ...listOptions });
    return (result.blobs || []).find((blob) => blob.pathname === pathname) || null;
  }

  return {
    async getVaultMeta(vaultId) {
      const metaBlob = await findByPath(blobPath(vaultId, 'meta.json'));
      return metaBlob ? readJsonFromBlob(fetchImpl, metaBlob.url) : null;
    },

    async createVault(vaultId, meta) {
      const client = await clientPromise;
      await client.put(blobPath(vaultId, 'meta.json'), JSON.stringify(meta), {
        contentType: 'application/json',
        ...writeOptions
      });
    },

    async listRecords(vaultId, collectionName) {
      const client = await clientPromise;
      const prefix = blobPath(vaultId, `${collectionName}/`);
      const records = [];
      let cursor;

      do {
        const page = await client.list({ prefix, cursor, ...listOptions });
        for (const blob of page.blobs || []) {
          records.push(await readJsonFromBlob(fetchImpl, blob.url));
        }
        cursor = page.cursor;
      } while (cursor);

      return records;
    },

    async putRecord(vaultId, collectionName, recordId, record) {
      const client = await clientPromise;
      await client.put(blobPath(vaultId, `${collectionName}/${encodeURIComponent(recordId)}.json`), JSON.stringify(record), {
        contentType: 'application/json',
        ...writeOptions
      });
    }
  };
}
