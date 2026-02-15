# Architecture Analysis: On-Device Sentiment Analysis & Auto-Tagging

## Executive Summary

Adding sentiment analysis to this app is straightforward and worth doing. Adding zero-shot classification for auto-tagging is **not worth doing** in its proposed form. The model is too large, too slow, and the results on short transcripts will be unreliable. I recommend sentiment analysis via a small DistilBERT model and keyword-based tagging instead of zero-shot classification.

---

## 1. Current Architecture Assessment

The app is clean and well-structured for a single-file vanilla JS app. Key observations:

- **Single pipeline instance** (`transcriber`) loaded lazily on first use, then cached. Good pattern.
- **Serialized queue** (`transcriptionQueue`) chains promises so only one transcription runs at a time. Necessary because Whisper is heavy.
- **IndexedDB at version 1**, single object store `notes` with keyPath `id`. No indexes.
- **Whisper tiny.en** model: ~40 MB download (q8 encoder + decoder). Already a significant payload for a web app.
- **No Web Worker** — all ML inference runs on the main thread. This is already a problem for Whisper (blocks UI during transcription), and adding more models will make it worse.

---

## 2. Model Selection — This Is Where the Proposal Needs Pushback

### 2a. Sentiment Analysis: Acceptable

**Recommended model:** `Xenova/distilbert-base-uncased-finetuned-sst-2-english`

| Quantization | Size |
|---|---|
| q8 (default WASM) | ~67 MB |
| q4 | ~125 MB (surprisingly larger than q8 due to ONNX q4 format overhead) |
| fp16 | ~134 MB |
| int8/uint8 | ~67 MB |

The **q8/int8 variant at ~67 MB** is the right choice. This is a well-understood, battle-tested model for English sentiment. It produces a simple POSITIVE/NEGATIVE label with a confidence score. For voice notes — where the user just wants a mood indicator — this is sufficient.

**Concern:** 67 MB on top of the ~40 MB Whisper model means the app now downloads ~107 MB of model data on first use. This is manageable if cached properly (transformers.js uses IndexedDB/Cache API by default), but it should be communicated to the user. A progress indicator during first load is essential.

### 2b. Zero-Shot Classification: I Recommend Against It

**Proposed model:** `Xenova/bart-large-mnli` — **1.63 GB**. Absolutely not. Even quantized, this is hundreds of megabytes.

**Smaller alternative:** `Xenova/mobilebert-uncased-mnli` — 99 MB full, **~26 MB at q8**. This is the only zero-shot model that is remotely viable for the browser.

But even with MobileBERT-MNLI at 26 MB, there are fundamental problems:

1. **Zero-shot classification quality degrades on short text.** Voice note transcripts from Whisper tiny are often 1-3 sentences, sometimes garbled. Zero-shot classification needs enough semantic content to meaningfully compare against candidate labels. On "Remind me to buy milk" it will produce low-confidence garbage across all labels.

2. **The candidate label set is a hidden design problem.** Zero-shot classification requires you to provide candidate labels at inference time. What labels? Who chooses them? If they are hardcoded (e.g., "work", "personal", "health", "shopping"), you have just built a fixed classifier with extra steps and worse performance than simple keyword matching. If the user provides custom labels, now you need UI for label management — scope creep for a small app.

3. **Inference cost per note is high.** Zero-shot classification runs the model once per candidate label (it formulates each as an NLI hypothesis). With 8 candidate labels, that is 8 forward passes through a BERT-class model per note. On a mobile device this could take several seconds.

4. **Three ML models in one page is too many.** Whisper + DistilBERT-SST2 + MobileBERT-MNLI means three separate model loads, three chunks of WASM memory, and a combined download north of 130 MB. This is getting into "the user closes the tab" territory.

### 2c. My Alternative: Keyword-Based Tagging

Replace zero-shot classification with a simple keyword/pattern matcher:

