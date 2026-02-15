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
  if (!modelStatusEl) return;
  modelStatusEl.textContent = text;
  modelStatusEl.className = className || "";
}

function hideModelStatus() {
  if (!modelStatusEl) return;
  modelStatusEl.className = "hidden";
}

function loadTranscriber() {
  if (transcriber) return Promise.resolve(transcriber);
  if (modelLoadingPromise) return modelLoadingPromise;

  showModelStatus("Loading transcription model...");

  // Timeout that we can cancel on success to avoid a leaked rejection.
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error("Model load timed out")),
      60000,
    );
  });

  modelLoadingPromise = Promise.race([
    pipeline(
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
    ),
    timeout,
  ])
    .then((p) => {
      clearTimeout(timeoutId);
      transcriber = p;
      showModelStatus("Model ready", "ready");
      setTimeout(hideModelStatus, 2000);
      return transcriber;
    })
    .catch((err) => {
      clearTimeout(timeoutId);
      console.error("Failed to load Whisper model:", err);
      showModelStatus("Model failed to load", "error");
      modelLoadingPromise = null;
      throw err;
    });

  return modelLoadingPromise;
}

// Reusable AudioContext for decoding audio blobs.  Browsers limit how many
// AudioContexts can exist simultaneously (typically ~6).  Creating and closing
// a new one per transcription exhausts that limit and causes crashes.  By
// reusing a single context we stay well within the budget.
let decodingAudioCtx = null;

