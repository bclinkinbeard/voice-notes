'use strict';

import { categorizeNote, analyzeSentiment, preloadSentimentModel } from './analysis.js';

// --- Constants ---

const DEFAULT_LIST_ID = 'default';
const MODE_DESCRIPTIONS = {
  capture: 'Record and save voice notes.',
  accomplish: 'Track tasks with checkboxes and reordering.'
};

// --- DOM References ---

const backBtn = document.getElementById('back-btn');
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
const recordBtn = document.getElementById('record-btn');
const recordHint = document.getElementById('record-hint');
const timerEl = document.getElementById('timer');
const recorderEl = document.getElementById('recorder');
const waveformCanvas = document.getElementById('waveform');
const waveformCtx = waveformCanvas ? waveformCanvas.getContext('2d') : null;
const listModal = document.getElementById('list-modal');
const listModalTitle = document.getElementById('list-modal-title');
const listNameInput = document.getElementById('list-name-input');
const modeSelector = document.getElementById('mode-selector');
const modeDescription = document.getElementById('mode-description');
const modalCancelBtn = document.getElementById('modal-cancel-btn');
const modalSaveBtn = document.getElementById('modal-save-btn');
const filterBar = document.getElementById('filter-bar');

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
let editingListId = null;
let selectedMode = 'capture';
let dragState = null;
let activeFilter = 'all';