```javascript
const TAG_RULES = [
  { tag: "todo",     patterns: [/remind me/i, /don't forget/i, /need to/i, /have to/i, /todo/i] },
  { tag: "idea",     patterns: [/what if/i, /idea/i, /maybe we could/i, /how about/i] },
  { tag: "meeting",  patterns: [/meeting/i, /call with/i, /standup/i, /sync/i] },
  { tag: "personal", patterns: [/family/i, /birthday/i, /dinner/i, /vacation/i] },
  { tag: "work",     patterns: [/project/i, /deadline/i, /client/i, /sprint/i, /deploy/i] },
];

function autoTag(transcript) {
  return TAG_RULES
    .filter(rule => rule.patterns.some(p => p.test(transcript)))
    .map(rule => rule.tag);
}
```

This is:
- **Zero bytes of additional model download**
- **Sub-millisecond execution**
- **100% predictable and debuggable**
- **Easily extensible** — users could even add custom rules later
- **Works offline with no loading state**

The accuracy will be lower on edge cases than a good zero-shot model, but for a small voice notes app, it will be *right enough* and infinitely more practical. You can always upgrade to ML-based tagging later if keyword matching proves insufficient — but I predict it won't.

---

## 3. Queue Architecture: Shared vs. Separate

### Recommendation: Use the existing single queue. Do not create separate queues.

The current `transcriptionQueue` serializes work so only one heavy operation runs at a time. Sentiment analysis and tagging should be appended to the same chain, running immediately after transcription completes for each note.

**Why not separate queues?**

- Separate queues would allow sentiment/tagging to run concurrently with transcription. On a mobile device with 2-4 GB RAM, running Whisper inference simultaneously with DistilBERT inference will cause memory pressure, jank, or OOM kills.
- The operations have a natural dependency: you cannot analyze sentiment on a transcript that does not exist yet.
- A single queue is simpler to reason about, simpler to implement, and matches the existing pattern.

**Revised flow per note:**

```
enqueueTranscription(noteId, audioBlob)
  └─> transcribe(audioBlob)          → save transcript
      └─> analyzeSentiment(transcript) → save sentiment
          └─> autoTag(transcript)      → save tags
              └─> updateUI(noteId)
```

If keyword-based tagging is used (as I recommend), the `autoTag` step is synchronous and adds zero latency. The whole post-transcription enrichment step becomes just the sentiment analysis call.

**If zero-shot classification were used instead**, it absolutely must be in the same queue, because running two BERT models concurrently in WASM is asking for trouble.

---

## 4. IndexedDB Schema Migration

### Current schema (version 1):
```
notes: { id, audioBlob, transcript, duration, createdAt }
```

### Target schema (version 2):
```
notes: { id, audioBlob, transcript, duration, createdAt, sentiment, tags }
```

Where:
- `sentiment`: `{ label: "POSITIVE"|"NEGATIVE", score: 0.0-1.0 }` or `null`
- `tags`: `string[]` (e.g., `["todo", "work"]`) or `[]`

### Migration strategy:

Bump `DB_VERSION` to 2. In the `onupgradeneeded` handler, no structural changes to the object store are needed — IndexedDB is schema-less for record fields. You only need to create an index if you want to query by sentiment or tags.

```javascript
const DB_VERSION = 2;

req.onupgradeneeded = (event) => {
  const db = req.result;
  const oldVersion = event.oldVersion;

  if (oldVersion < 1) {
    db.createObjectStore(STORE_NAME, { keyPath: "id" });
  }

  // No structural migration needed for v2.
  // New fields (sentiment, tags) are simply absent on old records
  // and will be populated when the user opens a note or on next analysis pass.
};
```

**Do NOT iterate existing records with a cursor to backfill defaults.** This is unnecessary overhead. Instead, handle missing fields at read time:

```javascript
const sentiment = note.sentiment || null;
const tags = note.tags || [];
```

This is the simplest, safest migration path. Old records without sentiment/tags just render without them. If you want to backfill, do it lazily — when a note card is rendered and has a transcript but no sentiment, queue it for analysis.

**Optional index for filtering by tag:**

If you later want to filter notes by tag (e.g., "show me all 'todo' notes"), you would need a multi-entry index:

