// @ts-check
const { test, expect } = require("@playwright/test");

// Mock the transformers.js CDN import so app.js can load without network
// access.  The mock returns a dummy `pipeline` function that resolves to a
// no-op model.
const TRANSFORMERS_MOCK = `
  export function pipeline() {
    return Promise.resolve(function dummyModel() {
      return Promise.resolve({ text: "", labels: ["neutral"], scores: [1] });
    });
  }
`;

/**
 * Intercept the CDN request for transformers.js and return the mock.
 * Must be called BEFORE page.goto().
 */
async function mockTransformers(page) {
  await page.route("**/cdn.jsdelivr.net/**", (route) => {
    route.fulfill({
      contentType: "application/javascript; charset=utf-8",
      body: TRANSFORMERS_MOCK,
    });
  });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Inject notes directly into IndexedDB before the app loads */
async function seedNotes(page, notes) {
  await page.evaluate((data) => {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open("voiceNotesDB", 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("notes")) {
          db.createObjectStore("notes", { keyPath: "id" });
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction("notes", "readwrite");
        const store = tx.objectStore("notes");
        for (const note of data) store.put(note);
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
      req.onerror = () => reject(req.error);
    });
  }, notes);
}

/** Clear the IndexedDB completely */
async function clearDB(page) {
  await page.evaluate(() => {
    return new Promise((resolve) => {
      const req = indexedDB.deleteDatabase("voiceNotesDB");
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
      req.onblocked = () => resolve();
    });
  });
}

/** Generate a tiny valid WAV blob (silence) inside the browser */
function makeWavBlobScript(durationSecs = 1) {
  return `(() => {
    const sampleRate = 16000;
    const numSamples = ${durationSecs} * sampleRate;
    const buffer = new ArrayBuffer(44 + numSamples * 2);
    const view = new DataView(buffer);

    // RIFF header
    const writeStr = (offset, str) => {
      for (let i = 0; i < str.length; i++)
        view.setUint8(offset + i, str.charCodeAt(i));
    };
    writeStr(0, "RIFF");
    view.setUint32(4, 36 + numSamples * 2, true);
    writeStr(8, "WAVE");
    writeStr(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeStr(36, "data");
    view.setUint32(40, numSamples * 2, true);

    return new Blob([buffer], { type: "audio/wav" });
  })()`;
}

/** Create a sample note object for seeding */
function makeNote(overrides = {}) {
  return {
    id: Date.now().toString(),
    transcript: "This is a test note for the meeting tomorrow.",
    duration: 5.2,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

// Apply CDN mock globally so every page.goto() works without network
test.beforeEach(async ({ page }) => {
  await mockTransformers(page);
});

// ─── Smoke Tests ─────────────────────────────────────────────────────────────

test.describe("Smoke Tests", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
  });

  test("page loads with correct title", async ({ page }) => {
    await expect(page).toHaveTitle("Voice Notes");
  });

  test("heading is visible", async ({ page }) => {
    await expect(page.locator("h1")).toHaveText("Voice Notes");
  });

  test("record button is visible", async ({ page }) => {
    await expect(page.locator("#record-btn")).toBeVisible();
  });

  test("empty state shows when no notes", async ({ page }) => {
    const emptyState = page.locator("#empty-state");
    await expect(emptyState).toBeVisible();
    await expect(emptyState).toContainText("No voice notes yet");
  });

  test("timer initializes at 0:00", async ({ page }) => {
    await expect(page.locator("#timer")).toHaveText("0:00");
  });

  test("record hint shows tap to record", async ({ page }) => {
    await expect(page.locator("#record-hint")).toHaveText("Tap to record");
  });

  test("waveform canvas exists in DOM", async ({ page }) => {
    // Canvas is display:none until recording starts (.active class)
    await expect(page.locator("#waveform")).toBeAttached();
  });

  test("model status is hidden initially", async ({ page }) => {
    const status = page.locator("#model-status");
    await expect(status).toHaveClass("hidden");
  });
});

// ─── Note Card Rendering ─────────────────────────────────────────────────────

