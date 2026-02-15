# NLP Analysis Pipeline

*2026-02-15 by Showboat 0.5.0*

This report documents the NLP analysis pipeline integrated into the voice notes
application. The pipeline adds two capabilities that run after every
transcription: keyword-based tagging (instant, purely local) and sentiment
analysis (model-driven, lazy-loaded). Both persist their results to IndexedDB
and surface them in the card UI without blocking the transcription flow.

The implementation lives entirely in `/home/user/voice-notes/app.js` with a
supporting keyword module in `/home/user/voice-notes/tagger.js`.

---

## 1. New Import

Line 2 of `app.js` adds the `tagTranscript` function from the local tagger
module, sitting directly below the existing transformers.js import that powers
both Whisper transcription and the new sentiment classifier.

```bash
sed -n '1,2p' app.js
```

```output
import { pipeline } from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3";
import { tagTranscript } from "./tagger.js";
```

Two imports, one shared dependency: `pipeline` is the factory used to
instantiate both the Whisper ASR pipeline (line 112) and the zero-shot
classification pipeline (line 245). `tagTranscript` is a pure function -- no
model, no async, no network -- that scores a transcript against six keyword
categories and returns the top three matches.

We can confirm exactly where `tagTranscript` is called:

```bash
grep -n 'tagTranscript' app.js
```

```output
2:import { tagTranscript } from "./tagger.js";
264:  const tags = tagTranscript(transcript);
```

One import, one call site. Clean separation.

---

## 2. Generic DB Update

Before this change, the only way to write back to a note was
`updateNoteTranscript()`, which hard-coded the `transcript` field. The NLP
pipeline needs to persist two new fields (`tone` and `tags`) without adding yet
another single-purpose updater. `updateNoteFields()` solves this generically.

```bash
sed -n '72,88p' app.js
```

