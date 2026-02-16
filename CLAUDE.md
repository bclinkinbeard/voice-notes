# Voice Notes

A minimal, offline-first PWA for capturing voice notes and task lists on mobile. Record thoughts, track to-dos, and organize with lists — no server, no account, no internet required.

## Quick Reference

- **Dev server:** `npm run dev` (Vite)
- **Run tests:** `node tests.js`
- **Build:** `npm run build` (outputs to `dist/`)
- **Current version:** v23 (tracked in `index.html` `#app-version`, `public/sw.js` `CACHE_NAME`, and `tests.js` version assertions)

## Project Goals

- **Offline-first**: Full functionality with no network connection. Service worker caches all assets; IndexedDB stores all data locally.
- **Instant load**: Target < 1s first contentful paint on 3G. No frameworks. Ship plain HTML, CSS, and JS.
- **Static hosting**: The entire app is served from a static file server. No backend, no API, no server-side logic.
- **Mobile-first**: Designed for phone use. Touch-friendly, single-hand operable, responsive from the start.
- **Platform-native**: Use Web APIs directly — MediaRecorder for audio, IndexedDB for storage, Service Worker for offline, Web App Manifest for install.

## Tech Stack

- **HTML/CSS/JS** — no UI frameworks, no transpilation
- **Vite** — dev server and production build (dev dependency only)
- **Service Worker** — asset caching and offline support
- **MediaRecorder API** — audio capture
- **Web Speech API** — live transcription during recording
- **IndexedDB** — local persistence of recordings, lists, and metadata
- **Web Audio API / Canvas** — oscilloscope-style waveform visualization
- **Web App Manifest** — PWA install prompt and home screen icon
- **@huggingface/transformers** — local sentiment analysis (DistilBERT model, runs in-browser)

## Architecture Principles

- Single-page app with no routing library. Two views (lists view, list detail view) toggled via JS.
- All state lives in IndexedDB. No in-memory-only state that would be lost on refresh (theme preference stored in localStorage).
- Audio stored as blobs in IndexedDB. No external storage dependencies.
- Progressive enhancement: core record/playback works first, everything else is additive.
- ES module imports between app files (`app.js` imports from `analysis.js`).
- Sentiment analysis model loads lazily on first use and runs entirely in-browser.

## File Structure

```
index.html                        — single HTML entry point
app.js                            — main application logic (~1400 lines)
app.css                           — all styles (~930 lines)
analysis.js                       — keyword categorization + sentiment analysis (~94 lines)
tests.js                          — test suite (~1510 lines, run via node tests.js)
package.json                      — npm scripts and dependencies
vite.config.js                    — Vite build configuration
public/
  sw.js                           — service worker for offline caching
  manifest.json                   — PWA manifest
  icons/
    icon-192.png                  — app icon (192x192)
    icon-512.png                  — app icon (512x512)
  design-variations/              — theme mockup HTML files (aurora, frost, neon, showboat)
```

## Code Organization (app.js)

The file is organized into clearly commented sections:

1. **Constants** — `DEFAULT_LIST_ID`, `MODE_DESCRIPTIONS`
2. **DOM References** — cached `getElementById` calls at top of file
3. **State** — module-scoped `let` variables for recording state, playback, transcription, lists, drag, filters
4. **IndexedDB** — `openDB()`, `migrateNotesToDefaultList()`, `saveNote()`, `getAllNotes()`, `getNotesByList()`, `deleteNote()`, `deleteNotesByList()`, `saveList()`, `getAllLists()`, `getList()`, `deleteList()`
5. **Timer Display** — `formatDuration()`, `startTimer()`, `stopTimer()`
6. **Waveform Visualization** — canvas-based oscilloscope using Web Audio API `AnalyserNode`
7. **Speech Transcription** — `startTranscription()`, `stopTranscription()` using Web Speech API
8. **Transcription Cleaning** — `cleanFillersFromTranscription()` removes filler words (umm, uh, etc.)
9. **Transcription Splitting** — `splitTranscriptionOnAnd()` splits accomplish-mode entries on "and"
10. **Audio Recording** — `startRecording()`, `stopRecording()` using MediaRecorder
11. **Playback Cleanup** — `stopCurrentPlayback()` with `URL.revokeObjectURL`
12. **UI Rendering** — `formatDate()`, `createNoteCard()`, `createListCard()`, `renderLists()`, `renderFilterBar()`, `renderListDetail()`
13. **Drag-to-Reorder (Accomplish Mode)** — touch-based drag reordering with `startDrag()`, `onDragMove()`, `onDragEnd()`
14. **Background Analysis** — `processUnanalyzedNotes()` runs categorization and sentiment on new notes
15. **View Navigation** — `showListsView()`, `showListDetailView()`
16. **List Modal** — `openListModal()`, `closeListModal()`, `updateModeSelector()`
17. **List Detail Actions** — rename and delete list button handlers
18. **Record Button Handler** — main interaction toggle with busy guard
19. **Theme** — `applyTheme()`, theme picker event handling, localStorage persistence
20. **Service Worker Registration**
21. **Initialization** — `renderLists()` on load, theme restore, sentiment model preload

