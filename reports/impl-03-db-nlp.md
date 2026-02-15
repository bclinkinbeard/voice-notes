# Implementation Report: IndexedDB Layer + NLP Analysis Integration

## Summary of Changes

All changes were made to `/home/user/voice-notes/app.js`.

### 1. New import (line 2)
Added `import { tagTranscript } from "./tagger.js"` alongside the existing transformers.js import. This brings in the keyword-based tagging module.

### 2. `updateNoteFields()` (lines 72-88)
Generic IndexedDB update function added after `updateNoteTranscript()`. Uses a get-then-put pattern with `Object.assign()` to merge arbitrary fields (`tone`, `tags`, or any future metadata) into an existing note record without overwriting unrelated properties.

### 3. NLP Analysis section (lines 236-289)
New section between Whisper Transcription and Audio Recorder:

- **`loadSentimentModel()`** -- Lazy-loads MobileBERT (`Xenova/mobilebert-uncased-mnli`) via transformers.js `pipeline("zero-shot-classification")`. Uses the same singleton + promise-caching pattern as `loadTranscriber()`.
- **`analyzeNote(noteId, transcript)`** -- Orchestrates two analysis steps:
  1. Keyword tagging via `tagTranscript()` (synchronous, no model needed)
  2. Sentiment classification via zero-shot against labels `["positive", "negative", "neutral"]`, mapped to tone values `"warm"`, `"heavy"`, or `"neutral"`

  Persists results to IndexedDB via `updateNoteFields()` and updates the DOM via `updateNoteAnalysis()`.

### 4. Modified `enqueueTranscription()` (lines 165-185)
After successful transcription and UI update, fires `analyzeNote()` as a non-awaited promise (fire-and-forget). Failures are caught and logged but do not affect the transcription queue or block subsequent notes.

### 5. `updateNoteAnalysis()` (lines 202-234)
DOM manipulation function that:
- Sets the `data-tone` attribute on the `.note-tone` element
- Replaces any `.note-tags` container (including the "Analyzing..." indicator) with up to 3 tag chips, or removes the container if no tags exist

### 6. Updated `createNoteCard()` (lines 494-544)
The card template now renders tone and tags from persisted note data on initial load:
- Tone dot in the header with `data-tone` attribute
- "Analyzing..." placeholder when transcript exists but tags have not yet been computed
- Tag chips when `note.tags` array is populated

## Architecture Decisions

### Fire-and-forget analysis
`analyzeNote()` is deliberately not awaited inside the transcription queue. This means:
- The transcription queue advances immediately to the next note
- Sentiment model download/inference happens concurrently with subsequent transcriptions
- A single note's analysis failure cannot stall the entire pipeline

### Lazy model loading with singleton caching
Both `loadTranscriber()` and `loadSentimentModel()` follow the same pattern:
1. Return cached instance if already loaded
2. Return in-flight promise if currently loading (prevents duplicate downloads)
3. On failure, clear the promise cache so a retry is possible

This avoids downloading MobileBERT until the first transcription completes, keeping initial page load fast.

### Separation of tagging and sentiment
- **Tagging** (`tagTranscript`) is a synchronous keyword lookup -- instant, zero network cost
- **Sentiment** requires a ~25 MB model download and inference -- handled asynchronously with error isolation

## Error Handling Approach

| Layer | Strategy |
|---|---|
| `loadSentimentModel()` | Clears `sentimentLoadingPromise` on failure so future calls retry. Throws to caller. |
| `analyzeNote()` | Catches sentiment errors internally; tone defaults to `"neutral"`. Tags still persist even if sentiment fails. |
| `enqueueTranscription()` | Catches `analyzeNote()` rejection via `.catch()` -- logs but does not rethrow. Transcription queue continues. |
| `updateNoteAnalysis()` | Guards with early return if the note card no longer exists in the DOM. |

The guiding principle: analysis is additive enrichment. If it fails, the note still has its audio and transcript intact.

## Data Flow

```
stopRecording()
  |
  v
saveNote({ id, audioBlob, transcript: "", duration, createdAt })
  |
  v
enqueueTranscription(noteId, audioBlob)
  |
  +---> loadTranscriber() --> Whisper inference
  |       |
  |       v
  |     updateNoteTranscript(noteId, transcript)  -- IndexedDB write
  |     updateTranscriptInUI(noteId, transcript)  -- DOM update
  |       |
  |       v  (fire-and-forget)
  |     analyzeNote(noteId, transcript)
  |       |
  |       +---> tagTranscript(transcript)           -- instant keyword tags
  |       +---> loadSentimentModel() --> classify    -- MobileBERT inference
  |       |
  |       v
  |     updateNoteFields(noteId, { tone, tags })   -- IndexedDB write
  |     updateNoteAnalysis(noteId, tone, tags)     -- DOM update
  |
  v
  (queue advances to next note)
```

## File Changes

| File | Lines Changed | Description |
|---|---|---|
| `app.js` | Line 2 | Added `tagger.js` import |
| `app.js` | Lines 72-88 | Added `updateNoteFields()` |
| `app.js` | Lines 175-180 | Chained `analyzeNote()` in `enqueueTranscription()` |
| `app.js` | Lines 202-234 | Added `updateNoteAnalysis()` UI function |
| `app.js` | Lines 236-289 | Added NLP Analysis section (`loadSentimentModel`, `analyzeNote`) |
| `app.js` | Lines 494-544 | Updated `createNoteCard()` to render tone/tags from persisted data |