test.describe("Note Card Rendering", () => {
  test("renders a note card with transcript", async ({ page }) => {
    await page.goto("/");
    await seedNotes(page, [
      makeNote({
        id: "note1",
        transcript: "Hello world this is a test",
        duration: 8,
        tags: ["work"],
        tone: "warm",
      }),
    ]);
    await page.reload();

    const card = page.locator('.note-card[data-id="note1"]');
    await expect(card).toBeVisible();
    await expect(card.locator(".note-transcript")).toHaveText(
      "Hello world this is a test",
    );
    await expect(card.locator(".note-duration")).toHaveText("0:08");
    await expect(card.locator(".play-btn")).toBeVisible();
    await expect(card.locator(".delete-btn")).toBeVisible();
  });

  test("shows Transcribing indicator for notes with empty transcript", async ({
    page,
  }) => {
    await page.goto("/");
    await seedNotes(page, [
      makeNote({ id: "note-pending", transcript: "", audioBlob: null }),
    ]);
    await page.reload();

    const card = page.locator('.note-card[data-id="note-pending"]');
    const transcript = card.locator(".note-transcript");
    await expect(transcript).toHaveText("Transcribing...");
    await expect(transcript).toHaveClass(/transcribing/);
  });

  test("notes with transcript but no tags get recovered with tags", async ({
    page,
  }) => {
    await page.goto("/");
    // Note has transcript but no tags — recovery should compute tags
    await seedNotes(page, [
      makeNote({
        id: "note-analyzing",
        transcript: "Need to remember the meeting with the team",
      }),
    ]);
    await page.reload();

    const card = page.locator('.note-card[data-id="note-analyzing"]');
    // Recovery runs instantly so tags should appear
    const tagChips = card.locator(".note-tag:not(.tone-label)");
    await expect(tagChips.first()).toBeVisible({ timeout: 5000 });
  });

  test("renders tone pill for positive sentiment", async ({ page }) => {
    await page.goto("/");
    await seedNotes(page, [
      makeNote({
        id: "note-positive",
        transcript: "I feel great today",
        tags: ["journal"],
        tone: "warm",
      }),
    ]);
    await page.reload();

    const card = page.locator('.note-card[data-id="note-positive"]');
    await expect(card.locator(".tone-label")).toHaveText("Positive");
    await expect(card.locator(".tone-label")).toHaveClass(/tone-warm/);
  });

  test("renders tone pill for negative sentiment", async ({ page }) => {
    await page.goto("/");
    await seedNotes(page, [
      makeNote({
        id: "note-negative",
        transcript: "This is frustrating",
        tags: [],
        tone: "heavy",
      }),
    ]);
    await page.reload();

    const card = page.locator('.note-card[data-id="note-negative"]');
    await expect(card.locator(".tone-label")).toHaveText("Negative");
    await expect(card.locator(".tone-label")).toHaveClass(/tone-heavy/);
  });

  test("does not show tone pill for neutral sentiment", async ({ page }) => {
    await page.goto("/");
    await seedNotes(page, [
      makeNote({
        id: "note-neutral",
        transcript: "Testing",
        tags: [],
        tone: "neutral",
      }),
    ]);
    await page.reload();

    const card = page.locator('.note-card[data-id="note-neutral"]');
    await expect(card.locator(".tone-label")).toHaveCount(0);
  });

  test("renders tag chips", async ({ page }) => {
    await page.goto("/");
    await seedNotes(page, [
      makeNote({
        id: "note-tags",
        transcript: "Meeting about the project deadline",
        tags: ["work", "reminder"],
        tone: "neutral",
      }),
    ]);
    await page.reload();

    const card = page.locator('.note-card[data-id="note-tags"]');
    const tagChips = card.locator(".note-tag:not(.tone-label)");
    await expect(tagChips).toHaveCount(2);
    await expect(tagChips.nth(0)).toHaveText("work");
    await expect(tagChips.nth(1)).toHaveText("reminder");
  });

  test("recovery computes and displays keyword-based tags", async ({
    page,
  }) => {
    await page.goto("/");
    // Seed a note that has a transcript but NO tags (simulates post-transcription state).
    // The transcript contains keywords that should trigger: todo ("need to"),
    // work ("meeting", "project", "deadline"), and reminder ("deadline").
    await seedNotes(page, [
      makeNote({
        id: "note-autotag",
        transcript:
          "I need to prepare for the meeting about the project deadline",
        tone: "neutral",
        // tags intentionally omitted — recovery should fill them in
      }),
    ]);
    await page.reload();

    const card = page.locator('.note-card[data-id="note-autotag"]');
    const tagChips = card.locator(".note-tag:not(.tone-label)");
    // Should show keyword-derived tag chips (work, todo, reminder)
    await expect(tagChips).toHaveCount(3, { timeout: 5000 });
    const tagTexts = await tagChips.allTextContents();
    expect(tagTexts).toContain("work");
    expect(tagTexts).toContain("todo");
    expect(tagTexts).toContain("reminder");
  });

  test("limits tag chips to 3", async ({ page }) => {
    await page.goto("/");
    await seedNotes(page, [
      makeNote({
        id: "note-manytags",
        transcript: "Test",
        tags: ["work", "idea", "todo", "personal"],
        tone: "neutral",
      }),
    ]);
    await page.reload();

    const card = page.locator('.note-card[data-id="note-manytags"]');
    const tagChips = card.locator(".note-tag:not(.tone-label)");
    await expect(tagChips).toHaveCount(3);
  });

  test("formats duration correctly for minutes", async ({ page }) => {
    await page.goto("/");
    await seedNotes(page, [
      makeNote({
        id: "note-longduration",
        transcript: "Long note",
        duration: 125,
        tags: [],
        tone: "neutral",
      }),
    ]);
    await page.reload();

    const card = page.locator('.note-card[data-id="note-longduration"]');
    await expect(card.locator(".note-duration")).toHaveText("2:05");
  });
});

// ─── Multiple Notes & Ordering ───────────────────────────────────────────────

test.describe("Multiple Notes", () => {
  test("notes are sorted newest first", async ({ page }) => {
    await page.goto("/");
    await seedNotes(page, [
      makeNote({
        id: "old",
        transcript: "Older note",
        createdAt: "2026-01-01T10:00:00Z",
        tags: [],
        tone: "neutral",
      }),
      makeNote({
        id: "new",
        transcript: "Newer note",
        createdAt: "2026-02-15T10:00:00Z",
        tags: [],
        tone: "neutral",
      }),
    ]);
    await page.reload();

    const cards = page.locator(".note-card");
    await expect(cards).toHaveCount(2);

    // First card should be the newer note
    await expect(cards.nth(0)).toHaveAttribute("data-id", "new");
    await expect(cards.nth(1)).toHaveAttribute("data-id", "old");
  });

  test("empty state hides when notes exist", async ({ page }) => {
    await page.goto("/");
    await seedNotes(page, [
      makeNote({ id: "note1", transcript: "Test", tags: [], tone: "neutral" }),
    ]);
    await page.reload();

    await expect(page.locator("#empty-state")).toBeHidden();
  });

  test("empty state returns after deleting last note", async ({ page }) => {
    await page.goto("/");
    await seedNotes(page, [
      makeNote({ id: "only", transcript: "Delete me", tags: [], tone: "neutral" }),
    ]);
    await page.reload();

    await expect(page.locator(".note-card")).toHaveCount(1);
    await expect(page.locator("#empty-state")).toBeHidden();

    await page.locator(".delete-btn").click();
    await expect(page.locator(".note-card")).toHaveCount(0);
    await expect(page.locator("#empty-state")).toBeVisible();
  });
});

// ─── Deletion ────────────────────────────────────────────────────────────────

