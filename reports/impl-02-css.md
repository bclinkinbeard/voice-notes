# CSS: Tone Dots, Tag Chips & Analyzing State

*2026-02-15 by Showboat 0.5.0*

Three new visual features were added to the note cards: a colored tone-indicator
dot, auto-generated tag chips, and a pulsing "analyzing..." state. All of the
CSS lives in a single contiguous block appended to the end of `app.css`. This
report walks through each section, explains the design choices, and shows that
the new code reuses existing patterns rather than inventing new ones.

## Overview — what was appended

The original stylesheet ended at the `@keyframes pulse` block on line 292.
Lines 294-361 are entirely new. Let's see the full addition:

```bash
sed -n '294,361p' /home/user/voice-notes/app.css
```

```output
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

That is 68 new lines covering three distinct feature areas, each separated by a
decorated comment banner for scanability.

## Tone Indicator Styles

### Container: `.note-header-right`

The existing `.note-header` is a `space-between` flex row. The new
`.note-header-right` wraps the duration badge and the tone dot on the right side
so they sit inline with consistent spacing:

```bash
sed -n '296,300p' /home/user/voice-notes/app.css
```

```output
.note-header-right {
  display: flex;
  align-items: center;
  gap: 8px;
}
```

### The dot itself: `.note-tone`

A 6 px circle. The default color is slate (`#64748b`), which doubles as the
"neutral" value so no JavaScript is needed to style the fallback:

```bash
sed -n '302,310p' /home/user/voice-notes/app.css
```

```output
.note-tone {
  display: block;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #64748b;
  flex-shrink: 0;
  transition: background 0.3s ease;
}
```

`flex-shrink: 0` prevents the dot from collapsing when the header is tight.
The `transition` gives a smooth color fade when the NLP result arrives
asynchronously.

### Tone colors via `data-tone`

```bash
sed -n '312,322p' /home/user/voice-notes/app.css
```

```output
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

Let's pull out just the color values to confirm:

```bash
grep -n 'background:' /home/user/voice-notes/app.css | grep -E '#4ade80|#64748b|#f59e0b'
```

```output
307:  background: #64748b;
313:  background: #4ade80;
317:  background: #64748b;
321:  background: #f59e0b;
```

Three tones, three colors:

| Tone      | Hex       | Tailwind name | Rationale                         |
|-----------|-----------|---------------|-----------------------------------|
| `warm`    | `#4ade80` | green-400     | Positive, approachable energy     |
| `neutral` | `#64748b` | slate-500     | Blends into the muted UI chrome   |
| `heavy`   | `#f59e0b` | amber-500     | Caution without alarm (see below) |

## Tag Chip Styles

```bash
sed -n '326,341p' /home/user/voice-notes/app.css
```

```output
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
```

The container (`.note-tags`) is a wrapping flex row with a tight 6 px gap, so
chips flow naturally across multiple lines on narrow screens.

Each `.note-tag` is a pill (`border-radius: 99px` — the same trick used by
`.note-duration` on line 172):

```bash
grep -n 'border-radius: 99px' /home/user/voice-notes/app.css
```

```output
172:  border-radius: 99px;
336:  border-radius: 99px;
```

The background is a translucent slate — `rgba(100, 116, 139, 0.2)` — paired
with a muted text color (`#94a3b8`, Tailwind slate-400). This keeps chips
visible but subordinate to the transcript text. Every chip shares the same
color regardless of tag content; the tags are metadata, not categories, so a
uniform color avoids visual noise and the maintenance burden of a color palette
per tag.

`user-select: none` prevents accidental selection when tapping near a chip on
mobile.

## Analyzing State

While the NLP pipeline runs, the UI shows an "Analyzing..." label with a
pulsing dot. Here are the styles:

```bash
sed -n '343,361p' /home/user/voice-notes/app.css
```

```output
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

The pattern is nearly identical to the existing `.transcribing` indicator. Both
use a `::before` pseudo-element dot with `animation: pulse 1s infinite`. Let's
confirm there is only one `@keyframes pulse` definition shared between them:

```bash
grep -n '@keyframes pulse' /home/user/voice-notes/app.css
```

```output
289:@keyframes pulse {
```

```bash
grep -n 'animation: pulse' /home/user/voice-notes/app.css
```

```output
286:  animation: pulse 1s infinite;
360:  animation: pulse 1s infinite;
```

One definition on line 289, two consumers: the transcribing indicator (line 286)
and the analyzing indicator (line 360). No duplication of keyframe logic.

The analyzing dot is slightly smaller (5 px vs 6 px) and uses `--text-muted`
instead of `--accent`. This is intentional: transcription is the primary
pipeline stage and gets the bold accent color; NLP analysis is a secondary,
background step so it stays quieter.

## Design Rationale

### Why amber for "heavy", not red?

The app's accent color is already `#e94560` (a strong red-pink), used for the
record button, duration badge, and error states. If the "heavy" tone dot were
also red, it would read as an error or a destructive action. Amber (`#f59e0b`)
signals "noteworthy" without triggering alarm — appropriate for a journaling
app where every tone is valid, just different.

### Why a uniform chip color?

Tags like "work", "idea", and "errand" are auto-generated labels. Assigning
each a distinct hue would create a rainbow effect on cards with several tags and
would require maintaining a deterministic color-mapping function. A single
translucent slate chip keeps the visual weight low and lets the transcript
remain the focal point of each card.

### Why is the tone dot only 6 px?

The dot is ambient information — a glanceable mood signal, not a primary
control. At 6 px it is large enough to show color clearly on retina displays
but small enough to avoid competing with the date label and duration badge in
the header row. The `.transcribing` dot (also 6 px on line 282) established
this size as the app's baseline for status indicators:

```bash
grep -n 'width: 6px' /home/user/voice-notes/app.css
```

```output
282:  width: 6px;
304:  width: 6px;
```

Both status dots share the same 6 px footprint, keeping the visual language
consistent.
