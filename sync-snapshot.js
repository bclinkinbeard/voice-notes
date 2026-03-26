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

function toTimestamp(value) {
  const time = Date.parse(String(value || ''));
  return Number.isFinite(time) ? time : null;
}

function pickEarlierIso(left, right) {
  const leftTime = toTimestamp(left);
  const rightTime = toTimestamp(right);

  if (leftTime === null) return right || new Date().toISOString();
  if (rightTime === null) return left;
  return leftTime <= rightTime ? left : right;
}

function mergeStringArrays(...values) {
  const merged = [];
  const seen = new Set();

  for (const value of values) {
    for (const entry of sanitizeStringArray(value)) {
      if (seen.has(entry)) continue;
      seen.add(entry);
      merged.push(entry);
    }
  }

  return merged;
}

function normalizeLocalListRecord(list) {
  const sanitized = sanitizeListRecord(list);
  return {
    ...list,
    ...sanitized,
  };
}

function normalizeLocalNoteRecord(note) {
  const sanitized = sanitizeNoteRecord(note);
  return {
    ...note,
    ...sanitized,
  };
}

function mergeNoteRecords(localNote, remoteNote) {
  const local = localNote ? normalizeLocalNoteRecord(localNote) : null;
  const remote = remoteNote ? sanitizeNoteRecord(remoteNote) : null;

  if (!local && !remote) return null;
  if (!local) return { ...remote };
  if (!remote) return { ...local };

  return {
    ...remote,
    ...local,
    id: local.id,
    listId: local.listId || remote.listId,
    createdAt: pickEarlierIso(local.createdAt, remote.createdAt),
    transcription: local.transcription || remote.transcription,
    duration: Math.max(local.duration || 0, remote.duration || 0),
    completed: Boolean(local.completed || remote.completed),
  };
}

function mergeListRecords(localList, remoteList, noteIds) {
  const local = localList ? normalizeLocalListRecord(localList) : null;
  const remote = remoteList ? sanitizeListRecord(remoteList) : null;
  const fallback = local || remote;

  if (!fallback) return null;

  return {
    ...(remote || {}),
    ...(local || {}),
    id: fallback.id,
    name: (local && local.name) || (remote && remote.name) || 'Untitled List',
    mode: (local && local.mode) || (remote && remote.mode) || 'capture',
    createdAt: pickEarlierIso(local && local.createdAt, remote && remote.createdAt),
    noteOrder: mergeStringArrays(
      local && local.noteOrder,
      remote && remote.noteOrder,
      noteIds
    ),
  };
}

function mergeSyncData(localData, remoteSnapshot) {
  const localLists = Array.isArray(localData && localData.lists) ? localData.lists : [];
  const localNotes = Array.isArray(localData && localData.notes) ? localData.notes : [];
  const remoteData = sanitizeSyncSnapshot(remoteSnapshot);

  const localListMap = new Map(localLists.map((list) => [String(list.id || '').trim(), list]).filter(([id]) => id));
  const localNoteMap = new Map(localNotes.map((note) => [String(note.id || '').trim(), note]).filter(([id]) => id));
  const remoteListMap = new Map(remoteData.lists.map((list) => [list.id, list]));
  const remoteNoteMap = new Map(remoteData.notes.map((note) => [note.id, note]));

  const mergedNotes = [];
  const noteIdsByList = new Map();
  const noteIdsByListSorted = new Map();
  const noteIdsByListBuckets = new Map();
  const noteIds = new Set([...localNoteMap.keys(), ...remoteNoteMap.keys()]);

  for (const noteId of noteIds) {
    const mergedNote = mergeNoteRecords(localNoteMap.get(noteId), remoteNoteMap.get(noteId));
    if (!mergedNote) continue;
    mergedNotes.push(mergedNote);

    if (!noteIdsByListBuckets.has(mergedNote.listId)) {
      noteIdsByListBuckets.set(mergedNote.listId, []);
    }
    noteIdsByListBuckets.get(mergedNote.listId).push(mergedNote);
  }

  for (const [listId, notes] of noteIdsByListBuckets.entries()) {
    notes.sort((left, right) => {
      const leftTime = toTimestamp(left.createdAt) || 0;
      const rightTime = toTimestamp(right.createdAt) || 0;
      return rightTime - leftTime;
    });
    noteIdsByListSorted.set(listId, notes.map((note) => note.id));
    noteIdsByList.set(listId, new Set(notes.map((note) => note.id)));
  }

  const mergedLists = [];
  const listIds = new Set([
    ...localListMap.keys(),
    ...remoteListMap.keys(),
    ...noteIdsByList.keys(),
  ]);

  for (const listId of listIds) {
    const mergedList = mergeListRecords(
      localListMap.get(listId),
      remoteListMap.get(listId),
      noteIdsByListSorted.get(listId) || []
    );
    if (!mergedList) continue;
    mergedLists.push(mergedList);
  }

  const knownListIds = new Set(mergedLists.map((list) => list.id));
  for (const note of mergedNotes) {
    if (knownListIds.has(note.listId)) continue;
    mergedLists.push({
      id: note.listId,
      name: 'Untitled List',
      mode: 'capture',
      createdAt: note.createdAt || new Date().toISOString(),
      noteOrder: [note.id],
    });
    knownListIds.add(note.listId);
  }

  const stats = {
    addedLists: remoteData.lists.filter((list) => !localListMap.has(list.id)).length,
    addedNotes: remoteData.notes.filter((note) => !localNoteMap.has(note.id)).length,
    mergedLists: remoteData.lists.filter((list) => localListMap.has(list.id)).length,
    mergedNotes: remoteData.notes.filter((note) => localNoteMap.has(note.id)).length,
  };

  return {
    version: remoteData.version,
    exportedAt: remoteData.exportedAt,
    lists: mergedLists,
    notes: mergedNotes,
    stats,
  };
}

export {
  mergeSyncData,
  normalizeAudioHash,
  SYNC_KEY_HEADER,
  SYNC_SNAPSHOT_VERSION,
  normalizeSyncKey,
  sanitizeSyncSnapshot,
};
