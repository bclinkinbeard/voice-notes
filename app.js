'use strict';

import {
  SYNC_KEY_STORAGE,
  buildSnapshotPayload,
  fetchCloudMeta,
  normalizeSyncKey,
  pullSnapshot,
  pushSnapshot,
} from './sync-client.js';
import { mergeSyncData } from './sync-snapshot.js';

// --- Constants ---

const DEFAULT_LIST_ID = 'default';
const DB_VERSION = 4;
const AUTO_PUSH_DELAY_MS = 1200;
const MODE_DESCRIPTIONS = {
  capture: 'Record and save voice notes.',
  accomplish: 'Track tasks with checkboxes and reordering.'
};

// --- DOM References ---

const backBtn = document.getElementById('back-btn');
const helpBtn = document.getElementById('help-btn');
const syncBtn = document.getElementById('sync-btn');
const listsView = document.getElementById('lists-view');
const listsContainer = document.getElementById('lists-container');
const listsEmptyState = document.getElementById('lists-empty-state');
const newListBtn = document.getElementById('new-list-btn');
const listDetailView = document.getElementById('list-detail-view');
const listDetailName = document.getElementById('list-detail-name');
const listDetailMode = document.getElementById('list-detail-mode');
const renameListBtn = document.getElementById('rename-list-btn');
const deleteListBtn = document.getElementById('delete-list-btn');
const listNotesEl = document.getElementById('list-notes');
const listEmptyState = document.getElementById('list-empty-state');
const entryModeToggle = document.getElementById('entry-mode-toggle');
const voiceEntryBtn = document.getElementById('voice-entry-btn');
const textEntryBtn = document.getElementById('text-entry-btn');
const recordBtn = document.getElementById('record-btn');
const recordHint = document.getElementById('record-hint');
const timerEl = document.getElementById('timer');
const recorderEl = document.getElementById('recorder');
const waveformCanvas = document.getElementById('waveform');
const waveformCtx = waveformCanvas ? waveformCanvas.getContext('2d') : null;
const textEntryPanel = document.getElementById('text-entry-panel');
const textNoteInput = document.getElementById('text-note-input');
const textEntryHint = document.getElementById('text-entry-hint');
const textNoteSubmitBtn = document.getElementById('text-note-submit');
const listModal = document.getElementById('list-modal');
const listModalTitle = document.getElementById('list-modal-title');
const listNameInput = document.getElementById('list-name-input');
const modeSelector = document.getElementById('mode-selector');
const modeDescription = document.getElementById('mode-description');
const modalCancelBtn = document.getElementById('modal-cancel-btn');
const modalSaveBtn = document.getElementById('modal-save-btn');
const helpModal = document.getElementById('help-modal');
const helpModalCloseBtn = document.getElementById('help-modal-close');
const syncModal = document.getElementById('sync-modal');
const syncModalCloseBtn = document.getElementById('sync-modal-close');
const themePicker = document.getElementById('theme-picker');
const cloudAuthStatus = document.getElementById('cloud-auth-status');
const cloudUserDetails = document.getElementById('cloud-user-details');
const cloudSyncKeyInput = document.getElementById('cloud-sync-key');
const cloudConnectKeyBtn = document.getElementById('cloud-connect-key');
const cloudClearKeyBtn = document.getElementById('cloud-clear-key');
const cloudSnapshotUpdated = document.getElementById('cloud-snapshot-updated');
const cloudSnapshotVersion = document.getElementById('cloud-snapshot-version');
const syncLastCloudPull = document.getElementById('sync-last-cloud-pull');
const syncLastCloudPush = document.getElementById('sync-last-cloud-push');
const cloudPullBtn = document.getElementById('cloud-pull');
const cloudPushBtn = document.getElementById('cloud-push');
const cloudSyncMessage = document.getElementById('cloud-sync-message');

// --- State ---

let mediaRecorder = null;
let audioChunks = [];
let recordingStartTime = null;
let timerInterval = null;
let audioContext = null;
let analyser = null;
let waveformFrameId = null;
let currentAudio = null;
let currentPlayBtn = null;
let currentProgressFill = null;
let isRecording = false;
let recordBusy = false;
let speechRecognition = null;
let transcriptionResult = '';
let currentListId = null;
let editingNoteId = null;
let editingListId = null;
let selectedMode = 'capture';
let dragState = null;
let currentEntryMode = 'voice';
let syncKey = '';
let cloudMeta = null;
let syncBusy = false;
let autoPushTimer = null;
let autoPushQueued = false;
let textEntryBusy = false;

const SYNC_META_KEYS = {
  lastCloudPullAt: 'voice-notes-last-cloud-pull-at',
  lastCloudPushAt: 'voice-notes-last-cloud-push-at',
};

// --- IndexedDB ---

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open('voiceNotesDB', DB_VERSION);

    request.onupgradeneeded = (e) => {
      const db = e.target.result;
      const oldVersion = e.oldVersion;

      if (!db.objectStoreNames.contains('notes')) {
        db.createObjectStore('notes', { keyPath: 'id' });
      }

      if (!db.objectStoreNames.contains('lists')) {
        db.createObjectStore('lists', { keyPath: 'id' });
      }

      const noteStore = e.target.transaction.objectStore('notes');

      // Add listId index to notes if upgrading from v1
      if (oldVersion < 2) {
        if (!noteStore.indexNames.contains('listId')) {
          noteStore.createIndex('listId', 'listId', { unique: false });
        }

        // Create default list
        const listStore = e.target.transaction.objectStore('lists');
        listStore.put({
          id: DEFAULT_LIST_ID,
          name: 'My Notes',
          mode: 'capture',
          createdAt: new Date().toISOString(),
          noteOrder: []
        });
      }

      if (oldVersion < 4) {
        const cursorRequest = noteStore.openCursor();
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (!cursor) return;
          const note = cursor.value;
          let changed = false;
          if ('categories' in note) {
            delete note.categories;
            changed = true;
          }
          if ('sentiment' in note) {
            delete note.sentiment;
            changed = true;
          }
          if (changed) {
            cursor.update(note);
          }
          cursor.continue();
        };
      }
    };

    request.onsuccess = (e) => {
      const db = e.target.result;
      // Migrate existing notes to default list
      migrateNotesToDefaultList(db).then(() => resolve(db)).catch(() => resolve(db));
    };
    request.onerror = (e) => {
      dbPromise = null;
      reject(e.target.error);
    };
  });

  return dbPromise;
}

function migrateNotesToDefaultList(db) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('notes', 'readwrite');
    const store = tx.objectStore('notes');
    const request = store.getAll();

    request.onsuccess = () => {
      const notes = request.result;
      let migrated = 0;
      for (const note of notes) {
        if (!note.listId) {
          note.listId = DEFAULT_LIST_ID;
          if (note.completed === undefined) note.completed = false;
          store.put(note);
          migrated++;
        }
      }
      tx.oncomplete = () => resolve(migrated);
      tx.onerror = () => reject(tx.error);
    };
    request.onerror = () => reject(request.error);
  });
}

