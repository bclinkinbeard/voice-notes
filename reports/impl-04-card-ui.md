# Note Card UI: Tone, Tags & Progressive States

*2026-02-15 by Showboat 0.5.0*

The `createNoteCard()` function in `app.js` went from rendering a static transcript-and-buttons card to producing a living component that progresses through four visual states as background work completes. This report walks through every piece of the new implementation: state detection, tone dot placement, tag rendering logic, the full card template, and the progressive reveal lifecycle.

---

## 1. State Detection

The function opens with four derived booleans that partition the note's lifecycle. These are computed once, at render time, and decide which variant of each sub-template gets stamped into the card.

```bash
sed -n '533,536p' /home/user/voice-notes/app.js
```

```output
  const hasTranscript = note.transcript && note.transcript.length > 0;
  const toneValue = note.tone || "neutral";
  const hasTags = Array.isArray(note.tags);
  const hasVisibleTags = hasTags && note.tags.length > 0;
```

The distinctions matter:

- **`hasTranscript`** guards against both `null`/`undefined` and empty-string transcripts. Until the Whisper pipeline finishes, this is `false`.
- **`toneValue`** defaults to `"neutral"` so the tone dot always renders with a valid `data-tone` attribute, even before sentiment analysis runs.
- **`hasTags`** checks whether `note.tags` is an array *at all*. A note that has never been analyzed has `tags: undefined`; one that has been analyzed but matched nothing has `tags: []`. This lets the template distinguish "still working" from "nothing found."
- **`hasVisibleTags`** is the narrower test: the array exists *and* is non-empty, meaning there are actual tag chips to render.

---

## 2. Tone Dot in Header

The card header now packs the tone dot and the duration badge together inside a `.note-header-right` wrapper, giving CSS a single flex container to right-align both elements.

```bash
sed -n '562,568p' /home/user/voice-notes/app.js
```

```output
    <div class="note-header">
      <span class="note-date">${formatDate(note.createdAt)}</span>
      <div class="note-header-right">
        <span class="note-tone" data-tone="${toneValue}" aria-hidden="true"></span>
        <span class="note-duration">${formatDuration(note.duration)}</span>
      </div>
    </div>
```

A few details worth noting:

- The `.note-tone` span carries `aria-hidden="true"` because the dot is a purely decorative color indicator; screen readers skip it.
- `data-tone` is set to the resolved `toneValue`, so CSS attribute selectors like `[data-tone="positive"]` can apply the correct color without any JS class toggling.
- The `.note-header-right` div groups tone and duration so they float together on the right side of the header row, while the date stays left-aligned.

We can confirm the tone dot is referenced later in the live-update path as well:

```bash
grep -n 'note-tone\|data-tone' /home/user/voice-notes/app.js
```

```output
207:  const toneDot = card.querySelector(".note-tone");
565:        <span class="note-tone" data-tone="${toneValue}" aria-hidden="true"></span>
```

Line 207 is inside `updateNoteAnalysis()`, which mutates the dot's `data-tone` attribute in place when sentiment analysis completes, transitioning it from "neutral" to its real value without rebuilding the card.

---

## 3. Tags Section Logic

The tags section uses a three-way conditional that maps directly onto the state variables from section 1.

```bash
sed -n '545,559p' /home/user/voice-notes/app.js
```

```output
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
```

The three branches:

1. **`hasTranscript && !hasTags`** -- The transcript is in, but `note.tags` is still `undefined` (analysis has not finished). The card shows an "Analyzing..." indicator with the `.analyzing` class so CSS can pulse or fade it.
2. **`hasVisibleTags`** -- Analysis is done and returned at least one tag. The tags array is sliced to a maximum of three chips, each escaped through `escapeHtml()` to prevent XSS from any model-generated tag text.
3. **Implicit else (fall-through)** -- Either there is no transcript yet (so asking for tags is premature) or tags came back as an empty array (nothing to show). `tagsHTML` stays as an empty string and the section is omitted from the DOM entirely.

This means the tags area never renders a confusing empty container -- it is either actively indicating work-in-progress, showing results, or absent.

---

## 4. Updated Card Template

Here is the complete `innerHTML` template that assembles all the pieces.

```bash
sed -n '561,578p' /home/user/voice-notes/app.js
```