```output
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

The key line is `Object.assign(note, fields)`. This merges any object of
key-value pairs onto the existing note record -- `tone`, `tags`, or any future
metadata -- without knowing the schema at compile time. The function reads the
current note inside a read-write transaction, mutates it in place, then puts it
back. If the note no longer exists (deleted between transcription and analysis),
the `if (note)` guard silently skips the write.

We can verify it is called from exactly one place -- the analysis pipeline:

```bash
grep -n 'updateNoteFields' app.js
```

```output
72:async function updateNoteFields(id, fields) {
285:  await updateNoteFields(noteId, { tone, tags });
```

Line 285 passes `{ tone, tags }` -- two fields merged in a single transaction.

---

## 3. Sentiment Model Loading

The sentiment classifier uses the same singleton + caching pattern as the
Whisper transcriber. Two module-level variables gate the lifecycle: one holds
the resolved instance, the other holds the in-flight loading promise.

```bash
sed -n '238,260p' app.js
```

```output
let sentimentClassifier = null;
let sentimentLoadingPromise = null;

function loadSentimentModel() {
  if (sentimentClassifier) return Promise.resolve(sentimentClassifier);
  if (sentimentLoadingPromise) return sentimentLoadingPromise;

  sentimentLoadingPromise = pipeline(
    "zero-shot-classification",
    "Xenova/mobilebert-uncased-mnli",
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
```

Three states, three code paths:

1. **Already loaded** (`sentimentClassifier` is truthy) -- returns a resolved
   promise immediately. Zero overhead on subsequent calls.
2. **Currently loading** (`sentimentLoadingPromise` is truthy) -- returns the
   same in-flight promise so concurrent callers coalesce onto a single download.
3. **Never loaded** -- kicks off `pipeline("zero-shot-classification", ...)` and
   caches the promise.

The model is `Xenova/mobilebert-uncased-mnli`, a MobileBERT variant fine-tuned
on MultiNLI for natural language inference. Used here as a zero-shot classifier,
it scores transcript text against candidate labels without task-specific
fine-tuning.

Note the `.catch` handler: on failure it resets `sentimentLoadingPromise` to
`null`, allowing future calls to retry the download. This prevents a transient
network error from permanently poisoning the cache.

---

## 4. Analysis Pipeline

`analyzeNote()` is the orchestrator. It runs two analyses in sequence -- one
instant, one model-driven -- then persists and renders the results.

```bash
sed -n '262,289p' app.js
```

```output
async function analyzeNote(noteId, transcript) {
  // Keyword-based tagging (instant, no model needed)
  const tags = tagTranscript(transcript);

  // Sentiment analysis via zero-shot classification
  let tone = "neutral";
  try {
    const classifier = await loadSentimentModel();
    const result = await classifier(transcript, ["positive", "negative", "neutral"]);
    const topLabel = result.labels[0];
    const topScore = result.scores[0];

    if (topScore > 0.5) {
      if (topLabel === "positive") tone = "warm";
      else if (topLabel === "negative") tone = "heavy";
      // "neutral" stays as default
    }
  } catch (err) {
    console.error("Sentiment analysis failed for note", noteId, err);
    // Tone stays "neutral" on failure — non-blocking
  }

  // Persist results
  await updateNoteFields(noteId, { tone, tags });

  // Update UI
  updateNoteAnalysis(noteId, tone, tags);
}
```

The flow breaks down as follows:

1. **Keyword tagging** (line 264): `tagTranscript(transcript)` runs
   synchronously. It matches the transcript against six categories (idea, todo,
   reminder, journal, work, personal) and returns up to three tags ranked by
   keyword hit count. This always succeeds and always completes instantly.

2. **Sentiment classification** (lines 267-282): The classifier receives the
   transcript and three candidate labels: `"positive"`, `"negative"`,
   `"neutral"`. It returns ranked labels with confidence scores. The mapping
   from classifier labels to UI tone values is:
   - `"positive"` with score > 0.5 maps to `"warm"`
   - `"negative"` with score > 0.5 maps to `"heavy"`
   - Everything else (including `"neutral"`, or any label below the 0.5
     threshold) stays `"neutral"`

   The 0.5 threshold prevents low-confidence classifications from swinging
   the tone indicator on ambiguous text.

3. **Persistence** (line 285): `updateNoteFields` merges `{ tone, tags }` into
   the IndexedDB record in a single transaction.

4. **UI update** (line 288): `updateNoteAnalysis` pushes the results into the
   live DOM without a full re-render.

---

## 5. Queue Chaining

The NLP pipeline is invoked as a fire-and-forget continuation at the tail of
each transcription job inside `enqueueTranscription()`.

```bash
sed -n '165,186p' app.js
```

```output
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
```

The critical detail is on lines 177-179: `analyzeNote()` is called but its
returned promise is **not awaited**. Instead, a `.catch()` is attached to
swallow any rejection. This means:

- The transcription queue does not wait for NLP to finish before processing
  the next recording. Analysis runs concurrently in the background.
- An NLP failure logs an error but never rejects the queue's chain promise,
  so subsequent transcription jobs proceed normally.
- The `if (transcript)` guard on line 176 skips analysis for empty
  transcriptions (e.g., silence or noise that Whisper returned as whitespace).

This is a deliberate design choice: transcription is the critical path;
analysis is best-effort enrichment.

---

## 6. Live UI Update

After analysis completes, `updateNoteAnalysis()` patches the existing DOM card
with tone and tag data -- no full list re-render required.

```bash
sed -n '202,234p' app.js
```

```output
function updateNoteAnalysis(noteId, tone, tags) {
  const card = notesList.querySelector(`[data-id="${noteId}"]`);
  if (!card) return;

  // Update tone dot
  const toneDot = card.querySelector(".note-tone");
  if (toneDot) {
    toneDot.dataset.tone = tone || "neutral";
  }

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
```

Two DOM operations happen:

1. **Tone dot** (lines 207-210): The `.note-tone` element's `data-tone`
   attribute is set to `"warm"`, `"heavy"`, or `"neutral"`. CSS uses this
   attribute to color the indicator dot -- a pure data-attribute-driven style
   hook with no class juggling.

2. **Tag chips** (lines 213-233): Up to three `<span class="note-tag">` elements
   are created and wrapped in a `.note-tags` container. If an existing tags
   container is present (e.g., the "Analyzing..." placeholder rendered by
   `createNoteCard`), it is replaced via `replaceWith()`. If no container
   exists, the new one is inserted before the progress bar. If there are no
   tags at all, any existing container is removed entirely.

The `slice(0, 3)` on line 218 enforces the same three-tag cap as the tagger
itself, providing a defensive second boundary.

---

## 7. Error Isolation

NLP failures are isolated at two layers so they never block or break the
transcription pipeline.

```bash
grep -n 'catch\|non-blocking\|failure' app.js
```

```output
132:    .catch((err) => {
167:    try {
177:        analyzeNote(noteId, transcript).catch((err) => {
181:    } catch (err) {
253:    .catch((err) => {
268:  try {
279:  } catch (err) {
376:        ctx.close().catch(() => {});
499:    try {
504:    } catch (err) {
600:        currentlyPlaying.audio.play().catch(() => {
647:    audio.play().catch(() => {
687:loadTranscriber().catch(() => {});
694:      acquireMicStream().catch(() => {});
701:  }).catch(() => {});
```

The NLP-specific error boundaries are:

**Layer 1 -- Queue level (line 177):** `analyzeNote(...).catch(...)` is the
outermost boundary. Because the promise is not awaited, a rejection here is
caught by the `.catch()` handler, logged, and discarded. The transcription
queue's own promise chain is unaffected. Even if `analyzeNote` throws
synchronously (it cannot, being async, but defensively), the async function
wrapper would convert that to a rejection caught by the same `.catch()`.

**Layer 2 -- Sentiment level (lines 268-282):** Inside `analyzeNote`, the
sentiment classification is wrapped in its own `try/catch`. If the model fails
to load or the classifier throws, the error is caught, logged, and execution
continues with `tone = "neutral"`. The keyword tags (already computed before
this block) are still persisted and rendered. This means a sentiment model
failure degrades to "tags only" rather than "nothing".

**Layer 3 -- Model loader (lines 253-257):** `loadSentimentModel()` has its
own `.catch()` that resets `sentimentLoadingPromise = null` before re-throwing.
This ensures a transient failure does not permanently cache a rejected promise;
the next note will retry the model download.

The result is a graceful degradation chain:

- Full success: tone + tags displayed
- Sentiment failure: neutral tone + tags displayed
- Complete NLP failure: nothing displayed, transcription unaffected
- Transcription failure: "Transcription failed" shown, NLP never invoked

No NLP error can propagate to the user's recording or transcription experience.