function saveNote(note) {
  return openDB().then((db) => {
    return new Promise((resolve, reject) => {
      const tx = db.transaction('notes', 'readwrite');
      const nextNote = { ...note };
      delete nextNote.categories;
      delete nextNote.sentiment;
      tx.objectStore('notes').put(nextNote);
      tx.oncomplete = () => {
        scheduleAutoPush();
        resolve();
      };
      tx.onerror = (e) => reject(e.target.error);
    });
  });
}

function getAllNotes() {
  return openDB().then((db) => {
    return new Promise((resolve, reject) => {
      const tx = db.transaction('notes', 'readonly');
      const request = tx.objectStore('notes').getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = (e) => reject(e.target.error);
    });
  });
}

function getNotesByList(listId) {
  return openDB().then((db) => {
    return new Promise((resolve, reject) => {
      const tx = db.transaction('notes', 'readonly');
      const store = tx.objectStore('notes');
      if (store.indexNames.contains('listId')) {
        const index = store.index('listId');
        const request = index.getAll(listId);
        request.onsuccess = () => resolve(request.result);
        request.onerror = (e) => reject(e.target.error);
      } else {
        const request = store.getAll();
        request.onsuccess = () => resolve(request.result.filter((n) => n.listId === listId));
        request.onerror = (e) => reject(e.target.error);
      }
    });
  });
}

function getNote(id) {
  return openDB().then((db) => {
    return new Promise((resolve, reject) => {
      const tx = db.transaction('notes', 'readonly');
      const request = tx.objectStore('notes').get(id);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = (e) => reject(e.target.error);
    });
  });
}

function deleteNote(id) {
  return openDB().then((db) => {
    return new Promise((resolve, reject) => {
      const tx = db.transaction('notes', 'readwrite');
      tx.objectStore('notes').delete(id);
      tx.oncomplete = () => {
        scheduleAutoPush();
        resolve();
      };
      tx.onerror = (e) => reject(e.target.error);
    });
  });
}

function deleteNotesByList(listId) {
  return getNotesByList(listId).then((notes) => {
    return openDB().then((db) => {
      return new Promise((resolve, reject) => {
        const tx = db.transaction('notes', 'readwrite');
        const store = tx.objectStore('notes');
        for (const note of notes) {
          store.delete(note.id);
        }
        tx.oncomplete = () => resolve();
        tx.onerror = (e) => reject(e.target.error);
      });
    });
  });
}

function saveList(list) {
  return openDB().then((db) => {
    return new Promise((resolve, reject) => {
      const tx = db.transaction('lists', 'readwrite');
      tx.objectStore('lists').put(list);
      tx.oncomplete = () => {
        scheduleAutoPush();
        resolve();
      };
      tx.onerror = (e) => reject(e.target.error);
    });
  });
}

function getAllLists() {
  return openDB().then((db) => {
    return new Promise((resolve, reject) => {
      const tx = db.transaction('lists', 'readonly');
      const request = tx.objectStore('lists').getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = (e) => reject(e.target.error);
    });
  });
}

function getList(id) {
  return openDB().then((db) => {
    return new Promise((resolve, reject) => {
      const tx = db.transaction('lists', 'readonly');
      const request = tx.objectStore('lists').get(id);
      request.onsuccess = () => resolve(request.result);
      request.onerror = (e) => reject(e.target.error);
    });
  });
}

function deleteList(id) {
  return deleteNotesByList(id).then(() => {
    return openDB().then((db) => {
      return new Promise((resolve, reject) => {
        const tx = db.transaction('lists', 'readwrite');
        tx.objectStore('lists').delete(id);
        tx.oncomplete = () => {
          scheduleAutoPush();
          resolve();
        };
        tx.onerror = (e) => reject(e.target.error);
      });
    });
  });
}

function exportAllData() {
  return Promise.all([getAllLists(), getAllNotes()]).then(([lists, notes]) => ({
    lists,
    notes,
  }));
}

function mergeAllData(snapshot) {
  return exportAllData().then((localData) => {
    const merged = mergeSyncData(localData, snapshot);

    return openDB().then((db) => {
      return new Promise((resolve, reject) => {
        const tx = db.transaction(['lists', 'notes'], 'readwrite');
        const listsStore = tx.objectStore('lists');
        const notesStore = tx.objectStore('notes');

        for (const list of merged.lists) {
          listsStore.put(list);
        }
        for (const note of merged.notes) {
          notesStore.put(note);
        }

        tx.oncomplete = () => resolve(merged);
        tx.onerror = () => reject(tx.error);
      });
    });
  });
}

// --- Cloud Sync ---

