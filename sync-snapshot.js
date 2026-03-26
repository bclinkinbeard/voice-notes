'use strict';

const SYNC_SNAPSHOT_VERSION = 1;
const SYNC_KEY_HEADER = 'x-sync-key';

function normalizeSyncKey(value) {
  const key = String(value || '').trim();
  if (key.length < 8) return '';
  if (key.length > 256) return '';
  return key;
}

function normalizeAudioHash(value) {
  const hash = String(value || '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(hash)) {
    return '';
  }
  return hash;
}

function sanitizeStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry) => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function sanitizeSentiment(value) {
  if (!value || typeof value !== 'object') return null;

  const label = typeof value.label === 'string' ? value.label.trim() : '';
  if (!label) return null;

  const score = Number(value.score);
  if (!Number.isFinite(score)) {
    return { label };
  }

  return { label, score };
}

function sanitizeListRecord(list) {
  if (!list || typeof list !== 'object') {
    throw new Error('Each list must be an object.');
  }

  const id = String(list.id || '').trim();
  if (!id) {
    throw new Error('Each list must include an id.');
  }

  return {
    id,
    name: String(list.name || '').trim() || 'Untitled List',
    mode: list.mode === 'accomplish' ? 'accomplish' : 'capture',
    createdAt: typeof list.createdAt === 'string' && list.createdAt.trim()
      ? list.createdAt
      : new Date().toISOString(),
    noteOrder: sanitizeStringArray(list.noteOrder),
  };
}

function sanitizeNoteRecord(note) {
  if (!note || typeof note !== 'object') {
    throw new Error('Each note must be an object.');
  }

  const id = String(note.id || '').trim();
  if (!id) {
    throw new Error('Each note must include an id.');
  }

  const listId = String(note.listId || '').trim();
  if (!listId) {
    throw new Error('Each note must include a listId.');
  }

  const duration = Number(note.duration);

  return {
    id,
    listId,
    createdAt: typeof note.createdAt === 'string' && note.createdAt.trim()
      ? note.createdAt
      : new Date().toISOString(),
    transcription: typeof note.transcription === 'string' ? note.transcription : '',
    duration: Number.isFinite(duration) && duration > 0 ? Math.round(duration) : 0,
    completed: Boolean(note.completed),
    categories: sanitizeStringArray(note.categories),
    sentiment: sanitizeSentiment(note.sentiment),
  };
}

function sanitizeSyncSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') {
    throw new Error('Snapshot must be an object.');
  }

  if (!Array.isArray(snapshot.lists) || !Array.isArray(snapshot.notes)) {
    throw new Error('Snapshot must include lists and notes arrays.');
  }

  const version = Number.isInteger(snapshot.version)
    ? snapshot.version
    : SYNC_SNAPSHOT_VERSION;

  if (version !== SYNC_SNAPSHOT_VERSION) {
    throw new Error(`Unsupported snapshot version: ${snapshot.version}`);
  }

  return {
    version: SYNC_SNAPSHOT_VERSION,
    lists: snapshot.lists.map((list) => sanitizeListRecord(list)),
    notes: snapshot.notes.map((note) => sanitizeNoteRecord(note)),
    exportedAt: typeof snapshot.exportedAt === 'string' && snapshot.exportedAt.trim()
      ? snapshot.exportedAt
      : new Date().toISOString(),
  };
}

export {
  normalizeAudioHash,
  SYNC_KEY_HEADER,
  SYNC_SNAPSHOT_VERSION,
  normalizeSyncKey,
  sanitizeSyncSnapshot,
};
