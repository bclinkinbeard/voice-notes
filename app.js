import { pipeline } from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3";
import { tagTranscript } from "./tagger.js";

// ─── IndexedDB Storage ───────────────────────────────────────────────────────

const DB_NAME = "voiceNotesDB";
const DB_VERSION = 1;
const STORE_NAME = "notes";

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveNote(note) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(note);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function getAllNotes() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function deleteNote(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function updateNoteTranscript(id, transcript) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const getReq = store.get(id);
    getReq.onsuccess = () => {
      const note = getReq.result;
      if (note) {
        note.transcript = transcript;
        store.put(note);
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function updateNoteFields(id, fields) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const getReq = store.get(id);
    getReq.onsuccess = () => {
      const note = getReq.result;
      if (note) {
        Object.assign(note, fields);
        store.put(note);
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ─── Whisper Transcription (fully local via transformers.js) ─────────────────

let transcriber = null;
let modelLoadingPromise = null;

const modelStatusEl = document.getElementById("model-status");

function showModelStatus(text, className) {
  modelStatusEl.textContent = text;
  modelStatusEl.className = className || "";
}

function hideModelStatus() {
  modelStatusEl.className = "hidden";
}

function loadTranscriber() {
  if (transcriber) return Promise.resolve(transcriber);
  if (modelLoadingPromise) return modelLoadingPromise;

  showModelStatus("Loading transcription model...");

  modelLoadingPromise = pipeline(
    "automatic-speech-recognition",
    "onnx-community/whisper-tiny.en",
    {
      progress_callback: (event) => {
        if (event.status === "progress" && event.total) {
          const pct = Math.round((event.loaded / event.total) * 100);
          showModelStatus(`Downloading model... ${pct}%`);
        } else if (event.status === "initiate") {
          showModelStatus("Downloading model...");
        }
      },
    },
  )
    .then((p) => {
      transcriber = p;
      showModelStatus("Model ready", "ready");
      setTimeout(hideModelStatus, 2000);
      return transcriber;
    })
    .catch((err) => {
      console.error("Failed to load Whisper model:", err);
      showModelStatus("Model failed to load", "error");
      modelLoadingPromise = null;
      throw err;
    });

  return modelLoadingPromise;
}

async function blobToFloat32Audio(blob) {
  const arrayBuffer = await blob.arrayBuffer();
  const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const decoded = await audioCtx.decodeAudioData(arrayBuffer);
  await audioCtx.close();

  const targetRate = 16000;
  const numSamples = Math.round(decoded.duration * targetRate);
  if (numSamples === 0) return new Float32Array(0);

  const offlineCtx = new OfflineAudioContext(1, numSamples, targetRate);
  const source = offlineCtx.createBufferSource();
  source.buffer = decoded;
  source.connect(offlineCtx.destination);
  source.start(0);

  const resampled = await offlineCtx.startRendering();
  return resampled.getChannelData(0);
}

// Serialize transcription jobs so only one runs at a time
let transcriptionQueue = Promise.resolve();

function enqueueTranscription(noteId, audioBlob) {
  transcriptionQueue = transcriptionQueue.then(async () => {
    try {
      const t = await loadTranscriber();
      const audioData = await blobToFloat32Audio(audioBlob);
      const result = await t(audioData);
      const transcript = result.text.trim();
      await updateNoteTranscript(noteId, transcript);
      updateTranscriptInUI(noteId, transcript);

      // Chain NLP analysis (non-blocking — failures won't affect transcription)
      if (transcript) {
        analyzeNote(noteId, transcript).catch((err) => {
          console.error("NLP analysis failed for note", noteId, err);
        });
      }
    } catch (err) {
      console.error("Transcription failed for note", noteId, err);
      updateTranscriptInUI(noteId, null);
    }
  });
}

function updateTranscriptInUI(noteId, transcript) {
  const card = notesList.querySelector(`[data-id="${noteId}"]`);
  if (!card) return;

  const el = card.querySelector(".note-transcript");
  if (transcript) {
    el.className = "note-transcript";
    el.textContent = transcript;
  } else {
    el.className = "note-transcript empty";
    el.textContent = "Transcription failed";
  }
}

function updateNoteAnalysis(noteId, tags) {
  const card = notesList.querySelector(`[data-id="${noteId}"]`);
  if (!card) return;

  // Replace analyzing indicator with tags (or remove it)
  const existingTagsContainer = card.querySelector(".note-tags");

  if (tags && tags.length > 0) {
    const tagsDiv = document.createElement("div");
    tagsDiv.className = "note-tags";
    tags.slice(0, 3).forEach((t) => {
      const span = document.createElement("span");
      span.className = "note-tag";
      span.textContent = t;
      tagsDiv.appendChild(span);
    });

    if (existingTagsContainer) {
      existingTagsContainer.replaceWith(tagsDiv);
    } else {
      const progressEl = card.querySelector(".note-progress");
      progressEl.parentNode.insertBefore(tagsDiv, progressEl);
    }
  } else if (existingTagsContainer) {
    existingTagsContainer.remove();
  }
}

// ─── NLP Analysis (sentiment + tagging) ─────────────────────────────────────

async function analyzeNote(noteId, transcript) {
  // Keyword-based tagging (instant, no model needed)
  const tags = tagTranscript(transcript);

  // Persist and display tags immediately
  await updateNoteFields(noteId, { tags });
  updateNoteAnalysis(noteId, tags);
}

// ─── Audio Recorder ──────────────────────────────────────────────────────────

let mediaRecorder = null;
let audioChunks = [];
let audioContext = null;
let analyser = null;
let recordingStartTime = null;
let timerInterval = null;
let animationFrameId = null;
let cachedStream = null;

async function acquireMicStream() {
  // Reuse an existing live stream if tracks are still active
  if (cachedStream && cachedStream.getTracks().some((t) => t.readyState === "live")) {
    return cachedStream;
  }
  cachedStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  return cachedStream;
}

async function startRecording() {
  const stream = await acquireMicStream();

  // Set up Web Audio analyser for waveform
  audioContext = new (window.AudioContext || window.webkitAudioContext)();
  const source = audioContext.createMediaStreamSource(stream);
  analyser = audioContext.createAnalyser();
  analyser.fftSize = 256;
  source.connect(analyser);

  // Determine supported MIME type
  const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
    ? "audio/webm;codecs=opus"
    : MediaRecorder.isTypeSupported("audio/webm")
      ? "audio/webm"
      : "";

  const options = mimeType ? { mimeType } : {};
  mediaRecorder = new MediaRecorder(stream, options);
  audioChunks = [];

  mediaRecorder.ondataavailable = (e) => {
    if (e.data.size > 0) audioChunks.push(e.data);
  };

  mediaRecorder.start(100);
  recordingStartTime = Date.now();

  canvas.classList.add("active");
  startTimer();
  drawWaveform();
}

function stopRecording() {
  return new Promise((resolve) => {
    if (!mediaRecorder || mediaRecorder.state === "inactive") {
      resolve(null);
      return;
    }

    // Capture references so the onstop callback cleans up the correct session
    // even if a new recording starts before this one's onstop fires.
    const recorder = mediaRecorder;
    const chunks = audioChunks;
    const startTime = recordingStartTime;
    const ctx = audioContext;
    const frameId = animationFrameId;

    // Detach from module-level state immediately so a new recording
    // won't collide with this session's cleanup.
    mediaRecorder = null;
    audioChunks = [];
    audioContext = null;
    analyser = null;
    animationFrameId = null;

    recorder.onstop = () => {
      const mimeType = recorder.mimeType || "audio/webm";
      const blob = new Blob(chunks, { type: mimeType });
      const duration = Math.round((Date.now() - startTime) / 1000);

      // Don't stop stream tracks — keep the mic grant alive for quick re-record.
      // Tracks are shared via cachedStream and reused by the next recording.

      if (ctx) {
        ctx.close().catch(() => {});
      }

      stopTimer();
      cancelAnimationFrame(frameId);
      clearWaveform();
      canvas.classList.remove("active");

      resolve({ blob, duration });
    };

    recorder.stop();
  });
}

// ─── Timer ───────────────────────────────────────────────────────────────────

const timerEl = document.getElementById("timer");

function startTimer() {
  timerEl.classList.add("active");
  timerInterval = setInterval(updateTimer, 200);
}

function stopTimer() {
  clearInterval(timerInterval);
  timerEl.classList.remove("active");
  timerEl.textContent = "0:00";
}

function updateTimer() {
  const elapsed = Math.floor((Date.now() - recordingStartTime) / 1000);
  const mins = Math.floor(elapsed / 60);
  const secs = String(elapsed % 60).padStart(2, "0");
  timerEl.textContent = `${mins}:${secs}`;
}

// ─── Waveform Visualization ─────────────────────────────────────────────────

const canvas = document.getElementById("waveform");
const ctx = canvas.getContext("2d");

function drawWaveform() {
  if (!analyser) return;

  const bufferLength = analyser.frequencyBinCount;
  const dataArray = new Uint8Array(bufferLength);

  function draw() {
    if (!analyser) return;
    animationFrameId = requestAnimationFrame(draw);
    analyser.getByteTimeDomainData(dataArray);

    ctx.fillStyle = getComputedStyle(document.documentElement)
      .getPropertyValue("--surface")
      .trim();
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.lineWidth = 2;
    ctx.strokeStyle = "#e94560";
    ctx.beginPath();

    const sliceWidth = canvas.width / bufferLength;
    let x = 0;

    for (let i = 0; i < bufferLength; i++) {
      const v = dataArray[i] / 128.0;
      const y = (v * canvas.height) / 2;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
      x += sliceWidth;
    }

    ctx.lineTo(canvas.width, canvas.height / 2);
    ctx.stroke();
  }

  draw();
}

function clearWaveform() {
  ctx.fillStyle = getComputedStyle(document.documentElement)
    .getPropertyValue("--surface")
    .trim();
  ctx.fillRect(0, 0, canvas.width, canvas.height);
}

// ─── UI ──────────────────────────────────────────────────────────────────────

const recordBtn = document.getElementById("record-btn");
const recordHint = document.getElementById("record-hint");
const notesList = document.getElementById("notes-list");
const emptyState = document.getElementById("empty-state");

let isRecording = false;
let currentlyPlaying = null;

recordBtn.addEventListener("click", async () => {
  if (isRecording) {
    // Stop
    isRecording = false;
    recordBtn.classList.remove("recording");
    recordHint.textContent = "Tap to record";

    const result = await stopRecording();

    if (result && result.duration > 0) {
      const note = {
        id: Date.now().toString(),
        audioBlob: result.blob,
        transcript: "",
        duration: result.duration,
        createdAt: new Date().toISOString(),
      };

      await saveNote(note);
      renderNotes();

      // Transcribe asynchronously — UI updates when done
      enqueueTranscription(note.id, result.blob);
    }
  } else {
    // Start
    try {
      await startRecording();
      isRecording = true;
      recordBtn.classList.add("recording");
      recordHint.textContent = "Tap to stop";
    } catch (err) {
      console.error("Could not start recording:", err);
      recordHint.textContent = "Microphone access denied";
    }
  }
});

function formatDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = String(seconds % 60).padStart(2, "0");
  return `${m}:${s}`;
}

function formatDate(isoString) {
  const d = new Date(isoString);
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function createNoteCard(note) {
  const card = document.createElement("div");
  card.className = "note-card";
  card.dataset.id = note.id;

  const hasTranscript = note.transcript && note.transcript.length > 0;
  const hasTags = Array.isArray(note.tags);
  const hasVisibleTags = hasTags && note.tags.length > 0;

  let transcriptHTML;
  if (hasTranscript) {
    transcriptHTML = `<div class="note-transcript">${escapeHtml(note.transcript)}</div>`;
  } else {
    transcriptHTML = `<div class="note-transcript transcribing">Transcribing...</div>`;
  }

  // Tags section
  let tagsHTML = "";
  if (hasTranscript && !hasTags) {
    // Transcript exists but analysis not done yet
    tagsHTML = `
      <div class="note-tags analyzing">
        <span class="analyzing-text">Analyzing...</span>
      </div>`;
  } else if (hasVisibleTags) {
    const tagChips = note.tags
      .slice(0, 3)
      .map((t) => `<span class="note-tag">${escapeHtml(t)}</span>`)
      .join("");
    tagsHTML = `<div class="note-tags">${tagChips}</div>`;
  }

  card.innerHTML = `
    <div class="note-header">
      <span class="note-date">${formatDate(note.createdAt)}</span>
      <div class="note-header-right">
        <span class="note-duration">${formatDuration(note.duration)}</span>
      </div>
    </div>
    ${transcriptHTML}
    ${tagsHTML}
    <div class="note-progress">
      <div class="note-progress-bar"></div>
    </div>
    <div class="note-actions">
      <button class="play-btn">&#9654; Play</button>
      <button class="delete-btn" aria-label="Delete">&#128465;</button>
    </div>
  `;

  const playBtn = card.querySelector(".play-btn");
  const progressWrap = card.querySelector(".note-progress");
  const progressBar = card.querySelector(".note-progress-bar");

  playBtn.addEventListener("click", () => {
    if (currentlyPlaying && currentlyPlaying.noteId !== note.id) {
      currentlyPlaying.audio.pause();
      currentlyPlaying.audio.currentTime = 0;
      const otherCard = notesList.querySelector(
        `[data-id="${currentlyPlaying.noteId}"]`,
      );
      if (otherCard) {
        otherCard.querySelector(".play-btn").innerHTML = "&#9654; Play";
        otherCard.querySelector(".note-progress").classList.remove("visible");
      }
      currentlyPlaying = null;
    }

    if (currentlyPlaying && currentlyPlaying.noteId === note.id) {
      if (currentlyPlaying.audio.paused) {
        currentlyPlaying.audio.play().catch(() => {
          resetPlayUI();
        });
        playBtn.innerHTML = "&#9646;&#9646; Pause";
      } else {
        currentlyPlaying.audio.pause();
        playBtn.innerHTML = "&#9654; Play";
      }
      return;
    }

    const url = URL.createObjectURL(note.audioBlob);
    const audio = new Audio(url);
    currentlyPlaying = { audio, noteId: note.id };

    function resetPlayUI() {
      playBtn.innerHTML = "&#9654; Play";
      progressWrap.classList.remove("visible");
      progressBar.style.width = "0%";
      currentlyPlaying = null;
    }

    progressWrap.classList.add("visible");
    playBtn.innerHTML = "&#9646;&#9646; Pause";

    audio.ontimeupdate = () => {
      if (audio.duration) {
        const pct = (audio.currentTime / audio.duration) * 100;
        progressBar.style.width = pct + "%";
      }
    };

    audio.onended = () => {
      // Detach handlers so stale events can't fire after cleanup
      audio.ontimeupdate = null;
      audio.onerror = null;
      URL.revokeObjectURL(url);
      resetPlayUI();
    };

    audio.onerror = () => {
      audio.ontimeupdate = null;
      audio.onended = null;
      URL.revokeObjectURL(url);
      resetPlayUI();
    };

    audio.play().catch(() => {
      URL.revokeObjectURL(url);
      resetPlayUI();
    });
  });

  card.querySelector(".delete-btn").addEventListener("click", async () => {
    if (currentlyPlaying && currentlyPlaying.noteId === note.id) {
      currentlyPlaying.audio.pause();
      currentlyPlaying = null;
    }
    await deleteNote(note.id);
    renderNotes();
  });

  return card;
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

async function renderNotes() {
  const notes = await getAllNotes();
  notes.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  notesList.innerHTML = "";
  notes.forEach((note) => notesList.appendChild(createNoteCard(note)));

  emptyState.classList.toggle("hidden", notes.length > 0);

  // Re-trigger analysis for notes stuck with a transcript but no tags
  notes.forEach((note) => {
    if (note.transcript && !Array.isArray(note.tags)) {
      analyzeNote(note.id, note.transcript).catch((err) => {
        console.error("Recovery analysis failed for note", note.id, err);
      });
    }
  });
}

// ─── Init ────────────────────────────────────────────────────────────────────

clearWaveform();
renderNotes();

// Preload the Whisper model in the background so it's ready when needed
loadTranscriber().catch(() => {});

// Pre-acquire the mic stream if permission was previously granted so the user
// doesn't get re-prompted on first record click.
if (navigator.permissions) {
  navigator.permissions.query({ name: "microphone" }).then((status) => {
    if (status.state === "granted") {
      acquireMicStream().catch(() => {});
    }
    status.addEventListener("change", () => {
      if (status.state === "denied") {
        recordHint.textContent = "Microphone access denied";
      }
    });
  }).catch(() => {});
}