function formatDateTimeLabel(isoString) {
  if (!isoString) return 'Never';

  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return 'Never';

  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function getSyncMetaIso(key) {
  return localStorage.getItem(key) || '';
}

function setSyncMetaIso(key, value) {
  if (!value) {
    localStorage.removeItem(key);
    return;
  }
  localStorage.setItem(key, value);
}

function renderCloudMeta(meta) {
  if (cloudSnapshotUpdated) {
    cloudSnapshotUpdated.textContent = meta && meta.updatedAt
      ? formatDateTimeLabel(meta.updatedAt)
      : 'Never';
  }

  if (cloudSnapshotVersion) {
    cloudSnapshotVersion.textContent = meta && Number.isInteger(meta.version)
      ? String(meta.version)
      : 'None';
  }
}

function refreshLocalCloudLabels() {
  if (syncLastCloudPull) {
    syncLastCloudPull.textContent = formatDateTimeLabel(getSyncMetaIso(SYNC_META_KEYS.lastCloudPullAt));
  }
  if (syncLastCloudPush) {
    syncLastCloudPush.textContent = formatDateTimeLabel(getSyncMetaIso(SYNC_META_KEYS.lastCloudPushAt));
  }
}

function setCloudMessage(message, isError = false) {
  if (!cloudSyncMessage) return;
  cloudSyncMessage.textContent = message || '';
  cloudSyncMessage.classList.toggle('error', isError);
}

function clearAutoPushQueue() {
  autoPushQueued = false;
  if (autoPushTimer) {
    clearTimeout(autoPushTimer);
    autoPushTimer = null;
  }
}

function scheduleAutoPush() {
  if (!syncKey) return;

  autoPushQueued = true;
  if (autoPushTimer) {
    clearTimeout(autoPushTimer);
  }

  autoPushTimer = setTimeout(() => {
    autoPushTimer = null;
    flushAutoPush().catch(() => {});
  }, AUTO_PUSH_DELAY_MS);
}

async function flushAutoPush() {
  if (!autoPushQueued || !syncKey) return;

  if (syncBusy) {
    scheduleAutoPush();
    return;
  }

  autoPushQueued = false;
  await pushToCloud({ isAuto: true });
}

function updateCloudSyncUi() {
  const connected = Boolean(syncKey);

  if (cloudAuthStatus) {
    cloudAuthStatus.textContent = connected ? 'Connected' : 'Not connected';
  }

  if (syncBtn) {
    syncBtn.dataset.connected = connected ? 'true' : 'false';
    syncBtn.dataset.busy = syncBusy ? 'true' : 'false';
    syncBtn.setAttribute('aria-busy', syncBusy ? 'true' : 'false');
  }

  if (cloudUserDetails) {
    cloudUserDetails.textContent = connected
      ? `Shared key loaded (${syncKey.length} characters).`
      : 'Enter the same shared key on each device to sync lists and note text. Recordings stay local for now.';
  }

  if (cloudSyncKeyInput) {
    if (connected && cloudSyncKeyInput.value !== syncKey) {
      cloudSyncKeyInput.value = syncKey;
    }
    if (!connected && !syncBusy && document.activeElement !== cloudSyncKeyInput) {
      cloudSyncKeyInput.value = '';
    }
  }

  if (cloudConnectKeyBtn) cloudConnectKeyBtn.disabled = syncBusy;
  if (cloudClearKeyBtn) cloudClearKeyBtn.disabled = syncBusy || !connected;
  if (cloudPullBtn) cloudPullBtn.disabled = syncBusy || !connected;
  if (cloudPushBtn) cloudPushBtn.disabled = syncBusy || !connected;

  renderCloudMeta(cloudMeta);
  refreshLocalCloudLabels();
}

async function refreshCloudSync() {
  if (!syncKey) {
    cloudMeta = null;
    updateCloudSyncUi();
    return;
  }

  const result = await fetchCloudMeta(syncKey);
  cloudMeta = result.meta || null;
  updateCloudSyncUi();
  setCloudMessage('');
}

async function connectCloudSync() {
  const nextKey = normalizeSyncKey(cloudSyncKeyInput ? cloudSyncKeyInput.value : '');
  if (!nextKey) {
    setCloudMessage('Sync key must be 8-256 characters.', true);
    return;
  }

  syncBusy = true;
  updateCloudSyncUi();
  setCloudMessage('Connecting...');

  try {
    syncKey = nextKey;
    localStorage.setItem(SYNC_KEY_STORAGE, syncKey);
    await refreshCloudSync();
    setCloudMessage('Sync key connected.');
  } catch (error) {
    syncKey = '';
    cloudMeta = null;
    localStorage.removeItem(SYNC_KEY_STORAGE);
    setCloudMessage(error.message || 'Failed to connect sync key.', true);
  } finally {
    syncBusy = false;
    updateCloudSyncUi();
  }
}

function clearCloudSync() {
  clearAutoPushQueue();
  syncKey = '';
  cloudMeta = null;
  localStorage.removeItem(SYNC_KEY_STORAGE);
  setCloudMessage('Sync key cleared.');
  updateCloudSyncUi();
}

async function pushToCloud(options = {}) {
  const { isAuto = false } = options;

  if (!syncKey) {
    if (!isAuto) {
      setCloudMessage('Enter a sync key before pushing.', true);
    }
    return false;
  }

  if (!isAuto) {
    clearAutoPushQueue();
  }

  if (syncBusy) {
    if (isAuto) {
      scheduleAutoPush();
    }
    return false;
  }

  syncBusy = true;
  updateCloudSyncUi();

  try {
    setCloudMessage(isAuto ? 'Auto-syncing latest changes...' : 'Preparing snapshot...');
    const exportData = await exportAllData();
    const payload = await buildSnapshotPayload(exportData);
    const result = await pushSnapshot(payload.snapshot, syncKey, (message) => setCloudMessage(message));

    cloudMeta = result.meta || null;
    setSyncMetaIso(SYNC_META_KEYS.lastCloudPushAt, new Date().toISOString());
    updateCloudSyncUi();
    setCloudMessage(
      isAuto
        ? `Auto-sync complete. ${payload.snapshot.notes.length} notes are up to date.`
        : `Push complete. Synced ${payload.snapshot.lists.length} lists and ${payload.snapshot.notes.length} notes.`
    );
    return true;
  } catch (error) {
    setCloudMessage(error.message || (isAuto ? 'Auto-sync failed.' : 'Push failed.'), true);
    return false;
  } finally {
    syncBusy = false;
    updateCloudSyncUi();
    if (autoPushQueued && !autoPushTimer) {
      scheduleAutoPush();
    }
  }
}

async function pullFromCloud() {
  if (!syncKey) {
    setCloudMessage('Enter a sync key before pulling.', true);
    return;
  }

  syncBusy = true;
  clearAutoPushQueue();
  updateCloudSyncUi();

  try {
    setCloudMessage('Merging cloud snapshot...');
    const pulled = await pullSnapshot(syncKey);
    if (!pulled.hasSnapshot || !pulled.snapshot) {
      setCloudMessage('No cloud snapshot found for this sync key.');
      return;
    }

    stopCurrentPlayback();
    const merged = await mergeAllData(pulled.snapshot);

    cloudMeta = pulled.meta || null;
    setSyncMetaIso(SYNC_META_KEYS.lastCloudPullAt, new Date().toISOString());
    updateCloudSyncUi();
    setCloudMessage(
      `Pull complete. Added ${merged.stats.addedLists} lists and ${merged.stats.addedNotes} notes from cloud.`
    );
    if (currentListId) {
      const currentList = await getList(currentListId);
      if (currentList) {
        await renderListDetail(currentListId);
      } else {
        showListsView();
      }
    } else {
      await renderLists();
    }
  } catch (error) {
    setCloudMessage(error.message || 'Pull failed.', true);
  } finally {
    syncBusy = false;
    updateCloudSyncUi();
  }
}

async function pullFromCloudOnLoad() {
  if (!syncKey || syncBusy) return;

  syncBusy = true;
  updateCloudSyncUi();

  try {
    const pulled = await pullSnapshot(syncKey);
    cloudMeta = pulled.meta || null;

    if (!pulled.hasSnapshot || !pulled.snapshot) {
      setCloudMessage('');
      return;
    }

    await mergeAllData(pulled.snapshot);
    setSyncMetaIso(SYNC_META_KEYS.lastCloudPullAt, new Date().toISOString());

    if (currentListId) {
      const currentList = await getList(currentListId);
      if (currentList) {
        await renderListDetail(currentListId);
      } else {
        showListsView();
      }
    } else {
      await renderLists();
    }

    setCloudMessage('');
  } finally {
    syncBusy = false;
    updateCloudSyncUi();
  }
}

// --- Timer Display ---

function formatDuration(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return mins + ':' + String(secs).padStart(2, '0');
}

function startTimer() {
  timerEl.classList.add('active');
  timerInterval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - recordingStartTime) / 1000);
    timerEl.textContent = formatDuration(elapsed);
  }, 1000);
}

function stopTimer() {
  clearInterval(timerInterval);
  timerInterval = null;
  timerEl.classList.remove('active');
  timerEl.textContent = '0:00';
}

// --- Waveform Visualization ---