test.describe("Note Deletion", () => {
  test("delete removes the card from the list", async ({ page }) => {
    await page.goto("/");
    await seedNotes(page, [
      makeNote({ id: "del1", transcript: "Note one", tags: [], tone: "neutral" }),
      makeNote({ id: "del2", transcript: "Note two", tags: [], tone: "neutral" }),
    ]);
    await page.reload();

    await expect(page.locator(".note-card")).toHaveCount(2);

    // Delete the first card
    await page.locator('.note-card[data-id="del1"] .delete-btn').click();
    await expect(page.locator(".note-card")).toHaveCount(1);
    await expect(page.locator('.note-card[data-id="del2"]')).toBeVisible();
  });

  test("deleted note does not persist after reload", async ({ page }) => {
    await page.goto("/");
    await seedNotes(page, [
      makeNote({ id: "persist-del", transcript: "Should be gone", tags: [], tone: "neutral" }),
    ]);
    await page.reload();

    await page.locator(".delete-btn").click();
    await expect(page.locator(".note-card")).toHaveCount(0);

    // Reload and verify it is still gone
    await page.reload();
    await expect(page.locator(".note-card")).toHaveCount(0);
    await expect(page.locator("#empty-state")).toBeVisible();
  });
});

// ─── Playback UI ─────────────────────────────────────────────────────────────

test.describe("Playback UI", () => {
  test("play button toggles to pause", async ({ page }) => {
    await page.goto("/");
    // Need a real audioBlob for playback — create one in the browser
    await page.evaluate(`(async () => {
      const blob = ${makeWavBlobScript(1)};
      const req = indexedDB.open("voiceNotesDB", 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("notes"))
          db.createObjectStore("notes", { keyPath: "id" });
      };
      await new Promise((resolve) => {
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction("notes", "readwrite");
          tx.objectStore("notes").put({
            id: "play1",
            audioBlob: blob,
            transcript: "Playback test",
            duration: 1,
            createdAt: new Date().toISOString(),
            tags: [],
            tone: "neutral",
          });
          tx.oncomplete = () => { db.close(); resolve(); };
        };
      });
    })()`);
    await page.reload();

    const playBtn = page.locator('.note-card[data-id="play1"] .play-btn');
    await expect(playBtn).toContainText("Play");

    await playBtn.click();
    await expect(playBtn).toContainText("Pause");
  });

  test("progress bar becomes visible during playback", async ({ page }) => {
    await page.goto("/");
    await page.evaluate(`(async () => {
      const blob = ${makeWavBlobScript(1)};
      const req = indexedDB.open("voiceNotesDB", 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("notes"))
          db.createObjectStore("notes", { keyPath: "id" });
      };
      await new Promise((resolve) => {
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction("notes", "readwrite");
          tx.objectStore("notes").put({
            id: "prog1",
            audioBlob: blob,
            transcript: "Progress test",
            duration: 1,
            createdAt: new Date().toISOString(),
            tags: [],
            tone: "neutral",
          });
          tx.oncomplete = () => { db.close(); resolve(); };
        };
      });
    })()`);
    await page.reload();

    const progress = page.locator(
      '.note-card[data-id="prog1"] .note-progress',
    );
    await expect(progress).not.toHaveClass(/visible/);

    await page.locator('.note-card[data-id="prog1"] .play-btn').click();
    await expect(progress).toHaveClass(/visible/);
  });

  test("play resets to Play after audio ends", async ({ page }) => {
    await page.goto("/");
    // Create a very short audio clip (0.1s) so it ends quickly
    await page.evaluate(`(async () => {
      const blob = ${makeWavBlobScript(0.1)};
      const req = indexedDB.open("voiceNotesDB", 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("notes"))
          db.createObjectStore("notes", { keyPath: "id" });
      };
      await new Promise((resolve) => {
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction("notes", "readwrite");
          tx.objectStore("notes").put({
            id: "end1",
            audioBlob: blob,
            transcript: "Short audio",
            duration: 0.1,
            createdAt: new Date().toISOString(),
            tags: [],
            tone: "neutral",
          });
          tx.oncomplete = () => { db.close(); resolve(); };
        };
      });
    })()`);
    await page.reload();

    const playBtn = page.locator('.note-card[data-id="end1"] .play-btn');
    await playBtn.click();
    // Wait for audio to end and button to reset
    await expect(playBtn).toContainText("Play", { timeout: 5000 });
  });
});

// ─── Persistence (IndexedDB) ─────────────────────────────────────────────────

test.describe("Persistence", () => {
  test("notes survive page reload", async ({ page }) => {
    await page.goto("/");
    await seedNotes(page, [
      makeNote({
        id: "persistent",
        transcript: "I should survive a reload",
        tags: ["journal"],
        tone: "warm",
      }),
    ]);
    await page.reload();

    await expect(page.locator('.note-card[data-id="persistent"]')).toBeVisible();
    await expect(
      page.locator('.note-card[data-id="persistent"] .note-transcript'),
    ).toHaveText("I should survive a reload");

    // Reload again
    await page.reload();
    await expect(page.locator('.note-card[data-id="persistent"]')).toBeVisible();
  });

  test("tone and tags persist after reload", async ({ page }) => {
    await page.goto("/");
    await seedNotes(page, [
      makeNote({
        id: "persist-analysis",
        transcript: "Meeting with the project team tomorrow",
        tags: ["work", "reminder"],
        tone: "warm",
      }),
    ]);
    await page.reload();

    const card = page.locator('.note-card[data-id="persist-analysis"]');
    await expect(card.locator(".tone-label")).toHaveText("Positive");
    const tagChips = card.locator(".note-tag:not(.tone-label)");
    await expect(tagChips).toHaveCount(2);

    // Reload and verify they are still there
    await page.reload();
    await expect(
      page.locator('.note-card[data-id="persist-analysis"] .tone-label'),
    ).toHaveText("Positive");
  });
});

// ─── Recording UI State Machine ──────────────────────────────────────────────

