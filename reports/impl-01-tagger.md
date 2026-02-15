# Keyword Tagger Implementation

*2026-02-15 by Showboat 0.5.0*

The keyword-based tagger is the auto-classification engine for voice notes. Given a
raw transcript string, it scans for predefined keyword phrases across six categories
and returns the top-scoring tags. The entire module lives in a single 54-line file
with zero dependencies.

---

## 1. File Overview

The module is compact -- one constant, one exported function, and nothing else.

```bash
cat -n tagger.js
```

```output
     1	// ─── Keyword-Based Transcript Tagger ────────────────────────────────────────
     2
     3	const TAG_KEYWORDS = {
     4	  idea: [
     5	    "what if", "idea", "imagine", "could we", "concept",
     6	    "brainstorm", "thinking about", "maybe we should", "how about", "wonder if",
     7	  ],
     8	  todo: [
     9	    "need to", "have to", "gotta", "must", "don't forget",
    10	    "remember to", "should", "task", "to do", "to-do", "make sure",
    11	  ],
    12	  reminder: [
    13	    "remind", "appointment", "deadline", "by tomorrow", "by monday",
    14	    "by friday", "due", "schedule", "don't forget", "o'clock", "a.m.", "p.m.",
    15	  ],
    16	  journal: [
    17	    "feeling", "felt", "today was", "my day", "grateful",
    18	    "thankful", "reflecting", "i think", "i feel", "been thinking",
    19	  ],
    20	  work: [
    21	    "meeting", "project", "client", "team", "office",
    22	    "deadline", "presentation", "email", "boss", "coworker",
    23	    "sprint", "standup", "review",
    24	  ],
    25	  personal: [
    26	    "family", "doctor", "gym", "workout", "grocery",
    27	    "dinner", "weekend", "vacation", "birthday", "friend", "kids", "home",
    28	  ],
    29	};
    30
    31	/**
    32	 * Score each tag category by counting how many of its keywords appear in the
    33	 * lowercased text. Return the top 3 categories (max) that scored at least 1,
    34	 * sorted by descending match count.
    35	 */
    36	export function tagTranscript(text) {
    37	  if (!text || typeof text !== "string") return [];
    38
    39	  const lower = text.toLowerCase();
    40
    41	  const scores = Object.entries(TAG_KEYWORDS).map(([tag, keywords]) => {
    42	    let count = 0;
    43	    for (const kw of keywords) {
    44	      if (lower.includes(kw)) count++;
    45	    }
    46	    return { tag, count };
    47	  });
    48
    49	  return scores
    50	    .filter((s) => s.count > 0)
    51	    .sort((a, b) => b.count - a.count)
    52	    .slice(0, 3)
    53	    .map((s) => s.tag);
    54	}
```

```bash
wc -l tagger.js
```

```output
54 tagger.js
```

54 lines total. No imports, no runtime dependencies.

---

## 2. Keyword Dictionary

The `TAG_KEYWORDS` constant maps six tag categories to arrays of keyword phrases.
Let's extract just that structure and count the keywords per category.

```bash
sed -n '3,29p' tagger.js
```

```output
const TAG_KEYWORDS = {
  idea: [
    "what if", "idea", "imagine", "could we", "concept",
    "brainstorm", "thinking about", "maybe we should", "how about", "wonder if",
  ],
  todo: [
    "need to", "have to", "gotta", "must", "don't forget",
    "remember to", "should", "task", "to do", "to-do", "make sure",
  ],
  reminder: [
    "remind", "appointment", "deadline", "by tomorrow", "by monday",
    "by friday", "due", "schedule", "don't forget", "o'clock", "a.m.", "p.m.",
  ],
  journal: [
    "feeling", "felt", "today was", "my day", "grateful",
    "thankful", "reflecting", "i think", "i feel", "been thinking",
  ],
  work: [
    "meeting", "project", "client", "team", "office",
    "deadline", "presentation", "email", "boss", "coworker",
    "sprint", "standup", "review",
  ],
  personal: [
    "family", "doctor", "gym", "workout", "grocery",
    "dinner", "weekend", "vacation", "birthday", "friend", "kids", "home",
  ],
};
```

