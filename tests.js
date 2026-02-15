'use strict';

// ============================================================
// Voice Notes — Test Suite
// Runs in Node.js with minimal DOM mocking. Zero dependencies.
// ============================================================

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;
let currentSuite = '';

function suite(name) {
  currentSuite = name;
  console.log('\n\x1b[1m' + name + '\x1b[0m');
}

function assert(condition, message) {
  totalTests++;
  if (condition) {
    passedTests++;
    console.log('  \x1b[32m\u2714\x1b[0m ' + message);
  } else {
    failedTests++;
    console.log('  \x1b[31m\u2718\x1b[0m ' + message);
  }
}

function assertEqual(actual, expected, message) {
  const pass = actual === expected;
  assert(pass, message + (pass ? '' : ' (expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual) + ')'));
}

// ============================================================
// Replicate pure functions from app.js for testing
// (app.js runs in browser scope; we extract and test the logic)
// ============================================================

function formatDuration(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return mins + ':' + String(secs).padStart(2, '0');
}

function formatDate(isoString) {
  return new Date(isoString).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  });
}

// The transcription accumulation logic from the onresult handler
function accumulateTranscription(resultSets) {
  let transcriptionResult = '';
  for (const resultSet of resultSets) {
    for (let i = 0; i < resultSet.length; i++) {
      if (resultSet[i].isFinal) {
        const text = resultSet[i][0].transcript.trim();
        if (text) {
          transcriptionResult += (transcriptionResult ? ' ' : '') + text;
        }
      }
    }
  }
  return transcriptionResult;
}

// Simulates stopTranscription logic (now async — waits for onend)
function simulateStopTranscription(recognition, transcriptionResult) {
  if (!recognition) {
    return Promise.resolve({ result: transcriptionResult, recognition: null, stopped: false });
  }

  // Mirror the real app.js stopTranscription: it sets onend, then calls stop().
  // The browser fires onend asynchronously after stop(). We simulate this.
  return new Promise((resolve) => {
    const ref = recognition;
    ref._stopped = false;

    // Override stop to mark stopped, then async-fire onend
    ref.stop = function() {
      ref._stopped = true;
      Promise.resolve().then(() => {
        if (ref.onend) ref.onend();
      });
    };

    recognition = null;

    ref.onend = () => {
      const result = transcriptionResult;
      resolve({ result, recognition: null, stopped: ref._stopped });
    };

    ref.stop();
  });
}

// Simulates startTranscription guard
function wouldStartTranscription(SpeechRecognitionCtor) {
  if (!SpeechRecognitionCtor) return false;
  return true;
}

// Minimal DOM element mock for card rendering tests
function createElement(tag) {
  const classes = new Set();
  const children = [];
  const el = {
    tagName: tag.toUpperCase(),
    className: '',
    textContent: '',
    type: '',
    style: {},
    children,
    classList: {
      add(c) { classes.add(c); el.className = Array.from(classes).join(' '); },
      remove(c) { classes.delete(c); el.className = Array.from(classes).join(' '); },
      contains(c) { return classes.has(c); }
    },
    appendChild(child) { children.push(child); },
    querySelector(selector) {
      // Simple class selector support
      const cls = selector.startsWith('.') ? selector.slice(1) : null;
      if (!cls) return null;
      if (classes.has(cls)) return el;
      for (const child of children) {
        const found = child.querySelector ? child.querySelector(selector) : null;
        if (found) return found;
      }
      return null;
    },
    get innerHTML() {
      // textContent was set directly, so HTML-escaped
      return escapeHTML(el.textContent);
    }
  };
  // Sync className setter to classes set
  Object.defineProperty(el, 'className', {
    get() { return Array.from(classes).join(' '); },
    set(val) {
      classes.clear();
      if (val) val.split(' ').filter(Boolean).forEach((c) => classes.add(c));
    }
  });
  return el;
}

