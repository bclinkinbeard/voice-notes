'use strict';

// --- DOM References ---

const recordBtn = document.getElementById('record-btn');
const recordHint = document.getElementById('record-hint');
const notesList = document.getElementById('notes-list');
const emptyState = document.getElementById('empty-state');
const timerEl = document.getElementById('timer');

// --- State ---

let mediaRecorder = null;
let audioChunks = [];
let recordingStartTime = null;
let timerInterval = null;
let currentAudio = null;
let currentPlayBtn = null;
let currentProgressFill = null;
let isRecording = false;
let recordBusy = false;
let speechRecognition = null;
let transcriptionResult = '';

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

// --- Speech Transcription ---

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

function startTranscription() {
  if (!SpeechRecognition) return;

  transcriptionResult = '';
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

  recognition.onerror = () => {};

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

    try {
      recognition.stop();
    } catch (e) {
      done();
    }
  });
}

// --- Transcribe Audio Blob ---

async function transcribeAudioBlob(blob) {
  if (!SpeechRecognition) return '';
  if (!blob) return '';

  return new Promise((resolve) => {
    let result = '';
    let settled = false;

    function finish() {
      if (settled) return;
      settled = true;
      resolve(result);
    }

    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.lang = navigator.language || 'en-US';

    recognition.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) {
          const text = e.results[i][0].transcript.trim();
          if (text) {
            result += (result ? ' ' : '') + text;
          }
        }
      }
    };

    recognition.onend = finish;
    recognition.onerror = finish;

    try {
      recognition.start();
    } catch (e) {
      finish();
      return;
    }

    // Play the blob so recognition can capture the audio
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    audio.onended = () => {
      URL.revokeObjectURL(url);
      setTimeout(() => { try { recognition.stop(); } catch (e) {} }, 500);
    };
    audio.onerror = () => {
      URL.revokeObjectURL(url);
      try { recognition.stop(); } catch (e) {}
    };
    audio.play().catch(() => {
      URL.revokeObjectURL(url);
      try { recognition.stop(); } catch (e) {}
    });
  });
}

// --- Process Untranscribed Notes ---

async function processUntranscribedNotes() {
  const notes = await getAllNotes();
  const untranscribed = notes.filter((n) => !n.transcription);
  if (untranscribed.length === 0) return;

  let updated = false;
  for (const note of untranscribed) {
    try {
      const transcription = await transcribeAudioBlob(note.audioBlob);
      if (transcription) {
        note.transcription = transcription;
        await saveNote(note);
        updated = true;
      }
    } catch (e) {
      // Skip notes that fail to transcribe
    }
  }

  if (updated) {
    await renderNotes();
  }
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
  startTranscription();
}

async function stopRecording() {
  if (!mediaRecorder || mediaRecorder.state === 'inactive') {
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

  // Transcription
  const transcriptionEl = document.createElement('p');
  transcriptionEl.className = 'note-transcription';
  if (note.transcription) {
    transcriptionEl.textContent = note.transcription;
  } else {
    transcriptionEl.textContent = 'No transcription available';
    transcriptionEl.classList.add('note-transcription-empty');
  }

  // Assemble card
  card.appendChild(header);
  card.appendChild(progress);
  card.appendChild(transcriptionEl);
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
      recordHint.textContent = 'Tap to record';

      const result = await stopRecording();

      if (result && result.duration > 0) {
        const note = {
          id: crypto.randomUUID(),
          audioBlob: result.blob,
          duration: result.duration,
          transcription: result.transcription || '',
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
      recordHint.textContent = 'Tap to stop';
    }
  } catch (err) {
    isRecording = false;
    recordBtn.classList.remove('recording');
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

renderNotes().then(() => {
  processUntranscribedNotes().catch((err) => {
    console.error('Failed to process untranscribed notes:', err);
  });
}).catch((err) => {
  console.error('Failed to load notes:', err);
  emptyState.textContent = 'Unable to load notes. Storage may be unavailable.';
});
