# UX/UI Specification: On-Device Sentiment Analysis & Auto-Tagging

## Executive Summary

This spec adds two features to voice note cards: a **tone indicator** (sentiment) and **auto-generated tags**. The guiding principle is **additive subtlety** -- these features should enrich note cards without disrupting the existing minimal aesthetic. Everything below is designed to be implementable within the current single-file CSS/HTML/JS architecture.

---

## 1. Design Decisions & Rationale

### 1.1 Sentiment: "Tone" not "Sentiment"

**Decision: Use the word "tone" internally and never surface the word "sentiment" or "negative" to users.**

Labeling someone's personal voice note as "negative" is presumptuous and potentially off-putting. A user venting about their day does not need software passing judgment. Instead, we use a subtle **tone dot** -- a small colored circle that communicates emotional valence without labeling it. No text label accompanies the dot on the card. The color speaks for itself, and users who do not care can completely ignore it.

Terminology mapping:
- Positive sentiment = **warm** (internally). No user-facing label needed.
- Neutral sentiment = **neutral** (internally). No user-facing label needed.
- Negative sentiment = **heavy** (internally). No user-facing label needed.

The dot is decorative context, not a verdict.

### 1.2 Tags: Constrained Vocabulary, Read-Only for v1

**Decision: Use a fixed set of 6 tag categories. Read-only. No user editing in v1.**

Rationale: Open-ended tagging from NLP will produce inconsistent, confusing labels. A constrained vocabulary keeps the UI predictable and the chips visually consistent. Users do not need to edit auto-tags in v1 -- the value proposition is zero-effort organization, not manual curation. If classification confidence is low, show no tags rather than wrong tags.

**Tag vocabulary (6 categories):**

| Tag       | Use case                                      |
|-----------|-----------------------------------------------|
| `idea`    | Creative thoughts, brainstorming, "what if"   |
| `todo`    | Action items, tasks, "I need to", "don't forget" |
| `reminder`| Time-sensitive notes, appointments, deadlines  |
| `journal` | Reflections, personal thoughts, diary entries  |
| `work`    | Professional context, meetings, projects       |
| `personal`| Family, health, relationships, life admin      |

A note can have **0 to 3 tags maximum** displayed. If the classifier returns more, show the top 3 by confidence. If confidence is below threshold for all categories, show zero tags. Empty is better than wrong.

### 1.3 Filtering: Not in v1

**Decision: No filter/search UI for v1. This is over-engineering.**

With fewer than ~50 notes, visual scanning is faster than filter interaction. Tags add glanceable context but do not yet need to be actionable. Adding a filter bar would consume 48-60px of vertical space, push content down, and add interaction complexity for a feature with minimal payoff at low note counts. Revisit when users have 100+ notes.

### 1.4 User-Editing of Tags: Not in v1

**Decision: Tags are read-only in v1.**

Adding edit/remove affordances (X buttons on chips, long-press menus) would triple the interaction surface area for a feature that should feel automatic. If auto-tagging is good enough, editing is unnecessary. If it is bad, we fix the model, not add manual overrides.

---

## 2. Note Card Layout Specification

### 2.1 Current Card Structure (for reference)

```
+------------------------------------------+
| Dec 15, 2025                       0:42  |  <- .note-header
|                                          |
| Transcript text goes here and can        |  <- .note-transcript
| wrap to multiple lines...                |
|                                          |
| [============================]           |  <- .note-progress (when playing)
|                                          |
| [ > Play              ]  [ trash ]       |  <- .note-actions
+------------------------------------------+
```

### 2.2 New Card Structure

```
+------------------------------------------+
| Dec 15, 2025              * warm   0:42  |  <- .note-header (tone dot added)
|                                          |
| Transcript text goes here and can        |  <- .note-transcript
| wrap to multiple lines...                |
|                                          |
| [idea] [work]                            |  <- .note-tags (NEW row)
|                                          |
| [============================]           |  <- .note-progress (when playing)
|                                          |
| [ > Play              ]  [ trash ]       |  <- .note-actions
+------------------------------------------+
```

