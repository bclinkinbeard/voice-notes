# Voice Notes

A minimal, offline-first PWA for capturing voice notes on mobile. Record thoughts anytime, anywhere — no server, no account, no internet required.

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
- **IndexedDB** — local persistence of recordings and metadata
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
app.css             — all styles
app.js              — all application logic
sw.js               — service worker for offline caching
manifest.json       — PWA manifest
icons/              — app icons for manifest
```

## Performance Budget

- Total asset size: < 50 KB (excluding icons)
- No external requests required for core functionality
- Service worker installed on first visit; all subsequent loads from cache

## Code Style

- Vanilla JS, ES modules where beneficial
- Semantic HTML, minimal DOM nesting
- CSS custom properties for theming
- No classes or IDs for styling when data attributes or semantic selectors suffice
- Prefer `const` over `let`, never `var`
