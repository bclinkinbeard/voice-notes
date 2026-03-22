import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createHttpSyncTransport } from '../sync.js';
import { createBlobRelayBackend } from './relay-blob-backend.js';
import { createFileRelayBackend } from './relay-file-backend.js';
import { startRelayServer } from './index.js';
import { createRelayStore } from './relay-store.js';

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

function assertDeepEqual(actual, expected, message) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  assert(a === b, message + ` (expected ${b}, got ${a})`);
}

function suite(name, fn) {
  console.log('\n' + name);
  return Promise.resolve(fn());
}

async function withRelay(fn, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'voice-notes-relay-'));
  const filePath = join(dir, 'relay-store.json');
  const server = await startRelayServer({ port: 0, filePath, ...options });
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    await fn(baseUrl, { dir, filePath });
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
    await rm(dir, { recursive: true, force: true });
  }
}

function makeSyncState() {
  return {
    lastPushCursor: '',
    lastPullCursor: '',
    lastArtifactPushCursor: '',
    lastArtifactPullCursor: ''
  };
}

function createMemoryBlobClient() {
  const blobs = new Map();

  return {
    async put(pathname, body, options = {}) {
      if (!options.allowOverwrite && blobs.has(pathname)) {
        throw new Error(`Blob already exists: ${pathname}`);
      }
      blobs.set(pathname, String(body));
      return {
        pathname,
        url: `memory://${pathname}`
      };
    },
    async list({ prefix = '', cursor = '' } = {}) {
      const names = [...blobs.keys()].filter((name) => name.startsWith(prefix)).sort();
      const start = cursor ? Number(cursor) || 0 : 0;
      const pageNames = names.slice(start, start + 2);
      const nextCursor = start + pageNames.length < names.length ? String(start + pageNames.length) : undefined;
      return {
        blobs: pageNames.map((pathname) => ({ pathname, url: `memory://${pathname}` })),
        cursor: nextCursor
      };
    },
    async fetch(url) {
      const pathname = String(url).replace('memory://', '');
      if (!blobs.has(pathname)) {
        return { ok: false, status: 404, statusText: 'Not Found' };
      }
      return {
        ok: true,
        async json() {
          return JSON.parse(blobs.get(pathname));
        }
      };
    }
  };
}

function createMockBlobBackend() {
  const client = createMemoryBlobClient();
  return createBlobRelayBackend({
    getClient: async () => ({
      put: client.put,
      list: client.list
    }),
    fetchImpl: client.fetch
  });
}

async function runStoreContractSuite(name, backendFactory) {
  await suite(name, async () => {
    const setup = await backendFactory();
    const store = createRelayStore(setup.backend || setup);
    const auth = { readKey: 'read-secret', writeKey: 'write-secret' };
    const vaultId = 'vault:contract';
    const eventA = {
      eventId: 'evt:a',
      recordedAt: '2026-03-20T10:00:00.000Z',
      iv: 'iv:a',
      payload: 'payload:a'
    };
    const eventB = {
      eventId: 'evt:b',
      recordedAt: '2026-03-20T10:00:00.000Z',
      iv: 'iv:b',
      payload: 'payload:b'
    };
    const artifact = {
      artifactId: 'artifact:1',
      createdAt: '2026-03-20T10:00:01.000Z',
      iv: 'iv:artifact',
      payload: 'payload:artifact'
    };

    let result = await store.upsertEvents(vaultId, auth, [eventB, eventA]);
    assertEqual(result.accepted, 2, 'creates vault on first authenticated write');

    result = await store.upsertEvents(vaultId, auth, [eventA]);
    assertEqual(result.accepted, 0, 'dedupes duplicate event ids');

    let read = await store.readEvents(vaultId, { readKey: 'read-secret' }, '');
    assertDeepEqual(read.records, [eventA, eventB], 'event ordering is deterministic');
    assertEqual(read.cursor !== '', true, 'event reads return opaque cursor');

    read = await store.readEvents(vaultId, { readKey: 'read-secret' }, read.cursor);
    assertDeepEqual(read.records, [], 'cursor only returns newer records');

    await store.upsertArtifacts(vaultId, auth, [artifact, artifact]);
    const artifactRead = await store.readArtifacts(vaultId, { readKey: 'read-secret' }, '');
    assertDeepEqual(artifactRead.records, [artifact], 'dedupes duplicate artifact ids');
    assertEqual(artifactRead.records[0].payload, artifact.payload, 'returns ciphertext unchanged');

    let rejected = false;
    try {
      await store.readEvents(vaultId, { readKey: 'wrong-read-key' }, '');
    } catch (error) {
      rejected = error.status === 403;
    }
    assertEqual(rejected, true, 'rejects invalid read key');

    rejected = false;
    try {
      await store.upsertEvents(vaultId, { ...auth, writeKey: 'wrong-write-key' }, [eventA]);
    } catch (error) {
      rejected = error.status === 403;
    }
    assertEqual(rejected, true, 'rejects invalid write key');

    if (setup.cleanup) {
      await setup.cleanup();
    }
  });
}