Key changes:
1. **Tone dot** inserted into `.note-header`, between `.note-date` and `.note-duration`
2. **Tags row** inserted between `.note-transcript` and `.note-progress`

---

## 3. Tone Indicator Specification

### 3.1 Visual Design

The tone indicator is a **6px diameter circle** placed in the note header row. It sits to the left of the duration badge, separated by 8px. It has no text label, no tooltip, no interaction. It is purely ambient information.

**Color mapping:**

| Internal tone | Dot color  | CSS value  | Rationale                                    |
|---------------|------------|------------|----------------------------------------------|
| warm          | Soft green | `#4ade80`  | Matches existing "ready" status color         |
| neutral       | Muted blue | `#64748b`  | Blends with the muted text, almost invisible  |
| heavy         | Muted amber| `#f59e0b`  | Warm caution, NOT red. Red = error/delete     |

**Critical design choice:** The "heavy" tone is amber, NOT red. Red (`--accent: #e94560`) is already used for the record button, duration badge, delete hover, and accent actions. Using red for negative sentiment would create false visual association with errors or danger. Amber reads as "warm caution" -- noticeable but not alarming.

The neutral dot is intentionally low-contrast (`#64748b` on `#16213e` surface). Most notes will be neutral, and the dot should nearly disappear for the common case, only drawing attention for warm or heavy tones.

### 3.2 HTML Structure

The tone dot is added inside `.note-header`, between the date and the right-side group:

```html
<div class="note-header">
  <span class="note-date">Dec 15, 2025</span>
  <div class="note-header-right">
    <span class="note-tone" data-tone="warm"></span>
    <span class="note-duration">0:42</span>
  </div>
</div>
```

The `.note-header-right` wrapper groups the tone dot and duration badge so they stay aligned together on the right side of the header.

### 3.3 CSS

```css
.note-header-right {
  display: flex;
  align-items: center;
  gap: 8px;
}

.note-tone {
  display: block;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #64748b;       /* default: neutral */
  flex-shrink: 0;
  transition: background 0.3s ease;
}

.note-tone[data-tone="warm"] {
  background: #4ade80;
}

.note-tone[data-tone="neutral"] {
  background: #64748b;
}

.note-tone[data-tone="heavy"] {
  background: #f59e0b;
}
```

No new CSS variables are introduced for these colors. They are one-off values scoped to the tone indicator. If we later need to reference them elsewhere, we can promote them to variables at that point.

### 3.4 Accessibility

The tone dot is purely decorative. It should have `aria-hidden="true"` to avoid confusing screen readers. The tone data is ambient, not actionable, and there is no text equivalent needed for v1.

```html
<span class="note-tone" data-tone="warm" aria-hidden="true"></span>
```

---

## 4. Auto-Tags Specification

### 4.1 Visual Design

Tags are rendered as **pill-shaped chips** in a horizontal row below the transcript. They use a translucent background tinted with `--surface-2` and muted text, following the same visual pattern as the existing `.note-duration` badge but with a more subdued color palette.