## Code Organization (analysis.js)

Separated module for note analysis:

1. **Keyword-Based Categorization** — `CATEGORY_KEYWORDS` dictionary mapping 8 categories (todo, idea, question, reminder, work, personal, health, finance) to keyword arrays. `categorizeNote()` returns matched categories.
2. **Sentiment Analysis** — `analyzeSentiment()` uses `@huggingface/transformers` with the `Xenova/distilbert-base-uncased-finetuned-sst-2-english` model (quantized to q8). Lazy-loaded on first call. Returns `{ label, score }` where label is positive/negative/neutral.
3. **Combined Analysis** — `analyzeNote()` runs both categorization and sentiment. `preloadSentimentModel()` triggers eager model loading.

## Data Schema

### IndexedDB Database: `voiceNotesDB` (version 2)

#### Note Object (`notes` store, keyPath: `id`, index: `listId`)

```js
{
  id: string,            // crypto.randomUUID()
  audioBlob: Blob|null,  // raw audio data (null for accomplish-mode text-only notes)
  duration: number,      // seconds (integer, 0 for text-only)
  transcription: string, // speech-to-text result (empty string if unavailable)
  createdAt: string,     // ISO 8601 timestamp
  listId: string,        // references a list ID (default: 'default')
  completed: boolean,    // task completion state (accomplish mode)
  categories: string[],  // auto-detected categories from analysis.js
  sentiment: string      // 'positive', 'negative', or 'neutral'
}
```

#### List Object (`lists` store, keyPath: `id`)

```js
{
  id: string,            // crypto.randomUUID() or 'default'
  name: string,          // user-provided list name
  mode: string,          // 'capture' or 'accomplish'
  createdAt: string,     // ISO 8601 timestamp
  noteOrder: string[]    // ordered array of note IDs (for drag reordering)
}
```

### List Modes

- **Capture** — Records voice notes with audio playback. Audio blob is saved. Notes display transcription, play button, and progress bar.
- **Accomplish** — Speak to-do items that become a checklist. Audio is discarded (only transcription text is saved). Entries spoken with "and" are automatically split into separate items. Supports checkboxes and drag-to-reorder.

### stopRecording() Return Value

```js
{ blob: Blob, duration: number, transcription: string }
```

## Testing

Tests run in Node.js with zero runtime dependencies:

```sh
node tests.js
```

The test file (`tests.js`) uses a custom lightweight harness with `suite()`, `assert()`, and `assertEqual()`. Tests replicate pure functions from `app.js` since the app runs in browser scope. **295 tests, all passing.**

Test categories:

- **Unit tests** — `formatDuration`, `formatDate`, `formatTranscriptionSegment`, `cleanFillersFromTranscription`, `splitTranscriptionOnAnd`, `categorizeNote`
- **DOM rendering tests** — note card creation (capture mode, accomplish mode, completed state, empty transcription, legacy notes, text-only notes, audio notes, categories/sentiment tags), list card creation
- **Async flow tests** — transcription start/stop, recognition error handling
- **Contract tests** — note schema shape, list schema shape, stopRecording result shape
- **Note ordering tests** — createdAt ordering, noteOrder respect, completed-items-sink behavior
- **Migration tests** — notes get default listId, existing listId preserved
- **Transcription simulation tests** — `transcribeAudioBlob` and `processUntranscribedNotes` simulations (planned feature)
- **Analysis tests** — categorization matching, sentiment tag rendering
- **XSS safety** — verifying `textContent` prevents script injection
- **Source file integrity** — checks that key functions, patterns, classes, and version numbers exist in source files

## Service Worker

Located at `public/sw.js`. Strategy: **cache-first with network fallback**.

- `CACHE_NAME` in `sw.js` is versioned (currently `voice-notes-v23`)
- App shell assets are pre-cached on install: `./`, `app.css`, `app.js`, `manifest.json`, icons
- Old caches are automatically cleaned up on activation
- Audio blobs are NOT cached by the service worker (stored in IndexedDB)

### Version Bumping

**IMPORTANT:** When changing **any** cached asset (`index.html`, `app.css`, `app.js`, `manifest.json`, or icons), you **must** bump the version in **all three** places in the same commit:
1. `public/sw.js` — `CACHE_NAME = 'voice-notes-vN'`
2. `index.html` — `<p id="app-version">vN</p>`
3. `tests.js` — version assertions in the "Source file integrity" suite (search for current version string)

