# Implementation Report: Keyword-Based Transcript Tagger

## Summary

Created `tagger.js`, a lightweight ES module that exports a single function `tagTranscript(text)`. Given a voice note transcript, it returns up to 3 tag strings from a vocabulary of 6 categories: `idea`, `todo`, `reminder`, `journal`, `work`, and `personal`. No external dependencies.

---

## Approach

**Strategy: substring matching against a curated keyword list.**

Each of the 6 tag categories has 10-13 associated keywords or short phrases. The function lowercases the input text once, then iterates through every keyword in every category, counting how many keywords appear as substrings. Categories are ranked by match count, and the top 3 with at least one match are returned.

This was chosen over regex-based matching for simplicity and readability. Substring matching via `String.prototype.includes()` is sufficient here because the keywords are plain lowercase phrases with no need for word-boundary precision, and the performance cost is negligible for transcript-length strings.

The keyword lists are stored in a `TAG_KEYWORDS` object at module scope, making them easy to extend or modify without touching the scoring logic.

---

## Edge Cases Considered

- **Null/undefined/non-string input**: returns empty array immediately via a type guard.
- **Empty string**: no keywords will match, returns empty array.
- **Fewer than 3 matching categories**: the function returns only the categories that matched (0, 1, or 2), never pads to 3.
- **Shared keywords across categories**: `"deadline"` appears in both `reminder` and `work`; `"don't forget"` appears in both `todo` and `reminder`. A single transcript can score points in multiple categories from the same phrase, which is intentional -- it reflects that the note genuinely belongs to both categories.
- **Case insensitivity**: the entire input is lowercased before matching, and all keywords are stored lowercase.
- **Tie-breaking**: when two categories have the same match count, their relative order is determined by `Array.prototype.sort()` stability (stable in all modern engines). The order among tied categories is the order they appear in `TAG_KEYWORDS`, which is fine since no specific tie-break rule was required.

---

## File Changes

| File | Action |
|------|--------|
| `tagger.js` | **Created** -- new keyword-based tagging module |
| `reports/impl-01-tagger.md` | **Created** -- this report |

No existing files were modified.

---

## How to Test

Since this is a browser ES module, the quickest way to test is from the browser console on the app page, or by creating a small test script:

```js
import { tagTranscript } from "./tagger.js";

// Should return ["work", "todo"] (or similar based on match counts)
console.log(tagTranscript("I have a meeting tomorrow and need to send the email to the client"));

// Should return ["idea"]
console.log(tagTranscript("What if we could brainstorm a new concept?"));

// Should return ["journal", "personal"]
console.log(tagTranscript("Today was a good day. Feeling grateful. Had dinner with family."));

// Should return []
console.log(tagTranscript("Hello world"));

// Should return []
console.log(tagTranscript(""));
console.log(tagTranscript(null));
```

Alternatively, drop a `<script type="module">` block into `index.html` temporarily, or use Node.js (v14+) with `--experimental-vm-modules` or a `.mjs` extension.
