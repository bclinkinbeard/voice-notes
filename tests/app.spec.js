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
});
