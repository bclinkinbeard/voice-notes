import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runFirstPartyEnrichers } from './analysis.js';
import { buildProjection, factSignature, normalizeText, slugify, tokenizeText } from './projections.js';
import { executeQuery, planQuery } from './query.js';
import { createVaultInvite, parseVaultInvite } from './sync.js';
import { EVENT_KINDS, previewLegacyMigration } from './storage.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let total = 0;
let passed = 0;

function assert(condition, message) {
  total += 1;
  if (!condition) {
    throw new Error(message);
  }
  passed += 1;
}

function assertEqual(actual, expected, message) {
  assert(actual === expected, message + ` (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

function assertDeepEqual(actual, expected, message) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  assert(a === b, message + ` (expected ${b}, got ${a})`);
}

function suite(name, fn) {
  console.log('\n' + name);
  return Promise.resolve(fn());
}

function makeEvent(eventId, kind, body, options = {}) {
  return {
    eventId,
    vaultId: options.vaultId || 'vault:1',
    occurredAt: options.occurredAt || '2026-03-20T10:00:00.000Z',
    recordedAt: options.recordedAt || options.occurredAt || '2026-03-20T10:00:00.000Z',
    deviceId: options.deviceId || 'device:1',
    kind,
    schemaVersion: 1,
    sourceRefs: options.sourceRefs || [],
    body,
    provenance: options.provenance || { source: 'user' },
    confidence: options.confidence === undefined ? 1 : options.confidence
  };
}

function materialize(events, artifacts = [], vault = { id: 'vault:1', name: 'Personal Vault' }) {
  let currentEvents = events.slice();
  for (let pass = 0; pass < 4; pass += 1) {
    const projection = buildProjection({ vault, events: currentEvents, artifacts });
    const derived = runFirstPartyEnrichers({ vault, projection });
    const existingIds = new Set(currentEvents.map((event) => event.eventId));
    const fresh = derived.filter((event) => !existingIds.has(event.eventId));
    if (fresh.length === 0) {
      return buildProjection({ vault, events: currentEvents, artifacts });
    }
    currentEvents = currentEvents.concat(fresh);
  }
  return buildProjection({ vault, events: currentEvents, artifacts });
}

await suite('Projection utils', () => {
  assertEqual(normalizeText('  Bathroom Remodel!  '), 'bathroom remodel', 'normalizes text');
  assertEqual(slugify('Bathroom Remodel / Phase 2'), 'bathroom-remodel-phase-2', 'slugifies punctuation');
  assertDeepEqual(tokenizeText('Protein-rich meals, next week!'), ['protein', 'rich', 'meals', 'next', 'week'], 'tokenizes text');
  assertEqual(
    factSignature({ subjectId: 'capture:1', predicate: 'status', value: 'done' }),
    'capture:1|status|val:done',
    'builds value signatures'
  );
});

await suite('Projection building', () => {
  const events = [
    makeEvent('evt:1', EVENT_KINDS.CAPTURE_CREATED, { captureId: 'capture:1', captureType: 'text' }),
    makeEvent('evt:2', EVENT_KINDS.TEXT_EXTRACTED, { captureId: 'capture:1', mode: 'manual', text: 'Bathroom remodel update. Waiting on the plumber estimate.' }),
    makeEvent('evt:3', EVENT_KINDS.FACT_ASSERTED, { subjectId: 'capture:1', predicate: 'status', value: 'open', valueType: 'text' }),
    makeEvent('evt:4', EVENT_KINDS.FACT_ASSERTED, { subjectId: 'entity:project:bathroom-remodel', predicate: 'kind', value: 'project', valueType: 'text' }),
    makeEvent('evt:5', EVENT_KINDS.FACT_ASSERTED, { subjectId: 'entity:project:bathroom-remodel', predicate: 'title', value: 'Bathroom Remodel', valueType: 'text' }),
    makeEvent('evt:6', EVENT_KINDS.FACT_ASSERTED, { subjectId: 'capture:1', predicate: 'about', objectId: 'entity:project:bathroom-remodel', valueType: 'entity' })
  ];
  const projection = buildProjection({ vault: { id: 'vault:1', name: 'Personal Vault' }, events, artifacts: [] });

  assertEqual(projection.entries.length, 1, 'creates one entry');
  assertEqual(projection.entries[0].title, 'Bathroom remodel update. Waiting on the plumber estimate.', 'entry title derived from text');
  assertEqual(projection.entries[0].status, 'open', 'entry status applied from facts');
  assertEqual(projection.entitiesById['entity:project:bathroom-remodel'].title, 'Bathroom Remodel', 'entity title present');
  assertDeepEqual(projection.entries[0].aboutIds, ['entity:project:bathroom-remodel'], 'about relation stored');
});

await suite('Projection retractions and preference', () => {
  const events = [
    makeEvent('evt:1', EVENT_KINDS.CAPTURE_CREATED, { captureId: 'capture:1', captureType: 'text' }),
    makeEvent('evt:2', EVENT_KINDS.TEXT_EXTRACTED, { captureId: 'capture:1', mode: 'transcript', text: 'rough transcript' }, { provenance: { source: 'model' } }),
    makeEvent('evt:3', EVENT_KINDS.TEXT_EXTRACTED, { captureId: 'capture:1', mode: 'manual', text: 'Edited transcript' }, { provenance: { source: 'user' }, recordedAt: '2026-03-20T10:05:00.000Z' }),
    makeEvent('evt:4', EVENT_KINDS.FACT_ASSERTED, { subjectId: 'capture:1', predicate: 'status', value: 'open' }),
    makeEvent('evt:5', EVENT_KINDS.FACT_RETRACTED, { subjectId: 'capture:1', predicate: 'status', value: 'open' })
  ];
  const projection = buildProjection({ vault: { id: 'vault:1', name: 'Personal Vault' }, events, artifacts: [] });
  assertEqual(projection.entries[0].text, 'Edited transcript', 'user text wins over model text');
  assertEqual(projection.entries[0].status, '', 'retracted fact removed from current state');
});

await suite('Enrichment pipeline', () => {
  const events = [
    makeEvent('evt:1', EVENT_KINDS.CAPTURE_CREATED, { captureId: 'capture:1', captureType: 'text' }),
    makeEvent('evt:2', EVENT_KINDS.TEXT_EXTRACTED, {
      captureId: 'capture:1',
      mode: 'manual',
      text: 'Bathroom remodel project update. Waiting on the plumber estimate. Next step is confirm tile samples.'
    })
  ];
  const projection = materialize(events);

  assert(projection.entities.some((entity) => entity.kind === 'project' && entity.title === 'Bathroom Remodel Project'), 'detects project entity');
  assert(projection.entries[0].waitingOn.includes('the plumber estimate'), 'extracts waiting-on value');
  assertEqual(projection.entries[0].nextStep, 'confirm tile samples', 'extracts next-step fact');
});

await suite('Topic classification and query results', () => {
  const events = [
    makeEvent('evt:1', EVENT_KINDS.CAPTURE_CREATED, { captureId: 'capture:1', captureType: 'text' }),
    makeEvent('evt:2', EVENT_KINDS.TEXT_EXTRACTED, { captureId: 'capture:1', mode: 'manual', text: 'Nutrition check-in: protein target feels low and meal prep slipped this week.' }),
    makeEvent('evt:3', EVENT_KINDS.CAPTURE_CREATED, { captureId: 'capture:2', captureType: 'text' }, { occurredAt: '2026-03-20T11:00:00.000Z', recordedAt: '2026-03-20T11:00:00.000Z' }),
    makeEvent('evt:4', EVENT_KINDS.TEXT_EXTRACTED, { captureId: 'capture:2', mode: 'manual', text: 'Bathroom remodel project update. Waiting on permit approval.' }, { occurredAt: '2026-03-20T11:00:00.000Z', recordedAt: '2026-03-20T11:00:00.000Z' })
  ];
  const projection = materialize(events);

  const aboutNutrition = executeQuery('Show me entries about nutrition.', projection);
  assertEqual(aboutNutrition.entries.length, 1, 'nutrition query returns one entry');
  assert(aboutNutrition.entries[0].text.includes('protein target'), 'nutrition query returns matching entry');

  const currentProjects = executeQuery('What are my current projects?', projection);
  assert(currentProjects.entities.some((entity) => entity.kind === 'project'), 'current projects query returns project entities');

  const waitingOn = executeQuery('What are we waiting on with the bathroom remodel project?', projection);
  assert(waitingOn.answer.includes('permit approval'), 'waiting-on query summarizes blocker');
});

await suite('Query planning', () => {
  assertEqual(planQuery('What are my current projects?').kind, 'current-projects', 'plans current-project queries');
  assertEqual(planQuery('Show me entries about nutrition.').kind, 'entries-about', 'plans entries-about queries');
  assertEqual(planQuery('What are we waiting on with the bathroom remodel?').kind, 'waiting-on', 'plans waiting-on queries');
});

await suite('Legacy migration preview', () => {
  const lists = [
    { id: 'default', name: 'Tasks', mode: 'accomplish', createdAt: '2026-03-01T09:00:00.000Z' }
  ];
  const notes = [
    {
      id: 'note-1',
      audioBlob: { type: 'audio/webm', size: 2048 },
      duration: 18,
      transcription: 'Pick up paint swatches',
      createdAt: '2026-03-01T09:30:00.000Z',
      listId: 'default',
      completed: false,
      categories: ['work']
    }
  ];
  const preview = previewLegacyMigration('vault:1', lists, notes);
  const kinds = preview.migratedEvents.map((event) => event.kind);

  assertEqual(preview.artifactRecords.length, 1, 'migrates audio artifacts');
  assert(kinds.includes(EVENT_KINDS.CAPTURE_CREATED), 'creates capture events');
  assert(kinds.includes(EVENT_KINDS.TEXT_EXTRACTED), 'creates text extraction events');
  assert(kinds.includes(EVENT_KINDS.FACT_ASSERTED), 'creates fact assertion events');
});

await suite('Sync invite round-trip', () => {
  const invite = createVaultInvite({
    id: 'vault:shared',
    name: 'Shared Remodel Vault',
    relayUrl: 'https://relay.example.com',
    readKey: 'read-secret',
    writeKey: 'write-secret'
  });
  const parsed = parseVaultInvite(invite);
  assertEqual(parsed.vaultId, 'vault:shared', 'vault id round-trips');
  assertEqual(parsed.name, 'Shared Remodel Vault', 'vault name round-trips');
  assertEqual(parsed.relayUrl, 'https://relay.example.com', 'relay url round-trips');
});

await suite('Source integrity', () => {
  const indexHtml = readFileSync(join(__dirname, 'index.html'), 'utf8');
  const appCss = readFileSync(join(__dirname, 'app.css'), 'utf8');
  const appJs = readFileSync(join(__dirname, 'app.js'), 'utf8');
  const swJs = readFileSync(join(__dirname, 'public', 'sw.js'), 'utf8');
  const manifest = readFileSync(join(__dirname, 'public', 'manifest.json'), 'utf8');

  assert(indexHtml.includes('LifeOS Capture'), 'index uses new product name');
  assert(indexHtml.includes('tab-ask'), 'index includes ask tab');
  assert(indexHtml.includes('vault-sheet'), 'index includes vault sheet');
  assert(appCss.includes('#capture-actions'), 'app.css styles capture actions');
  assert(appCss.includes('.entry-card'), 'app.css styles entry cards');
  assert(appJs.includes('runFirstPartyEnrichers'), 'app.js runs enrichers');
  assert(appJs.includes('createHttpSyncTransport'), 'app.js uses sync transport');
  assert(swJs.includes('lifeos-capture-v24'), 'service worker cache version bumped');
  assert(swJs.includes('./storage.js'), 'service worker caches module graph');
  assert(manifest.includes('LifeOS Capture'), 'manifest renamed');
});

console.log('\n========================================');
console.log(`${passed}/${total} tests passed`);
console.log('========================================');
