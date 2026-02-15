'use strict';

// --- DOM References ---

const recordBtn = document.getElementById('record-btn');
const recordHint = document.getElementById('record-hint');
const notesList = document.getElementById('notes-list');
const emptyState = document.getElementById('empty-state');
const timerEl = document.getElementById('timer');
const recorderEl = document.getElementById('recorder');
const waveformCanvas = document.getElementById('waveform');
const waveformCtx = waveformCanvas.getContext('2d');

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

// --- IndexedDB ---

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open('voiceNotesDB', 1);

    request.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('notes')) {
        db.createObjectStore('notes', { keyPath: 'id' });
      }
    };

    request.onsuccess = (e) => resolve(e.target.result);
    request.onerror = (e) => {
      dbPromise = null;
      reject(e.target.error);
    };
  });

  return dbPromise;
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
  audioContext = new (window.AudioContext || window.webkitAudioContext)();
  analyser = audioContext.createAnalyser();
  analyser.fftSize = 128;

  const source = audioContext.createMediaStreamSource(stream);
  source.connect(analyser);

  const bufferLength = analyser.frequencyBinCount;
  const dataArray = new Uint8Array(bufferLength);
  const barCount = 32;
  const canvas = waveformCanvas;
  const ctx = waveformCtx;
  const dpr = window.devicePixelRatio || 1;

  canvas.width = 280 * dpr;
  canvas.height = 64 * dpr;
  ctx.scale(dpr, dpr);

  const accentColor = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();

  function draw() {
    waveformFrameId = requestAnimationFrame(draw);
    analyser.getByteFrequencyData(dataArray);

    ctx.clearRect(0, 0, 280, 64);

    const barWidth = 280 / barCount;
    const gap = 2;
    const step = Math.floor(bufferLength / barCount);

    for (let i = 0; i < barCount; i++) {
      const value = dataArray[i * step] / 255;
      const barHeight = Math.max(3, value * 58);
      const x = i * barWidth;
      const y = (64 - barHeight) / 2;

      ctx.fillStyle = accentColor;
      ctx.globalAlpha = 0.4 + value * 0.6;
      ctx.beginPath();
      ctx.roundRect(x + gap / 2, y, barWidth - gap, barHeight, 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  draw();
}

function stopWaveform() {
  if (waveformFrameId) {
    cancelAnimationFrame(waveformFrameId);
    waveformFrameId = null;
  }
  if (audioContext) {
    audioContext.close().catch(() => {});
    audioContext = null;
    analyser = null;
  }
  waveformCtx.clearRect(0, 0, waveformCanvas.width, waveformCanvas.height);
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

  mediaRecorder.start(100);
  recordingStartTime = Date.now();
  startTimer();
  startWaveform(stream);
}

function stopRecording() {
  if (!mediaRecorder || mediaRecorder.state === 'inactive') {
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    const recorder = mediaRecorder;

    recorder.onstop = () => {
      const blob = new Blob(audioChunks, { type: recorder.mimeType });
      const duration = Math.round((Date.now() - recordingStartTime) / 1000);

      recorder.stream.getTracks().forEach((t) => t.stop());
      audioChunks = [];
      mediaRecorder = null;
      stopTimer();
      stopWaveform();

      resolve({ blob, duration });
    };

    recorder.stop();
  });
}

// --- Playback Cleanup ---

function stopCurrentPlayback() {
  if (!currentAudio) return;
  currentAudio.pause();
  if (currentAudio._objectURL) {
    URL.revokeObjectURL(currentAudio._objectURL);
  }
  if (currentPlayBtn) {
    currentPlayBtn.textContent = 'Play';
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

function createNoteCard(note) {
  const card = document.createElement('div');
  card.className = 'note-card';

  // Header
  const header = document.createElement('div');
  header.className = 'note-header';

  const dateSpan = document.createElement('span');
  dateSpan.className = 'note-date';
  dateSpan.textContent = formatDate(note.createdAt);

  const durationSpan = document.createElement('span');
  durationSpan.className = 'note-duration';
  durationSpan.textContent = formatDuration(note.duration);

  header.appendChild(dateSpan);
  header.appendChild(durationSpan);

  // Progress bar
  const progress = document.createElement('div');
  progress.className = 'note-progress';

  const progressFill = document.createElement('div');
  progressFill.className = 'note-progress-fill';
  progress.appendChild(progressFill);

  // Actions
  const actions = document.createElement('div');
  actions.className = 'note-actions';

  const playBtn = document.createElement('button');
  playBtn.type = 'button';
  playBtn.className = 'play-btn';
  playBtn.textContent = 'Play';

  const deleteBtn = document.createElement('button');
  deleteBtn.type = 'button';
  deleteBtn.className = 'delete-btn';
  deleteBtn.textContent = 'Delete';

  actions.appendChild(playBtn);
  actions.appendChild(deleteBtn);

  // Assemble card
  card.appendChild(header);
  card.appendChild(progress);
  card.appendChild(actions);

  // Play button handler
  playBtn.addEventListener('click', () => {
    // Toggle existing playback on same card
    if (currentAudio && currentPlayBtn === playBtn) {
      if (!currentAudio.paused) {
        currentAudio.pause();
        playBtn.textContent = 'Play';
      } else {
        currentAudio.play().catch(() => {
          stopCurrentPlayback();
        });
        playBtn.textContent = 'Pause';
      }
      return;
    }

    // Stop any other card's playback
    stopCurrentPlayback();

    // Start new playback
    const url = URL.createObjectURL(note.audioBlob);
    const audio = new Audio(url);
    audio._objectURL = url;

    currentAudio = audio;
    currentPlayBtn = playBtn;
    currentProgressFill = progressFill;

    audio.play().then(() => {
      playBtn.textContent = 'Pause';
    }).catch(() => {
      URL.revokeObjectURL(url);
      currentAudio = null;
      currentPlayBtn = null;
      currentProgressFill = null;
      playBtn.textContent = 'Play';
    });

    audio.ontimeupdate = () => {
      if (audio.duration && isFinite(audio.duration) && audio.duration > 0) {
        progressFill.style.width = (audio.currentTime / audio.duration) * 100 + '%';
      }
    };

    audio.onended = () => {
      URL.revokeObjectURL(audio._objectURL);
      playBtn.textContent = 'Play';
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

    if (currentPlayBtn === playBtn) {
      stopCurrentPlayback();
    }

    try {
      await deleteNote(note.id);
      await renderNotes();
    } catch (err) {
      console.error('Failed to delete note:', err);
    }
  });

  return card;
}

async function renderNotes() {
  stopCurrentPlayback();

  const notes = await getAllNotes();
  notes.sort((a, b) => (b.createdAt > a.createdAt ? 1 : b.createdAt < a.createdAt ? -1 : 0));

  while (notesList.firstChild) {
    notesList.removeChild(notesList.firstChild);
  }

  for (const note of notes) {
    notesList.appendChild(createNoteCard(note));
  }

  if (notes.length === 0) {
    emptyState.classList.remove('hidden');
  } else {
    emptyState.classList.add('hidden');
  }
}

// --- Record Button Handler ---

recordBtn.addEventListener('click', async () => {
  if (recordBusy) return;

  try {
    recordBusy = true;

    if (isRecording) {
      isRecording = false;
      recordBtn.classList.remove('recording');
      recorderEl.classList.remove('recording');
      recordHint.textContent = 'Tap to record';

      const result = await stopRecording();

      if (result && result.duration > 0) {
        const note = {
          id: crypto.randomUUID(),
          audioBlob: result.blob,
          duration: result.duration,
          createdAt: new Date().toISOString()
        };
        await saveNote(note);
        await renderNotes();
      } else if (result) {
        recordHint.textContent = 'Too short — hold longer';
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

renderNotes().catch((err) => {
  console.error('Failed to load notes:', err);
  emptyState.textContent = 'Unable to load notes. Storage may be unavailable.';
});