```javascript
if (oldVersion < 2) {
  const store = event.target.transaction.objectStore(STORE_NAME);
  store.createIndex("tags", "tags", { multiEntry: true });
}
```

But I would defer this until filtering is actually implemented. Do not add indexes speculatively.

---

## 5. Model Loading Strategy: Lazy, Not Eager

### Current behavior:
Whisper is loaded eagerly on page load (`loadTranscriber().catch(() => {})` at the bottom of `app.js`). This is a reasonable choice because every user session will likely involve recording.

### For the sentiment model:
**Load lazily, on first use.** Do not eagerly load it.

Reasons:
- The user may open the app to listen to existing notes, not to record new ones. Loading a 67 MB model for nothing wastes bandwidth and memory.
- Eagerly loading two models on page load means two simultaneous large downloads competing for bandwidth and two model initializations competing for CPU. This will make the app feel sluggish on load.
- The sentiment model is only needed after a transcription completes. There is a natural delay (recording time + transcription time) before it is first needed. Load it during that window.

**Concrete approach:**

```javascript
let sentimentAnalyzer = null;
let sentimentLoadingPromise = null;

function loadSentimentAnalyzer() {
  if (sentimentAnalyzer) return Promise.resolve(sentimentAnalyzer);
  if (sentimentLoadingPromise) return sentimentLoadingPromise;

  sentimentLoadingPromise = pipeline(
    "sentiment-analysis",
    "Xenova/distilbert-base-uncased-finetuned-sst-2-english",
    { dtype: "q8" }
  )
    .then((p) => { sentimentAnalyzer = p; return p; })
    .catch((err) => { sentimentLoadingPromise = null; throw err; });

  return sentimentLoadingPromise;
}
```

This mirrors the existing `loadTranscriber()` pattern exactly. Consistency matters in a single-file app.

**Optional optimization:** Start loading the sentiment model as soon as the user presses "record" (not on page load, but before transcription finishes). This gives the model a head start while the user is still speaking.

---

## 6. Error Handling: NLP Failure Must Not Block the Core Flow

This is critical. The app's primary value is recording and transcribing voice notes. Sentiment and tagging are nice-to-have enrichments. If they fail, the user should not notice.

### Principles:

1. **Transcription failure** = show "Transcription failed" (existing behavior). Correct.
2. **Sentiment failure** = save the note with `sentiment: null`. Render the card without a sentiment badge. Log the error. Do not retry automatically.
3. **Tagging failure** = save the note with `tags: []`. Render without tags. (With keyword-based tagging, failure is essentially impossible unless the code itself has a bug.)
4. **Model load failure** = do not block subsequent transcriptions. If the sentiment model fails to download, skip sentiment for all notes in this session. Show a subtle status message, not an alert.

### Implementation in the queue:

```javascript
transcriptionQueue = transcriptionQueue.then(async () => {
  try {
    const t = await loadTranscriber();
    const audioData = await blobToFloat32Audio(audioBlob);
    const result = await t(audioData);
    const transcript = result.text.trim();
    await updateNoteTranscript(noteId, transcript);

    // Enrichment — failures here are non-fatal
    let sentiment = null;
    let tags = [];
    try {
      const analyzer = await loadSentimentAnalyzer();
      const sentimentResult = await analyzer(transcript);
      sentiment = sentimentResult[0]; // { label, score }
    } catch (err) {
      console.warn("Sentiment analysis failed for note", noteId, err);
    }
    tags = autoTag(transcript); // keyword-based, cannot throw

    await updateNoteEnrichment(noteId, sentiment, tags);
    updateFullUI(noteId, transcript, sentiment, tags);
  } catch (err) {
    console.error("Transcription failed for note", noteId, err);
    updateTranscriptInUI(noteId, null);
  }
});
```

The key pattern: transcription failure is a hard error (the note is useless without it), but enrichment failure is soft (the note is still useful).

---

## 7. Code Organization in a Single-File App

The app is ~565 lines. Adding sentiment + keyword tagging will bring it to roughly 650-700 lines. This is still manageable in a single file **if you maintain the existing section comment pattern.**

### Recommended section structure:

