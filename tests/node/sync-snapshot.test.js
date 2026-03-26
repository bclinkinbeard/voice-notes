import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeAudioHash,
  normalizeSyncKey,
  sanitizeSyncSnapshot,
} from '../../sync-snapshot.js';
import { deriveNamespaceFromKey } from '../../server/sync-key.js';

test('normalizeSyncKey enforces expected length bounds', () => {
  assert.equal(normalizeSyncKey(''), '');
  assert.equal(normalizeSyncKey('short'), '');
  assert.equal(normalizeSyncKey('abcdefgh'), 'abcdefgh');
  assert.equal(normalizeSyncKey('x'.repeat(257)), '');
});

test('normalizeAudioHash only accepts sha256-style hashes', () => {
  assert.equal(normalizeAudioHash(''), '');
  assert.equal(normalizeAudioHash('abc123'), '');
  assert.equal(normalizeAudioHash('A'.repeat(64)), 'a'.repeat(64));
  assert.equal(normalizeAudioHash('g'.repeat(64)), '');
});

test('sanitizeSyncSnapshot normalizes list and note records', () => {
  const snapshot = sanitizeSyncSnapshot({
    version: 1,
    exportedAt: '2026-03-26T12:00:00.000Z',
    lists: [
      {
        id: 'list-1',
        name: 'Inbox',
        mode: 'accomplish',
        createdAt: '2026-03-26T12:00:00.000Z',
        noteOrder: ['note-1', '', 'note-2'],
      },
    ],
    notes: [
      {
        id: 'note-1',
        listId: 'list-1',
        createdAt: '2026-03-26T12:00:00.000Z',
        transcription: 'hello',
        duration: 4.4,
        completed: 1,
        categories: ['work', '', 'idea'],
        sentiment: { label: 'positive', score: 0.99 },
      },
    ],
  });

  assert.equal(snapshot.lists[0].mode, 'accomplish');
  assert.deepEqual(snapshot.lists[0].noteOrder, ['note-1', 'note-2']);
  assert.equal(snapshot.notes[0].duration, 4);
  assert.equal(snapshot.notes[0].completed, true);
  assert.deepEqual(snapshot.notes[0].categories, ['work', 'idea']);
  assert.deepEqual(snapshot.notes[0].sentiment, { label: 'positive', score: 0.99 });
  assert.equal('audioHash' in snapshot.notes[0], false);
  assert.equal('audioMimeType' in snapshot.notes[0], false);
});

test('deriveNamespaceFromKey is deterministic', () => {
  assert.equal(
    deriveNamespaceFromKey('abcdefgh'),
    deriveNamespaceFromKey('abcdefgh')
  );
  assert.notEqual(
    deriveNamespaceFromKey('abcdefgh'),
    deriveNamespaceFromKey('ijklmnop')
  );
});
