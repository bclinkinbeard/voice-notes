// ─── Keyword-Based Transcript Tagger ────────────────────────────────────────

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

/**
 * Score each tag category by counting how many of its keywords appear in the
 * lowercased text. Return the top 3 categories (max) that scored at least 1,
 * sorted by descending match count.
 */
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