```
// ─── IndexedDB Storage ───────────────
// ─── Whisper Transcription ───────────
// ─── Sentiment Analysis ──────────────   ← NEW
// ─── Auto-Tagging ────────────────────   ← NEW
// ─── Audio Recorder ──────────────────
// ─── Timer ───────────────────────────
// ─── Waveform Visualization ──────────
// ─── UI ──────────────────────────────
// ─── Init ────────────────────────────
```

### What NOT to do:

- **Do not introduce ES modules or a build step** for this. The app works as a single `<script type="module">` loading from CDN. Splitting into `sentiment.js`, `tagger.js`, etc. adds import management overhead with minimal benefit at this scale.
- **Do not introduce classes or a state management pattern.** The app uses plain functions and module-scoped variables. Adding a `NoteProcessor` class or a pub/sub event bus is over-engineering for a 700-line app.
- **Do not create a generic "NLP pipeline manager"** that abstracts over different model types. You have two pipelines (transcription and sentiment). Write two loader functions that look alike. Duplication is cheaper than the wrong abstraction.

### What IS worth doing:

- Generalize `updateNoteTranscript()` into a broader `updateNote()` function that can write any subset of fields, so you are not creating `updateNoteSentiment()`, `updateNoteTags()`, etc.

```javascript
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
```

Then: `await updateNoteFields(noteId, { transcript, sentiment, tags });` — one write instead of three.

---

## 8. UI Rendering Considerations

A few concrete points for the implementation:

- **Sentiment** should be a small colored badge on the note card: a green/red pill showing "Positive"/"Negative" or just an icon. Do not show the raw confidence score — it means nothing to end users.
- **Tags** should be small pills below the transcript. Tapping a tag could filter notes (future feature), but initially they are just visual indicators.
- **While analyzing**, show nothing. Do not add a "Analyzing sentiment..." spinner. The analysis takes <1 second on a DistilBERT model. By the time the user reads the transcript, the sentiment badge will already be there. If it is not (because the model is still loading), it simply appears a moment later. No need to draw attention to the processing.
- **For notes that predate the feature**, render them without sentiment/tags. Do not backfill all old notes on upgrade — this would block the queue for minutes if the user has many notes.

---

## 9. Summary of Recommendations

| Decision | Recommendation |
|---|---|
| Sentiment model | `Xenova/distilbert-base-uncased-finetuned-sst-2-english` at q8 (~67 MB) |
| Tagging approach | **Keyword-based regex matching, NOT zero-shot classification** |
| Queue architecture | Single shared queue; sentiment runs after transcription in same chain |
| Model loading | Lazy — load sentiment model on first transcription, not on page load |
| IndexedDB migration | Bump to version 2; no cursor migration; handle missing fields at read time |
| Error handling | Soft failures for enrichment; hard failures only for transcription |
| Code organization | New sections in same file; generalize `updateNoteFields()`; no classes or build step |
| Backfill old notes | Do not backfill on upgrade; enrich lazily if/when needed |

## 10. Risks and Open Questions

1. **Main thread blocking.** Both Whisper and DistilBERT run inference on the main thread via WASM. During transcription + sentiment analysis, the UI will be unresponsive. For this iteration, this is probably acceptable (notes are short, inference is fast). But the next iteration should seriously consider moving all ML inference to a Web Worker. This is a structural change that is easier to do before adding more models, not after.

2. **Total model payload.** ~107 MB of models (Whisper + DistilBERT) downloaded and cached on first use. On slow mobile connections, this is painful. Consider showing a one-time "Setting up AI features..." screen on first load with a combined progress bar.

3. **Whisper transcript quality.** Whisper tiny produces noisy transcripts. Sentiment analysis on a garbled transcript will produce garbled sentiment. There is no fix for this at the architecture level — it is an inherent limitation of using the smallest possible speech model. If sentiment results are bad in practice, the problem is probably Whisper, not DistilBERT.

4. **Expandability of keyword tagging.** The proposed keyword rules are just a starting point. If users want custom tags, this becomes a settings/preferences feature requiring additional UI and storage. Defer this until there is evidence users want it.
