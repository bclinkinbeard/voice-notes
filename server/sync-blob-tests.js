import http from 'node:http';

import { createBlobSyncBackend } from './sync-blob-backend.js';
import { createSyncRequestHandler } from './sync-routes.js';
import { createSyncStore } from './sync-store.js';
import { runSyncBehaviorSuite } from './sync-test-suite.js';

let total = 0;
let passed = 0;

function assert(condition, message) {
  total += 1;
  if (!condition) {
    throw new Error(message);
  }
  passed += 1;
}

function assertEqual(actual, expected, message) {
  assert(actual === expected, message + ` (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

function createInMemoryBlobClient() {
  let now = Date.parse('2026-03-20T00:00:00.000Z');
  let version = 0;
  const blobs = new Map();

  function metadata(pathname, blob) {
    return {
      size: Buffer.byteLength(blob.body),
      uploadedAt: new Date(blob.uploadedAt),
      pathname,
      url: `https://example.test/${pathname}`,
      downloadUrl: `https://example.test/${pathname}?download=1`,
      etag: blob.etag
    };
  }

  return {
    async put(pathname, body, options = {}) {
      if (blobs.has(pathname) && !options.allowOverwrite) {
        throw new Error(`Blob already exists at ${pathname}`);
      }
      const stringBody = typeof body === 'string' ? body : String(body);
      version += 1;
      now += 1000;
      const blob = {
        body: stringBody,
        uploadedAt: now,
        etag: `"etag-${version}"`
      };
      blobs.set(pathname, blob);
      return {
        pathname,
        contentType: options.contentType || 'application/octet-stream',
        contentDisposition: `attachment; filename="${pathname.split('/').pop()}"`,
        url: `https://example.test/${pathname}`,
        downloadUrl: `https://example.test/${pathname}?download=1`,
        etag: blob.etag
      };
    },

    async get(pathname) {
      const blob = blobs.get(pathname);
      if (!blob) return null;
      return {
        statusCode: 200,
        stream: new Response(blob.body).body,
        headers: new Headers(),
        blob: {
          ...metadata(pathname, blob),
          contentType: 'application/json',
          contentDisposition: `attachment; filename="${pathname.split('/').pop()}"`,
          cacheControl: 'public, max-age=0'
        }
      };
    },

    async list(options = {}) {
      const prefix = String(options.prefix || '');
      const items = Array.from(blobs.entries())
        .filter(([pathname]) => pathname.startsWith(prefix))
        .map(([pathname, blob]) => metadata(pathname, blob))
        .reverse();
      return {
        blobs: items,
        hasMore: false
      };
    }
  };
}

async function startBlobSyncServer(backend) {
  const server = http.createServer(createSyncRequestHandler(createSyncStore(backend)));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  return server;
}

async function closeServer(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function withSync(fn) {
  const backend = createBlobSyncBackend({
    client: createInMemoryBlobClient(),
    prefix: 'vaults'
  });
  const server = await startBlobSyncServer(backend);
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    await fn(baseUrl);
  } finally {
    await closeServer(server);
  }
}

const behaviorCounts = await runSyncBehaviorSuite('Blob backend', withSync);
total += behaviorCounts.total;
passed += behaviorCounts.passed;

console.log('\nBlob backend: persists sync state across restarts');
{
  const client = createInMemoryBlobClient();
  const firstServer = await startBlobSyncServer(createBlobSyncBackend({
    client,
    prefix: 'vaults'
  }));
  const firstAddress = firstServer.address();
  const firstBaseUrl = `http://127.0.0.1:${firstAddress.port}`;
  const path = `${firstBaseUrl}/v1/vaults/${encodeURIComponent('vault:restart')}/events`;
  const headers = {
    'Content-Type': 'application/json',
    'X-Vault-Read-Key': 'read-secret',
    'X-Vault-Write-Key': 'write-secret'
  };
  const event = {
    eventId: 'evt:restart',
    recordedAt: '2026-03-21T10:00:00.000Z',
    iv: 'restart-iv',
    payload: 'restart-payload'
  };

  let response = await fetch(path, {
    method: 'POST',
    headers,
    body: JSON.stringify({ events: [event] })
  });
  let payload = await response.json();
  assertEqual(response.status, 200, 'accepts writes before restart');
  assertEqual(payload.accepted, 1, 'persists the first blob-backed event');
  await closeServer(firstServer);

  const secondServer = await startBlobSyncServer(createBlobSyncBackend({
    client,
    prefix: 'vaults'
  }));
  const secondAddress = secondServer.address();
  const secondBaseUrl = `http://127.0.0.1:${secondAddress.port}`;
  response = await fetch(`${secondBaseUrl}/v1/vaults/${encodeURIComponent('vault:restart')}/events`, {
    headers: {
      'X-Vault-Read-Key': 'read-secret'
    }
  });
  payload = await response.json();
  assertEqual(response.status, 200, 'reads succeed after restart');
  assertEqual(payload.events.length, 1, 'reloads stored blob-backed events after restart');
  assertEqual(payload.events[0].eventId, 'evt:restart', 'restored event payload stays intact after restart');
  await closeServer(secondServer);
}

console.log('\n========================================');
console.log(`${passed}/${total} blob backend server tests passed`);
console.log('========================================');