```output
  card.innerHTML = `
    <div class="note-header">
      <span class="note-date">${formatDate(note.createdAt)}</span>
      <div class="note-header-right">
        <span class="note-tone" data-tone="${toneValue}" aria-hidden="true"></span>
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
```

The layout, top to bottom:

| Row | Element | Content |
|-----|---------|---------|
| 1 | `.note-header` | Date on the left, tone dot + duration on the right |
| 2 | `${transcriptHTML}` | Either the transcript text or a "Transcribing..." placeholder |
| 3 | `${tagsHTML}` | "Analyzing..." indicator, tag chips, or nothing |
| 4 | `.note-progress` | Hidden progress bar for audio playback |
| 5 | `.note-actions` | Play and Delete buttons |

The `transcriptHTML` and `tagsHTML` variables are injected as raw template strings, letting the conditional logic from sections above control exactly which DOM nodes appear without any post-render cleanup.

---

## 5. Four Card States

The combination of transcript, tone, and tags variables produces four distinct visual states a card can be in at any given moment.

### (a) Transcribing

The note was just recorded. No transcript, no tone, no tags.

- `hasTranscript = false`, `toneValue = "neutral"`, `hasTags = false`
- Transcript area shows: **"Transcribing..."** with the `.transcribing` CSS class
- Tags area: **empty** (omitted from DOM -- asking for tags before transcript exists makes no sense)
- Tone dot: rendered but set to `data-tone="neutral"` (default/inactive color)

```bash
grep -n 'transcribing\|Transcribing' /home/user/voice-notes/app.js
```

```output
542:    transcriptHTML = `<div class="note-transcript transcribing">Transcribing...</div>`;
```

### (b) Analyzing

Transcript has arrived, NLP pipeline is running.

- `hasTranscript = true`, `toneValue = "neutral"`, `hasTags = false` (tags still `undefined`)
- Transcript area shows: the actual transcript text
- Tags area shows: **"Analyzing..."** with the `.analyzing` class
- Tone dot: still `data-tone="neutral"`, waiting for sentiment result

```bash
grep -n 'analyzing\|Analyzing' /home/user/voice-notes/app.js
```

```output
212:  // Replace analyzing indicator with tags (or remove it)
550:      <div class="note-tags analyzing">
551:        <span class="analyzing-text">Analyzing...</span>
```

### (c) Fully Processed -- With Tags

Analysis complete, tags returned.

- `hasTranscript = true`, `toneValue = "positive"|"negative"|etc.`, `hasVisibleTags = true`
- Transcript area: the transcript text
- Tags area: up to three `.note-tag` chips
- Tone dot: colored according to detected sentiment

### (d) Fully Processed -- Without Tags

Analysis complete, but the model returned an empty tag set.

- `hasTranscript = true`, `toneValue = "positive"|etc.`, `hasTags = true`, `hasVisibleTags = false`
- Transcript area: the transcript text
- Tags area: **empty** (cleanly removed, no residual "Analyzing..." text)
- Tone dot: colored by sentiment

---

## 6. Progressive Reveal

The card does not wait until all data is available to render. It renders immediately with whatever the note object contains, then receives surgical DOM updates as each pipeline stage completes. Here is the data flow.

**Step 1: Card renders.** `createNoteCard()` stamps the initial template. For a brand-new recording, this means "Transcribing..." text, a neutral tone dot, and no tags section.

**Step 2: Transcript appears.** The transcription queue calls `updateTranscriptInUI()` which swaps the placeholder in place:

```bash
sed -n '189,200p' /home/user/voice-notes/app.js
```

```output
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
```

At this point the card has a transcript but tags are still `undefined` in the database. If the card were re-rendered from scratch now, it would show "Analyzing...". But since we are doing an in-place DOM update, the "Analyzing..." indicator does not appear until the *next* full `renderNotes()` cycle (or it is skipped entirely if analysis finishes fast enough).

**Step 3: "Analyzing..." shows.** If the card is re-rendered while analysis is in flight (e.g., user navigates away and back), the three-way conditional in section 3 catches `hasTranscript && !hasTags` and stamps the analyzing indicator.

**Step 4: Tone dot transitions + tags appear.** `updateNoteAnalysis()` performs the final in-place surgery:

```bash
sed -n '201,235p' /home/user/voice-notes/app.js
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

This function handles both fresh cards (where no `.note-tags` element exists yet and it must be inserted before `.note-progress`) and re-rendered cards (where the "Analyzing..." container exists and is replaced via `replaceWith()`). If analysis returned no tags, any existing tags container is simply removed.

The tone dot update is a single `dataset.tone` assignment. Because CSS styles are bound to the `data-tone` attribute (e.g., `[data-tone="positive"] { background: green }`), the dot transitions color the instant the attribute changes -- no class manipulation needed.

**The full pipeline, end to end:**

```
Record stops
  --> createNoteCard() renders with "Transcribing...", neutral dot, no tags
  --> Whisper finishes --> updateTranscriptInUI() swaps transcript text
  --> analyzeNote() kicks off (chained, non-blocking)
  --> sentiment + tags resolve --> updateNoteAnalysis() patches dot color + inserts tag chips
```

Every stage is non-destructive: the card is never torn down and rebuilt during this flow. The user sees content appear progressively, each piece fading in as it becomes available, with no layout jank or flash of empty content.