// --- IndexedDB ---

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open('voiceNotesDB', 2);

    request.onupgradeneeded = (e) => {
      const db = e.target.result;
      const oldVersion = e.oldVersion;

      if (!db.objectStoreNames.contains('notes')) {
        db.createObjectStore('notes', { keyPath: 'id' });
      }

      if (!db.objectStoreNames.contains('lists')) {
        db.createObjectStore('lists', { keyPath: 'id' });
      }

      // Add listId index to notes if upgrading from v1
      if (oldVersion < 2) {
        const noteStore = e.target.transaction.objectStore('notes');
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
      tx.objectStore('notes').put(note);
      tx.oncomplete = () => resolve();
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

function deleteNote(id) {
  return openDB().then((db) => {
    return new Promise((resolve, reject) => {
      const tx = db.transaction('notes', 'readwrite');
      tx.objectStore('notes').delete(id);
      tx.oncomplete = () => resolve();
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
      tx.oncomplete = () => resolve();
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
        tx.oncomplete = () => resolve();
        tx.onerror = (e) => reject(e.target.error);
      });
    });
  });
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

function startWaveform(stream) {
  if (!waveformCtx) return;

  if (!audioContext || audioContext.state === 'closed') {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
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
  ctx.scale(dpr, dpr);

  const accentColor = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();

  function draw() {
    waveformFrameId = requestAnimationFrame(draw);
    analyser.getByteTimeDomainData(dataArray);

    ctx.fillStyle = 'rgba(26, 26, 46, 0.3)';
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

// --- Transcription Splitting ---

function splitTranscriptionOnAnd(text) {
  if (!text) return [text];
  const parts = text.split(/\s+and\s+/i).map((s) => s.trim()).filter(Boolean);
  return parts.length > 0 ? parts : [text];
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
  startWaveform(stream);
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

function createNoteCard(note, list) {
  const card = document.createElement('div');
  card.className = 'note-card';
  card.dataset.noteId = note.id;
  const isAccomplish = list && list.mode === 'accomplish';

  if (isAccomplish && note.completed) {
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
    dragHandle.addEventListener('touchstart', (e) => {
      e.preventDefault();
      startDrag(card, e.touches[0]);
    }, { passive: false });
  }

  // Content area
  const content = document.createElement('div');
  content.className = 'note-content';

  // Transcription
  const transcriptionEl = document.createElement('p');
  transcriptionEl.className = 'note-transcription';
  if (note.transcription) {
    transcriptionEl.textContent = note.transcription;
  } else {
    transcriptionEl.textContent = 'No transcription available';
    transcriptionEl.classList.add('note-transcription-empty');
  }
  content.appendChild(transcriptionEl);

  // Analysis tags (categories + sentiment)
  const hasCategories = note.categories && note.categories.length > 0;
  const hasSentiment = note.sentiment && note.sentiment.label !== 'neutral';
  if (hasCategories || hasSentiment) {
    const tagsEl = document.createElement('div');
    tagsEl.className = 'note-tags';

    if (hasSentiment) {
      const sentimentTag = document.createElement('span');
      sentimentTag.className = 'note-tag note-tag-sentiment';
      sentimentTag.dataset.sentiment = note.sentiment.label;
      sentimentTag.textContent = note.sentiment.label;
      tagsEl.appendChild(sentimentTag);
    }

    if (hasCategories) {
      for (const cat of note.categories) {
        const tag = document.createElement('span');
        tag.className = 'note-tag';
        tag.textContent = cat;
        tagsEl.appendChild(tag);
      }
    }

    content.appendChild(tagsEl);
  }

  const hasAudio = !!note.audioBlob;

  // Meta line (duration · date)
  if (hasAudio) {
    const meta = document.createElement('div');
    meta.className = 'note-meta';
    meta.textContent = formatDuration(note.duration) + ' \u00B7 ' + formatDate(note.createdAt);
    content.appendChild(meta);
  }

  // Progress bar (only for notes with audio)
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
    playBtn.className = 'play-btn';
    playBtn.textContent = '\u25B6';
    playBtn.setAttribute('aria-label', 'Play');
    actions.appendChild(playBtn);
  }

  const deleteBtn = document.createElement('button');
  deleteBtn.type = 'button';
  deleteBtn.className = 'delete-btn';
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

function renderFilterBar(notes) {
  const allCategories = new Set();
  for (const note of notes) {
    if (note.categories) {
      for (const cat of note.categories) {
        allCategories.add(cat);
      }
    }
  }

  while (filterBar.firstChild) {
    filterBar.removeChild(filterBar.firstChild);
  }

  if (allCategories.size === 0) {
    filterBar.classList.add('hidden');
    return;
  }

  const allChip = document.createElement('button');
  allChip.type = 'button';
  allChip.className = 'filter-chip' + (activeFilter === 'all' ? ' active' : '');
  allChip.textContent = 'All';
  allChip.dataset.filter = 'all';
  allChip.addEventListener('click', () => {
    activeFilter = 'all';
    renderListDetail(currentListId);
  });
  filterBar.appendChild(allChip);

  for (const cat of allCategories) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'filter-chip' + (activeFilter === cat ? ' active' : '');
    chip.textContent = cat;
    chip.dataset.filter = cat;
    chip.addEventListener('click', () => {
      activeFilter = cat;
      renderListDetail(currentListId);
    });
    filterBar.appendChild(chip);
  }

  filterBar.classList.remove('hidden');
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

  // Render filter bar
  renderFilterBar(notes);

  // Apply category filter
  let filteredNotes = notes;
  if (activeFilter !== 'all') {
    filteredNotes = notes.filter((n) => n.categories && n.categories.includes(activeFilter));
  }

  while (listNotesEl.firstChild) {
    listNotesEl.removeChild(listNotesEl.firstChild);
  }

  for (const note of filteredNotes) {
    listNotesEl.appendChild(createNoteCard(note, list));
  }

  if (filteredNotes.length === 0) {
    listEmptyState.classList.remove('hidden');
  } else {
    listEmptyState.classList.add('hidden');
  }
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

// --- Background Analysis ---

async function processUnanalyzedNotes(listId) {
  try {
    const notes = await getNotesByList(listId);
    const needsCategories = notes.filter((n) => n.transcription && !n.categories);
    const needsSentiment = notes.filter((n) => n.transcription && !n.sentiment);

    // Instant: add categories to any notes missing them
    let categorized = false;
    for (const note of needsCategories) {
      note.categories = categorizeNote(note.transcription);
      await saveNote(note);
      categorized = true;
    }

    if (categorized && currentListId === listId && !isRecording) {
      await renderListDetail(listId);
    }

    // Background: run sentiment analysis on notes missing it
    // Skip if user is recording — avoid memory pressure from model loading
    for (const note of needsSentiment) {
      if (isRecording) break;
      try {
        const sentiment = await analyzeSentiment(note.transcription);
        note.sentiment = sentiment;
        await saveNote(note);
        if (currentListId === listId && !isRecording) {
          await renderListDetail(listId);
        }
      } catch (e) {
        // Skip notes that fail
      }
    }
  } catch (e) {
    console.error('processUnanalyzedNotes error:', e);
  }
}

// --- View Navigation ---

function showListsView() {
  stopCurrentPlayback();
  currentListId = null;
  activeFilter = 'all';
  listsView.classList.remove('hidden');
  listDetailView.classList.add('hidden');
  backBtn.classList.add('hidden');
  renderLists();
}

function showListDetailView(listId) {
  currentListId = listId;
  activeFilter = 'all';
  listsView.classList.add('hidden');
  listDetailView.classList.remove('hidden');
  backBtn.classList.remove('hidden');
  recordHint.textContent = 'Tap to record';
  renderListDetail(listId);

  // Run lightweight keyword categorization on existing notes in background.
  // Sentiment model loading is deferred until after first recording to avoid
  // memory pressure while the user might be about to record.
  processUnanalyzedNotes(listId);
}

backBtn.addEventListener('click', showListsView);

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
  listModal.classList.remove('hidden');
  listNameInput.focus();
}

function closeListModal() {
  listModal.classList.add('hidden');
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
        const transcription = isAccomplish ? rawTranscription : formatTranscriptionSegment(rawTranscription) || '';
        const parts = isAccomplish ? splitTranscriptionOnAnd(transcription) : [transcription];
        const now = new Date().toISOString();

        if (!list.noteOrder) list.noteOrder = [];

        const savedNotes = [];
        for (let i = 0; i < parts.length; i++) {
          const note = {
            id: crypto.randomUUID(),
            audioBlob: i === 0 ? result.blob : null,
            duration: i === 0 ? result.duration : 0,
            transcription: parts[i] || '',
            createdAt: now,
            listId: currentListId,
            completed: false,
            categories: categorizeNote(parts[i] || ''),
            sentiment: null
          };
          await saveNote(note);
          list.noteOrder.push(note.id);
          savedNotes.push(note);
        }

        await saveList(list);
        await renderListDetail(currentListId);

        // Background sentiment analysis — runs after recording finishes
        // so model loading doesn't compete with MediaRecorder for memory.
        const listIdAtSave = currentListId;
        (async () => {
          for (const note of savedNotes) {
            if (!note.transcription) continue;
            try {
              const sentiment = await analyzeSentiment(note.transcription);
              note.sentiment = sentiment;
              await saveNote(note);
              if (currentListId === listIdAtSave && !isRecording) {
                await renderListDetail(listIdAtSave);
              }
            } catch (e) {
              // Sentiment analysis failed — note still saved without it
            }
          }
          // Also process any other unanalyzed notes now that recording is done
          processUnanalyzedNotes(listIdAtSave);
        })();
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

// --- Service Worker Registration ---

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js')
    .catch((err) => console.error('SW registration failed:', err));
}

// --- Initialization ---

showListsView();