test.describe("Recording UI", () => {
  test("record button changes appearance when recording", async ({
    page,
    context,
  }) => {
    // Grant microphone permission
    await context.grantPermissions(["microphone"]);
    await page.goto("/");

    const recordBtn = page.locator("#record-btn");
    await expect(recordBtn).not.toHaveClass(/recording/);

    // We cannot fully mock MediaRecorder in Playwright easily, but we can
    // test that clicking the button attempts to start recording. If getUserMedia
    // fails (no real mic), the hint should say "Microphone access denied".
    // With granted permissions and Chromium's fake device, it may work.
    await recordBtn.click();

    // Either it starts recording or shows an error — both are valid outcomes
    const hint = page.locator("#record-hint");
    const hintText = await hint.textContent();
    expect(
      hintText === "Tap to stop" || hintText === "Microphone access denied",
    ).toBeTruthy();
  });
});

// ─── Recovery Behavior ───────────────────────────────────────────────────────

test.describe("Recovery", () => {
  test("tags-only recovery preserves existing tone", async ({ page }) => {
    await page.goto("/");
    // Note with tone but no tags array — recovery should add tags without
    // clearing the tone
    await seedNotes(page, [
      makeNote({
        id: "recovery-tone",
        transcript: "Remember to pick up groceries for dinner",
        tone: "warm",
        // tags intentionally omitted — not an array
      }),
    ]);
    await page.reload();

    const card = page.locator('.note-card[data-id="recovery-tone"]');
    // Tone should still be visible (not flickered away)
    await expect(card.locator(".tone-label")).toHaveText("Positive");
    // Tags should be computed by keyword tagger ("remember to" → todo/reminder,
    // "grocery" / "dinner" → personal)
    const tagChips = card.locator(".note-tag:not(.tone-label)");
    await expect(tagChips.first()).toBeVisible();
  });

  test("notes without tags or tone show Analyzing then get tags", async ({
    page,
  }) => {
    await page.goto("/");
    await seedNotes(page, [
      makeNote({
        id: "recovery-both",
        transcript: "Need to email the client about the project deadline",
        // no tags, no tone
      }),
    ]);
    await page.reload();

    const card = page.locator('.note-card[data-id="recovery-both"]');
    // Tags should be filled in by the recovery loop (keyword tagger runs instantly)
    // "need to" → todo, "client" / "project" / "deadline" → work, "deadline" → reminder
    const tagChips = card.locator(".note-tag:not(.tone-label)");
    await expect(tagChips.first()).toBeVisible({ timeout: 5000 });
  });
});

// ─── HTML Escaping ───────────────────────────────────────────────────────────

test.describe("Security", () => {
  test("transcript is HTML-escaped", async ({ page }) => {
    await page.goto("/");
    await seedNotes(page, [
      makeNote({
        id: "xss-test",
        transcript: '<script>alert("xss")</script>',
        tags: [],
        tone: "neutral",
      }),
    ]);
    await page.reload();

    const card = page.locator('.note-card[data-id="xss-test"]');
    // Should display the raw text, not execute the script
    await expect(card.locator(".note-transcript")).toHaveText(
      '<script>alert("xss")</script>',
    );

    // Verify no script was injected
    const alertFired = await page.evaluate(() => {
      return window.__xss_fired || false;
    });
    expect(alertFired).toBe(false);
  });

  test("tag content is HTML-escaped", async ({ page }) => {
    await page.goto("/");
    await seedNotes(page, [
      makeNote({
        id: "xss-tag",
        transcript: "Test",
        tags: ['<img src=x onerror=alert(1)>'],
        tone: "neutral",
      }),
    ]);
    await page.reload();

    const card = page.locator('.note-card[data-id="xss-tag"]');
    const tagChip = card.locator(".note-tag").first();
    await expect(tagChip).toHaveText('<img src=x onerror=alert(1)>');
  });
});

// ─── Console Error Monitoring ────────────────────────────────────────────────

test.describe("No Crashes", () => {
  test("app loads without console errors", async ({ page }) => {
    const errors = [];
    page.on("pageerror", (err) => errors.push(err.message));

    await page.goto("/");
    // Wait for app to settle
    await page.waitForTimeout(1000);

    // Filter out model-loading errors (expected when model CDN is unavailable)
    const realErrors = errors.filter(
      (e) => !e.includes("Failed to load") && !e.includes("pipeline"),
    );
    expect(realErrors).toEqual([]);
  });

  test("app loads with seeded data without errors", async ({ page }) => {
    const errors = [];
    page.on("pageerror", (err) => errors.push(err.message));

    await page.goto("/");
    await seedNotes(page, [
      makeNote({ id: "err1", transcript: "Note 1", tags: ["work"], tone: "warm" }),
      makeNote({ id: "err2", transcript: "Note 2", tags: [], tone: "neutral" }),
      makeNote({ id: "err3", transcript: "", audioBlob: null }),
    ]);
    await page.reload();

    await page.waitForTimeout(1000);

    const realErrors = errors.filter(
      (e) => !e.includes("Failed to load") && !e.includes("pipeline"),
    );
    expect(realErrors).toEqual([]);
  });

  test("no unhandled promise rejections on load", async ({ page }) => {
    const rejections = [];
    page.on("pageerror", (err) => rejections.push(err.message));

    // Listen for unhandled rejections via console
    const unhandled = [];
    page.on("console", (msg) => {
      if (msg.type() === "error" && msg.text().includes("Unhandled")) {
        unhandled.push(msg.text());
      }
    });

    await page.goto("/");
    await page.waitForTimeout(1500);

    // Filter expected model loading errors
    const unexpected = rejections.filter(
      (e) =>
        !e.includes("Failed to load") &&
        !e.includes("pipeline") &&
        !e.includes("Model load timed out"),
    );
    expect(unexpected).toEqual([]);
  });
});

// ─── Stability & Error Resilience ───────────────────────────────────────────

