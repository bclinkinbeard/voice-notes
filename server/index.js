import { existsSync } from 'node:fs';
import http from 'node:http';
import { join } from 'node:path';

import { createBlobSyncBackend } from './sync-blob-backend.js';
import { createFileSyncBackend } from './sync-file-backend.js';
import { createSyncRequestHandler } from './sync-routes.js';
import { createSyncStore } from './sync-store.js';

function defaultStoreFile() {
  return join(process.cwd(), 'server', '.sync-store.json');
}

function legacyStoreFile() {
  return join(process.cwd(), 'server', '.relay-store.json');
}

function resolveStoreFile(filePath) {
  if (filePath) return filePath;
  const preferred = defaultStoreFile();
  if (existsSync(preferred)) return preferred;
  const legacy = legacyStoreFile();
  if (existsSync(legacy)) return legacy;
  return preferred;
}

function resolveBackendMode(options = {}) {
  const mode = String(options.storageBackend || process.env.SYNC_STORAGE_BACKEND || process.env.RELAY_STORAGE_BACKEND || '').trim().toLowerCase();
  if (!mode) {
    return options.blobToken || process.env.BLOB_READ_WRITE_TOKEN ? 'blob' : 'file';
  }
  if (mode === 'file' || mode === 'blob') return mode;
  throw new Error(`Unsupported sync storage backend "${mode}". Use "file" or "blob".`);
}

export function createSyncBackend(options = {}) {
  if (options.backend) return options.backend;

  const mode = resolveBackendMode(options);
  if (mode === 'blob') {
    return createBlobSyncBackend({
      token: options.blobToken,
      prefix: options.blobPrefix || process.env.SYNC_BLOB_PREFIX || process.env.RELAY_BLOB_PREFIX || 'vaults',
      access: options.blobAccess || process.env.SYNC_BLOB_ACCESS || process.env.RELAY_BLOB_ACCESS || 'private'
    });
  }

  return createFileSyncBackend(resolveStoreFile(options.filePath));
}

export function createSyncServer(options = {}) {
  const store = createSyncStore(createSyncBackend(options));
  return http.createServer(createSyncRequestHandler(store));
}

export async function startSyncServer(options = {}) {
  const server = options.server || createSyncServer(options);
  const host = options.host || '127.0.0.1';
  const port = options.port === undefined ? Number(process.env.PORT || 8787) : options.port;

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  return server;
}

if (import.meta.url === new URL(process.argv[1], 'file://').href) {
  const server = await startSyncServer();
  const address = server.address();
  const location = typeof address === 'object' && address
    ? `http://${address.address}:${address.port}`
    : 'sync';
  console.log(`Sync server listening at ${location}`);
}