await suite('Relay round-trip uses vaultKey for payload crypto', async () => {
  await withRelay(async (baseUrl) => {
    const vault = {
      id: 'vault:shared',
      relayUrl: baseUrl,
      vaultKey: 'vault-secret',
      readKey: 'read-secret',
      writeKey: 'write-secret'
    };
    const transport = createHttpSyncTransport(vault);
    const syncState = makeSyncState();
    const event = {
      eventId: 'evt:1',
      vaultId: vault.id,
      occurredAt: '2026-03-20T10:00:00.000Z',
      recordedAt: '2026-03-20T10:00:00.000Z',
      deviceId: 'device:1',
      kind: 'capture.created',
      schemaVersion: 1,
      sourceRefs: [],
      body: {
        captureId: 'capture:1',
        captureType: 'voice'
      },
      provenance: { source: 'user' },
      confidence: 1
    };
    const artifact = {
      artifactId: 'artifact:1',
      vaultId: vault.id,
      captureId: 'capture:1',
      kind: 'audio',
      mimeType: 'audio/webm',
      name: 'clip.webm',
      size: 3,
      createdAt: '2026-03-20T10:00:01.000Z',
      blob: new Blob([Uint8Array.from([1, 2, 3])], { type: 'audio/webm' })
    };

    const pushResult = await transport.push([event], syncState);
    const pushArtifactResult = await transport.pushArtifacts([artifact], syncState);
    assertEqual(pushResult.accepted, 1, 'accepts a pushed event');
    assertEqual(pushArtifactResult.accepted, 1, 'accepts a pushed artifact');

    const pulledEvents = await transport.pull(syncState);
    const pulledArtifacts = await transport.pullArtifacts(syncState);
    assertDeepEqual(pulledEvents.events, [event], 'round-trips event payloads through the relay');
    assertEqual(pulledArtifacts.artifacts.length, 1, 'pulls one artifact record');
    assertEqual(pulledArtifacts.artifacts[0].name, 'clip.webm', 'artifact metadata round-trips');
    assertDeepEqual(
      Array.from(new Uint8Array(await pulledArtifacts.artifacts[0].blob.arrayBuffer())),
      [1, 2, 3],
      'artifact blob bytes round-trip'
    );
  });
});

await suite('Relay cursors exclude late-arriving older history', async () => {
  await withRelay(async (baseUrl) => {
    const vault = {
      id: 'vault:cursor',
      relayUrl: baseUrl,
      vaultKey: 'vault-secret',
      readKey: 'read-secret',
      writeKey: 'write-secret'
    };
    const transport = createHttpSyncTransport(vault);
    const firstEvent = {
      eventId: 'evt:newer',
      vaultId: vault.id,
      occurredAt: '2026-03-20T10:00:00.000Z',
      recordedAt: '2026-03-20T10:00:00.000Z',
      deviceId: 'device:1',
      kind: 'capture.created',
      schemaVersion: 1,
      sourceRefs: [],
      body: {
        captureId: 'capture:1',
        captureType: 'text'
      },
      provenance: { source: 'user' },
      confidence: 1
    };
    const lateHistoryEvent = {
      ...firstEvent,
      eventId: 'evt:older',
      recordedAt: '2026-03-10T10:00:00.000Z',
      occurredAt: '2026-03-10T10:00:00.000Z',
      body: {
        captureId: 'capture:2',
        captureType: 'text'
      }
    };

    await transport.push([firstEvent], makeSyncState());
    const firstPull = await transport.pull(makeSyncState());
    assertDeepEqual(firstPull.events, [firstEvent], 'first pull returns the initial event');

    await transport.push([lateHistoryEvent], {
      ...makeSyncState(),
      lastPushCursor: firstPull.cursor
    });
    const secondPull = await transport.pull({
      ...makeSyncState(),
      lastPullCursor: firstPull.cursor
    });
    assertDeepEqual(secondPull.events, [], 'older history remains behind the ordered cursor boundary');
  });
});

await suite('Empty vault sync initializes the remote relay', async () => {
  await withRelay(async (baseUrl) => {
    const vault = {
      id: 'vault:empty',
      relayUrl: baseUrl,
      vaultKey: 'vault-secret',
      readKey: 'read-secret',
      writeKey: 'write-secret'
    };
    const transport = createHttpSyncTransport(vault);
    const syncState = makeSyncState();

    const pushResult = await transport.push([], syncState);
    const pushArtifactResult = await transport.pushArtifacts([], syncState);
    const pullResult = await transport.pull(syncState);
    const pullArtifactResult = await transport.pullArtifacts(syncState);

    assertEqual(pushResult.accepted, 0, 'empty event push still initializes the relay vault');
    assertEqual(pushArtifactResult.accepted, 0, 'empty artifact push still initializes the relay vault');
    assertDeepEqual(pullResult.events, [], 'empty vault pull succeeds after initialization');
    assertDeepEqual(pullArtifactResult.artifacts, [], 'empty artifact pull succeeds after initialization');
  });
});

await runStoreContractSuite('File relay backend preserves shared store behavior', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'voice-notes-file-backend-'));
  return {
    backend: createFileRelayBackend(join(dir, 'relay-store.json')),
    cleanup: () => rm(dir, { recursive: true, force: true })
  };
});

await runStoreContractSuite('Blob relay backend preserves shared store behavior', async () => createMockBlobBackend());

console.log('\n========================================');
console.log(`${passed}/${total} server tests passed`);
