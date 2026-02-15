import { tagTranscript } from "./tagger.js";

// Reproduce the scoring internals to show how counts work
const TAG_KEYWORDS = {
  idea: ["what if","idea","imagine","could we","concept","brainstorm","thinking about","maybe we should","how about","wonder if"],
  todo: ["need to","have to","gotta","must","don't forget","remember to","should","task","to do","to-do","make sure"],
  reminder: ["remind","appointment","deadline","by tomorrow","by monday","by friday","due","schedule","don't forget","o'clock","a.m.","p.m."],
  journal: ["feeling","felt","today was","my day","grateful","thankful","reflecting","i think","i feel","been thinking"],
  work: ["meeting","project","client","team","office","deadline","presentation","email","boss","coworker","sprint","standup","review"],
  personal: ["family","doctor","gym","workout","grocery","dinner","weekend","vacation","birthday","friend","kids","home"],
};

const text = "I need to remember to email the client by tomorrow. Don't forget the presentation for the team meeting.";
const lower = text.toLowerCase();

console.log("Input:", JSON.stringify(text));
console.log("");
console.log("Scoring breakdown:");
console.log("─".repeat(50));

const scores = [];
for (const [tag, keywords] of Object.entries(TAG_KEYWORDS)) {
  const matched = keywords.filter(kw => lower.includes(kw));
  if (matched.length > 0) {
    console.log(`  ${tag.padEnd(12)} ${String(matched.length).padStart(2)} hit(s): ${matched.join(", ")}`);
  } else {
    console.log(`  ${tag.padEnd(12)}  0 hits`);
  }
  scores.push({ tag, count: matched.length });
}

console.log("─".repeat(50));
const result = scores
  .filter(s => s.count > 0)
  .sort((a, b) => b.count - a.count)
  .slice(0, 3)
  .map(s => s.tag);
console.log("");
console.log("After filter(>0), sort(desc), slice(0,3):");
console.log("  Final tags →", JSON.stringify(result));
console.log("");
console.log("Verify against tagTranscript():");
console.log("  Result     →", JSON.stringify(tagTranscript(text)));
