import { tagTranscript } from "./tagger.js";

// === Edge Cases ===
console.log("=== Edge Cases ===");
console.log("null       →", JSON.stringify(tagTranscript(null)));
console.log("undefined  →", JSON.stringify(tagTranscript(undefined)));
console.log("empty str  →", JSON.stringify(tagTranscript("")));
console.log("number     →", JSON.stringify(tagTranscript(42)));
console.log("no matches →", JSON.stringify(tagTranscript("the quick brown fox")));

console.log("");

// === Example Transcripts ===
console.log("=== Example Transcripts ===");
console.log("");

const t1 = "What if we brainstorm a concept for the new project? I've been thinking about this idea all week.";
console.log("Transcript 1:");
console.log(" ", JSON.stringify(t1));
console.log("  Tags →", JSON.stringify(tagTranscript(t1)));
console.log("");

const t2 = "I need to remember to email the client by tomorrow. Don't forget the presentation for the team meeting.";
console.log("Transcript 2:");
console.log(" ", JSON.stringify(t2));
console.log("  Tags →", JSON.stringify(tagTranscript(t2)));
console.log("");

const t3 = "Today was a good day. I feel grateful for my family. We had dinner together and the kids were happy.";
console.log("Transcript 3:");
console.log(" ", JSON.stringify(t3));
console.log("  Tags →", JSON.stringify(tagTranscript(t3)));
console.log("");

const t4 = "Remind me about the doctor appointment at 3 o'clock p.m. by Friday.";
console.log("Transcript 4:");
console.log(" ", JSON.stringify(t4));
console.log("  Tags →", JSON.stringify(tagTranscript(t4)));
console.log("");

const t5 = "I have to schedule a gym workout and grocery run this weekend. Must make sure to pick up the kids by 5 o'clock.";
console.log("Transcript 5 (multi-category):");
console.log(" ", JSON.stringify(t5));
console.log("  Tags →", JSON.stringify(tagTranscript(t5)));