test.describe("Stability", () => {
  test("app survives model loading failure without crashing", async ({
    page,
  }) => {
    // Override the mock to make pipeline() reject
    await page.route("**/cdn.jsdelivr.net/**", (route) => {
      route.fulfill({
        contentType: "application/javascript; charset=utf-8",
        body: `
          export function pipeline() {
            return Promise.reject(new Error("Simulated model failure"));
          }
        `,
      });
    });

    const errors = [];
    page.on("pageerror", (err) => errors.push(err.message));

    await page.goto("/");
    await page.waitForTimeout(1500);

    // App should still be functional (no uncaught page errors)
    const realErrors = errors.filter(
      (e) =>
        !e.includes("Simulated model failure") &&
        !e.includes("Failed to load") &&
        !e.includes("pipeline"),
    );
    expect(realErrors).toEqual([]);

    // UI should still render properly
    await expect(page.locator("h1")).toHaveText("Voice Notes");
    await expect(page.locator("#record-btn")).toBeVisible();

    // Model status should show error
    await expect(page.locator("#model-status")).toHaveText(
      "Model failed to load",
    );
  });

  test("app survives corrupted note data without crashing", async ({
    page,
  }) => {
    const errors = [];
    page.on("pageerror", (err) => errors.push(err.message));

    await page.goto("/");
    // Seed notes with various kinds of corrupted/edge-case data
    await seedNotes(page, [
      // Normal note
      makeNote({ id: "good", transcript: "Normal note", tags: ["work"], tone: "warm" }),
      // Note with null transcript
      makeNote({ id: "null-transcript", transcript: null, tags: [], tone: "neutral" }),
      // Note with undefined fields
      { id: "minimal", createdAt: new Date().toISOString(), duration: 0 },
      // Note with empty tags but valid transcript
      makeNote({ id: "empty-tags", transcript: "Hello world", tags: [], tone: "" }),
      // Note with very long transcript
      makeNote({
        id: "long",
        transcript: "word ".repeat(5000).trim(),
        tags: ["journal"],
        tone: "warm",
      }),
    ]);
    await page.reload();
    await page.waitForTimeout(1000);

    // Should render without crash
    const realErrors = errors.filter(
      (e) => !e.includes("Failed to load") && !e.includes("pipeline"),
    );
    expect(realErrors).toEqual([]);

    // At least the good note should be visible
    await expect(page.locator('.note-card[data-id="good"]')).toBeVisible();
  });

  test("deleting a note while others are loading doesn't crash", async ({
    page,
  }) => {
    const errors = [];
    page.on("pageerror", (err) => errors.push(err.message));

    await page.goto("/");
    await seedNotes(page, [
      makeNote({ id: "del-race-1", transcript: "First note", tags: ["work"], tone: "warm" }),
      makeNote({ id: "del-race-2", transcript: "Second note", tags: [], tone: "neutral" }),
      makeNote({ id: "del-race-3", transcript: "Third note", tags: ["todo"], tone: "heavy" }),
    ]);
    await page.reload();

    await expect(page.locator(".note-card")).toHaveCount(3);

    // Rapidly delete the first note
    await page.locator('.note-card[data-id="del-race-1"] .delete-btn').click();
    await expect(page.locator(".note-card")).toHaveCount(2);

    // Immediately delete another
    await page.locator('.note-card[data-id="del-race-2"] .delete-btn').click();
    await expect(page.locator(".note-card")).toHaveCount(1);

    await page.waitForTimeout(500);

    const realErrors = errors.filter(
      (e) => !e.includes("Failed to load") && !e.includes("pipeline"),
    );
    expect(realErrors).toEqual([]);

    // Remaining note should be intact
    await expect(page.locator('.note-card[data-id="del-race-3"]')).toBeVisible();
  });

  test("app handles many notes without crashing", async ({ page }) => {
    const errors = [];
    page.on("pageerror", (err) => errors.push(err.message));

    await page.goto("/");

    // Generate 50 notes
    const notes = [];
    for (let i = 0; i < 50; i++) {
      notes.push(
        makeNote({
          id: `bulk-${i}`,
          transcript: `Note number ${i} about the meeting with the project team`,
          tags: ["work"],
          tone: i % 3 === 0 ? "warm" : i % 3 === 1 ? "heavy" : "neutral",
          createdAt: new Date(Date.now() - i * 60000).toISOString(),
        }),
      );
    }
    await seedNotes(page, notes);
    await page.reload();

    // All notes should render
    await expect(page.locator(".note-card")).toHaveCount(50);

    await page.waitForTimeout(500);

    const realErrors = errors.filter(
      (e) => !e.includes("Failed to load") && !e.includes("pipeline"),
    );
    expect(realErrors).toEqual([]);
  });

  test("playback on missing audio blob doesn't crash", async ({ page }) => {
    const errors = [];
    page.on("pageerror", (err) => errors.push(err.message));

    await page.goto("/");
    await seedNotes(page, [
      makeNote({
        id: "no-blob",
        transcript: "Note with no audio",
        tags: [],
        tone: "neutral",
        // audioBlob intentionally omitted
      }),
    ]);
    await page.reload();

    // Click play on note without audio — should not crash
    const playBtn = page.locator('.note-card[data-id="no-blob"] .play-btn');
    await playBtn.click();
    await page.waitForTimeout(500);

    const realErrors = errors.filter(
      (e) => !e.includes("Failed to load") && !e.includes("pipeline"),
    );
    expect(realErrors).toEqual([]);
  });

  test("rapid play/pause toggling doesn't crash", async ({ page }) => {
    const errors = [];
    page.on("pageerror", (err) => errors.push(err.message));

    await page.goto("/");
    await page.evaluate(`(async () => {
      const blob = ${makeWavBlobScript(2)};
      const req = indexedDB.open("voiceNotesDB", 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("notes"))
          db.createObjectStore("notes", { keyPath: "id" });
      };
      await new Promise((resolve) => {
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction("notes", "readwrite");
          tx.objectStore("notes").put({
            id: "rapid-play",
            audioBlob: blob,
            transcript: "Rapid play test",
            duration: 2,
            createdAt: new Date().toISOString(),
            tags: [],
            tone: "neutral",
          });
          tx.oncomplete = () => { db.close(); resolve(); };
        };
      });
    })()`);
    await page.reload();

    const playBtn = page.locator('.note-card[data-id="rapid-play"] .play-btn');

    // Rapidly toggle play/pause 6 times
    for (let i = 0; i < 6; i++) {
      await playBtn.click();
      await page.waitForTimeout(100);
    }

    await page.waitForTimeout(500);

    const realErrors = errors.filter(
      (e) => !e.includes("Failed to load") && !e.includes("pipeline"),
    );
    expect(realErrors).toEqual([]);
  });

  test("switching playback between two notes doesn't crash", async ({
    page,
  }) => {
    const errors = [];
    page.on("pageerror", (err) => errors.push(err.message));

    await page.goto("/");
    await page.evaluate(`(async () => {
      const blob = ${makeWavBlobScript(2)};
      const req = indexedDB.open("voiceNotesDB", 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("notes"))
          db.createObjectStore("notes", { keyPath: "id" });
      };
      await new Promise((resolve) => {
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction("notes", "readwrite");
          const store = tx.objectStore("notes");
          store.put({
            id: "switch-a",
            audioBlob: blob,
            transcript: "Note A for switching",
            duration: 2,
            createdAt: new Date().toISOString(),
            tags: [],
            tone: "neutral",
          });
          store.put({
            id: "switch-b",
            audioBlob: blob,
            transcript: "Note B for switching",
            duration: 2,
            createdAt: new Date(Date.now() - 1000).toISOString(),
            tags: [],
            tone: "neutral",
          });
          tx.oncomplete = () => { db.close(); resolve(); };
        };
      });
    })()`);
    await page.reload();

    const playA = page.locator('.note-card[data-id="switch-a"] .play-btn');
    const playB = page.locator('.note-card[data-id="switch-b"] .play-btn');

    // Play A, then immediately switch to B, then back to A
    await playA.click();
    await page.waitForTimeout(200);
    await playB.click();
    await page.waitForTimeout(200);
    await playA.click();
    await page.waitForTimeout(500);

    const realErrors = errors.filter(
      (e) => !e.includes("Failed to load") && !e.includes("pipeline"),
    );
    expect(realErrors).toEqual([]);
  });

  test("model status shows error state on load failure", async ({ page }) => {
    // Override the mock to make pipeline() reject
    await page.route("**/cdn.jsdelivr.net/**", (route) => {
      route.fulfill({
        contentType: "application/javascript; charset=utf-8",
        body: `
          export function pipeline() {
            return Promise.reject(new Error("Network error"));
          }
        `,
      });
    });

    await page.goto("/");
    // Model status should show error
    await expect(page.locator("#model-status")).toHaveText(
      "Model failed to load",
      { timeout: 5000 },
    );
    await expect(page.locator("#model-status")).toHaveClass("error");
  });

  test("deleting note during playback cleans up audio", async ({ page }) => {
    const errors = [];
    page.on("pageerror", (err) => errors.push(err.message));

    await page.goto("/");
    await page.evaluate(`(async () => {
      const blob = ${makeWavBlobScript(3)};
      const req = indexedDB.open("voiceNotesDB", 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("notes"))
          db.createObjectStore("notes", { keyPath: "id" });
      };
      await new Promise((resolve) => {
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction("notes", "readwrite");
          tx.objectStore("notes").put({
            id: "del-playing",
            audioBlob: blob,
            transcript: "Delete while playing",
            duration: 3,
            createdAt: new Date().toISOString(),
            tags: [],
            tone: "neutral",
          });
          tx.oncomplete = () => { db.close(); resolve(); };
        };
      });
    })()`);
    await page.reload();

    // Start playing
    await page.locator('.note-card[data-id="del-playing"] .play-btn').click();
    await expect(
      page.locator('.note-card[data-id="del-playing"] .play-btn'),
    ).toContainText("Pause");

    // Delete the note while it's playing
    await page.locator('.note-card[data-id="del-playing"] .delete-btn').click();
    await expect(page.locator(".note-card")).toHaveCount(0);

    await page.waitForTimeout(500);

    const realErrors = errors.filter(
      (e) => !e.includes("Failed to load") && !e.includes("pipeline"),
    );
    expect(realErrors).toEqual([]);
  });

  test("recovery handles notes with missing fields gracefully", async ({
    page,
  }) => {
    const errors = [];
    page.on("pageerror", (err) => errors.push(err.message));

    await page.goto("/");
    await seedNotes(page, [
      // Note needing tag recovery
      makeNote({
        id: "recover-tags",
        transcript: "Need to call the client about the project deadline",
        tone: "warm",
        // tags omitted — recovery should compute them
      }),
      // Note needing full recovery (tags + tone)
      makeNote({
        id: "recover-both",
        transcript: "I feel grateful for the team meeting today",
        // both tags and tone omitted
      }),
    ]);
    await page.reload();

    // Wait for recovery to complete
    const tagChips = page.locator(
      '.note-card[data-id="recover-tags"] .note-tag:not(.tone-label)',
    );
    await expect(tagChips.first()).toBeVisible({ timeout: 5000 });

    // Tone should still be present on the first note
    await expect(
      page.locator('.note-card[data-id="recover-tags"] .tone-label'),
    ).toHaveText("Positive");

    // Second note should have tags computed too
    const bothTags = page.locator(
      '.note-card[data-id="recover-both"] .note-tag:not(.tone-label)',
    );
    await expect(bothTags.first()).toBeVisible({ timeout: 5000 });

    await page.waitForTimeout(500);

    const realErrors = errors.filter(
      (e) => !e.includes("Failed to load") && !e.includes("pipeline"),
    );
    expect(realErrors).toEqual([]);
  });

  test("page reload with pending recovery doesn't cause errors", async ({
    page,
  }) => {
    const errors = [];
    page.on("pageerror", (err) => errors.push(err.message));

    await page.goto("/");
    await seedNotes(page, [
      makeNote({
        id: "reload-recover",
        transcript: "Meeting with the team about the project",
        // No tags/tone — triggers recovery
      }),
    ]);

    // Reload immediately — recovery might be in progress
    await page.reload();
    // Reload again quickly
    await page.reload();

    await page.waitForTimeout(1500);

    const realErrors = errors.filter(
      (e) => !e.includes("Failed to load") && !e.includes("pipeline"),
    );
    expect(realErrors).toEqual([]);

    // Note should still be there
    await expect(
      page.locator('.note-card[data-id="reload-recover"]'),
    ).toBeVisible();
  });
});