async function startWaveform(stream) {
  if (!waveformCtx) return;

  if (!audioContext || audioContext.state === 'closed') {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
  }

  if (audioContext.state === 'suspended') {
    try {
      await audioContext.resume();
    } catch (error) {
      console.warn('Unable to resume audio context for waveform rendering.', error);
    }
  }
  analyser = audioContext.createAnalyser();
  analyser.fftSize = 2048;

  const source = audioContext.createMediaStreamSource(stream);
  source.connect(analyser);

  const bufferLength = analyser.fftSize;
  const dataArray = new Uint8Array(bufferLength);
  const ctx = waveformCtx;
  const dpr = window.devicePixelRatio || 1;
  const W = 280;
  const H = 64;

  waveformCanvas.width = W * dpr;
  waveformCanvas.height = H * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const computedStyle = getComputedStyle(document.documentElement);
  const accentColor = computedStyle.getPropertyValue('--accent').trim() || '#6d5cff';
  const waveformFillColor = computedStyle.getPropertyValue('--waveform-fill').trim() || 'rgba(26, 26, 46, 0.3)';

  function draw() {
    waveformFrameId = requestAnimationFrame(draw);
    analyser.getByteTimeDomainData(dataArray);

    ctx.fillStyle = waveformFillColor;
    ctx.fillRect(0, 0, W, H);

    ctx.lineWidth = 2;
    ctx.strokeStyle = accentColor;
    ctx.shadowColor = accentColor;
    ctx.shadowBlur = 6;
    ctx.beginPath();

    const sliceWidth = W / bufferLength;
    let x = 0;

    for (let i = 0; i < bufferLength; i++) {
      const v = dataArray[i] / 128.0;
      const y = (v * H) / 2;

      if (i === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
      x += sliceWidth;
    }

    ctx.lineTo(W, H / 2);
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  draw();
}

function stopWaveform() {
  if (waveformFrameId) {
    cancelAnimationFrame(waveformFrameId);
    waveformFrameId = null;
  }
  analyser = null;
  if (waveformCtx) {
    waveformCtx.clearRect(0, 0, waveformCanvas.width, waveformCanvas.height);
  }
}

// --- Speech Transcription ---

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

function formatTranscriptionSegment(text) {
  if (!text) return text;
  text = text.charAt(0).toUpperCase() + text.slice(1);
  if (!/[.!?]$/.test(text)) {
    text += '.';
  }
  return text;
}

function startTranscription() {
  if (!SpeechRecognition) return;

  transcriptionResult = '';

  function createRecognition() {
    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.lang = navigator.language || 'en-US';

    recognition.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) {
          const text = e.results[i][0].transcript.trim();
          if (text) {
            transcriptionResult += (transcriptionResult ? ' ' : '') + text;
          }
        }
      }
    };

    recognition.onerror = () => {
      if (isRecording && speechRecognition === recognition) {
        try { recognition.stop(); } catch (e) {}
      }
    };

    recognition.onend = () => {
      if (isRecording && speechRecognition === recognition) {
        const restarted = createRecognition();
        restarted.start();
        speechRecognition = restarted;
      }
    };

    return recognition;
  }

  const recognition = createRecognition();
  recognition.start();
  speechRecognition = recognition;
}

function stopTranscription() {
  if (!speechRecognition) {
    const result = transcriptionResult;
    transcriptionResult = '';
    return Promise.resolve(result);
  }

  return new Promise((resolve) => {
    function done() {
      const result = transcriptionResult;
      transcriptionResult = '';
      resolve(result);
    }

    const recognition = speechRecognition;
    speechRecognition = null;

    recognition.onend = done;
    recognition.onerror = done;

    setTimeout(() => {
      try {
        recognition.stop();
      } catch (e) {
        done();
      }
    }, 1500);
  });
}

// --- Transcription Cleaning ---

function cleanFillersFromTranscription(text) {
  if (!text) return text;
  return text.replace(/\b[Uu]mm?\b/g, '').replace(/\s{2,}/g, ' ').trim();
}

function capitalizeFirstLetter(text) {
  if (!text) return text;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// --- Transcription Splitting ---

function splitTranscriptionOnAnd(text) {
  if (!text) return [text];
  const parts = text
    .split(/\s+and\s+/i)
    .map((s) => capitalizeFirstLetter(s.trim()))
    .filter(Boolean);
  return parts.length > 0 ? parts : [text];
}

function buildNoteRecord(listId, transcription, options = {}) {
  return {
    id: crypto.randomUUID(),
    audioBlob: Object.prototype.hasOwnProperty.call(options, 'audioBlob') ? options.audioBlob : null,
    duration: Number.isFinite(options.duration) ? options.duration : 0,
    transcription,
    createdAt: options.createdAt || new Date().toISOString(),
    listId,
    completed: Boolean(options.completed),
  };
}

// --- Audio Recording ---

async function startRecording() {
  if (typeof MediaRecorder === 'undefined') {
    throw new Error('Recording not supported');
  }

  audioChunks = [];
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

  try {
    let mimeType = '';
    const candidates = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/mp4'
    ];
    for (const candidate of candidates) {
      if (MediaRecorder.isTypeSupported(candidate)) {
        mimeType = candidate;
        break;
      }
    }

    const options = mimeType ? { mimeType } : undefined;
    mediaRecorder = new MediaRecorder(stream, options);
  } catch (err) {
    stream.getTracks().forEach((t) => t.stop());
    throw err;
  }

  mediaRecorder.ondataavailable = (e) => {
    if (e.data.size > 0) {
      audioChunks.push(e.data);
    }
  };

  mediaRecorder.onerror = () => {
    isRecording = false;
    recordBtn.classList.remove('recording');
    recorderEl.classList.remove('recording');
    recordHint.textContent = 'Recording error — try again';
    mediaRecorder = null;
    stopTimer();
    stopWaveform();
    stopTranscription();
  };

  mediaRecorder.start(100);
  recordingStartTime = Date.now();
  startTimer();
  await startWaveform(stream);
  startTranscription();
}

async function stopRecording() {
  if (!mediaRecorder || mediaRecorder.state === 'inactive') {
    stopTimer();
    stopWaveform();
    mediaRecorder = null;
    return null;
  }

  const recorder = mediaRecorder;

  const blobPromise = new Promise((resolve) => {
    recorder.onstop = () => {
      resolve(new Blob(audioChunks, { type: recorder.mimeType }));
    };
  });

  recorder.stop();

  const [transcription, blob] = await Promise.all([
    stopTranscription(),
    blobPromise
  ]);

  const duration = Math.round((Date.now() - recordingStartTime) / 1000);
  recorder.stream.getTracks().forEach((t) => t.stop());
  audioChunks = [];
  mediaRecorder = null;
  stopTimer();
  stopWaveform();

  return { blob, duration, transcription };
}

// --- Playback Cleanup ---