Here is the per-category breakdown:

```bash
node -e "
const src = require('fs').readFileSync('tagger.js','utf8');
const m = src.match(/const TAG_KEYWORDS = ({[\s\S]*?});/);
const obj = eval('(' + m[1] + ')');
for (const [tag, kws] of Object.entries(obj)) {
  console.log(tag.padEnd(12) + kws.length + ' keywords');
}
console.log('─'.repeat(30));
const total = Object.values(obj).flat().length;
console.log('total'.padEnd(12) + total + ' keywords');
"
```

```output
idea        10 keywords
todo        11 keywords
reminder    12 keywords
journal     10 keywords
work        13 keywords
personal    12 keywords
──────────────────────────────
total       68 keywords
```

68 keywords spread across 6 categories. Note that the keywords are *phrases*, not
single words -- entries like `"thinking about"`, `"by tomorrow"`, and `"don't forget"`
use multi-word matching. This reduces false positives compared to single-token lookups.

Two keywords appear in more than one category, creating intentional overlap:

```bash
node -e "
const TAG_KEYWORDS = {
  todo: ['need to','have to','gotta','must',\"don't forget\",'remember to','should','task','to do','to-do','make sure'],
  reminder: ['remind','appointment','deadline','by tomorrow','by monday','by friday','due','schedule',\"don't forget\",\"o'clock\",'a.m.','p.m.'],
  work: ['meeting','project','client','team','office','deadline','presentation','email','boss','coworker','sprint','standup','review'],
};
const tags = ['todo','reminder','work'];
for (let i = 0; i < tags.length; i++) {
  for (let j = i + 1; j < tags.length; j++) {
    const shared = TAG_KEYWORDS[tags[i]].filter(k => TAG_KEYWORDS[tags[j]].includes(k));
    if (shared.length > 0) console.log(tags[i] + ' + ' + tags[j] + ': ' + shared.join(', '));
  }
}
"
```

```output
todo + reminder: don't forget
reminder + work: deadline
```

`"don't forget"` lives in both **todo** and **reminder**; `"deadline"` lives in both
**reminder** and **work**. This is by design -- a note about a deadline is legitimately
both work-related and reminder-like. A single keyword match can boost two categories
simultaneously.

---

## 3. Scoring Algorithm

The scoring logic lives in `tagTranscript()`, starting at line 36.

```bash
sed -n '36,54p' tagger.js
```

```output
export function tagTranscript(text) {
  if (!text || typeof text !== "string") return [];

  const lower = text.toLowerCase();

  const scores = Object.entries(TAG_KEYWORDS).map(([tag, keywords]) => {
    let count = 0;
    for (const kw of keywords) {
      if (lower.includes(kw)) count++;
    }
    return { tag, count };
  });

  return scores
    .filter((s) => s.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, 3)
    .map((s) => s.tag);
}
```

The algorithm proceeds in four steps:

1. **Guard clause** (line 37): if the input is falsy or not a string, return `[]`
   immediately.
2. **Case normalization** (line 39): lowercase the entire transcript once, so keyword
   matching is case-insensitive.
3. **Counting pass** (lines 41-47): for each of the 6 tag categories, iterate through
   its keyword list and count how many are found via `String.includes()`. This produces
   an array of `{ tag, count }` objects.
4. **Rank and trim** (lines 49-53): filter out categories with zero hits, sort by
   descending count, take the top 3, and return just the tag names.

Let's trace through a concrete example to see this in action:

```bash
node _test_scoring.mjs
```

