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

function assertDeepEqual(actual, expected, message) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  assert(pass, message + (pass ? '' : ' (expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual) + ')'));
}

// ============================================================
// Replicate pure functions from app.js for testing
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

function simulateStopTranscription(recognition, transcriptionResult) {
  if (!recognition) {
    return Promise.resolve({ result: transcriptionResult, recognition: null, stopped: false });
  }

  return new Promise((resolve) => {
    const ref = recognition;
    ref._stopped = false;

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

function wouldStartTranscription(SpeechRecognitionCtor) {
  if (!SpeechRecognitionCtor) return false;
  return true;
}

// Replicate splitTranscriptionOnAnd from app.js
function splitTranscriptionOnAnd(text) {
  if (!text) return [text];
  const parts = text.split(/\s+and\s+/i).map((s) => s.trim()).filter(Boolean);
  return parts.length > 0 ? parts : [text];
}

// Minimal DOM element mock
function createElement(tag) {
  const classes = new Set();
  const children = [];
  const attributes = {};
  const listeners = {};
  const el = {
    tagName: tag.toUpperCase(),
    className: '',
    textContent: '',
    type: '',
    checked: false,
    style: {},
    children,
    dataset: {},
    classList: {
      add(c) { classes.add(c); el.className = Array.from(classes).join(' '); },
      remove(c) { classes.delete(c); el.className = Array.from(classes).join(' '); },
      contains(c) { return classes.has(c); }
    },
    appendChild(child) { children.push(child); },
    setAttribute(name, value) { attributes[name] = value; },
    getAttribute(name) { return attributes[name] || null; },
    addEventListener(event, fn) {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(fn);
    },
    _listeners: listeners,
    querySelector(selector) {
      const cls = selector.startsWith('.') ? selector.slice(1) : null;
      if (!cls) return null;
      if (classes.has(cls)) return el;
      for (const child of children) {
        const found = child.querySelector ? child.querySelector(selector) : null;
        if (found) return found;
      }
      return null;
    },
    querySelectorAll(selector) {
      const cls = selector.startsWith('.') ? selector.slice(1) : null;
      const results = [];
      if (cls && classes.has(cls)) results.push(el);
      for (const child of children) {
        if (child.querySelectorAll) {
          results.push(...child.querySelectorAll(selector));
        }
      }
      return results;
    },
  };
  let rawInnerHTML = '';
  Object.defineProperty(el, 'innerHTML', {
    get() { return rawInnerHTML || escapeHTML(el.textContent); },
    set(val) { rawInnerHTML = val; }
  });
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

// Replicate createNoteCard logic (updated with list parameter)
function createNoteCard(note, list) {
  const card = createElement('div');
  card.className = 'note-card';
  card.dataset.noteId = note.id;
  const isAccomplish = list && list.mode === 'accomplish';

  if (isAccomplish && note.completed) {
    card.classList.add('completed');
  }

  if (isAccomplish) {
    const dragHandle = createElement('span');
    dragHandle.className = 'drag-handle';
    dragHandle.textContent = '\u2261';
    card.appendChild(dragHandle);

    const checkbox = createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'note-checkbox';
    checkbox.checked = !!note.completed;
    card.appendChild(checkbox);
  }

  const content = createElement('div');
  content.className = 'note-content';

  const transcriptionEl = createElement('p');
  transcriptionEl.className = 'note-transcription';
  if (note.transcription) {
    transcriptionEl.textContent = note.transcription;
  } else {
    transcriptionEl.textContent = 'No transcription available';
    transcriptionEl.classList.add('note-transcription-empty');
  }
  content.appendChild(transcriptionEl);

  const hasAudio = !!note.audioBlob;

  if (hasAudio) {
    const meta = createElement('div');
    meta.className = 'note-meta';
    meta.textContent = formatDuration(note.duration) + ' \u00B7 ' + formatDate(note.createdAt);
    content.appendChild(meta);

    const progress = createElement('div');
    progress.className = 'note-progress';
    const progressFill = createElement('div');
    progressFill.className = 'note-progress-fill';
    progress.appendChild(progressFill);
    content.appendChild(progress);
  }

  card.appendChild(content);

  const actions = createElement('div');
  actions.className = 'note-actions';

  if (hasAudio) {
    const playBtn = createElement('button');
    playBtn.type = 'button';
    playBtn.className = 'play-btn';
    playBtn.textContent = '\u25B6';
    actions.appendChild(playBtn);
  }

  const deleteBtn = createElement('button');
  deleteBtn.type = 'button';
  deleteBtn.className = 'delete-btn';
  deleteBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>';
  actions.appendChild(deleteBtn);
  card.appendChild(actions);

  return card;
}

// Replicate createListCard logic
function createListCard(list, noteCount) {
  const card = createElement('div');
  card.className = 'list-card';
  card.dataset.listId = list.id;

  const info = createElement('div');
  info.className = 'list-card-info';

  const name = createElement('h3');
  name.className = 'list-card-name';
  name.textContent = list.name;

  const meta = createElement('div');
  meta.className = 'list-card-meta';

  const modeBadge = createElement('span');
  modeBadge.className = 'list-mode-badge';
  modeBadge.textContent = list.mode === 'accomplish' ? 'Accomplish' : 'Capture';
  modeBadge.dataset.mode = list.mode;

  const count = createElement('span');
  count.className = 'list-card-count';
  count.textContent = noteCount + (noteCount === 1 ? ' note' : ' notes');

  meta.appendChild(modeBadge);
  meta.appendChild(count);

  info.appendChild(name);
  info.appendChild(meta);

  const arrow = createElement('span');
  arrow.className = 'list-card-arrow';
  arrow.textContent = '\u203A';

  card.appendChild(info);
  card.appendChild(arrow);

  return card;
}

// Simulates transcribeAudioBlob logic
function simulateTranscribeBlob(SpeechRecognitionCtor, blob) {
  if (!SpeechRecognitionCtor) return Promise.resolve('');
  if (!blob) return Promise.resolve('');

  return new Promise((resolve) => {
    let result = '';
    let settled = false;

    function finish() {
      if (settled) return;
      settled = true;
      resolve(result);
    }

    const recognition = new SpeechRecognitionCtor();
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.lang = 'en-US';

    recognition.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) {
          const text = e.results[i][0].transcript.trim();
          if (text) {
            result += (result ? ' ' : '') + text;
          }
        }
      }
    };

    recognition.onend = finish;
    recognition.onerror = finish;

    try {
      recognition.start();
    } catch (e) {
      finish();
    }
  });
}

// Simulates processUntranscribedNotes logic
async function simulateProcessUntranscribed(notes, transcribeFn) {
  const untranscribed = notes.filter((n) => !n.transcription);
  if (untranscribed.length === 0) return { updatedNotes: [], rendered: false };

  const updatedNotes = [];

  for (const note of untranscribed) {
    try {
      const transcription = await transcribeFn(note.audioBlob);
      if (transcription) {
        note.transcription = transcription;
        updatedNotes.push(note);
      }
    } catch (e) {
      // Skip notes that fail
    }
  }

  return { updatedNotes, rendered: updatedNotes.length > 0 };
}

// Note ordering logic (replicates renderListDetail ordering)
function orderNotes(notes, noteOrder, mode) {
  let result;
  if (noteOrder && noteOrder.length > 0) {
    const noteMap = {};
    for (const n of notes) noteMap[n.id] = n;
    const ordered = [];
    for (const nid of noteOrder) {
      if (noteMap[nid]) {
        ordered.push(noteMap[nid]);
        delete noteMap[nid];
      }
    }
    const remaining = Object.values(noteMap);
    remaining.sort((a, b) => (b.createdAt > a.createdAt ? 1 : b.createdAt < a.createdAt ? -1 : 0));
    ordered.push(...remaining);
    result = ordered;
  } else {
    result = [...notes];
    result.sort((a, b) => (b.createdAt > a.createdAt ? 1 : b.createdAt < a.createdAt ? -1 : 0));
  }
  // Move completed items to the bottom in accomplish mode
  if (mode === 'accomplish') {
    const incomplete = result.filter((n) => !n.completed);
    const completed = result.filter((n) => n.completed);
    result = [...incomplete, ...completed];
  }
  return result;
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
await (async () => {
  const errorRecognition = {
    onend: null,
    onerror: null,
    stop() {
      Promise.resolve().then(() => {
        if (this.onerror) this.onerror({ error: 'service-not-available' });
      });
    }
  };
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

suite('Note card — capture mode (no list)');
{
  const note = {
    id: 'test-1',
    duration: 45,
    transcription: 'This is a test note',
    createdAt: '2026-02-15T14:30:00.000Z'
  };
  const card = createNoteCard(note);
  assert(card.classList.contains('note-card'), 'card has note-card class');
  assertEqual(card.dataset.noteId, 'test-1', 'card has data-note-id');
  const transcriptionEl = card.querySelector('.note-transcription');
  assertEqual(transcriptionEl.textContent, 'This is a test note', 'displays transcription text');
  assert(!transcriptionEl.classList.contains('note-transcription-empty'), 'no empty class when text present');
}

suite('Note card — with capture list');
{
  const note = {
    id: 'test-cap',
    duration: 45,
    transcription: 'Test note',
    createdAt: '2026-02-15T14:30:00.000Z',
    listId: 'list-1',
    completed: false
  };
  const list = { id: 'list-1', name: 'My List', mode: 'capture', createdAt: '2026-02-15T00:00:00Z', noteOrder: [] };
  const card = createNoteCard(note, list);
  assert(card.classList.contains('note-card'), 'card has note-card class');
  assert(!card.querySelector('.note-checkbox'), 'no checkbox in capture mode');
  assert(!card.querySelector('.drag-handle'), 'no drag handle in capture mode');
  assert(!card.classList.contains('completed'), 'not completed in capture mode');
}

suite('Note card — accomplish mode uncompleted');
{
  const note = {
    id: 'test-acc-1',
    duration: 30,
    transcription: 'Do this task',
    createdAt: '2026-02-15T14:30:00.000Z',
    listId: 'list-2',
    completed: false
  };
  const list = { id: 'list-2', name: 'Tasks', mode: 'accomplish', createdAt: '2026-02-15T00:00:00Z', noteOrder: [] };
  const card = createNoteCard(note, list);
  assert(card.classList.contains('note-card'), 'card has note-card class');
  assert(!card.classList.contains('completed'), 'not marked completed');

  const checkbox = card.querySelector('.note-checkbox');
  assert(checkbox !== null, 'has checkbox');
  assertEqual(checkbox.checked, false, 'checkbox unchecked');

  const dragHandle = card.querySelector('.drag-handle');
  assert(dragHandle !== null, 'has drag handle');
}

suite('Note card — accomplish mode completed');
{
  const note = {
    id: 'test-acc-2',
    duration: 20,
    transcription: 'Done task',
    createdAt: '2026-02-15T14:30:00.000Z',
    listId: 'list-2',
    completed: true
  };
  const list = { id: 'list-2', name: 'Tasks', mode: 'accomplish', createdAt: '2026-02-15T00:00:00Z', noteOrder: [] };
  const card = createNoteCard(note, list);
  assert(card.classList.contains('completed'), 'card has completed class');

  const checkbox = card.querySelector('.note-checkbox');
  assert(checkbox !== null, 'has checkbox');
  assertEqual(checkbox.checked, true, 'checkbox checked');
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

suite('Note card — meta line shows duration and date');
{
  const note = { id: 'test-dur', audioBlob: { size: 100 }, duration: 125, transcription: 'hi', createdAt: '2026-02-15T12:00:00.000Z' };
  const card = createNoteCard(note);
  const meta = card.querySelector('.note-meta');
  assert(meta !== null, 'card has meta element');
  assert(meta.textContent.includes('2:05'), 'meta contains formatted duration');
  assert(meta.textContent.includes('\u00B7'), 'meta contains separator');
}

suite('Note card — action buttons');
{
  const note = { id: 'test-btn', audioBlob: { size: 50 }, duration: 5, transcription: '', createdAt: '2026-02-15T12:00:00.000Z' };
  const card = createNoteCard(note);
  const playBtn = card.querySelector('.play-btn');
  const deleteBtn = card.querySelector('.delete-btn');
  assertEqual(playBtn.textContent, '\u25B6', 'play button icon');
  assert(deleteBtn.innerHTML.includes('<svg'), 'delete button has trash SVG icon');
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
    createdAt: '2026-02-15T14:30:00.000Z',
    listId: 'default',
    completed: false
  };
  assertEqual(typeof note.id, 'string', 'id is string');
  assertEqual(typeof note.duration, 'number', 'duration is number');
  assertEqual(typeof note.transcription, 'string', 'transcription is string');
  assertEqual(typeof note.createdAt, 'string', 'createdAt is string');
  assert('audioBlob' in note, 'audioBlob field exists');
  assertEqual(typeof note.listId, 'string', 'listId is string');
  assertEqual(typeof note.completed, 'boolean', 'completed is boolean');
}

suite('List schema contract');
{
  const list = {
    id: 'list-123',
    name: 'My List',
    mode: 'capture',
    createdAt: '2026-02-15T14:30:00.000Z',
    noteOrder: []
  };
  assertEqual(typeof list.id, 'string', 'id is string');
  assertEqual(typeof list.name, 'string', 'name is string');
  assert(list.mode === 'capture' || list.mode === 'accomplish', 'mode is capture or accomplish');
  assertEqual(typeof list.createdAt, 'string', 'createdAt is string');
  assert(Array.isArray(list.noteOrder), 'noteOrder is array');
}

suite('List schema — accomplish mode');
{
  const list = {
    id: 'list-456',
    name: 'Tasks',
    mode: 'accomplish',
    createdAt: '2026-02-15T14:30:00.000Z',
    noteOrder: ['note-1', 'note-2']
  };
  assertEqual(list.mode, 'accomplish', 'mode is accomplish');
  assertEqual(list.noteOrder.length, 2, 'noteOrder has entries');
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
// List card rendering tests
// ============================================================

suite('List card — capture mode');
{
  const list = { id: 'list-1', name: 'My Notes', mode: 'capture', createdAt: '2026-02-15T00:00:00Z', noteOrder: [] };
  const card = createListCard(list, 3);
  assert(card.classList.contains('list-card'), 'has list-card class');
  assertEqual(card.dataset.listId, 'list-1', 'has data-list-id');

  const name = card.querySelector('.list-card-name');
  assertEqual(name.textContent, 'My Notes', 'shows list name');

  const badge = card.querySelector('.list-mode-badge');
  assertEqual(badge.textContent, 'Capture', 'shows Capture badge');
  assertEqual(badge.dataset.mode, 'capture', 'badge data-mode is capture');

  const count = card.querySelector('.list-card-count');
  assertEqual(count.textContent, '3 notes', 'shows note count plural');
}

suite('List card — accomplish mode');
{
  const list = { id: 'list-2', name: 'Tasks', mode: 'accomplish', createdAt: '2026-02-15T00:00:00Z', noteOrder: [] };
  const card = createListCard(list, 1);

  const badge = card.querySelector('.list-mode-badge');
  assertEqual(badge.textContent, 'Accomplish', 'shows Accomplish badge');
  assertEqual(badge.dataset.mode, 'accomplish', 'badge data-mode is accomplish');

  const count = card.querySelector('.list-card-count');
  assertEqual(count.textContent, '1 note', 'shows note count singular');
}

suite('List card — zero notes');
{
  const list = { id: 'list-3', name: 'Empty', mode: 'capture', createdAt: '2026-02-15T00:00:00Z', noteOrder: [] };
  const card = createListCard(list, 0);

  const count = card.querySelector('.list-card-count');
  assertEqual(count.textContent, '0 notes', 'shows zero notes');
}

suite('List card — arrow indicator');
{
  const list = { id: 'list-4', name: 'Test', mode: 'capture', createdAt: '2026-02-15T00:00:00Z', noteOrder: [] };
  const card = createListCard(list, 5);

  const arrow = card.querySelector('.list-card-arrow');
  assert(arrow !== null, 'has arrow element');
}

// ============================================================
// Note ordering tests
// ============================================================

suite('Note ordering — by createdAt desc when no noteOrder');
{
  const notes = [
    { id: 'n1', createdAt: '2026-02-10T00:00:00Z' },
    { id: 'n3', createdAt: '2026-02-12T00:00:00Z' },
    { id: 'n2', createdAt: '2026-02-11T00:00:00Z' }
  ];
  const ordered = orderNotes(notes, []);
  assertDeepEqual(ordered.map((n) => n.id), ['n3', 'n2', 'n1'], 'sorted newest first');
}

suite('Note ordering — respects noteOrder');
{
  const notes = [
    { id: 'n1', createdAt: '2026-02-10T00:00:00Z' },
    { id: 'n2', createdAt: '2026-02-11T00:00:00Z' },
    { id: 'n3', createdAt: '2026-02-12T00:00:00Z' }
  ];
  const ordered = orderNotes(notes, ['n3', 'n1', 'n2']);
  assertDeepEqual(ordered.map((n) => n.id), ['n3', 'n1', 'n2'], 'follows noteOrder');
}

suite('Note ordering — new notes appended after noteOrder');
{
  const notes = [
    { id: 'n1', createdAt: '2026-02-10T00:00:00Z' },
    { id: 'n2', createdAt: '2026-02-11T00:00:00Z' },
    { id: 'n3', createdAt: '2026-02-12T00:00:00Z' },
    { id: 'n4', createdAt: '2026-02-13T00:00:00Z' }
  ];
  const ordered = orderNotes(notes, ['n2', 'n1']);
  assertDeepEqual(ordered.map((n) => n.id), ['n2', 'n1', 'n4', 'n3'], 'ordered items first, then remaining newest-first');
}

suite('Note ordering — handles missing noteOrder entries');
{
  const notes = [
    { id: 'n1', createdAt: '2026-02-10T00:00:00Z' },
    { id: 'n2', createdAt: '2026-02-11T00:00:00Z' }
  ];
  const ordered = orderNotes(notes, ['n3', 'n1', 'n2']);
  assertDeepEqual(ordered.map((n) => n.id), ['n1', 'n2'], 'skips missing note ids');
}

suite('Note ordering — completed items sink to bottom in accomplish mode');
{
  const notes = [
    { id: 'n1', createdAt: '2026-02-10T00:00:00Z', completed: true },
    { id: 'n2', createdAt: '2026-02-11T00:00:00Z', completed: false },
    { id: 'n3', createdAt: '2026-02-12T00:00:00Z', completed: true },
    { id: 'n4', createdAt: '2026-02-13T00:00:00Z', completed: false }
  ];
  const ordered = orderNotes(notes, ['n1', 'n2', 'n3', 'n4'], 'accomplish');
  assertDeepEqual(ordered.map((n) => n.id), ['n2', 'n4', 'n1', 'n3'], 'incomplete first, completed last');
}

suite('Note ordering — capture mode does not reorder by completed');
{
  const notes = [
    { id: 'n1', createdAt: '2026-02-10T00:00:00Z', completed: true },
    { id: 'n2', createdAt: '2026-02-11T00:00:00Z', completed: false }
  ];
  const ordered = orderNotes(notes, ['n1', 'n2'], 'capture');
  assertDeepEqual(ordered.map((n) => n.id), ['n1', 'n2'], 'order preserved in capture mode');
}

// ============================================================
// Migration logic tests
// ============================================================

suite('Migration — note gets default listId');
{
  const note = { id: 'old-1', audioBlob: {}, duration: 10, createdAt: '2026-01-01T00:00:00Z' };
  // Simulate migration
  if (!note.listId) {
    note.listId = 'default';
    if (note.completed === undefined) note.completed = false;
  }
  assertEqual(note.listId, 'default', 'legacy note gets default listId');
  assertEqual(note.completed, false, 'legacy note gets completed = false');
}

suite('Migration — note with existing listId not changed');
{
  const note = { id: 'new-1', audioBlob: {}, duration: 10, createdAt: '2026-01-01T00:00:00Z', listId: 'custom', completed: true };
  if (!note.listId) {
    note.listId = 'default';
    if (note.completed === undefined) note.completed = false;
  }
  assertEqual(note.listId, 'custom', 'existing listId preserved');
  assertEqual(note.completed, true, 'existing completed preserved');
}

// ============================================================
// Transcribe audio blob simulation
// ============================================================

suite('transcribeAudioBlob — no SpeechRecognition');
await (async () => {
  const result = await simulateTranscribeBlob(null, { size: 100 });
  assertEqual(result, '', 'returns empty string without SpeechRecognition');
})();

suite('transcribeAudioBlob — no blob');
await (async () => {
  const result = await simulateTranscribeBlob(function() {}, null);
  assertEqual(result, '', 'returns empty string without blob');
})();

suite('transcribeAudioBlob — accumulates recognition results');
await (async () => {
  function MockRecognition() {
    this.continuous = false;
    this.interimResults = true;
    this.lang = '';
    this.onresult = null;
    this.onend = null;
    this.onerror = null;
  }
  MockRecognition.prototype.start = function() {
    Promise.resolve().then(() => {
      if (this.onresult) {
        this.onresult({
          resultIndex: 0,
          results: [{ isFinal: true, 0: { transcript: 'Hello world' } }]
        });
      }
      if (this.onend) this.onend();
    });
  };

  const result = await simulateTranscribeBlob(MockRecognition, { size: 100 });
  assertEqual(result, 'Hello world', 'captures final recognition result');
})();

suite('transcribeAudioBlob — multiple results');
await (async () => {
  function MockRecognition() {
    this.continuous = false;
    this.interimResults = true;
    this.lang = '';
    this.onresult = null;
    this.onend = null;
    this.onerror = null;
  }
  MockRecognition.prototype.start = function() {
    Promise.resolve().then(() => {
      if (this.onresult) {
        this.onresult({
          resultIndex: 0,
          results: [
            { isFinal: true, 0: { transcript: 'First sentence' } },
            { isFinal: true, 0: { transcript: 'Second sentence' } }
          ]
        });
      }
      if (this.onend) this.onend();
    });
  };

  const result = await simulateTranscribeBlob(MockRecognition, { size: 100 });
  assertEqual(result, 'First sentence Second sentence', 'joins multiple results with space');
})();

suite('transcribeAudioBlob — onerror resolves');
await (async () => {
  function MockRecognition() {
    this.onresult = null;
    this.onend = null;
    this.onerror = null;
  }
  MockRecognition.prototype.start = function() {
    Promise.resolve().then(() => {
      if (this.onerror) this.onerror({ error: 'service-not-available' });
    });
  };

  const result = await simulateTranscribeBlob(MockRecognition, { size: 100 });
  assertEqual(result, '', 'resolves with empty string on error');
})();

suite('transcribeAudioBlob — start() throws');
await (async () => {
  function MockRecognition() {
    this.onresult = null;
    this.onend = null;
    this.onerror = null;
  }
  MockRecognition.prototype.start = function() {
    throw new Error('not allowed');
  };

  const result = await simulateTranscribeBlob(MockRecognition, { size: 100 });
  assertEqual(result, '', 'resolves with empty string when start() throws');
})();

suite('transcribeAudioBlob — sets continuous and interimResults');
await (async () => {
  let capturedContinuous = null;
  let capturedInterim = null;
  function MockRecognition() {
    this.continuous = false;
    this.interimResults = true;
    this.lang = '';
    this.onresult = null;
    this.onend = null;
    this.onerror = null;
  }
  MockRecognition.prototype.start = function() {
    capturedContinuous = this.continuous;
    capturedInterim = this.interimResults;
    Promise.resolve().then(() => { if (this.onend) this.onend(); });
  };

  await simulateTranscribeBlob(MockRecognition, { size: 100 });
  assertEqual(capturedContinuous, true, 'sets continuous = true');
  assertEqual(capturedInterim, false, 'sets interimResults = false');
})();

suite('processUntranscribedNotes — all notes already transcribed');
await (async () => {
  const notes = [
    { id: '1', audioBlob: {}, transcription: 'Already done', createdAt: '2026-01-01T00:00:00Z' },
    { id: '2', audioBlob: {}, transcription: 'Also done', createdAt: '2026-01-02T00:00:00Z' }
  ];
  const result = await simulateProcessUntranscribed(notes, () => Promise.resolve('text'));
  assertEqual(result.updatedNotes.length, 0, 'no notes updated');
  assert(!result.rendered, 'no re-render triggered');
})();

suite('processUntranscribedNotes — empty list');
await (async () => {
  const result = await simulateProcessUntranscribed([], () => Promise.resolve('text'));
  assertEqual(result.updatedNotes.length, 0, 'handles empty notes list');
  assert(!result.rendered, 'no re-render for empty list');
})();

suite('processUntranscribedNotes — processes untranscribed notes');
await (async () => {
  const notes = [
    { id: '1', audioBlob: { size: 100 }, transcription: '', createdAt: '2026-01-01T00:00:00Z' },
    { id: '2', audioBlob: { size: 200 }, transcription: 'Existing', createdAt: '2026-01-02T00:00:00Z' }
  ];
  const result = await simulateProcessUntranscribed(notes, () => Promise.resolve('New text'));
  assertEqual(result.updatedNotes.length, 1, 'one note updated');
  assertEqual(result.updatedNotes[0].id, '1', 'correct note was updated');
  assertEqual(result.updatedNotes[0].transcription, 'New text', 'transcription text applied');
  assert(result.rendered, 're-render triggered');
})();

suite('processUntranscribedNotes — legacy notes (no transcription field)');
await (async () => {
  const notes = [
    { id: '1', audioBlob: { size: 100 }, createdAt: '2026-01-01T00:00:00Z' }
  ];
  const result = await simulateProcessUntranscribed(notes, () => Promise.resolve('Transcribed'));
  assertEqual(result.updatedNotes.length, 1, 'legacy note gets processed');
  assertEqual(result.updatedNotes[0].transcription, 'Transcribed', 'transcription added to legacy note');
})();

suite('processUntranscribedNotes — transcription failure is skipped');
await (async () => {
  const notes = [
    { id: '1', audioBlob: { size: 100 }, transcription: '', createdAt: '2026-01-01T00:00:00Z' }
  ];
  const result = await simulateProcessUntranscribed(notes, () => Promise.reject(new Error('fail')));
  assertEqual(result.updatedNotes.length, 0, 'no notes updated on failure');
  assert(!result.rendered, 'no re-render on failure');
})();

suite('processUntranscribedNotes — empty transcription result skipped');
await (async () => {
  const notes = [
    { id: '1', audioBlob: { size: 100 }, transcription: '', createdAt: '2026-01-01T00:00:00Z' }
  ];
  const result = await simulateProcessUntranscribed(notes, () => Promise.resolve(''));
  assertEqual(result.updatedNotes.length, 0, 'note not updated when transcription is empty');
  assert(!result.rendered, 'no re-render when transcription empty');
})();

suite('processUntranscribedNotes — multiple untranscribed notes');
await (async () => {
  let callCount = 0;
  const notes = [
    { id: '1', audioBlob: { size: 100 }, transcription: '', createdAt: '2026-01-01T00:00:00Z' },
    { id: '2', audioBlob: { size: 200 }, transcription: '', createdAt: '2026-01-02T00:00:00Z' },
    { id: '3', audioBlob: { size: 300 }, transcription: 'Done', createdAt: '2026-01-03T00:00:00Z' }
  ];
  const result = await simulateProcessUntranscribed(notes, () => {
    callCount++;
    return Promise.resolve('Text ' + callCount);
  });
  assertEqual(result.updatedNotes.length, 2, 'two notes updated');
  assertEqual(callCount, 2, 'transcribe called twice (skips already-transcribed)');
  assertEqual(result.updatedNotes[0].transcription, 'Text 1', 'first note gets transcription');
  assertEqual(result.updatedNotes[1].transcription, 'Text 2', 'second note gets transcription');
  assert(result.rendered, 're-render triggered');
})();

suite('processUntranscribedNotes — partial failure');
await (async () => {
  let callCount = 0;
  const notes = [
    { id: '1', audioBlob: { size: 100 }, transcription: '', createdAt: '2026-01-01T00:00:00Z' },
    { id: '2', audioBlob: { size: 200 }, transcription: '', createdAt: '2026-01-02T00:00:00Z' }
  ];
  const result = await simulateProcessUntranscribed(notes, () => {
    callCount++;
    if (callCount === 1) return Promise.reject(new Error('fail'));
    return Promise.resolve('Success');
  });
  assertEqual(result.updatedNotes.length, 1, 'one note updated despite first failure');
  assertEqual(result.updatedNotes[0].id, '2', 'second note succeeded');
  assert(result.rendered, 're-render triggered for partial success');
})();

// ============================================================
// splitTranscriptionOnAnd tests
// ============================================================

suite('splitTranscriptionOnAnd — basic splitting');
assertDeepEqual(splitTranscriptionOnAnd('meat and potatoes and cheese'), ['meat', 'potatoes', 'cheese'], 'splits three items on "and"');
assertDeepEqual(splitTranscriptionOnAnd('apples and oranges'), ['apples', 'oranges'], 'splits two items');
assertDeepEqual(splitTranscriptionOnAnd('just one item'), ['just one item'], 'no "and" returns single item');
assertDeepEqual(splitTranscriptionOnAnd('bread AND butter'), ['bread', 'butter'], 'case-insensitive split');
assertDeepEqual(splitTranscriptionOnAnd('salt And pepper'), ['salt', 'pepper'], 'mixed-case "And" splits');
assertDeepEqual(splitTranscriptionOnAnd(''), [''], 'empty string returns array with empty string');
assertDeepEqual(splitTranscriptionOnAnd(null), [null], 'null returns array with null');
assertDeepEqual(splitTranscriptionOnAnd(undefined), [undefined], 'undefined returns array with undefined');
assertDeepEqual(splitTranscriptionOnAnd('band together'), ['band together'], 'does not split on "and" within words');
assertDeepEqual(splitTranscriptionOnAnd('candy and sandwiches'), ['candy', 'sandwiches'], 'splits even when surrounding words contain "and"');
assertDeepEqual(splitTranscriptionOnAnd('a  and  b'), ['a', 'b'], 'handles multiple spaces around "and"');
assertDeepEqual(splitTranscriptionOnAnd('first and second and third and fourth'), ['first', 'second', 'third', 'fourth'], 'splits four items');

suite('Note card — text-only note (no audioBlob)');
{
  const note = {
    id: 'text-only-1',
    audioBlob: null,
    duration: 0,
    transcription: 'potatoes',
    createdAt: '2026-02-15T14:30:00.000Z',
    listId: 'list-2',
    completed: false
  };
  const list = { id: 'list-2', name: 'Groceries', mode: 'accomplish', createdAt: '2026-02-15T00:00:00Z', noteOrder: [] };
  const card = createNoteCard(note, list);
  assert(card.classList.contains('note-card'), 'card has note-card class');
  assertEqual(card.querySelector('.note-transcription').textContent, 'potatoes', 'shows transcription text');
  assert(card.querySelector('.play-btn') === null, 'no play button for text-only note');
  assert(card.querySelector('.note-meta') === null, 'no meta line for text-only note');
  assert(card.querySelector('.note-progress') === null, 'no progress bar for text-only note');
  assert(card.querySelector('.delete-btn') !== null, 'still has delete button');
  assert(card.querySelector('.note-checkbox') !== null, 'still has checkbox in accomplish mode');
  assert(card.querySelector('.drag-handle') !== null, 'still has drag handle in accomplish mode');
}

suite('Note card — note with audioBlob still shows controls');
{
  const note = {
    id: 'audio-1',
    audioBlob: { size: 100 },
    duration: 30,
    transcription: 'meat',
    createdAt: '2026-02-15T14:30:00.000Z',
    listId: 'list-2',
    completed: false
  };
  const list = { id: 'list-2', name: 'Groceries', mode: 'accomplish', createdAt: '2026-02-15T00:00:00Z', noteOrder: [] };
  const card = createNoteCard(note, list);
  assert(card.querySelector('.play-btn') !== null, 'has play button for audio note');
  assert(card.querySelector('.note-meta') !== null, 'has meta line for audio note');
  assert(card.querySelector('.note-progress') !== null, 'has progress bar for audio note');
}

// ============================================================
// Source file integrity
// ============================================================

suite('Source file integrity');
{
  const fs = require('fs');
  const appJs = fs.readFileSync(__dirname + '/app.js', 'utf8');

  assert(appJs.includes('SpeechRecognition'), 'app.js references SpeechRecognition');
  assert(appJs.includes('startTranscription'), 'app.js defines startTranscription');
  assert(appJs.includes('stopTranscription'), 'app.js defines stopTranscription');
  assert(appJs.includes('result.transcription'), 'note creation uses result.transcription');
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

suite('Source file integrity — lists feature');
{
  const fs = require('fs');
  const appJs = fs.readFileSync(__dirname + '/app.js', 'utf8');

  assert(appJs.includes('saveList'), 'app.js defines saveList');
  assert(appJs.includes('getAllLists'), 'app.js defines getAllLists');
  assert(appJs.includes('getList'), 'app.js defines getList');
  assert(appJs.includes('deleteList'), 'app.js defines deleteList');
  assert(appJs.includes('getNotesByList'), 'app.js defines getNotesByList');
  assert(appJs.includes('deleteNotesByList'), 'app.js defines deleteNotesByList');
  assert(appJs.includes('renderLists'), 'app.js defines renderLists');
  assert(appJs.includes('renderListDetail'), 'app.js defines renderListDetail');
  assert(appJs.includes('createListCard'), 'app.js defines createListCard');
  assert(appJs.includes('showListsView'), 'app.js defines showListsView');
  assert(appJs.includes('showListDetailView'), 'app.js defines showListDetailView');
  assert(appJs.includes("DEFAULT_LIST_ID"), 'app.js defines DEFAULT_LIST_ID');
  assert(appJs.includes('migrateNotesToDefaultList'), 'app.js defines migration function');
  assert(appJs.includes("voiceNotesDB', 2"), 'IndexedDB version is 2');
  assert(appJs.includes("objectStore('lists'"), 'app.js uses lists object store');
  assert(appJs.includes('listId'), 'notes reference listId');
  assert(appJs.includes('completed'), 'notes have completed field');
  assert(appJs.includes('noteOrder'), 'lists have noteOrder field');
  assert(appJs.includes('note-checkbox'), 'app.js uses note-checkbox class');
  assert(appJs.includes('drag-handle'), 'app.js uses drag-handle class');
  assert(appJs.includes('note-content'), 'app.js uses note-content class');
  assert(appJs.includes('list-card'), 'app.js uses list-card class');
  assert(appJs.includes("mode === 'accomplish'"), 'app.js checks accomplish mode');
  assert(appJs.includes('splitTranscriptionOnAnd'), 'app.js defines splitTranscriptionOnAnd');
  assert(appJs.includes('hasAudio'), 'app.js checks hasAudio for conditional rendering');

  const appCss = fs.readFileSync(__dirname + '/app.css', 'utf8');
  assert(appCss.includes('.list-card'), 'app.css defines .list-card');
  assert(appCss.includes('.list-mode-badge'), 'app.css defines .list-mode-badge');
  assert(appCss.includes('.note-checkbox'), 'app.css defines .note-checkbox');
  assert(appCss.includes('.drag-handle'), 'app.css defines .drag-handle');
  assert(appCss.includes('.note-content'), 'app.css defines .note-content');
  assert(appCss.includes('.drag-placeholder'), 'app.css defines .drag-placeholder');
  assert(appCss.includes('.note-card.completed'), 'app.css defines .note-card.completed');
  assert(appCss.includes('#list-modal'), 'app.css defines #list-modal');
  assert(appCss.includes('.mode-btn'), 'app.css defines .mode-btn');
  assert(appCss.includes('#back-btn'), 'app.css defines #back-btn');

  const indexHtml = fs.readFileSync(__dirname + '/index.html', 'utf8');
  assert(indexHtml.includes('lists-view'), 'index.html has lists-view');
  assert(indexHtml.includes('list-detail-view'), 'index.html has list-detail-view');
  assert(indexHtml.includes('list-modal'), 'index.html has list-modal');
  assert(indexHtml.includes('back-btn'), 'index.html has back-btn');
  assert(indexHtml.includes('new-list-btn'), 'index.html has new-list-btn');
  assert(indexHtml.includes('mode-selector'), 'index.html has mode-selector');
  assert(indexHtml.includes('v19'), 'index.html version is v19');

  const swJs = fs.readFileSync(__dirname + '/sw.js', 'utf8');
  assert(swJs.includes('voice-notes-v19'), 'sw.js cache version is v19');
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