function stopCurrentPlayback() {
  if (!currentAudio) return;
  currentAudio.pause();
  if (currentAudio._objectURL) {
    URL.revokeObjectURL(currentAudio._objectURL);
  }
  if (currentPlayBtn) {
    currentPlayBtn.textContent = '\u25B6';
  }
  if (currentProgressFill) {
    currentProgressFill.style.width = '0%';
  }
  currentAudio = null;
  currentPlayBtn = null;
  currentProgressFill = null;
}

// --- UI Rendering ---

function formatDate(isoString) {
  return new Date(isoString).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  });
}

function focusTextEntryInput() {
  if (!textNoteInput) return;
  requestAnimationFrame(() => {
    textNoteInput.focus();
    const length = textNoteInput.value.length;
    textNoteInput.setSelectionRange(length, length);
  });
}

function focusNoteEditInput(noteId) {
  requestAnimationFrame(() => {
    const input = listNotesEl.querySelector(`[data-note-edit-input="${noteId}"]`);
    if (!input) return;
    input.focus();
    const length = input.value.length;
    input.setSelectionRange(length, length);
  });
}

function normalizeManualNoteText(text) {
  return String(text || '').replace(/\r\n?/g, '\n').trim();
}

function shouldSubmitTextEntryOnEnter() {
  return !window.matchMedia('(pointer: coarse)').matches;
}

async function setEditingNote(noteId) {
  editingNoteId = noteId;
  await renderListDetail(currentListId);
  focusNoteEditInput(noteId);
}

async function cancelEditingNote() {
  if (!editingNoteId) return;
  editingNoteId = null;
  await renderListDetail(currentListId);
}

async function saveEditedNote(noteId, nextText) {
  const note = await getNote(noteId);
  if (!note) return;
  note.transcription = normalizeManualNoteText(nextText);
  delete note.categories;
  delete note.sentiment;
  await saveNote(note);
  editingNoteId = null;
  await renderListDetail(currentListId);
}

function updateEntryModeUi() {
  const hasList = Boolean(currentListId);
  const isTextMode = currentEntryMode === 'text';

  if (entryModeToggle) {
    entryModeToggle.classList.toggle('hidden', !hasList);
  }

  if (voiceEntryBtn) {
    voiceEntryBtn.classList.toggle('active', hasList && !isTextMode);
    voiceEntryBtn.setAttribute('aria-pressed', String(hasList && !isTextMode));
  }

  if (textEntryBtn) {
    textEntryBtn.classList.toggle('active', hasList && isTextMode);
    textEntryBtn.setAttribute('aria-pressed', String(hasList && isTextMode));
  }

  if (recorderEl) {
    recorderEl.classList.toggle('hidden', !hasList || isTextMode);
  }

  if (textEntryPanel) {
    textEntryPanel.classList.toggle('hidden', !hasList || !isTextMode);
  }

  if (!hasList) return;

  const isAccomplish = listDetailMode && listDetailMode.dataset.mode === 'accomplish';

  if (textNoteInput) {
    textNoteInput.placeholder = isAccomplish ? 'Type a task' : 'Type a note';
  }

  if (textEntryHint) {
    textEntryHint.textContent = shouldSubmitTextEntryOnEnter()
      ? (isAccomplish
        ? 'Press Enter to add the task and keep moving. Use Shift+Enter for a line break.'
        : 'Press Enter to add another note. Use Shift+Enter for a new line.')
      : 'Use the button to add another note. Return inserts a new line on touch keyboards.';
  }

  if (textNoteSubmitBtn) {
    textNoteSubmitBtn.textContent = isAccomplish ? 'Add Task' : 'Add Note';
    textNoteSubmitBtn.disabled = textEntryBusy;
  }

  if (isTextMode) {
    focusTextEntryInput();
  }
}

function setEntryMode(mode) {
  if (isRecording) return;
  currentEntryMode = mode === 'text' ? 'text' : 'voice';
  updateEntryModeUi();
}

async function createTextNote() {
  if (textEntryBusy || !currentListId || !textNoteInput) return false;

  const listIdAtCreate = currentListId;
  const transcription = normalizeManualNoteText(textNoteInput.value);
  if (!transcription) {
    focusTextEntryInput();
    return false;
  }

  textEntryBusy = true;

  try {
    const list = await getList(listIdAtCreate);
    if (!list) return false;

    if (!list.noteOrder) {
      list.noteOrder = [];
    }

    const note = buildNoteRecord(listIdAtCreate, transcription);

    await saveNote(note);
    list.noteOrder.unshift(note.id);
    await saveList(list);

    textNoteInput.value = '';
    editingNoteId = null;
    await renderListDetail(listIdAtCreate);
    if (currentListId === listIdAtCreate && currentEntryMode === 'text') {
      focusTextEntryInput();
    }
    return true;
  } finally {
    textEntryBusy = false;
  }
}

