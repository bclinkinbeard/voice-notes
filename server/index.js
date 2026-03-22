import { existsSync } from 'node:fs';
import http from 'node:http';
import { join } from 'node:path';

import { createBlobSyncBackend } from './sync-blob-backend.js';
import { createFileSyncBackend } from './sync-file-backend.js';
import { createSyncRequestHandler } from './sync-routes.js';
import { createSyncStore } from './sync-store.js';
import { createRelayRequestHandler } from './relay-routes.js';
import { createRelayStore } from './relay-store.js';

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

export function resolveBackendMode(options = {}) {
  const mode = String(options.backend || options.mode || '').trim().toLowerCase();
  if (mode === 'file' || mode === 'blob') return mode;
  if (options.filePath) return 'file';
  return options.blobClient || options.blobToken || process.env.BLOB_READ_WRITE_TOKEN ? 'blob' : 'file';
}

export function createSyncServer(options = {}) {
  const mode = resolveBackendMode(options);
  const backend = mode === 'blob'
    ? createBlobSyncBackend({
        client: options.blobClient,
        token: options.blobToken,
        prefix: options.blobPrefix,
        access: options.blobAccess
      })
    : createFileSyncBackend(resolveStoreFile(options.filePath));
  const store = createSyncStore(backend);
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

export function createRelayServer(options = {}) {
  const store = createRelayStore(options.filePath || legacyStoreFile());
  return http.createServer(createRelayRequestHandler(store));
}

export async function startRelayServer(options = {}) {
  const server = options.server || createRelayServer(options);
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
  const location = typeof address === 'object' && address ? `http://${address.address}:${address.port}` : 'sync';
  console.log(`Sync listening at ${location}`);
}
