import assert from 'node:assert/strict';
import test from 'node:test';

import { createBlobSyncBackend } from './sync-blob-backend.js';

function createMemoryBlobClient() {
  const blobs = new Map();
  let tick = 0;

  return {
    async get(pathname) {
      if (!blobs.has(pathname)) return null;
      const entry = blobs.get(pathname);
      return {
        statusCode: 200,
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(entry.body));
            controller.close();
          }
        })
      };
    },
    async put(pathname, body) {
      tick += 1;
      blobs.set(pathname, {
        body,
        uploadedAt: new Date(1700000000000 + tick).toISOString()
      });
    },
    async list({ prefix }) {
      return {
        blobs: Array.from(blobs.entries())
          .filter(([pathname]) => pathname.startsWith(prefix))
          .map(([pathname, entry]) => ({ pathname, uploadedAt: entry.uploadedAt })),
        hasMore: false,
        cursor: undefined
      };
    }
  };
}

test('blob backend re-reads remote state instead of serving stale cache', async () => {
  const client = createMemoryBlobClient();
  const backendA = createBlobSyncBackend({ client, prefix: 'vaults' });
  const backendB = createBlobSyncBackend({ client, prefix: 'vaults' });

  await backendA.saveVault('v1', {
    readKey: 'r',
    writeKey: 'w',
    nextEventSequence: 2,
    nextArtifactSequence: 1,
    events: {
      e1: { record: { eventId: 'e1', recordedAt: '2026-03-22T00:00:00.000Z' }, sequence: 1 }
    },
    artifacts: {}
  });

  const loaded = await backendB.loadVault('v1');
  loaded.events.e2 = {
    record: { eventId: 'e2', recordedAt: '2026-03-22T00:01:00.000Z' },
    sequence: 2
  };
  loaded.nextEventSequence = 3;
  await backendB.saveVault('v1', loaded);

  const refreshed = await backendA.loadVault('v1');
  assert.deepEqual(Object.keys(refreshed.events).sort(), ['e1', 'e2']);
});

test('blob backend writes meta before collection data so partial failures remain discoverable', async () => {
  const client = createMemoryBlobClient();
  let puts = 0;
  const flakyClient = {
    ...client,
    async put(pathname, body, options) {
      puts += 1;
      await client.put(pathname, body, options);
      if (puts === 2) {
        throw new Error('simulated failure');
      }
    }
  };

  const backend = createBlobSyncBackend({ client: flakyClient, prefix: 'vaults' });
  await assert.rejects(() => backend.saveVault('v1', {
    readKey: 'r',
    writeKey: 'w',
    nextEventSequence: 2,
    nextArtifactSequence: 1,
    events: {
      e1: { record: { eventId: 'e1', recordedAt: '2026-03-22T00:00:00.000Z' }, sequence: 1 }
    },
    artifacts: {}
  }));

  const recovered = await createBlobSyncBackend({ client, prefix: 'vaults' }).loadVault('v1');
  assert.ok(recovered);
  assert.equal(recovered.writeKey, 'w');
});