async function blobToFloat32Audio(blob) {
  const arrayBuffer = await blob.arrayBuffer();

  if (!decodingAudioCtx || decodingAudioCtx.state === "closed") {
    decodingAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }

  const decoded = await decodingAudioCtx.decodeAudioData(arrayBuffer.slice(0));

  const targetRate = 16000;
  const numSamples = Math.round(decoded.duration * targetRate);
  if (!numSamples || numSamples <= 0) return new Float32Array(0);

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

const pendingTranscriptions = new Set();

function enqueueTranscription(noteId, audioBlob) {
  if (pendingTranscriptions.has(noteId)) return; // avoid double-enqueue
  pendingTranscriptions.add(noteId);

  transcriptionQueue = transcriptionQueue
    .then(async () => {
      try {
        const t = await loadTranscriber();
        const audioData = await blobToFloat32Audio(audioBlob);
        const result = await t(audioData);
        const transcript = (result?.text ?? "").trim();
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
      } finally {
        pendingTranscriptions.delete(noteId);
      }
    })
    .catch((err) => {
      console.error("Transcription queue error:", err);
      pendingTranscriptions.delete(noteId);
    });
}

function updateTranscriptInUI(noteId, transcript) {
  if (!notesList) return;
  const card = notesList.querySelector(`[data-id="${noteId}"]`);
  if (!card) return;

  const el = card.querySelector(".note-transcript");
  if (!el) return;
  if (transcript) {
    el.className = "note-transcript";
    el.textContent = transcript;
  } else {
    el.className = "note-transcript empty";
    el.textContent = "Transcription failed";
  }
}

function toneText(tone) {
  if (tone === "warm") return "Positive";
  if (tone === "heavy") return "Negative";
  return null; // neutral — don't show a label
}

function updateNoteAnalysis(noteId, tone, tags) {
  if (!notesList) return;
  const card = notesList.querySelector(`[data-id="${noteId}"]`);
  if (!card) return;

  // Build new tags row with tone label + tag chips
  const hasContent = (tags && tags.length > 0) || toneText(tone);
  const existingTagsContainer = card.querySelector(".note-tags");

  if (hasContent) {
    const tagsDiv = document.createElement("div");
    tagsDiv.className = "note-tags";

    const label = toneText(tone);
    if (label) {
      const span = document.createElement("span");
      span.className = "note-tag tone-label tone-" + tone;
      span.textContent = label;
      tagsDiv.appendChild(span);
    }

    if (tags) {
      tags.slice(0, 3).forEach((t) => {
        const span = document.createElement("span");
        span.className = "note-tag";
        span.textContent = t;
        tagsDiv.appendChild(span);
      });
    }

    if (existingTagsContainer) {
      existingTagsContainer.replaceWith(tagsDiv);
    } else {
      const progressEl = card.querySelector(".note-progress");
      if (progressEl && progressEl.parentNode) {
        progressEl.parentNode.insertBefore(tagsDiv, progressEl);
      } else {
        card.appendChild(tagsDiv);
      }
    }
  } else if (existingTagsContainer) {
    existingTagsContainer.remove();
  }
}

// ─── NLP Analysis (sentiment + tagging) ─────────────────────────────────────

let sentimentClassifier = null;
let sentimentLoadingPromise = null;

function loadSentimentModel() {
  if (sentimentClassifier) return Promise.resolve(sentimentClassifier);
  if (sentimentLoadingPromise) return sentimentLoadingPromise;

  // Wait for the transcriber to finish loading first so the two large model
  // downloads don't compete and choke the ONNX runtime / network.
  sentimentLoadingPromise = loadTranscriber()
    .catch(() => {}) // don't fail sentiment if transcriber fails
    .then(() =>
      pipeline("zero-shot-classification", "Xenova/mobilebert-uncased-mnli"),
    )
    .then((p) => {
      sentimentClassifier = p;
      return sentimentClassifier;
    })
    .catch((err) => {
      console.error("Failed to load sentiment model:", err);
      sentimentLoadingPromise = null;
      throw err;
    });

  return sentimentLoadingPromise;
}

async function analyzeNote(noteId, transcript, existingTone) {
  // Keyword-based tagging (instant, no model needed)
  const tags = tagTranscript(transcript);

  // Persist and display tags immediately so the UI never stalls.
  // Preserve the existing tone in the intermediate UI update so the pill
  // doesn't flicker away while the sentiment model loads.
  await updateNoteFields(noteId, { tags });
  updateNoteAnalysis(noteId, existingTone || null, tags);

  // Sentiment analysis via zero-shot classification (slow — downloads model)
  let tone = existingTone || null;
  try {
    const classifier = await loadSentimentModel();
    const result = await classifier(transcript, [
      "positive",
      "negative",
      "neutral",
    ]);
    const topLabel = result.labels[0];
    const topScore = result.scores[0];

    tone = "neutral";
    if (topScore > 0.5) {
      if (topLabel === "positive") tone = "warm";
      else if (topLabel === "negative") tone = "heavy";
    }
  } catch (err) {
    console.error("Sentiment analysis failed for note", noteId, err);
  }

  // Only persist tone if we actually ran sentiment (don't overwrite with null)
  if (tone) {
    await updateNoteFields(noteId, { tone });
  }
  updateNoteAnalysis(noteId, tone, tags);
}

// ─── Audio Recorder ──────────────────────────────────────────────────────────

let mediaRecorder = null;
let audioChunks = [];
// Persistent AudioContext for the mic — never closed between recordings so the
// cached stream stays alive and the browser doesn't re-prompt for permission.
let persistentAudioCtx = null;
let analyser = null;
let recordingStartTime = null;
let timerInterval = null;
let animationFrameId = null;
let cachedStream = null;

function getAudioContext() {
  if (!persistentAudioCtx || persistentAudioCtx.state === "closed") {
    persistentAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  // Resume in case the browser auto-suspended it
  if (persistentAudioCtx.state === "suspended") {
    persistentAudioCtx.resume().catch(() => {});
  }
  return persistentAudioCtx;
}

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

  // Set up Web Audio analyser for waveform using the persistent context
  const ctx = getAudioContext();
  const source = ctx.createMediaStreamSource(stream);
  analyser = ctx.createAnalyser();
  analyser.fftSize = 256;
  source.connect(analyser);

  // Determine best supported MIME type; fall back gracefully.
  let mimeType = "";
  if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported) {
    if (MediaRecorder.isTypeSupported("audio/webm;codecs=opus")) {
      mimeType = "audio/webm;codecs=opus";
    } else if (MediaRecorder.isTypeSupported("audio/webm")) {
      mimeType = "audio/webm";
    }
  }

  const options = mimeType ? { mimeType } : {};
  mediaRecorder = new MediaRecorder(stream, options);
  audioChunks = [];

  mediaRecorder.ondataavailable = (e) => {
    if (e.data.size > 0) audioChunks.push(e.data);
  };

  mediaRecorder.start(100);
  recordingStartTime = Date.now();

  if (canvas) canvas.classList.add("active");
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
    const frameId = animationFrameId;

    // Detach from module-level state immediately so a new recording
    // won't collide with this session's cleanup.
    mediaRecorder = null;
    audioChunks = [];
    analyser = null;
    animationFrameId = null;
    recordingStartTime = null;

    recorder.onstop = () => {
      const mtype = recorder.mimeType || "audio/webm";
      const blob = new Blob(chunks, { type: mtype });
      const duration = startTime
        ? Math.round((Date.now() - startTime) / 1000)
        : 0;

      // Don't stop stream tracks — keep the mic grant alive for quick re-record.
      // Don't close the AudioContext — closing it kills the stream source and
      // forces the browser to re-prompt for microphone permission.

      stopTimer();
      if (frameId) cancelAnimationFrame(frameId);
      clearWaveform();
      if (canvas) canvas.classList.remove("active");

      resolve({ blob, duration });
    };

    recorder.stop();
  });
}