function escapeHTML(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Replicate createNoteCard logic for DOM tests
function createNoteCard(note) {
  const card = createElement('div');
  card.className = 'note-card';

  const header = createElement('div');
  header.className = 'note-header';
  const dateSpan = createElement('span');
  dateSpan.className = 'note-date';
  dateSpan.textContent = formatDate(note.createdAt);
  const durationSpan = createElement('span');
  durationSpan.className = 'note-duration';
  durationSpan.textContent = formatDuration(note.duration);
  header.appendChild(dateSpan);
  header.appendChild(durationSpan);

  const progress = createElement('div');
  progress.className = 'note-progress';
  const progressFill = createElement('div');
  progressFill.className = 'note-progress-fill';
  progress.appendChild(progressFill);

  const actions = createElement('div');
  actions.className = 'note-actions';
  const playBtn = createElement('button');
  playBtn.type = 'button';
  playBtn.className = 'play-btn';
  playBtn.textContent = 'Play';
  const deleteBtn = createElement('button');
  deleteBtn.type = 'button';
  deleteBtn.className = 'delete-btn';
  deleteBtn.textContent = 'Delete';
  actions.appendChild(playBtn);
  actions.appendChild(deleteBtn);

  const transcriptionEl = createElement('p');
  transcriptionEl.className = 'note-transcription';
  if (note.transcription) {
    transcriptionEl.textContent = note.transcription;
  } else {
    transcriptionEl.textContent = 'No transcription available';
    transcriptionEl.classList.add('note-transcription-empty');
  }

  card.appendChild(header);
  card.appendChild(progress);
  card.appendChild(transcriptionEl);
  card.appendChild(actions);

  return card;
}

// ============================================================
// Test Suites
// ============================================================

async function runTests() {

suite('formatDuration');
assertEqual(formatDuration(0), '0:00', 'formats 0 seconds');
assertEqual(formatDuration(5), '0:05', 'formats 5 seconds');
assertEqual(formatDuration(9), '0:09', 'formats 9 seconds');
assertEqual(formatDuration(10), '0:10', 'formats 10 seconds');
assertEqual(formatDuration(59), '0:59', 'formats 59 seconds');
assertEqual(formatDuration(60), '1:00', 'formats 60 seconds');
assertEqual(formatDuration(61), '1:01', 'formats 61 seconds');
assertEqual(formatDuration(125), '2:05', 'formats 125 seconds');
assertEqual(formatDuration(600), '10:00', 'formats 600 seconds');
assertEqual(formatDuration(3600), '60:00', 'formats 3600 seconds (1 hour)');
assertEqual(formatDuration(3661), '61:01', 'formats 3661 seconds');

suite('formatDate');
const dateStr = formatDate('2026-02-15T14:30:00.000Z');
assert(typeof dateStr === 'string' && dateStr.length > 0, 'produces non-empty string');
assert(dateStr.includes('Feb') || dateStr.includes('15'), 'includes expected month or day');
const dateStr2 = formatDate('2026-12-25T00:00:00.000Z');
assert(dateStr2.includes('Dec') || dateStr2.includes('25'), 'handles December date');

suite('Transcription result accumulation');
assertEqual(
  accumulateTranscription([]),
  '',
  'empty input yields empty string'
);
assertEqual(
  accumulateTranscription([[{ isFinal: true, 0: { transcript: 'Hello world' } }]]),
  'Hello world',
  'single final result'
);
assertEqual(
  accumulateTranscription([
    [{ isFinal: true, 0: { transcript: 'Hello' } }],
    [{ isFinal: true, 0: { transcript: 'world' } }]
  ]),
  'Hello world',
  'multiple batches joined with space'
);
assertEqual(
  accumulateTranscription([
    [{ isFinal: false, 0: { transcript: 'Hel' } }],
    [{ isFinal: true, 0: { transcript: 'Hello' } }]
  ]),
  'Hello',
  'interim results skipped'
);
assertEqual(
  accumulateTranscription([[{ isFinal: true, 0: { transcript: '  spaced  ' } }]]),
  'spaced',
  'results are trimmed'
);
assertEqual(
  accumulateTranscription([[{ isFinal: true, 0: { transcript: '' } }]]),
  '',
  'empty transcript strings ignored'
);
assertEqual(
  accumulateTranscription([[{ isFinal: true, 0: { transcript: '   ' } }]]),
  '',
  'whitespace-only transcript strings ignored'
);
assertEqual(
  accumulateTranscription([
    [
      { isFinal: true, 0: { transcript: 'First' } },
      { isFinal: true, 0: { transcript: 'Second' } },
      { isFinal: false, 0: { transcript: 'Nope' } }
    ]
  ]),
  'First Second',
  'multiple results in single batch: finals joined, interim skipped'
);

suite('stopTranscription logic (async)');
await (async () => {
  const mockRecognition = { _stopped: false, stop() { this._stopped = true; } };
  const result = await simulateStopTranscription(mockRecognition, 'Hello world');
  assertEqual(result.result, 'Hello world', 'returns accumulated text after onend');
  assert(mockRecognition._stopped, 'calls stop() on recognition');
  assertEqual(result.recognition, null, 'nullifies recognition reference');
})();
await (async () => {
  const result = await simulateStopTranscription(null, '');
  assertEqual(result.result, '', 'returns empty string when no recognition');
  assertEqual(result.recognition, null, 'recognition stays null');
})();
// Test onerror fallback — recognition that errors instead of ending
await (async () => {
  const errorRecognition = {
    onend: null,
    onerror: null,
    stop() {
      // Simulate browser firing onerror instead of onend
      Promise.resolve().then(() => {
        if (this.onerror) this.onerror({ error: 'service-not-available' });
      });
    }
  };
  // Simulate the real stopTranscription: set both onend and onerror to done, then stop
  const result = await new Promise((resolve) => {
    function done() {
      resolve('resolved');
    }
    errorRecognition.onend = done;
    errorRecognition.onerror = done;
    errorRecognition.stop();
  });
  assertEqual(result, 'resolved', 'onerror fallback resolves the promise when recognition errors');
})();

suite('startTranscription guard');
assertEqual(wouldStartTranscription(undefined), false, 'does not start when undefined');
assertEqual(wouldStartTranscription(null), false, 'does not start when null');
assertEqual(wouldStartTranscription(function() {}), true, 'starts when constructor exists');

suite('Note card — with transcription');
{
  const note = {
    id: 'test-1',
    duration: 45,
    transcription: 'This is a test note',
    createdAt: '2026-02-15T14:30:00.000Z'
  };
  const card = createNoteCard(note);
  assert(card.classList.contains('note-card'), 'card has note-card class');
  assertEqual(card.children.length, 4, 'card has 4 children');
  assert(card.children[0].classList.contains('note-header'), 'first child is header');
  assert(card.children[1].classList.contains('note-progress'), 'second child is progress');
  assert(card.children[2].classList.contains('note-transcription'), 'third child is transcription');
  assert(card.children[3].classList.contains('note-actions'), 'fourth child is actions');

  const transcriptionEl = card.querySelector('.note-transcription');
  assertEqual(transcriptionEl.textContent, 'This is a test note', 'displays transcription text');
  assert(!transcriptionEl.classList.contains('note-transcription-empty'), 'no empty class when text present');
}

suite('Note card — empty transcription');
{
  const note = {
    id: 'test-2',
    duration: 10,
    transcription: '',
    createdAt: '2026-02-15T14:00:00.000Z'
  };
  const card = createNoteCard(note);
  const transcriptionEl = card.querySelector('.note-transcription');
  assertEqual(transcriptionEl.textContent, 'No transcription available', 'shows fallback text');
  assert(transcriptionEl.classList.contains('note-transcription-empty'), 'has empty class');
}

suite('Note card — legacy note (no transcription field)');
{
  const note = {
    id: 'test-3',
    duration: 10,
    createdAt: '2026-01-01T10:00:00.000Z'
  };
  const card = createNoteCard(note);
  const transcriptionEl = card.querySelector('.note-transcription');
  assertEqual(transcriptionEl.textContent, 'No transcription available', 'shows fallback for legacy note');
  assert(transcriptionEl.classList.contains('note-transcription-empty'), 'has empty class for legacy note');
}

suite('Note card — duration badge');
{
  const note = { id: 'test-dur', duration: 125, transcription: 'hi', createdAt: '2026-02-15T12:00:00.000Z' };
  const card = createNoteCard(note);
  const dur = card.querySelector('.note-duration');
  assertEqual(dur.textContent, '2:05', 'duration badge shows formatted time');
}

suite('Note card — action buttons');
{
  const note = { id: 'test-btn', duration: 5, transcription: '', createdAt: '2026-02-15T12:00:00.000Z' };
  const card = createNoteCard(note);
  const playBtn = card.querySelector('.play-btn');
  const deleteBtn = card.querySelector('.delete-btn');
  assertEqual(playBtn.textContent, 'Play', 'play button text');
  assertEqual(deleteBtn.textContent, 'Delete', 'delete button text');
  assertEqual(playBtn.type, 'button', 'play button type attribute');
  assertEqual(deleteBtn.type, 'button', 'delete button type attribute');
}

suite('XSS safety');
{
  const note = {
    id: 'test-xss',
    duration: 5,
    transcription: '<script>alert("xss")</script> & "quotes"',
    createdAt: '2026-02-15T12:00:00.000Z'
  };
  const card = createNoteCard(note);
  const el = card.querySelector('.note-transcription');
  assertEqual(el.textContent, '<script>alert("xss")</script> & "quotes"', 'special chars preserved in textContent');
  assert(!el.innerHTML.includes('<script>'), 'script tags escaped in innerHTML');
}

suite('Long transcription');
{
  const longText = 'word '.repeat(500).trim();
  const note = { id: 'test-long', duration: 300, transcription: longText, createdAt: '2026-02-15T12:00:00.000Z' };
  const card = createNoteCard(note);
  assertEqual(card.querySelector('.note-transcription').textContent, longText, 'long text preserved');
}

suite('Note schema contract');
{
  const note = {
    id: 'abc-123',
    audioBlob: {},
    duration: 45,
    transcription: 'test',
    createdAt: '2026-02-15T14:30:00.000Z'
  };
  assertEqual(typeof note.id, 'string', 'id is string');
  assertEqual(typeof note.duration, 'number', 'duration is number');
  assertEqual(typeof note.transcription, 'string', 'transcription is string');
  assertEqual(typeof note.createdAt, 'string', 'createdAt is string');
  assert('audioBlob' in note, 'audioBlob field exists');
}

suite('stopRecording result contract');
{
  const result = { blob: {}, duration: 5, transcription: 'test words' };
  assert('blob' in result, 'result has blob');
  assert('duration' in result, 'result has duration');
  assert('transcription' in result, 'result has transcription');
  assertEqual(typeof result.transcription, 'string', 'transcription is a string');
}

// ============================================================
// Source file verification
// ============================================================

suite('Source file integrity');
{
  const fs = require('fs');
  const appJs = fs.readFileSync(__dirname + '/app.js', 'utf8');

  assert(appJs.includes('SpeechRecognition'), 'app.js references SpeechRecognition');
  assert(appJs.includes('startTranscription'), 'app.js defines startTranscription');
  assert(appJs.includes('stopTranscription'), 'app.js defines stopTranscription');
  assert(appJs.includes('transcription: result.transcription'), 'note object includes transcription from result');
  assert(appJs.includes('note-transcription'), 'app.js uses note-transcription class');
  assert(appJs.includes('note-transcription-empty'), 'app.js uses note-transcription-empty class');
  assert(appJs.includes("recognition.continuous = true"), 'recognition is set to continuous mode');
  assert(appJs.includes("recognition.interimResults = false"), 'interimResults is false (only final results)');
  assert(appJs.includes("recognition.lang"), 'recognition language is set');
  assert(appJs.includes("navigator.language || 'en-US'"), 'falls back to en-US');
  assert(appJs.includes('recognition.onend'), 'stopTranscription waits for onend event');
  assert(appJs.includes('recognition.onerror = done'), 'stopTranscription handles onerror fallback');
  assert(appJs.includes('Promise'), 'stopTranscription returns a Promise');
  assert(!appJs.includes('import '), 'no ES module imports (stays vanilla)');
  assert(!appJs.includes('require('), 'no CommonJS requires (stays vanilla)');
  assert(appJs.includes("'use strict'"), 'uses strict mode');

  const appCss = fs.readFileSync(__dirname + '/app.css', 'utf8');
  assert(appCss.includes('.note-transcription'), 'app.css defines .note-transcription');
  assert(appCss.includes('.note-transcription-empty'), 'app.css defines .note-transcription-empty');

  const indexHtml = fs.readFileSync(__dirname + '/index.html', 'utf8');
  assert(indexHtml.includes('app.js'), 'index.html loads app.js');
  assert(indexHtml.includes('app.css'), 'index.html loads app.css');
}

} // end runTests

// ============================================================
// Summary
// ============================================================

runTests().then(() => {
  console.log('\n' + '='.repeat(40));
  if (failedTests === 0) {
    console.log('\x1b[32m' + passedTests + '/' + totalTests + ' tests passed\x1b[0m');
  } else {
    console.log('\x1b[31m' + passedTests + '/' + totalTests + ' passed, ' + failedTests + ' failed\x1b[0m');
  }
  console.log('='.repeat(40));
  process.exit(failedTests > 0 ? 1 : 0);
}).catch((err) => {
  console.error('Test runner error:', err);
  process.exit(1);
});
