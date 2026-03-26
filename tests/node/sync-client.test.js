import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildSnapshotPayload,
} from '../../sync-client.js';

test('buildSnapshotPayload strips local audio fields from synced notes', async () => {
  const payload = await buildSnapshotPayload({
    lists: [
      {
        id: 'list-1',
        name: 'Inbox',
        mode: 'capture',
        createdAt: '2026-03-26T12:00:00.000Z',
        noteOrder: ['note-1', 'note-2'],
      },
    ],
    notes: [
      {
        id: 'note-1',
        listId: 'list-1',
        createdAt: '2026-03-26T12:00:00.000Z',
        transcription: 'One',
        duration: 3,
        completed: false,
        categories: [],
        sentiment: null,
        audioBlob: new Blob(['voice-note'], { type: 'audio/webm' }),
        audioHash: 'a'.repeat(64),
        audioMimeType: 'audio/webm',
      },
      {
        id: 'note-2',
        listId: 'list-1',
        createdAt: '2026-03-26T12:01:00.000Z',
        transcription: 'Two',
        duration: 3,
        completed: false,
        categories: [],
        sentiment: null,
        audioBlob: null,
      },
    ],
  });

  assert.equal('audios' in payload, false);
  assert.equal(payload.snapshot.notes.every((note) => !('audioBlob' in note)), true);
  assert.equal('audioHash' in payload.snapshot.notes[0], false);
  assert.equal('audioMimeType' in payload.snapshot.notes[0], false);
});