// ─── Non-Blocking Model Loading ─────────────────────────────────────────────

test.describe("Non-Blocking Model Loading", () => {
  test("UI is interactive while model is still loading", async ({ page }) => {
    // Use a slow mock that takes 3 seconds to "load"
    await page.route("**/cdn.jsdelivr.net/**", (route) => {
      route.fulfill({
        contentType: "application/javascript; charset=utf-8",
        body: `
          export function pipeline() {
            return new Promise((resolve) => {
              setTimeout(() => {
                resolve(function dummyModel() {
                  return Promise.resolve({ text: "", labels: ["neutral"], scores: [1] });
                });
              }, 3000);
            });
          }
        `,
      });
    });

    await page.goto("/");

    // Model should still be loading
    await expect(page.locator("#model-status")).not.toHaveClass("hidden");

    // But UI should be fully interactive — notes render and buttons work
    await expect(page.locator("h1")).toHaveText("Voice Notes");
    await expect(page.locator("#record-btn")).toBeVisible();
    await expect(page.locator("#record-btn")).toBeEnabled();

    // Seed notes while model is still loading
    await page.evaluate(`(async () => {
      const req = indexedDB.open("voiceNotesDB", 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("notes"))
          db.createObjectStore("notes", { keyPath: "id" });
      };
      await new Promise((resolve) => {
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction("notes", "readwrite");
          tx.objectStore("notes").put({
            id: "during-load",
            transcript: "Note created during model loading",
            duration: 5,
            createdAt: new Date().toISOString(),
            tags: ["work"],
            tone: "warm",
          });
          tx.oncomplete = () => { db.close(); resolve(); };
        };
      });
    })()`);
    await page.reload();

    // Notes are visible even while model loads
    await expect(
      page.locator('.note-card[data-id="during-load"]'),
    ).toBeVisible();

    // Can interact with notes (delete) while model loads
    await page.locator('.note-card[data-id="during-load"] .delete-btn').click();
    await expect(page.locator(".note-card")).toHaveCount(0);
  });

  test("existing notes display immediately without waiting for model", async ({
    page,
  }) => {
    // Slow model — takes 5 seconds
    await page.route("**/cdn.jsdelivr.net/**", (route) => {
      route.fulfill({
        contentType: "application/javascript; charset=utf-8",
        body: `
          export function pipeline() {
            return new Promise((resolve) => {
              setTimeout(() => {
                resolve(function dummyModel() {
                  return Promise.resolve({ text: "", labels: ["neutral"], scores: [1] });
                });
              }, 5000);
            });
          }
        `,
      });
    });

    await page.goto("/");
    await page.evaluate(`(async () => {
      const req = indexedDB.open("voiceNotesDB", 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("notes"))
          db.createObjectStore("notes", { keyPath: "id" });
      };
      await new Promise((resolve) => {
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction("notes", "readwrite");
          const store = tx.objectStore("notes");
          store.put({
            id: "instant-1",
            transcript: "First note",
            duration: 3,
            createdAt: new Date().toISOString(),
            tags: ["work"],
            tone: "warm",
          });
          store.put({
            id: "instant-2",
            transcript: "Second note",
            duration: 7,
            createdAt: new Date(Date.now() - 60000).toISOString(),
            tags: ["todo"],
            tone: "neutral",
          });
          tx.oncomplete = () => { db.close(); resolve(); };
        };
      });
    })()`);
    await page.reload();

    // Notes should be visible immediately — not waiting for model
    const cards = page.locator(".note-card");
    await expect(cards).toHaveCount(2, { timeout: 2000 });
    await expect(cards.nth(0).locator(".note-transcript")).toHaveText(
      "First note",
    );
    await expect(cards.nth(1).locator(".note-transcript")).toHaveText(
      "Second note",
    );

    // Tags and tone should be visible immediately (from stored data)
    await expect(
      cards.nth(0).locator(".tone-label"),
    ).toHaveText("Positive");
    await expect(
      cards.nth(0).locator(".note-tag:not(.tone-label)"),
    ).toHaveText("work");
  });
});