function createNoteCard(note, list) {
  const card = document.createElement('div');
  card.className = 'note-card';
  card.dataset.noteId = note.id;
  const isAccomplish = list && list.mode === 'accomplish';
  const isEditing = editingNoteId === note.id;
  if (isEditing) {
    card.classList.add('editing');
  }

  if (isAccomplish && note.completed && !isEditing) {
    card.classList.add('completed');
  }

  // Accomplish mode: drag handle + checkbox (direct children for flex row)
  if (isAccomplish) {
    const dragHandle = document.createElement('span');
    dragHandle.className = 'drag-handle';
    dragHandle.textContent = '\u2261';
    dragHandle.setAttribute('aria-label', 'Drag to reorder');
    card.appendChild(dragHandle);

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'note-checkbox';
    checkbox.checked = !!note.completed;
    checkbox.setAttribute('aria-label', 'Mark as completed');
    checkbox.addEventListener('change', async () => {
      note.completed = checkbox.checked;
      await saveNote(note);
      await renderListDetail(currentListId);
    });
    card.appendChild(checkbox);

    // Touch drag-to-reorder on handle
    if (!isEditing) {
      dragHandle.addEventListener('touchstart', (e) => {
        e.preventDefault();
        startDrag(card, e.touches[0]);
      }, { passive: false });
    }
  }

  const content = document.createElement('div');
  content.className = 'note-content';

  if (isEditing) {
    const editInput = document.createElement('textarea');
    editInput.className = 'note-editor';
    editInput.rows = Math.max(3, String(note.transcription || '').split('\n').length);
    editInput.value = note.transcription || '';
    editInput.dataset.noteEditInput = note.id;
    editInput.setAttribute('aria-label', 'Edit note text');
    editInput.addEventListener('keydown', async (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        await saveEditedNote(note.id, editInput.value);
        return;
      }

      if (e.key === 'Escape') {
        e.preventDefault();
        await cancelEditingNote();
      }
    });
    content.appendChild(editInput);

    const editActions = document.createElement('div');
    editActions.className = 'note-edit-actions';

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'note-edit-secondary-btn';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => {
      cancelEditingNote();
    });
    editActions.appendChild(cancelBtn);

    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'note-action-btn';
    saveBtn.textContent = 'Save';
    saveBtn.addEventListener('click', () => {
      saveEditedNote(note.id, editInput.value);
    });
    editActions.appendChild(saveBtn);

    content.appendChild(editActions);
  } else {
    const transcriptionEl = document.createElement('p');
    transcriptionEl.className = 'note-transcription';
    if (note.transcription) {
      transcriptionEl.textContent = note.transcription;
    } else {
      transcriptionEl.textContent = 'No transcription available';
      transcriptionEl.classList.add('note-transcription-empty');
    }
    content.appendChild(transcriptionEl);
  }

  const hasAudio = !!note.audioBlob;
  if (hasAudio) {
    const meta = document.createElement('div');
    meta.className = 'note-meta';
    const metaParts = [];
    if (note.duration > 0) {
      metaParts.unshift(formatDuration(note.duration));
    }
    metaParts.push(formatDate(note.createdAt));
    meta.textContent = metaParts.join(' \u00B7 ');
    content.appendChild(meta);
  }

  let progressFill = null;
  if (hasAudio) {
    const progress = document.createElement('div');
    progress.className = 'note-progress';
    progressFill = document.createElement('div');
    progressFill.className = 'note-progress-fill';
    progress.appendChild(progressFill);
    content.appendChild(progress);
  }

  card.appendChild(content);

  // Action icons (right side)
  const actions = document.createElement('div');
  actions.className = 'note-actions';

  let playBtn = null;
  if (hasAudio) {
    playBtn = document.createElement('button');
    playBtn.type = 'button';
    playBtn.className = 'note-action-btn play-btn';
    playBtn.textContent = '\u25B6';
    playBtn.setAttribute('aria-label', 'Play');
    actions.appendChild(playBtn);
  }

  if (!isEditing) {
    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'note-action-btn edit-btn';
    editBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>';
    editBtn.setAttribute('aria-label', 'Edit note text');
    editBtn.addEventListener('click', () => {
      setEditingNote(note.id);
    });
    actions.appendChild(editBtn);
  }

  const deleteBtn = document.createElement('button');
  deleteBtn.type = 'button';
  deleteBtn.className = 'note-action-btn delete-btn';
  deleteBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>';
  deleteBtn.setAttribute('aria-label', 'Delete');

  actions.appendChild(deleteBtn);
  card.appendChild(actions);

  // Play button handler
  if (playBtn) playBtn.addEventListener('click', () => {
    if (currentAudio && currentPlayBtn === playBtn) {
      if (!currentAudio.paused) {
        currentAudio.pause();
        playBtn.textContent = '\u25B6';
      } else {
        currentAudio.play().catch(() => {
          stopCurrentPlayback();
        });
        playBtn.textContent = '\u23F8';
      }
      return;
    }

    stopCurrentPlayback();

    const url = URL.createObjectURL(note.audioBlob);
    const audio = new Audio(url);
    audio._objectURL = url;

    currentAudio = audio;
    currentPlayBtn = playBtn;
    currentProgressFill = progressFill;

    audio.play().then(() => {
      playBtn.textContent = '\u23F8';
    }).catch(() => {
      URL.revokeObjectURL(url);
      currentAudio = null;
      currentPlayBtn = null;
      currentProgressFill = null;
      playBtn.textContent = '\u25B6';
    });

    audio.ontimeupdate = () => {
      if (audio.duration && isFinite(audio.duration) && audio.duration > 0) {
        progressFill.style.width = (audio.currentTime / audio.duration) * 100 + '%';
      }
    };

    audio.onended = () => {
      URL.revokeObjectURL(audio._objectURL);
      playBtn.textContent = '\u25B6';
      progressFill.style.width = '0%';
      if (currentAudio === audio) {
        currentAudio = null;
        currentPlayBtn = null;
        currentProgressFill = null;
      }
    };
  });

  // Delete button handler
  deleteBtn.addEventListener('click', async () => {
    if (!confirm('Delete this note?')) return;

    if (playBtn && currentPlayBtn === playBtn) {
      stopCurrentPlayback();
    }

    try {
      await deleteNote(note.id);
      if (editingNoteId === note.id) {
        editingNoteId = null;
      }
      // Remove from list noteOrder if present
      if (currentListId) {
        const listData = await getList(currentListId);
        if (listData && listData.noteOrder) {
          listData.noteOrder = listData.noteOrder.filter((nid) => nid !== note.id);
          await saveList(listData);
        }
      }
      await renderListDetail(currentListId);
    } catch (err) {
      console.error('Failed to delete note:', err);
    }
  });

  return card;
}

function createListCard(list, noteCount) {
  const card = document.createElement('div');
  card.className = 'list-card';
  card.dataset.listId = list.id;

  const info = document.createElement('div');
  info.className = 'list-card-info';

  const name = document.createElement('h3');
  name.className = 'list-card-name';
  name.textContent = list.name;

  const meta = document.createElement('div');
  meta.className = 'list-card-meta';

  const modeBadge = document.createElement('span');
  modeBadge.className = 'list-mode-badge';
  modeBadge.textContent = list.mode === 'accomplish' ? 'Accomplish' : 'Capture';
  modeBadge.dataset.mode = list.mode;

  const count = document.createElement('span');
  count.className = 'list-card-count';
  count.textContent = noteCount + (noteCount === 1 ? ' note' : ' notes');

  meta.appendChild(modeBadge);
  meta.appendChild(count);

  info.appendChild(name);
  info.appendChild(meta);

  const arrow = document.createElement('span');
  arrow.className = 'list-card-arrow';
  arrow.textContent = '\u203A';

  card.appendChild(info);
  card.appendChild(arrow);

  card.addEventListener('click', () => {
    showListDetailView(list.id);
  });

  return card;
}

async function renderLists() {
  const lists = await getAllLists();
  const allNotes = await getAllNotes();

  // Count notes per list
  const countMap = {};
  for (const note of allNotes) {
    const lid = note.listId || DEFAULT_LIST_ID;
    countMap[lid] = (countMap[lid] || 0) + 1;
  }

  lists.sort((a, b) => {
    // Default list always first
    if (a.id === DEFAULT_LIST_ID) return -1;
    if (b.id === DEFAULT_LIST_ID) return 1;
    return (a.createdAt > b.createdAt ? 1 : a.createdAt < b.createdAt ? -1 : 0);
  });

  while (listsContainer.firstChild) {
    listsContainer.removeChild(listsContainer.firstChild);
  }

  for (const list of lists) {
    listsContainer.appendChild(createListCard(list, countMap[list.id] || 0));
  }

  if (lists.length === 0) {
    listsEmptyState.classList.remove('hidden');
  } else {
    listsEmptyState.classList.add('hidden');
  }
}