```output
Input: "I need to remember to email the client by tomorrow. Don't forget the presentation for the team meeting."

Scoring breakdown:
──────────────────────────────────────────────────
  idea          0 hits
  todo          3 hit(s): need to, don't forget, remember to
  reminder      2 hit(s): by tomorrow, don't forget
  journal       0 hits
  work          5 hit(s): meeting, client, team, presentation, email
  personal      0 hits
──────────────────────────────────────────────────

After filter(>0), sort(desc), slice(0,3):
  Final tags → ["work","todo","reminder"]

Verify against tagTranscript():
  Result     → ["work","todo","reminder"]
```

The transcript scores highest in **work** (5 hits), followed by **todo** (3), then
**reminder** (2). Categories with zero hits (**idea**, **journal**, **personal**) are
filtered out. Only the top 3 survive the `.slice(0, 3)` cutoff. Notice that
`"don't forget"` incremented both **todo** and **reminder** -- the overlap keywords
doing their job.

---

## 4. Edge Cases

The guard clause on line 37 handles all non-string and empty inputs gracefully by
returning an empty array.

```bash
node _test_tagger.mjs 2>&1 | head -7
```

```output
=== Edge Cases ===
null       → []
undefined  → []
empty str  → []
number     → []
no matches → []
```

Every degenerate input produces `[]` -- no exceptions thrown, no crashes. The
`"the quick brown fox"` case confirms that text with no matching keywords also returns
an empty array cleanly.

The `!text` check catches `null`, `undefined`, and empty string `""` (all falsy).
The `typeof text !== "string"` check catches numeric, boolean, object, and other
non-string values. Together these two conditions cover all reasonable misuse paths.

---

## 5. Example Runs

Here are five transcript examples covering a range of tag combinations.

```bash
node _test_tagger.mjs
```

```output
=== Edge Cases ===
null       → []
undefined  → []
empty str  → []
number     → []
no matches → []

=== Example Transcripts ===

Transcript 1:
  "What if we brainstorm a concept for the new project? I've been thinking about this idea all week."
  Tags → ["idea","journal","work"]

Transcript 2:
  "I need to remember to email the client by tomorrow. Don't forget the presentation for the team meeting."
  Tags → ["work","todo","reminder"]

Transcript 3:
  "Today was a good day. I feel grateful for my family. We had dinner together and the kids were happy."
  Tags → ["journal","personal"]

Transcript 4:
  "Remind me about the doctor appointment at 3 o'clock p.m. by Friday."
  Tags → ["reminder","personal"]

Transcript 5 (multi-category):
  "I have to schedule a gym workout and grocery run this weekend. Must make sure to pick up the kids by 5 o'clock."
  Tags → ["personal","todo","reminder"]
```

Key observations:

- **Transcript 1** shows that an idea-heavy note still picks up incidental tags:
  `"project"` triggers **work**, and `"been thinking"` triggers **journal**. The
  highest-scoring category (**idea**) correctly lands in position 1.

- **Transcript 2** is a dense work/task note. Five work-related keywords push **work**
  to the top despite the note *feeling* more like a to-do list.

- **Transcript 3** returns only 2 tags -- proof that the tagger does not pad results
  to 3 when fewer categories match.

- **Transcript 4** is a clean reminder with a personal element (doctor). The time
  phrases (`"o'clock"`, `"p.m."`, `"by friday"`) heavily weight **reminder**.

- **Transcript 5** spans three categories roughly equally, demonstrating the top-3
  cap in action. If a fourth category had scored, it would have been dropped.

---

## Summary

| Aspect            | Detail                                              |
|-------------------|-----------------------------------------------------|
| File              | `tagger.js` -- 54 lines, zero dependencies          |
| Categories        | 6 tags, 68 total keyword phrases                    |
| Matching          | Case-insensitive `String.includes()` substring scan |
| Output            | Top 3 tags (max) sorted by descending match count   |
| Edge case safety  | Returns `[]` for null, undefined, empty, non-string |
| Shared keywords   | 2 intentional overlaps across categories            |

The tagger is deliberately simple: no NLP, no stemming, no weighting beyond raw
keyword counts. This makes it fast, predictable, and easy to extend -- adding a new
tag category is just a new key in the `TAG_KEYWORDS` object.