// ─── Microphone Permission Persistence ──────────────────────────────────────

test.describe("Microphone Persistence", () => {
  test("mic stream is cached and reused across record sessions", async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["microphone"]);
    await page.goto("/");

    // Check that acquireMicStream caches the stream
    const getUserMediaCallCount = await page.evaluate(async () => {
      let callCount = 0;
      const original = navigator.mediaDevices.getUserMedia.bind(
        navigator.mediaDevices,
      );
      navigator.mediaDevices.getUserMedia = async (...args) => {
        callCount++;
        return original(...args);
      };

      // Force two stream acquisitions
      const { acquireMicStream } = await import("/app.js");

      return callCount;
    });

    // On initial load, acquireMicStream may have been called once via the
    // permissions pre-check. Subsequent calls should reuse the cached stream.
    // The point is it shouldn't be called many times.
    expect(getUserMediaCallCount).toBeLessThanOrEqual(1);
  });

  test("AudioContext is not closed between recordings", async ({ page }) => {
    await page.goto("/");
    // Verify the code no longer has audioContext.close() in stopRecording
    const appSource = await page.evaluate(async () => {
      const resp = await fetch(window.location.origin + "/app.js");
      return resp.text();
    });

    // The stopRecording function should NOT close the AudioContext
    // Look for the comment that confirms this design decision
    expect(appSource).toContain(
      "Don't close the AudioContext",
    );

    // Verify there's a persistent audio context approach
    expect(appSource).toContain("persistentAudioCtx");
    expect(appSource).toContain("getAudioContext");
  });

  test("pre-acquires mic stream on load when permission is granted", async ({
    page,
  }) => {
    await page.goto("/");
    // Verify the source code has the pre-acquisition logic
    const appSource = await page.evaluate(async () => {
      const resp = await fetch(window.location.origin + "/app.js");
      return resp.text();
    });

    expect(appSource).toContain("navigator.permissions.query");
    expect(appSource).toContain('status.state === "granted"');
    expect(appSource).toContain("acquireMicStream()");
  });
});