async function renderListDetail(listId) {
  stopCurrentPlayback();

  const list = await getList(listId);
  if (!list) return;

  listDetailName.textContent = list.name;
  listDetailMode.textContent = list.mode === 'accomplish' ? 'Accomplish' : 'Capture';
  listDetailMode.dataset.mode = list.mode;

  const notes = await getNotesByList(listId);

  // Order notes: use noteOrder if available, else by createdAt desc
  if (list.noteOrder && list.noteOrder.length > 0) {
    const noteMap = {};
    for (const n of notes) noteMap[n.id] = n;
    const ordered = [];
    for (const nid of list.noteOrder) {
      if (noteMap[nid]) {
        ordered.push(noteMap[nid]);
        delete noteMap[nid];
      }
    }
    // Append any notes not in noteOrder (newly added)
    const remaining = Object.values(noteMap);
    remaining.sort((a, b) => (b.createdAt > a.createdAt ? 1 : b.createdAt < a.createdAt ? -1 : 0));
    ordered.push(...remaining);
    notes.length = 0;
    notes.push(...ordered);
  } else {
    notes.sort((a, b) => (b.createdAt > a.createdAt ? 1 : b.createdAt < a.createdAt ? -1 : 0));
  }

  // Move completed items to the bottom (stable: preserves relative order)
  if (list.mode === 'accomplish') {
    const incomplete = notes.filter((n) => !n.completed);
    const completed = notes.filter((n) => n.completed);
    notes.length = 0;
    notes.push(...incomplete, ...completed);
  }

  while (listNotesEl.firstChild) {
    listNotesEl.removeChild(listNotesEl.firstChild);
  }

  for (const note of notes) {
    listNotesEl.appendChild(createNoteCard(note, list));
  }

  if (notes.length === 0) {
    listEmptyState.classList.remove('hidden');
  } else {
    listEmptyState.classList.add('hidden');
  }

  updateEntryModeUi();
}

// --- Drag-to-Reorder (Accomplish Mode) ---

function startDrag(card, touch) {
  const container = listNotesEl;
  const cards = Array.from(container.querySelectorAll('.note-card'));
  const startIndex = cards.indexOf(card);
  if (startIndex === -1) return;

  const rect = card.getBoundingClientRect();
  const offsetY = touch.clientY - rect.top;

  card.classList.add('dragging');
  const placeholder = document.createElement('div');
  placeholder.className = 'drag-placeholder';
  placeholder.style.height = rect.height + 'px';

  container.insertBefore(placeholder, card);
  card.style.position = 'fixed';
  card.style.left = rect.left + 'px';
  card.style.top = rect.top + 'px';
  card.style.width = rect.width + 'px';
  card.style.zIndex = '1000';

  dragState = { card, placeholder, container, offsetY, startIndex };

  document.addEventListener('touchmove', onDragMove, { passive: false });
  document.addEventListener('touchend', onDragEnd);
}

function onDragMove(e) {
  if (!dragState) return;
  e.preventDefault();

  const touch = e.touches[0];
  const { card, placeholder, container, offsetY } = dragState;

  card.style.top = (touch.clientY - offsetY) + 'px';

  // Determine new position
  const siblings = Array.from(container.querySelectorAll('.note-card:not(.dragging)'));
  let insertBefore = null;
  for (const sibling of siblings) {
    const sibRect = sibling.getBoundingClientRect();
    const sibMid = sibRect.top + sibRect.height / 2;
    if (touch.clientY < sibMid) {
      insertBefore = sibling;
      break;
    }
  }

  if (insertBefore) {
    container.insertBefore(placeholder, insertBefore);
  } else {
    container.appendChild(placeholder);
  }
}

async function onDragEnd() {
  if (!dragState) return;

  document.removeEventListener('touchmove', onDragMove);
  document.removeEventListener('touchend', onDragEnd);

  const { card, placeholder, container } = dragState;

  card.classList.remove('dragging');
  card.style.position = '';
  card.style.left = '';
  card.style.top = '';
  card.style.width = '';
  card.style.zIndex = '';

  container.insertBefore(card, placeholder);
  container.removeChild(placeholder);

  dragState = null;

  // Save new order
  const newOrder = Array.from(container.querySelectorAll('.note-card')).map((c) => c.dataset.noteId);
  if (currentListId) {
    try {
      const list = await getList(currentListId);
      if (list) {
        list.noteOrder = newOrder;
        await saveList(list);
      }
    } catch (err) {
      console.error('Failed to save reorder:', err);
    }
  }
}

// --- View Navigation ---

function showListsView() {
  stopCurrentPlayback();
  currentListId = null;
  editingNoteId = null;
  if (textNoteInput) {
    textNoteInput.value = '';
  }
  listsView.classList.remove('hidden');
  listDetailView.classList.add('hidden');
  backBtn.classList.add('hidden');
  updateEntryModeUi();
  renderLists();
}

function showListDetailView(listId) {
  currentListId = listId;
  editingNoteId = null;
  listsView.classList.add('hidden');
  listDetailView.classList.remove('hidden');
  backBtn.classList.remove('hidden');
  recordHint.textContent = 'Tap to record';
  renderListDetail(listId);
}

backBtn.addEventListener('click', showListsView);

function openModal(modal, focusTarget) {
  if (!modal) return;
  modal.classList.remove('hidden');
  if (focusTarget) {
    focusTarget.focus();
  }
}

function closeModal(modal) {
  if (!modal) return;
  modal.classList.add('hidden');
}

// --- List Modal ---

function openListModal(listId) {
  editingListId = listId || null;
  selectedMode = 'capture';

  if (editingListId) {
    listModalTitle.textContent = 'Rename List';
    getList(editingListId).then((list) => {
      if (list) {
        listNameInput.value = list.name;
        selectedMode = list.mode;
        updateModeSelector();
      }
    });
    // Disable mode change when editing
    modeSelector.classList.add('hidden');
  } else {
    listModalTitle.textContent = 'New List';
    listNameInput.value = '';
    selectedMode = 'capture';
    modeSelector.classList.remove('hidden');
    updateModeSelector();
  }

  modeDescription.textContent = MODE_DESCRIPTIONS[selectedMode];
  openModal(listModal, listNameInput);
}

function closeListModal() {
  closeModal(listModal);
  editingListId = null;
  listNameInput.value = '';
}

function updateModeSelector() {
  const buttons = modeSelector.querySelectorAll('.mode-btn');
  buttons.forEach((btn) => {
    if (btn.dataset.mode === selectedMode) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
  });
  modeDescription.textContent = MODE_DESCRIPTIONS[selectedMode];
}

modeSelector.addEventListener('click', (e) => {
  const btn = e.target.closest('.mode-btn');
  if (!btn) return;
  selectedMode = btn.dataset.mode;
  updateModeSelector();
});

newListBtn.addEventListener('click', () => openListModal(null));
modalCancelBtn.addEventListener('click', closeListModal);
listModal.querySelector('#list-modal-backdrop').addEventListener('click', closeListModal);

if (helpBtn) {
  helpBtn.addEventListener('click', () => {
    openModal(helpModal, helpModalCloseBtn);
  });
}

if (syncBtn) {
  syncBtn.addEventListener('click', () => {
    openModal(syncModal, cloudSyncKeyInput);
  });
}

if (helpModalCloseBtn) {
  helpModalCloseBtn.addEventListener('click', () => {
    closeModal(helpModal);
  });
}

