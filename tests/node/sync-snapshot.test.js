import test from 'node:test';
import assert from 'node:assert/strict';

import {
  mergeSyncData,
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

test('mergeSyncData preserves local records and imports remote records', () => {
  const merged = mergeSyncData(
    {
      lists: [
        {
          id: 'list-1',
          name: 'Local Inbox',
          mode: 'accomplish',
          createdAt: '2026-03-26T12:00:00.000Z',
          noteOrder: ['note-local', 'note-shared'],
        },
      ],
      notes: [
        {
          id: 'note-local',
          listId: 'list-1',
          createdAt: '2026-03-26T12:01:00.000Z',
          transcription: 'local only',
          duration: 3,
          completed: false,
          categories: ['idea'],
          sentiment: null,
          audioBlob: { local: true },
        },
        {
          id: 'note-shared',
          listId: 'list-1',
          createdAt: '2026-03-26T12:02:00.000Z',
          transcription: 'local shared',
          duration: 2,
          completed: false,
          categories: ['work'],
          sentiment: { label: 'positive', score: 0.8 },
          audioBlob: { local: true },
        },
      ],
    },
    {
      version: 1,
      exportedAt: '2026-03-26T12:10:00.000Z',
      lists: [
        {
          id: 'list-1',
          name: 'Remote Inbox',
          mode: 'capture',
          createdAt: '2026-03-26T12:00:00.000Z',
          noteOrder: ['note-shared', 'note-remote'],
        },
      ],
      notes: [
        {
          id: 'note-shared',
          listId: 'list-1',
          createdAt: '2026-03-26T12:02:00.000Z',
          transcription: 'remote shared',
          duration: 5,
          completed: true,
          categories: ['todo'],
          sentiment: { label: 'negative', score: 0.2 },
        },
        {
          id: 'note-remote',
          listId: 'list-1',
          createdAt: '2026-03-26T12:03:00.000Z',
          transcription: 'remote only',
          duration: 4,
          completed: false,
          categories: ['personal'],
          sentiment: null,
        },
      ],
    }
  );

  assert.equal(merged.stats.addedLists, 0);
  assert.equal(merged.stats.addedNotes, 1);
  assert.equal(merged.stats.mergedLists, 1);
  assert.equal(merged.stats.mergedNotes, 1);
  assert.equal(merged.lists.length, 1);
  assert.deepEqual(merged.lists[0].noteOrder, ['note-local', 'note-shared', 'note-remote']);

  const shared = merged.notes.find((note) => note.id === 'note-shared');
  assert.equal(shared.transcription, 'local shared');
  assert.equal(shared.duration, 5);
  assert.equal(shared.completed, true);
  assert.deepEqual(shared.categories, ['work', 'todo']);
  assert.deepEqual(shared.sentiment, { label: 'positive', score: 0.8 });
  assert.deepEqual(shared.audioBlob, { local: true });

  const remote = merged.notes.find((note) => note.id === 'note-remote');
  assert.equal(remote.transcription, 'remote only');
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