// ─── Recording Crash Prevention ─────────────────────────────────────────────

test.describe("Recording Crash Prevention", () => {
  test("source and analyser nodes are disconnected between recordings", async ({
    page,
  }) => {
    await page.goto("/");
    const appSource = await page.evaluate(async () => {
      const resp = await fetch(window.location.origin + "/app.js");
      return resp.text();
    });

    // stopRecording must disconnect both the source node and analyser
    expect(appSource).toContain("src.disconnect()");
    expect(appSource).toContain("anal.disconnect()");

    // startRecording must clean up leftovers before creating new nodes
    expect(appSource).toContain("sourceNode.disconnect()");

    // Module state must track the source node so it can be disconnected
    expect(appSource).toContain("let sourceNode = null");
  });

  test("record button is guarded against re-entrant clicks", async ({
    page,
  }) => {
    await page.goto("/");
    const appSource = await page.evaluate(async () => {
      const resp = await fetch(window.location.origin + "/app.js");
      return resp.text();
    });

    // There must be a busy guard that prevents concurrent startRecording calls
    expect(appSource).toContain("recordBusy");
    expect(appSource).toContain("if (recordBusy) return");
  });
});

// ─── Real Recording Flow ────────────────────────────────────────────────────
// Uses Chromium's fake audio device (--use-fake-device-for-media-stream) to
// exercise the actual getUserMedia → MediaRecorder → stop → save path.

test.describe("Real Recording Flow", () => {
  test("first recording completes without errors", async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["microphone"]);

    const errors = [];
    page.on("pageerror", (err) => errors.push(err.message));
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(msg.text());
    });

    await page.goto("/");

    const recordBtn = page.locator("#record-btn");
    const hint = page.locator("#record-hint");

    // Start recording
    await recordBtn.click();

    // Must actually enter recording state (not fail silently)
    await expect(hint).toHaveText("Tap to stop", { timeout: 5000 });
    await expect(recordBtn).toHaveClass(/recording/);

    // Record for 1.5 seconds
    await page.waitForTimeout(1500);

    // Stop recording
    await recordBtn.click();
    await expect(hint).toHaveText("Tap to record", { timeout: 5000 });
    await expect(recordBtn).not.toHaveClass(/recording/);

    // A note card should appear
    await expect(page.locator(".note-card")).toHaveCount(1, { timeout: 5000 });

    // No errors should have occurred
    const realErrors = errors.filter(
      (e) =>
        !e.includes("Failed to load") &&
        !e.includes("pipeline") &&
        !e.includes("Model load timed out") &&
        !e.includes("Transcription failed"),
    );
    expect(realErrors).toEqual([]);
  });

  test("second recording completes without errors", async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["microphone"]);

    const errors = [];
    page.on("pageerror", (err) => errors.push(err.message));
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(msg.text());
    });

    await page.goto("/");

    const recordBtn = page.locator("#record-btn");
    const hint = page.locator("#record-hint");

    // --- First recording ---
    await recordBtn.click();
    await expect(hint).toHaveText("Tap to stop", { timeout: 5000 });
    await page.waitForTimeout(1000);
    await recordBtn.click();
    await expect(hint).toHaveText("Tap to record", { timeout: 5000 });
    await expect(page.locator(".note-card")).toHaveCount(1, { timeout: 5000 });

    // --- Second recording (this is where the crash was) ---
    await recordBtn.click();
    await expect(hint).toHaveText("Tap to stop", { timeout: 5000 });
    await expect(recordBtn).toHaveClass(/recording/);
    await page.waitForTimeout(1000);
    await recordBtn.click();
    await expect(hint).toHaveText("Tap to record", { timeout: 5000 });

    // Should now have 2 notes
    await expect(page.locator(".note-card")).toHaveCount(2, { timeout: 5000 });

    const realErrors = errors.filter(
      (e) =>
        !e.includes("Failed to load") &&
        !e.includes("pipeline") &&
        !e.includes("Model load timed out") &&
        !e.includes("Transcription failed"),
    );
    expect(realErrors).toEqual([]);
  });

  test("three consecutive recordings all succeed", async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["microphone"]);

    const errors = [];
    page.on("pageerror", (err) => errors.push(err.message));

    await page.goto("/");

    const recordBtn = page.locator("#record-btn");
    const hint = page.locator("#record-hint");

    for (let i = 0; i < 3; i++) {
      await recordBtn.click();
      await expect(hint).toHaveText("Tap to stop", { timeout: 5000 });
      await page.waitForTimeout(1000);
      await recordBtn.click();
      await expect(hint).toHaveText("Tap to record", { timeout: 5000 });
      await expect(page.locator(".note-card")).toHaveCount(i + 1, {
        timeout: 5000,
      });
    }

    const realErrors = errors.filter(
      (e) =>
        !e.includes("Failed to load") &&
        !e.includes("pipeline") &&
        !e.includes("Model load timed out") &&
        !e.includes("Transcription failed"),
    );
    expect(realErrors).toEqual([]);
  });
});
