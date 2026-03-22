import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveBackendMode } from './index.js';
import { createFileSyncBackend } from './sync-file-backend.js';
import { createSyncStore } from './sync-store.js';

test('resolveBackendMode honors explicit filePath even when blob token exists', () => {
  process.env.BLOB_READ_WRITE_TOKEN = 'token';
  assert.equal(resolveBackendMode({ filePath: '/tmp/store.json' }), 'file');
  delete process.env.BLOB_READ_WRITE_TOKEN;
});

test('file sync store persists and reads events', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'voice-notes-sync-'));
  const filePath = join(dir, 'sync-store.json');
  const store = createSyncStore(createFileSyncBackend(filePath));
  const auth = { readKey: 'read', writeKey: 'write' };

  const upsert = await store.upsertEvents('vault-1', auth, [
    { eventId: 'e1', recordedAt: '2026-03-22T00:00:00.000Z', type: 'note' }
  ]);

  assert.equal(upsert.accepted, 1);
  const read = await store.readEvents('vault-1', { readKey: 'read' }, '');
  assert.equal(read.records.length, 1);
  assert.equal(read.records[0].eventId, 'e1');

  const persisted = JSON.parse(await readFile(filePath, 'utf8'));
  assert.ok(persisted.vaults['vault-1']);
});
