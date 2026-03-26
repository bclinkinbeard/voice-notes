import { get, head, put } from '@vercel/blob';
import { sanitizeSyncSnapshot } from '../sync-snapshot.js';

const DEFAULT_BLOB_ACCESS = 'private';
const BLOB_ACCESS = normalizeBlobAccess(
  process.env.BLOB_ACCESS || process.env.VERCEL_BLOB_ACCESS || DEFAULT_BLOB_ACCESS
);

function normalizeBlobAccess(value) {
  return String(value || '').trim().toLowerCase() === 'public' ? 'public' : 'private';
}

function sanitizeNamespace(namespace) {
  return String(namespace || '').replace(/[^a-zA-Z0-9_-]/g, '_');
}

function buildMetaPath(namespace) {
  return `sync/${sanitizeNamespace(namespace)}/latest.json`;
}

function buildSnapshotPath(namespace, snapshotId) {
  return `sync/${sanitizeNamespace(namespace)}/snapshots/${snapshotId}.json`;
}

function buildAudioPath(namespace, hash) {
  return `sync/${sanitizeNamespace(namespace)}/audio/${hash}`;
}

function buildSnapshotId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function isNotFoundError(error) {
  if (!error) return false;
  const status = Number(error.status || error?.cause?.status || 0);
  if (status === 404) return true;
  const code = String(error.code || '').toLowerCase();
  if (code === 'not_found') return true;
  const name = String(error.name || '').toLowerCase();
  if (name.includes('notfound')) return true;
  const message = String(error.message || '').toLowerCase();
  return (
    message.includes('not found') ||
    message.includes('does not exist') ||
    message.includes('404')
  );
}

function requiredBlobAccessFromError(error) {
  const message = String(error?.message || '');
  const match = message.match(/access must be ["']?(public|private)["']?/i);
  return match ? normalizeBlobAccess(match[1]) : '';
}

async function withBlobAccessRetry(runWithAccess) {
  try {
    return await runWithAccess(BLOB_ACCESS);
  } catch (error) {
    const requiredAccess = requiredBlobAccessFromError(error);
    if (requiredAccess && requiredAccess !== BLOB_ACCESS) {
      return runWithAccess(requiredAccess);
    }
    throw error;
  }
}

async function getJson(pathname) {
  try {
    const result = await withBlobAccessRetry((access) => get(pathname, { access }));
    if (!result) return null;
    if (result.statusCode !== 200 || !result.stream) {
      throw new Error(`Blob fetch failed (${result.statusCode}).`);
    }
    const text = await new Response(result.stream).text();
    return JSON.parse(text);
  } catch (error) {
    if (isNotFoundError(error)) return null;
    throw error;
  }
}

async function putJson(pathname, data) {
  return withBlobAccessRetry((access) =>
    put(pathname, JSON.stringify(data), {
      access,
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: 'application/json; charset=utf-8',
    })
  );
}

async function putBinary(pathname, data, contentType) {
  return withBlobAccessRetry((access) =>
    put(pathname, data, {
      access,
      addRandomSuffix: false,
      allowOverwrite: false,
      contentType: contentType || 'application/octet-stream',
    })
  );
}

async function binaryExists(pathname) {
  try {
    await head(pathname);
    return true;
  } catch (error) {
    if (isNotFoundError(error)) return false;
    throw error;
  }
}

async function getBinary(pathname) {
  try {
    const result = await withBlobAccessRetry((access) => get(pathname, { access }));
    if (!result) return null;
    if (result.statusCode !== 200 || !result.stream) {
      if (result.statusCode === 304) return null;
      throw new Error(`Blob fetch failed (${result.statusCode}).`);
    }
    return {
      contentType: result.blob.contentType || 'application/octet-stream',
      stream: result.stream,
    };
  } catch (error) {
    if (isNotFoundError(error)) return null;
    throw error;
  }
}

function sanitizeSnapshot(snapshot) {
  return sanitizeSyncSnapshot(snapshot);
}

export {
  binaryExists,
  buildAudioPath,
  buildMetaPath,
  buildSnapshotId,
  buildSnapshotPath,
  getBinary,
  getJson,
  putBinary,
  putJson,
  sanitizeSnapshot,
};