// ─── Timer ───────────────────────────────────────────────────────────────────

const timerEl = document.getElementById("timer");

function startTimer() {
  if (!timerEl) return;
  timerEl.classList.add("active");
  timerInterval = setInterval(updateTimer, 200);
}

function stopTimer() {
  clearInterval(timerInterval);
  if (!timerEl) return;
  timerEl.classList.remove("active");
  timerEl.textContent = "0:00";
}

function updateTimer() {
  if (!recordingStartTime || !timerEl) return;
  const elapsed = Math.floor((Date.now() - recordingStartTime) / 1000);
  const mins = Math.floor(elapsed / 60);
  const secs = String(elapsed % 60).padStart(2, "0");
  timerEl.textContent = `${mins}:${secs}`;
}

// ─── Waveform Visualization ─────────────────────────────────────────────────

const canvas = document.getElementById("waveform");
const canvasCtx = canvas ? canvas.getContext("2d") : null;

function drawWaveform() {
  if (!analyser || !canvasCtx) return;

  const bufferLength = analyser.frequencyBinCount;
  const dataArray = new Uint8Array(bufferLength);

  function draw() {
    if (!analyser || !canvasCtx) return;
    animationFrameId = requestAnimationFrame(draw);
    analyser.getByteTimeDomainData(dataArray);

    canvasCtx.fillStyle = getComputedStyle(document.documentElement)
      .getPropertyValue("--surface")
      .trim();
    canvasCtx.fillRect(0, 0, canvas.width, canvas.height);

    canvasCtx.lineWidth = 2;
    canvasCtx.strokeStyle = "#e94560";
    canvasCtx.beginPath();

    const sliceWidth = canvas.width / bufferLength;
    let x = 0;

    for (let i = 0; i < bufferLength; i++) {
      const v = dataArray[i] / 128.0;
      const y = (v * canvas.height) / 2;
      if (i === 0) canvasCtx.moveTo(x, y);
      else canvasCtx.lineTo(x, y);
      x += sliceWidth;
    }

    canvasCtx.lineTo(canvas.width, canvas.height / 2);
    canvasCtx.stroke();
  }

  draw();
}

function clearWaveform() {
  if (!canvasCtx || !canvas) return;
  canvasCtx.fillStyle = getComputedStyle(document.documentElement)
    .getPropertyValue("--surface")
    .trim();
  canvasCtx.fillRect(0, 0, canvas.width, canvas.height);
}

// ─── UI ──────────────────────────────────────────────────────────────────────

const recordBtn = document.getElementById("record-btn");
const recordHint = document.getElementById("record-hint");
const notesList = document.getElementById("notes-list");
const emptyState = document.getElementById("empty-state");

let isRecording = false;
let currentlyPlaying = null;

if (recordBtn) {
  recordBtn.addEventListener("click", async () => {
    if (isRecording) {
      // Stop
      isRecording = false;
      recordBtn.classList.remove("recording");
      if (recordHint) recordHint.textContent = "Tap to record";

      let result;
      try {
        result = await stopRecording();
      } catch (err) {
        console.error("Failed to stop recording:", err);
      }

      if (result && result.duration > 0) {
        const note = {
          id: Date.now().toString(),
          audioBlob: result.blob,
          transcript: "",
          duration: result.duration,
          createdAt: new Date().toISOString(),
        };

        try {
          await saveNote(note);
        } catch (err) {
          console.error("Failed to save note:", err);
          return;
        }
        await renderNotes();

        // Transcribe asynchronously — UI updates when done
        enqueueTranscription(note.id, result.blob);
      }
    } else {
      // Start
      try {
        await startRecording();
        isRecording = true;
        recordBtn.classList.add("recording");
        if (recordHint) recordHint.textContent = "Tap to stop";
      } catch (err) {
        console.error("Could not start recording:", err);
        if (recordHint) recordHint.textContent = "Microphone access denied";
      }
    }
  });
}

