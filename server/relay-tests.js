import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createHttpSyncTransport, encryptEnvelope } from '../sync.js';
import { startRelayServer } from './index.js';

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

async function withRelay(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'voice-notes-relay-'));
  const filePath = join(dir, 'relay-store.json');
  const server = await startRelayServer({ port: 0, filePath });
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    await fn(baseUrl);
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

await suite('Relay rejects bad auth, dedupes, and preserves ciphertext', async () => {
  await withRelay(async (baseUrl) => {
    const vaultId = 'vault:auth';
    const path = `${baseUrl}/v1/vaults/${encodeURIComponent(vaultId)}/events`;
    const headers = {
      'Content-Type': 'application/json',
      'X-Vault-Read-Key': 'read-secret',
      'X-Vault-Write-Key': 'write-secret'
    };
    const event = {
      eventId: 'evt:1',
      vaultId,
      occurredAt: '2026-03-20T11:00:00.000Z',
      recordedAt: '2026-03-20T11:00:00.000Z',
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
    const encrypted = await encryptEnvelope('vault-secret', event);

    let response = await fetch(path, {
      method: 'POST',
      headers,
      body: JSON.stringify({ events: [encrypted] })
    });
    let payload = await response.json();
    assertEqual(response.status, 200, 'creates a vault on first push');
    assertEqual(payload.accepted, 1, 'accepts the first encrypted record');

    response = await fetch(path, {
      method: 'POST',
      headers,
      body: JSON.stringify({ events: [encrypted] })
    });
    payload = await response.json();
    assertEqual(payload.accepted, 0, 'dedupes duplicate event ids');

    response = await fetch(path, {
      headers: {
        'X-Vault-Read-Key': 'read-secret'
      }
    });
    payload = await response.json();
    assertDeepEqual(payload.events, [encrypted], 'returns ciphertext unchanged');

    response = await fetch(path + '?since=' + encodeURIComponent(payload.cursor), {
      headers: {
        'X-Vault-Read-Key': 'read-secret'
      }
    });
    payload = await response.json();
    assertDeepEqual(payload.events, [], 'cursor only returns newer records');

    response = await fetch(path, {
      headers: {
        'X-Vault-Read-Key': 'wrong-read-key'
      }
    });
    assertEqual(response.status, 403, 'rejects invalid read keys');

    response = await fetch(path, {
      method: 'POST',
      headers: {
        ...headers,
        'X-Vault-Write-Key': 'wrong-write-key'
      },
      body: JSON.stringify({ events: [encrypted] })
    });
    assertEqual(response.status, 403, 'rejects invalid write keys');
  });
});

await suite('Relay cursors still return late-arriving older history', async () => {
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
    assertDeepEqual(secondPull.events, [lateHistoryEvent], 'late-arriving older history is still visible after the cursor');
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

console.log('\n========================================');
console.log(`${passed}/${total} server tests passed`);
console.log('========================================');
