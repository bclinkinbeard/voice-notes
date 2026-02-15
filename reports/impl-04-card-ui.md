# Implementation Report: Note Card UI Enhancements

## Summary

Updated the `createNoteCard()` function in `app.js` to render three new UI elements: a tone indicator dot in the card header, tag chips below the transcript, and an "Analyzing..." state shown while tone/tag analysis is pending.

## Card States

The note card now supports four distinct visual states:

1. **Transcribing** -- No transcript yet. Shows "Transcribing..." placeholder. No tags section rendered. Tone dot defaults to `neutral`.
2. **Analyzing** -- Transcript exists but `note.tags` is not yet set (not an array). Shows the transcript text and an "Analyzing..." indicator in place of tags.
3. **With Tags** -- Transcript and tags both present (`note.tags` is a non-empty array). Displays up to 3 tag chips below the transcript.
4. **No Tags** -- Transcript exists and `note.tags` is an empty array (analysis complete, nothing found). Neither tags nor analyzing indicator is shown.

## Conditional Rendering Logic

### Tone Dot
- Always rendered inside a new `.note-header-right` wrapper alongside the duration.
- Uses `note.tone` if available; falls back to `"neutral"`.
- Output: `<span class="note-tone" data-tone="..." aria-hidden="true"></span>`.
- Styling is driven by CSS via the `data-tone` attribute.

### Tags Section
- **Analyzing state**: rendered when `hasTranscript && !Array.isArray(note.tags)`. Produces a `.note-tags.analyzing` div with an `.analyzing-text` span.
- **Tag chips**: rendered when `Array.isArray(note.tags) && note.tags.length > 0`. Tags are capped at 3 via `.slice(0, 3)` and escaped with `escapeHtml()`.
- **Empty/omitted**: when tags is an empty array or when there is no transcript, `tagsHTML` stays as an empty string and nothing is injected.

## File Changes

| File | Lines | Change |
|------|-------|--------|
| `app.js` | ~499-544 | Replaced template generation in `createNoteCard()` to add tone dot, header-right wrapper, tags/analyzing section |

Event listener code (play, delete) was not modified.