function formatDuration(seconds) {
  if (!seconds || !isFinite(seconds)) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = String(Math.round(seconds) % 60).padStart(2, "0");
  return `${m}:${s}`;
}

function formatDate(isoString) {
  if (!isoString) return "";
  const d = new Date(isoString);
  if (isNaN(d.getTime())) return "";
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

  // Tags + tone section
  const toneLabel = toneText(note.tone);
  let tagsHTML = "";
  if (hasTranscript && !hasTags) {
    // Transcript exists but analysis not done yet
    tagsHTML = `
      <div class="note-tags analyzing">
        <span class="analyzing-text">Analyzing...</span>
      </div>`;
  } else if (hasVisibleTags || toneLabel) {
    const tonePill = toneLabel
      ? `<span class="note-tag tone-label tone-${note.tone}">${escapeHtml(toneLabel)}</span>`
      : "";
    const tagChips = hasVisibleTags
      ? note.tags
          .slice(0, 3)
          .map((t) => `<span class="note-tag">${escapeHtml(t)}</span>`)
          .join("")
      : "";
    tagsHTML = `<div class="note-tags">${tonePill}${tagChips}</div>`;
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
      if (currentlyPlaying.url) URL.revokeObjectURL(currentlyPlaying.url);
      if (notesList) {
        const otherCard = notesList.querySelector(
          `[data-id="${currentlyPlaying.noteId}"]`,
        );
        if (otherCard) {
          const otherPlay = otherCard.querySelector(".play-btn");
          const otherProgress = otherCard.querySelector(".note-progress");
          if (otherPlay) otherPlay.innerHTML = "&#9654; Play";
          if (otherProgress) otherProgress.classList.remove("visible");
        }
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

    if (!note.audioBlob) return;

    const url = URL.createObjectURL(note.audioBlob);
    const audio = new Audio(url);
    currentlyPlaying = { audio, noteId: note.id, url };

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
    try {
      if (currentlyPlaying && currentlyPlaying.noteId === note.id) {
        currentlyPlaying.audio.pause();
        if (currentlyPlaying.url) URL.revokeObjectURL(currentlyPlaying.url);
        currentlyPlaying = null;
      }
      await deleteNote(note.id);
      await renderNotes();
    } catch (err) {
      console.error("Failed to delete note:", err);
    }
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

  if (notesList) {
    notesList.innerHTML = "";
    notes.forEach((note) => notesList.appendChild(createNoteCard(note)));
  }

  if (emptyState) {
    emptyState.classList.toggle("hidden", notes.length > 0);
  }

  // Re-transcribe notes whose transcription was interrupted (e.g. page
  // reload before Whisper finished).  The audio blob is still in IndexedDB.
  notes.forEach((note) => {
    if (!note.transcript && note.audioBlob) {
      enqueueTranscription(note.id, note.audioBlob);
    }
  });

  // Recovery: fill in missing tags and/or tone for notes that already have a
  // transcript (covers first-run and upgrade from older versions).
  notes.forEach((note) => {
    if (!note.transcript) return;

    const needsTags = !Array.isArray(note.tags);
    const needsTone = !note.tone;

    if (needsTags && !needsTone) {
      // Only tags are missing — compute instantly without re-running sentiment
      // so we never flicker or risk overwriting the existing tone.
      const tags = tagTranscript(note.transcript);
      updateNoteFields(note.id, { tags }).catch(() => {});
      updateNoteAnalysis(note.id, note.tone, tags);
    } else if (needsTags || needsTone) {
      analyzeNote(note.id, note.transcript, note.tone).catch((err) => {
        console.error("Recovery analysis failed for note", note.id, err);
      });
    }
  });
}

// ─── Init ────────────────────────────────────────────────────────────────────

clearWaveform();
renderNotes().catch((err) => console.error("Failed to load notes:", err));

// Preload the Whisper model in the background so it's ready when needed
loadTranscriber().catch(() => {});

// Pre-acquire the mic stream if permission was previously granted so the user
// doesn't get re-prompted on first record click.
try {
  if (navigator.permissions && typeof navigator.permissions.query === "function") {
    navigator.permissions.query({ name: "microphone" }).then((status) => {
      if (status.state === "granted") {
        acquireMicStream().catch(() => {});
      }
      if (typeof status.addEventListener === "function") {
        status.addEventListener("change", () => {
          if (status.state === "denied" && recordHint) {
            recordHint.textContent = "Microphone access denied";
          }
        });
      }
    }).catch(() => {});
  }
} catch (_) {
  // permissions API not available
}