Without this, the service worker will serve stale cached files and users won't see changes.

## Themes

Four built-in color themes, selectable via swatches in the header. Theme preference is persisted in `localStorage` under key `voice-notes-theme`.

| Theme | Accent | Background |
|-------|--------|------------|
| Midnight (default) | `#e94560` (red-pink) | `#1a1a2e` (dark blue) |
| Aurora | `#f4845f` (warm gradient) | `#1c1017` (dark warm) |
| Frost | `#2563eb` (blue) | `#f4f5f7` (light gray — light theme) |
| Neon | `#00e5ff` (cyan) | `#0a0a0a` (near-black) |

CSS custom properties (defined in `:root` and overridden per `[data-theme]`):

```css
--bg             /* page background */
--surface        /* card backgrounds */
--surface-2      /* secondary surfaces, badges */
--accent         /* primary action color */
--accent-glow    /* button glow effect */
--accent-bg      /* accent background tint */
--text           /* primary text */
--text-muted     /* secondary text */
--radius         /* standard border radius */
--waveform-fill  /* waveform canvas background */
```

Mobile-first layout constrained to `max-width: 480px` with `100dvh` minimum height.

## CSS Architecture (app.css)

Organized into sections with `/* ======== Section ======== */` headers:

1. **Custom Properties** — `:root` variables and theme overrides (Aurora, Frost, Neon)
2. **Reset & Base** — box-sizing, body, scrollbar styles
3. **Header** — app title, version, theme picker swatches
4. **Lists View** — list overview layout, "How to use" collapsible guide
5. **List Cards** — card styling with mode badge and note count
6. **List Detail View** — detail header with name, mode label, action buttons
7. **Recorder** — timer, waveform canvas, record button with glow animation
8. **Note Cards** — card layout, play button, progress bar, transcription text, checkbox (accomplish)
9. **Accomplish Mode** — drag handle, completed state, checkbox styling
10. **List Modal** — create/edit list dialog with backdrop
11. **Analysis Tags & Filter Bar** — category/sentiment tag chips, filter chip bar
12. **Utilities** — hidden class, empty states, responsive adjustments

## Browser APIs Used

| API | Purpose |
|-----|---------|
| MediaRecorder | Audio capture with MIME type negotiation (webm/opus > webm > mp4) |
| IndexedDB | Persistent storage for notes, lists, and audio blobs |
| Service Worker | Offline caching of app shell |
| Web Speech API (SpeechRecognition) | Live transcription during recording |
| Web Audio API (AnalyserNode) | Real-time oscilloscope waveform on canvas |
| crypto.randomUUID() | Note and list ID generation |
| URL.createObjectURL / revokeObjectURL | Audio playback from blobs |
| Touch Events | Drag-to-reorder in accomplish mode |
| localStorage | Theme preference persistence |

## Key Conventions for Making Changes

- **Minimal dependencies.** The only runtime dependency is `@huggingface/transformers` for sentiment analysis. Do not add additional npm packages, CDN scripts, or external resources without strong justification.
- **Vite for dev/build only.** Vite is a dev dependency for the dev server and production build. The app still ships as plain HTML/CSS/JS with no transpilation of application code.
- **Two JS files.** Application logic lives in `app.js` and `analysis.js`. `analysis.js` handles categorization and sentiment. Do not add more JS files without strong justification.
- **Bump cache version** when changing any file referenced in the service worker's `SHELL` array.
- **Test after changes** by running `node tests.js`. Add tests for new pure functions. All 295 tests must pass.
- **Use `textContent`** for any user-provided or dynamic text to prevent XSS.
- **Clean up object URLs** with `URL.revokeObjectURL()` after audio playback ends.
- **Touch targets minimum 48px** for mobile usability.
- **ES modules** — `app.js` uses `import` from `analysis.js`. The HTML loads `app.js` with `type="module"`.

## Code Style

- `'use strict'` at top of JS files
- Vanilla ES6+ (const/let, arrow functions, async/await, template literals)
- Prefer `const` over `let`, never `var`
- ES module `import`/`export` between app files; no CommonJS `require()`
- Semantic HTML, minimal DOM nesting
- CSS custom properties for theming (defined in `:root`, overridden per `[data-theme]`)
- Sectional comment headers: `// --- Section Name ---` in JS, `/* ======== Section ======== */` in CSS
- DOM elements created with `document.createElement()`, not innerHTML
- Use `textContent` (not `innerHTML`) for user-provided strings to prevent XSS
- Promise-based wrappers around IndexedDB callback API
- No classes or IDs for styling when data attributes or semantic selectors suffice
- Touch targets minimum 48px height