**Chip styling:**
- Font size: `0.7rem` (slightly smaller than duration badge's `0.75rem`)
- Padding: `2px 10px`
- Border radius: `99px` (full pill shape, matching `.note-duration`)
- Background: `rgba(100, 116, 139, 0.2)` (slate-tinted translucency)
- Text color: `#94a3b8` (muted slate, less prominent than `--text-muted`)
- No border
- No icons within chips

**Why not color-coded per tag?** Six different chip colors would create visual chaos on a dark minimal UI. Uniform muted chips keep the eye focused on the transcript text, which is the primary content. The tag *text* provides the differentiation. Color is reserved for the tone dot, which is a single element per card.

**Maximum tags displayed: 3.** If fewer are relevant, show fewer. If none meet the confidence threshold, show no tags row at all (the `.note-tags` container is omitted entirely, not rendered empty).

**Minimum tap target:** Each chip has a minimum height of 24px (achieved via line-height + padding), which meets the 24px minimum recommended for secondary non-critical touch targets. These chips are read-only and not interactive in v1, so the full 44px touch target guideline does not apply.

### 4.2 HTML Structure

Inserted between `.note-transcript` and `.note-progress`:

```html
<div class="note-tags">
  <span class="note-tag">idea</span>
  <span class="note-tag">work</span>
</div>
```

If no tags exist (processing incomplete or no confident classifications), this entire `<div>` is not rendered. Do not render an empty container.

### 4.3 CSS

```css
.note-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  /* No additional margin needed -- the parent .note-card gap: 10px handles spacing */
}

.note-tag {
  font-size: 0.7rem;
  line-height: 1;
  padding: 4px 10px;
  border-radius: 99px;
  background: rgba(100, 116, 139, 0.2);
  color: #94a3b8;
  white-space: nowrap;
  user-select: none;
}
```

### 4.4 Tag Label Formatting

Tags are displayed in **lowercase** with no punctuation. Examples: `idea`, `todo`, `reminder`, `journal`, `work`, `personal`. This matches the understated tone of the app. Title case or uppercase would be too loud.

---

## 5. Loading & Progressive Reveal

### 5.1 The Processing Pipeline

After a user stops recording, the current flow is:

1. Note card appears immediately with "Transcribing..." indicator (pulsing dot + text)
2. Whisper model transcribes audio
3. Transcript replaces the "Transcribing..." text

The new flow adds a second async phase:

1. Note card appears immediately with "Transcribing..." indicator (existing)
2. Whisper model transcribes audio
3. Transcript replaces the "Transcribing..." text
4. **NLP analysis begins (sentiment + tagging)**
5. **Tone dot and tags appear**

### 5.2 Loading State: "Analyzing..." Indicator

After transcription completes and the transcript text appears, an "Analyzing..." indicator replaces the space where tags will eventually appear. This uses the exact same visual pattern as the existing "Transcribing..." indicator: pulsing dot + text, same font size, same color.

```html
<div class="note-tags analyzing">
  <span class="analyzing-text">Analyzing...</span>
</div>
```

```css
.analyzing-text {
  font-size: 0.75rem;
  color: var(--text-muted);
  display: flex;
  align-items: center;
  gap: 6px;
}

.analyzing-text::before {
  content: "";
  display: inline-block;
  width: 5px;
  height: 5px;
  background: var(--text-muted);
  border-radius: 50%;
  animation: pulse 1s infinite;
}
```

This reuses the existing `@keyframes pulse` animation already defined in the stylesheet. The dot is 5px (slightly smaller than the 6px transcribing dot) and uses `--text-muted` instead of `--accent` to signal that this is a secondary background process, not the primary transcription step.

### 5.3 Reveal Sequence

When NLP analysis completes:

1. The `.analyzing-text` element is removed
2. The tone dot's `data-tone` attribute is set (it transitions via `transition: background 0.3s ease`)
3. Tag `<span>` elements are inserted into `.note-tags`
4. If no tags meet the confidence threshold, the `.note-tags` container is removed entirely
5. The tone dot defaults to `neutral` styling during analysis, so its appearance does not change abruptly if the result is indeed neutral

**No animation on tag appearance.** Fade-in animations on dynamically inserted chips create janky layout shifts on mobile. A clean instant render is preferable. The user's attention will already be elsewhere by the time analysis completes (1-3 seconds after transcription).

### 5.4 Tone Dot During Loading

The tone dot element is rendered immediately when the card is created, with `data-tone="neutral"` as the default. Since the neutral color (`#64748b`) is already low-contrast and nearly invisible, there is no jarring "pop" if the tone changes once analysis completes. The `transition: background 0.3s ease` on `.note-tone` handles the color shift smoothly.

---

## 6. Data Model Changes

The note object in IndexedDB should be extended:

```javascript
{
  id: "1702654800000",
  audioBlob: Blob,
  transcript: "I need to call the dentist tomorrow morning...",
  duration: 42,
  createdAt: "2025-12-15T10:00:00.000Z",
  // NEW fields:
  tone: "warm",          // "warm" | "neutral" | "heavy" | null (null = not yet analyzed)
  tags: ["reminder", "personal"]  // string[] (empty array = analyzed but no confident tags)
}
```

- `tone: null` means analysis has not yet completed. Render the dot as neutral.
- `tags: undefined` or not present means analysis has not yet completed. Render the analyzing indicator.
- `tags: []` (empty array) means analysis completed but nothing was confident. Render no tags row.

This distinction matters: we need to differentiate "still processing" from "processed but nothing found."

---

## 7. Implementation Notes for the HTML Rendering Function

The existing `createNoteCard()` function builds cards via `innerHTML`. The updated template should be:

```javascript
function createNoteCard(note) {
  const card = document.createElement("div");
  card.className = "note-card";
  card.dataset.id = note.id;

  const hasTranscript = note.transcript && note.transcript.length > 0;
  const toneValue = note.tone || "neutral";
  const hasTags = Array.isArray(note.tags);  // tags property exists = analysis done
  const hasVisibleTags = hasTags && note.tags.length > 0;

  // Transcript section
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
      .map(t => `<span class="note-tag">${escapeHtml(t)}</span>`)
      .join("");
    tagsHTML = `<div class="note-tags">${tagChips}</div>`;
  }
  // If hasTags but empty array: no tags HTML at all (intentional)

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

  // ... existing event listener setup unchanged ...

  return card;
}
```

### 7.1 Live Update Function

After NLP analysis completes for a note, the UI must be updated without a full re-render:

```javascript
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
    tags.slice(0, 3).forEach(t => {
      const span = document.createElement("span");
      span.className = "note-tag";
      span.textContent = t;
      tagsDiv.appendChild(span);
    });

    if (existingTagsContainer) {
      existingTagsContainer.replaceWith(tagsDiv);
    } else {
      // Insert before .note-progress
      const progressEl = card.querySelector(".note-progress");
      progressEl.parentNode.insertBefore(tagsDiv, progressEl);
    }
  } else {
    // No tags -- remove the analyzing indicator if present
    if (existingTagsContainer) {
      existingTagsContainer.remove();
    }
  }
}
```

---

## 8. Complete New CSS (Additive)

All new CSS to be appended to `app.css`. No modifications to existing rules are required except one: the `.note-header` inner structure changes to accommodate `.note-header-right`, but since the existing `justify-content: space-between` already handles two children, the only addition is the wrapper.

```css
/* ─── Tone Indicator ─────────────────────────────────────────────────────── */

.note-header-right {
  display: flex;
  align-items: center;
  gap: 8px;
}

.note-tone {
  display: block;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #64748b;
  flex-shrink: 0;
  transition: background 0.3s ease;
}

.note-tone[data-tone="warm"] {
  background: #4ade80;
}

.note-tone[data-tone="neutral"] {
  background: #64748b;
}

.note-tone[data-tone="heavy"] {
  background: #f59e0b;
}

/* ─── Auto-Tags ──────────────────────────────────────────────────────────── */

.note-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.note-tag {
  font-size: 0.7rem;
  line-height: 1;
  padding: 4px 10px;
  border-radius: 99px;
  background: rgba(100, 116, 139, 0.2);
  color: #94a3b8;
  white-space: nowrap;
  user-select: none;
}

/* ─── NLP Analyzing State ────────────────────────────────────────────────── */

.analyzing-text {
  font-size: 0.75rem;
  color: var(--text-muted);
  display: flex;
  align-items: center;
  gap: 6px;
}

.analyzing-text::before {
  content: "";
  display: inline-block;
  width: 5px;
  height: 5px;
  background: var(--text-muted);
  border-radius: 50%;
  animation: pulse 1s infinite;
}
```

---

## 9. Visual Summary

### Card state: Transcribing (no changes from current)
```
+------------------------------------------+
| Dec 15, 2025                 *     0:42  |
|                                          |
| * Transcribing...                        |
|                                          |
| [ > Play              ]  [ trash ]       |
+------------------------------------------+
  (tone dot is neutral/invisible, no tags)
```

### Card state: Transcribed, analyzing NLP
```
+------------------------------------------+
| Dec 15, 2025                 *     0:42  |
|                                          |
| I need to call the dentist tomorrow      |
| morning before the appointment...        |
|                                          |
| * Analyzing...                           |
|                                          |
| [ > Play              ]  [ trash ]       |
+------------------------------------------+
  (tone dot still neutral, analyzing indicator shown)
```

### Card state: Fully processed
```
+------------------------------------------+
| Dec 15, 2025                 *     0:42  |
|                              ^amber      |
| I need to call the dentist tomorrow      |
| morning before the appointment...        |
|                                          |
| [reminder] [personal]                    |
|                                          |
| [ > Play              ]  [ trash ]       |
+------------------------------------------+
  (tone dot is amber/heavy, two tags displayed)
```

### Card state: Fully processed, no tags
```
+------------------------------------------+
| Dec 15, 2025                 *     0:42  |
|                              ^green      |
| Had a great conversation with the team   |
| about the new product direction.         |
|                                          |
| [ > Play              ]  [ trash ]       |
+------------------------------------------+
  (tone dot is green/warm, no tags row rendered)
```

---

## 10. Things I Am Explicitly Rejecting

### Emoji for sentiment
Emoji sentiment indicators (happy face, sad face) are reductive and infantilizing. A 6px colored dot is the right level of abstraction for ambient emotional metadata.

### Per-tag color coding
Six different chip colors on a dark surface creates a Christmas tree effect. Uniform muted chips maintain visual coherence. The tag text label is sufficient differentiation.

### Sentiment text labels on cards
"Positive", "Negative", "Neutral" labels next to notes are judgmental. A dot is ambient. A word is a verdict.

### Filter bar in v1
Premature. Adds layout complexity for minimal utility at low note counts. The cost is high (new section, interaction states, empty filtered states, clear filter affordance) and the benefit is low (<50 notes).

### Editable tags in v1
Interaction bloat. X buttons on every chip, confirmation states, persistence logic. Ship read-only, validate the auto-tagging quality, iterate.

### Animated tag entrance
Fade-in and slide-up animations on dynamically inserted DOM elements cause layout thrashing on mobile WebViews. Hard no.

### "Mood" terminology
"Mood" implies the app is diagnosing the user's emotional state. "Tone" is more neutral -- it describes the character of the recording, not the person.

---

## 11. Future Considerations (Not in v1)

- **Filter by tag:** Add a horizontal scrollable chip bar below "Saved Notes" heading. Each chip is a tag name. Tapping filters the list. Tapping again clears. Single-select only.
- **Filter by tone:** Three small dots (green, gray, amber) as filter toggles in the header. Probably overkill.
- **Tag editing:** Long-press on a tag chip to remove it. No adding custom tags -- that changes the auto-tag value proposition.
- **Tone history:** A small sparkline or timeline showing tone distribution over time. Nice data visualization, but way beyond v1.

---

## 12. Modification Summary for Existing Files

### `app.css`
- **Add** new CSS rules (Section 8 above). No existing rules need modification.

### `index.html`
- **No changes.** All new DOM is generated dynamically in JavaScript.

### `app.js`
- **Modify** `createNoteCard()` to include tone dot and tags (Section 7).
- **Modify** `.note-header` inner HTML to use `.note-header-right` wrapper.
- **Add** `updateNoteAnalysis()` function for live updates after NLP completes.
- **Modify** note object schema to include `tone` and `tags` fields.
- **Add** NLP processing step after transcription in the queue (details left to ML/implementation agent).
- **Add** `updateNoteInDB()` helper or extend existing `updateNoteTranscript()` to also persist tone and tags.