if (syncModalCloseBtn) {
  syncModalCloseBtn.addEventListener('click', () => {
    closeModal(syncModal);
  });
}

document.querySelectorAll('[data-close-modal]').forEach((element) => {
  element.addEventListener('click', () => {
    const modalId = element.getAttribute('data-close-modal');
    if (!modalId) return;
    closeModal(document.getElementById(modalId));
  });
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;

  if (!listModal.classList.contains('hidden')) {
    closeListModal();
    return;
  }

  if (helpModal && !helpModal.classList.contains('hidden')) {
    closeModal(helpModal);
    return;
  }

  if (syncModal && !syncModal.classList.contains('hidden')) {
    closeModal(syncModal);
  }
});

modalSaveBtn.addEventListener('click', async () => {
  const name = listNameInput.value.trim();
  if (!name) {
    listNameInput.focus();
    return;
  }

  try {
    if (editingListId) {
      const list = await getList(editingListId);
      if (list) {
        list.name = name;
        await saveList(list);
      }
    } else {
      const list = {
        id: crypto.randomUUID(),
        name: name,
        mode: selectedMode,
        createdAt: new Date().toISOString(),
        noteOrder: []
      };
      await saveList(list);
    }

    closeListModal();

    if (currentListId) {
      await renderListDetail(currentListId);
    } else {
      await renderLists();
    }
  } catch (err) {
    console.error('Failed to save list:', err);
  }
});

// --- List Detail Actions ---

renameListBtn.addEventListener('click', () => {
  if (currentListId) openListModal(currentListId);
});

deleteListBtn.addEventListener('click', async () => {
  if (!currentListId) return;
  const list = await getList(currentListId);
  if (!list) return;

  const msg = 'Delete "' + list.name + '" and all its notes?';
  if (!confirm(msg)) return;

  try {
    await deleteList(currentListId);
    showListsView();
  } catch (err) {
    console.error('Failed to delete list:', err);
  }
});

// --- Cloud Sync Actions ---

if (cloudConnectKeyBtn) {
  cloudConnectKeyBtn.addEventListener('click', () => {
    connectCloudSync();
  });
}

if (cloudClearKeyBtn) {
  cloudClearKeyBtn.addEventListener('click', () => {
    clearCloudSync();
  });
}

if (cloudPushBtn) {
  cloudPushBtn.addEventListener('click', () => {
    pushToCloud();
  });
}

if (cloudPullBtn) {
  cloudPullBtn.addEventListener('click', () => {
    pullFromCloud();
  });
}

if (cloudSyncKeyInput) {
  cloudSyncKeyInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    connectCloudSync();
  });
}

if (entryModeToggle) {
  entryModeToggle.addEventListener('click', (e) => {
    const button = e.target.closest('.entry-mode-btn');
    if (!button) return;
    if (button === textEntryBtn) {
      setEntryMode('text');
    } else if (button === voiceEntryBtn) {
      setEntryMode('voice');
    }
  });
}

if (textNoteSubmitBtn) {
  textNoteSubmitBtn.addEventListener('click', () => {
    createTextNote();
  });
}

if (textNoteInput) {
  textNoteInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.shiftKey || !shouldSubmitTextEntryOnEnter()) return;
    e.preventDefault();
    createTextNote();
  });
}

// --- Record Button Handler ---

recordBtn.addEventListener('click', async () => {
  if (recordBusy) return;
  if (!currentListId) return;

  try {
    recordBusy = true;

    if (isRecording) {
      recordBtn.classList.remove('recording');
      recorderEl.classList.remove('recording');
      recordHint.textContent = 'Tap to record';

      const result = await stopRecording();
      isRecording = false;

      if (result && result.duration > 0) {
        const list = await getList(currentListId);
        const isAccomplish = list && list.mode === 'accomplish';
        const rawTranscription = result.transcription || '';
        const cleaned = isAccomplish ? cleanFillersFromTranscription(rawTranscription) : rawTranscription;
        const transcription = isAccomplish ? cleaned : formatTranscriptionSegment(cleaned) || '';
        const parts = isAccomplish ? splitTranscriptionOnAnd(transcription) : [transcription];
        const now = new Date().toISOString();

        if (!list.noteOrder) list.noteOrder = [];

        for (let i = 0; i < parts.length; i++) {
          const note = buildNoteRecord(currentListId, parts[i] || '', {
            createdAt: now,
            audioBlob: isAccomplish ? null : (i === 0 ? result.blob : null),
            duration: isAccomplish ? 0 : (i === 0 ? result.duration : 0),
          });
          await saveNote(note);
          list.noteOrder.unshift(note.id);
        }

        await saveList(list);
        await renderListDetail(currentListId);
      } else if (result) {
        recordHint.textContent = 'Too short \u2014 hold longer';
      }
    } else {
      await startRecording();
      isRecording = true;
      recordBtn.classList.add('recording');
      recorderEl.classList.add('recording');
      recordHint.textContent = 'Tap to stop';
    }
  } catch (err) {
    isRecording = false;
    recordBtn.classList.remove('recording');
    recorderEl.classList.remove('recording');
    stopWaveform();
    if (typeof MediaRecorder === 'undefined') {
      recordHint.textContent = 'Recording not supported in this browser';
    } else {
      recordHint.textContent = 'Microphone access denied';
    }
  } finally {
    recordBusy = false;
  }
});

// --- Theme ---

const THEME_META_COLORS = {
  '': '#1a1a2e',
  aurora: '#1c1017',
  frost: '#f4f5f7',
  neon: '#0a0a0f'
};

function applyTheme(theme) {
  if (theme) {
    document.documentElement.dataset.theme = theme;
  } else {
    delete document.documentElement.dataset.theme;
  }
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = THEME_META_COLORS[theme] || THEME_META_COLORS[''];
  if (themePicker) {
    themePicker.querySelectorAll('.theme-swatch').forEach((btn) => {
      btn.classList.toggle('active', (btn.dataset.themeValue || '') === (theme || ''));
    });
  }
  localStorage.setItem('voice-notes-theme', theme || '');
}

if (themePicker) {
  themePicker.addEventListener('click', (e) => {
    const btn = e.target.closest('.theme-swatch');
    if (!btn) return;
    applyTheme(btn.dataset.themeValue || '');
  });
}

applyTheme(localStorage.getItem('voice-notes-theme') || '');

// --- Service Worker Registration ---

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js')
    .catch((err) => console.error('SW registration failed:', err));
}

// --- Initialization ---

showListsView();
syncKey = normalizeSyncKey(localStorage.getItem(SYNC_KEY_STORAGE) || '');
updateCloudSyncUi();
if (syncKey) {
  pullFromCloudOnLoad().catch((error) => {
    setCloudMessage(error.message || 'Cloud sync unavailable.', true);
  });
} else {
  refreshCloudSync().catch((error) => {
    setCloudMessage(error.message || 'Cloud sync unavailable.', true);
  });
}
