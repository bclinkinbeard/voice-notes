# Voice Notes

A minimal, offline-first PWA for capturing voice notes on mobile. Record thoughts anytime, anywhere — no server, no account, no internet required.

## Quick Reference

- **Run tests:** `node tests.js`
- **Deploy:** Copy all files to any static file server (no build step)
- **Current version:** v18 (tracked in `index.html` `#app-version`, `sw.js` `CACHE_NAME`, and `tests.js` version assertions)

## Project Goals

- **Offline-first**: Full functionality with no network connection. Service worker caches all assets; IndexedDB stores all data locally.
- **Instant load**: Target < 1s first contentful paint on 3G. No frameworks, no bundlers, no build step. Ship plain HTML, CSS, and JS.
- **Static hosting**: The entire app is served from a static file server. No backend, no API, no server-side logic.
- **Mobile-first**: Designed for phone use. Touch-friendly, single-hand operable, responsive from the start.
- **Platform-native**: Use Web APIs directly — MediaRecorder for audio, IndexedDB for storage, Service Worker for offline, Web App Manifest for install.

## Tech Stack

- **HTML/CSS/JS** — no frameworks, no transpilation, no build tools
- **Service Worker** — asset caching and offline support
- **MediaRecorder API** — audio capture
- **Web Speech API** — live transcription during recording
- **IndexedDB** — local persistence of recordings and metadata
- **Web Audio API / Canvas** — oscilloscope-style waveform visualization
- **Web App Manifest** — PWA install prompt and home screen icon

## Architecture Principles

- Single-page app with no routing library. Minimal DOM manipulation via vanilla JS.
- All state lives in IndexedDB. No in-memory-only state that would be lost on refresh.
- Audio stored as blobs in IndexedDB. No external storage dependencies.
- Progressive enhancement: core record/playback works first, everything else is additive.
- No third-party dependencies. Every byte shipped is ours.

## File Structure

```
index.html          — single HTML entry point
app.js              — all application logic (~590 lines)
app.css             — all styles (~250 lines)
sw.js               — service worker for offline caching
manifest.json       — PWA manifest
tests.js            — test suite (runs via node tests.js)
icons/
  icon-192.png      — app icon (192x192)
  icon-512.png      — app icon (512x512)
```

## Code Organization (app.js)

The file is organized into clearly commented sections:

1. **DOM References** — cached `getElementById` calls at top of file
2. **State** — module-scoped `let` variables for recording state, playback, transcription
3. **IndexedDB** — `openDB()`, `saveNote()`, `getAllNotes()`, `deleteNote()`
4. **Timer Display** — `formatDuration()`, `startTimer()`, `stopTimer()`
5. **Waveform Visualization** — canvas-based oscilloscope using Web Audio API `AnalyserNode`
6. **Speech Transcription** — `startTranscription()`, `stopTranscription()` using Web Speech API
7. **Audio Recording** — `startRecording()`, `stopRecording()` using MediaRecorder
8. **Playback Cleanup** — `stopCurrentPlayback()` with URL.revokeObjectURL
9. **UI Rendering** — `formatDate()`, `createNoteCard()`, `renderNotes()`
10. **Record Button Handler** — main interaction toggle with busy guard
11. **Service Worker Registration**
12. **Initialization** — `renderNotes()` on load

## Data Schema

### Note Object (IndexedDB `notes` store, keyPath: `id`)

```js
{
  id: string,            // crypto.randomUUID()
  audioBlob: Blob,       // raw audio data
  duration: number,      // seconds (integer)
  transcription: string, // speech-to-text result (empty string if unavailable)
  createdAt: string      // ISO 8601 timestamp
}
```

### stopRecording() Return Value

```js
{ blob: Blob, duration: number, transcription: string }
```

## Testing

Tests run in Node.js with zero dependencies:

```sh
node tests.js
```

The test file (`tests.js`) uses a custom lightweight harness with `suite()`, `assert()`, and `assertEqual()`. Tests replicate pure functions from `app.js` since the app runs in browser scope. Test categories:

- **Unit tests** — `formatDuration`, `formatDate`, transcription accumulation logic
- **DOM rendering tests** — note card creation using minimal mock DOM objects
- **Async flow tests** — transcription start/stop, recognition error handling
- **Contract tests** — note schema shape, stopRecording result shape
- **XSS safety** — verifying `textContent` prevents script injection
- **Source file integrity** — grep-based checks that key functions and patterns exist in source

**Note:** 7 tests in the "Source file integrity — transcription on load" suite expect `transcribeAudioBlob` and `processUntranscribedNotes` functions that are not yet implemented in `app.js`. These are known failures for a planned feature (background transcription of existing notes on load).

## Service Worker

Strategy: **cache-first with network fallback**.

- `CACHE_NAME` in `sw.js` is versioned (currently `voice-notes-v18`)
- App shell assets are pre-cached on install: `./`, `app.css`, `app.js`, `manifest.json`, icons
- Old caches are automatically cleaned up on activation
- Audio blobs are NOT cached by the service worker (stored in IndexedDB)

### Version Bumping

**IMPORTANT:** When changing **any** cached asset (`index.html`, `app.css`, `app.js`, `manifest.json`, or icons), you **must** bump the version in **all three** places in the same commit:
1. `sw.js` — `CACHE_NAME = 'voice-notes-vN'`
2. `index.html` — `<p id="app-version">vN</p>`
3. `tests.js` — version assertions in the "Source file integrity" suite

Without this, the service worker will serve stale cached files and users won't see changes.

## Performance Budget

- Total asset size: < 50 KB (excluding icons)
- No external requests required for core functionality
- Service worker installed on first visit; all subsequent loads from cache

## Code Style

- `'use strict'` at top of JS files
- Vanilla ES6+ (const/let, arrow functions, async/await, template literals)
- Prefer `const` over `let`, never `var`
- No ES module `import`/`export`, no CommonJS `require()` — single-file architecture
- Semantic HTML, minimal DOM nesting
- CSS custom properties for theming (all defined in `:root`)
- Sectional comment headers: `// --- Section Name ---` in JS, `/* === Section === */` in CSS
- DOM elements created with `document.createElement()`, not innerHTML
- Use `textContent` (not `innerHTML`) for user-provided strings to prevent XSS
- Promise-based wrappers around IndexedDB callback API
- No classes or IDs for styling when data attributes or semantic selectors suffice
- Touch targets minimum 48px height

## CSS Architecture

Single dark theme using CSS custom properties:

```css
--bg: #1a1a2e         /* page background */
--surface: #16213e    /* card backgrounds */
--surface-2: #0f3460  /* secondary surfaces, badges */
--accent: #e94560     /* primary action color */
--accent-glow         /* button glow effect */
--text: #eee          /* primary text */
--text-muted: #999    /* secondary text */
--radius: 12px        /* standard border radius */
```

Mobile-first layout constrained to `max-width: 480px` with `100dvh` minimum height.

## Browser APIs Used

| API | Purpose |
|-----|---------|
| MediaRecorder | Audio capture with MIME type negotiation (webm/opus > webm > mp4) |
| IndexedDB | Persistent storage for notes and audio blobs |
| Service Worker | Offline caching of app shell |
| Web Speech API (SpeechRecognition) | Live transcription during recording |
| Web Audio API (AnalyserNode) | Real-time oscilloscope waveform on canvas |
| crypto.randomUUID() | Note ID generation |
| URL.createObjectURL / revokeObjectURL | Audio playback from blobs |

## Key Conventions for Making Changes

- **No dependencies.** Do not add npm packages, CDN scripts, or external resources.
- **No build step.** All files are shipped as-is. No transpilation, bundling, or minification.
- **Single-file JS.** All application logic lives in `app.js`. Do not split into modules.
- **Bump cache version** when changing any file referenced in the service worker's `SHELL` array.
- **Test after changes** by running `node tests.js`. Add tests for new pure functions.
- **Keep total asset size under 50 KB** (excluding icons).
- **Use `textContent`** for any user-provided or dynamic text to prevent XSS.
- **Clean up object URLs** with `URL.revokeObjectURL()` after audio playback ends.
