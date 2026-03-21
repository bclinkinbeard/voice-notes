'use strict';

import { buildProjection } from './projections.js';
import { executeQuery } from './query.js';
import {
  EVENT_KINDS,
  appendEvents,
  createEventEnvelope,
  createVaultDescriptor,
  ensureVaultState,
  generateSortableId,
  getArtifact,
  getArtifactsByVault,
  getEventsByVault,
  getSyncState,
  getVault,
  listVaults,
  migrateLegacyData,
  saveArtifacts,
  saveProjection,
  saveSyncState,
  saveVault,
  setActiveVaultId
} from './storage.js';
import { createHttpSyncTransport, createVaultInvite, parseVaultInvite } from './sync.js';

const state = {
  deviceId: '',
  vaults: [],
  activeVaultId: '',
  activeVault: null,
  projection: null,
  tab: 'inbox',
  captureMode: '',
  queryResult: null,
  entityId: '',
  editingEntryId: '',
  playback: null
};

const appTitle = document.getElementById('app-title');
const appVersion = document.getElementById('app-version');
const vaultPill = document.getElementById('vault-pill');
const syncBtn = document.getElementById('sync-btn');
const settingsBtn = document.getElementById('settings-btn');
const tabInbox = document.getElementById('tab-inbox');
const tabAsk = document.getElementById('tab-ask');
const inboxView = document.getElementById('inbox-view');
const askView = document.getElementById('ask-view');
const captureActions = document.getElementById('capture-actions');
const capturePanel = document.getElementById('capture-panel');
const voicePanel = document.getElementById('voice-panel');
const textForm = document.getElementById('text-capture-form');
const textInput = document.getElementById('text-capture-input');
const linkForm = document.getElementById('link-capture-form');
const linkInput = document.getElementById('link-capture-url');
const linkNoteInput = document.getElementById('link-capture-note');
const fileInput = document.getElementById('file-input');
const photoInput = document.getElementById('photo-input');
const timelineList = document.getElementById('timeline-list');
const timelineEmpty = document.getElementById('timeline-empty');
const activeProjectsEl = document.getElementById('active-projects');
const activeTopicsEl = document.getElementById('active-topics');
const askForm = document.getElementById('ask-form');
const askInput = document.getElementById('ask-input');
const askAnswer = document.getElementById('ask-answer');
const askResults = document.getElementById('ask-results');
const followUps = document.getElementById('follow-ups');
const entityDrawer = document.getElementById('entity-drawer');
const entityBackdrop = document.getElementById('entity-backdrop');
const entityCloseBtn = document.getElementById('entity-close-btn');
const entityTitle = document.getElementById('entity-title');
const entityMeta = document.getElementById('entity-meta');
const entityFacts = document.getElementById('entity-facts');
const entityEntries = document.getElementById('entity-entries');
const vaultSheet = document.getElementById('vault-sheet');
const vaultBackdrop = document.getElementById('vault-backdrop');
const vaultCloseBtn = document.getElementById('vault-close-btn');
const vaultSelector = document.getElementById('vault-selector');
const vaultNameInput = document.getElementById('vault-name-input');
const relayUrlInput = document.getElementById('relay-url-input');
const saveVaultBtn = document.getElementById('save-vault-btn');
const createVaultBtn = document.getElementById('create-vault-btn');
const generateInviteBtn = document.getElementById('generate-invite-btn');
const inviteOutput = document.getElementById('invite-output');
const inviteInput = document.getElementById('invite-input');
const applyInviteBtn = document.getElementById('apply-invite-btn');
const syncStatus = document.getElementById('sync-status');
const editorModal = document.getElementById('editor-modal');
const editorBackdrop = document.getElementById('editor-backdrop');
const editorCloseBtn = document.getElementById('editor-close-btn');
const editorInput = document.getElementById('editor-input');
const editorSaveBtn = document.getElementById('editor-save-btn');
const timerEl = document.getElementById('timer');
const recorderEl = document.getElementById('recorder');
const recordBtn = document.getElementById('record-btn');
const recordHint = document.getElementById('record-hint');
const waveformCanvas = document.getElementById('waveform');
const waveformCtx = waveformCanvas ? waveformCanvas.getContext('2d') : null;

const PLAYBACK_URLS = new Map();

let mediaRecorder = null;
let speechRecognition = null;
let transcriptionResult = '';
let recordingStartTime = null;
let timerInterval = null;
let waveformFrameId = null;
let audioContext = null;
let analyser = null;
let audioChunks = [];
let isRecording = false;
let recordBusy = false;

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

function formatDate(value) {
  return new Date(value).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  });
}

function formatDuration(seconds) {
  const total = Math.max(0, Math.floor(seconds || 0));
  const minutes = Math.floor(total / 60);
  const secs = total % 60;
  return minutes + ':' + String(secs).padStart(2, '0');
}

function looksLikeUrl(value) {
  return /^https?:\/\//i.test(String(value || '').trim());
}

function stripExtension(name) {
  return String(name || '').replace(/\.[a-z0-9]+$/i, '').replace(/[-_]+/g, ' ').trim();
}

function setTab(tab) {
  state.tab = tab;
  tabInbox.classList.toggle('active', tab === 'inbox');
  tabAsk.classList.toggle('active', tab === 'ask');
  inboxView.classList.toggle('hidden', tab !== 'inbox');
  askView.classList.toggle('hidden', tab !== 'ask');
}

function setCaptureMode(mode) {
  state.captureMode = mode || '';
  capturePanel.classList.toggle('hidden', !mode);
  voicePanel.classList.toggle('hidden', mode !== 'voice');
  textForm.classList.toggle('hidden', mode !== 'text');
  linkForm.classList.toggle('hidden', mode !== 'link');
  for (const button of captureActions.querySelectorAll('.capture-action')) {
    button.classList.toggle('active', button.dataset.action === mode);
  }
  if (mode === 'text') textInput.focus();
  if (mode === 'link') linkInput.focus();
}

function showVaultSheet() {
  vaultSheet.classList.remove('hidden');
  renderVaultSheet();
}

function hideVaultSheet() {
  vaultSheet.classList.add('hidden');
}

function showEditor(entryId) {
  state.editingEntryId = entryId;
  const entry = state.projection.entriesById[entryId];
  editorInput.value = entry ? entry.text : '';
  editorModal.classList.remove('hidden');
  editorInput.focus();
}

function hideEditor() {
  state.editingEntryId = '';
  editorInput.value = '';
  editorModal.classList.add('hidden');
}

function showEntity(entityId) {
  state.entityId = entityId;
  entityDrawer.classList.remove('hidden');
  renderEntityDrawer();
}

function hideEntity() {
  state.entityId = '';
  entityDrawer.classList.add('hidden');
}

function stopCurrentPlayback() {
  if (!state.playback) return;
  state.playback.audio.pause();
  if (state.playback.url) {
    URL.revokeObjectURL(state.playback.url);
  }
  if (state.playback.button) {
    state.playback.button.textContent = 'Play';
  }
  state.playback = null;
}

function clearObjectUrls() {
  for (const url of PLAYBACK_URLS.values()) {
    URL.revokeObjectURL(url);
  }
  PLAYBACK_URLS.clear();
}

function tokenPill(label, kind, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'entity-chip';
  button.dataset.kind = kind;
  button.textContent = label;
  button.addEventListener('click', onClick);
  return button;
}

function renderHeadlineChips() {
  while (activeProjectsEl.firstChild) activeProjectsEl.removeChild(activeProjectsEl.firstChild);
  while (activeTopicsEl.firstChild) activeTopicsEl.removeChild(activeTopicsEl.firstChild);

  const projects = state.projection.entities
    .filter((entity) => entity.kind === 'project' && entity.status !== 'done' && entity.mergedInto === '')
    .slice(0, 5);
  const topics = state.projection.entities
    .filter((entity) => entity.kind === 'topic')
    .slice(0, 6);

  for (const project of projects) {
    activeProjectsEl.appendChild(tokenPill(project.title, 'project', () => showEntity(project.id)));
  }

  for (const topic of topics) {
    activeTopicsEl.appendChild(tokenPill(topic.title, 'topic', () => showEntity(topic.id)));
  }
}

function createArtifactBadge(artifact, entry) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'artifact-badge';
  button.textContent = artifact.kind === 'photo' ? 'Photo' : artifact.kind === 'audio' ? 'Audio' : artifact.kind === 'link' ? 'Link' : 'File';
  button.addEventListener('click', async () => {
    const fullArtifact = await getArtifact(artifact.artifactId);
    if (!fullArtifact) return;

    if (artifact.kind === 'audio' && fullArtifact.blob) {
      if (state.playback && state.playback.entryId === entry.id) {
        stopCurrentPlayback();
        return;
      }

      stopCurrentPlayback();
      const url = URL.createObjectURL(fullArtifact.blob);
      const audio = new Audio(url);
      button.textContent = 'Pause';
      audio.play().catch(() => {
        URL.revokeObjectURL(url);
        button.textContent = 'Play';
      });
      audio.onended = () => {
        URL.revokeObjectURL(url);
        button.textContent = 'Play';
        state.playback = null;
      };
      state.playback = { entryId: entry.id, audio, url, button };
      return;
    }

    if ((artifact.kind === 'file' || artifact.kind === 'photo') && fullArtifact.blob) {
      const url = URL.createObjectURL(fullArtifact.blob);
      PLAYBACK_URLS.set(artifact.artifactId, url);
      const link = document.createElement('a');
      link.href = url;
      link.download = fullArtifact.name || 'artifact';
      link.click();
      return;
    }

    if (artifact.kind === 'link' && fullArtifact.url) {
      window.open(fullArtifact.url, '_blank', 'noopener,noreferrer');
    }
  });
  return button;
}

function createTimelineCard(entry) {
  const card = document.createElement('article');
  card.className = 'entry-card';

  const head = document.createElement('div');
  head.className = 'entry-card-head';

  const titleWrap = document.createElement('div');

  const typeLabel = document.createElement('span');
  typeLabel.className = 'entry-type';
  typeLabel.textContent = entry.kind || entry.captureType;
  titleWrap.appendChild(typeLabel);

  const title = document.createElement('h3');
  title.className = 'entry-title';
  title.textContent = entry.title;
  titleWrap.appendChild(title);

  const meta = document.createElement('p');
  meta.className = 'entry-meta';
  meta.textContent = formatDate(entry.recordedAt || entry.occurredAt);
  titleWrap.appendChild(meta);

  head.appendChild(titleWrap);

  const actions = document.createElement('div');
  actions.className = 'entry-actions';

  if (entry.kind === 'task' || entry.status === 'open' || entry.status === 'done') {
    const toggleBtn = document.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.className = 'ghost-btn';
    toggleBtn.textContent = entry.status === 'done' ? 'Reopen' : 'Done';
    toggleBtn.addEventListener('click', async () => {
      await updateEntryStatus(entry, entry.status === 'done' ? 'open' : 'done');
    });
    actions.appendChild(toggleBtn);
  }

  const editBtn = document.createElement('button');
  editBtn.type = 'button';
  editBtn.className = 'ghost-btn';
  editBtn.textContent = 'Edit';
  editBtn.addEventListener('click', () => showEditor(entry.id));
  actions.appendChild(editBtn);

  const archiveBtn = document.createElement('button');
  archiveBtn.type = 'button';
  archiveBtn.className = 'ghost-btn accent';
  archiveBtn.textContent = 'Archive';
  archiveBtn.addEventListener('click', async () => {
    await archiveEntry(entry.id);
  });
  actions.appendChild(archiveBtn);

  head.appendChild(actions);
  card.appendChild(head);

  if (entry.text) {
    const body = document.createElement('p');
    body.className = 'entry-body';
    body.textContent = entry.text;
    card.appendChild(body);
  }

  if (entry.summaries.length > 0) {
    const summary = document.createElement('p');
    summary.className = 'entry-summary';
    summary.textContent = entry.summaries[0].text;
    card.appendChild(summary);
  }

  if (entry.artifacts.length > 0) {
    const artifacts = document.createElement('div');
    artifacts.className = 'entry-artifacts';
    for (const artifact of entry.artifacts) {
      artifacts.appendChild(createArtifactBadge(artifact, entry));
    }
    card.appendChild(artifacts);
  }

  const chips = document.createElement('div');
  chips.className = 'entry-chips';
  for (const entityId of entry.aboutIds.concat(entry.collectionIds)) {
    const entity = state.projection.entitiesById[entityId];
    if (!entity) continue;
    chips.appendChild(tokenPill(entity.title, entity.kind, () => showEntity(entity.id)));
  }
  for (const waitingOn of entry.waitingOn) {
    const badge = document.createElement('span');
    badge.className = 'status-chip';
    badge.textContent = 'Waiting on: ' + waitingOn;
    chips.appendChild(badge);
  }
  if (entry.status && entry.status !== 'archived') {
    const badge = document.createElement('span');
    badge.className = 'status-chip';
    badge.textContent = entry.status;
    chips.appendChild(badge);
  }
  if (chips.childElementCount > 0) {
    card.appendChild(chips);
  }

  return card;
}

function renderTimeline() {
  clearObjectUrls();
  stopCurrentPlayback();
  while (timelineList.firstChild) timelineList.removeChild(timelineList.firstChild);
  const entries = state.projection.entries.filter((entry) => !entry.archived);
  timelineEmpty.classList.toggle('hidden', entries.length > 0);
  for (const entry of entries) {
    timelineList.appendChild(createTimelineCard(entry));
  }
}

function renderAskResult() {
  while (askResults.firstChild) askResults.removeChild(askResults.firstChild);
  while (followUps.firstChild) followUps.removeChild(followUps.firstChild);

  if (!state.queryResult) {
    askAnswer.textContent = 'Ask about projects, blockers, or topics to pull structured views from the event log.';
    return;
  }

  askAnswer.textContent = state.queryResult.answer;
  for (const entity of state.queryResult.entities || []) {
    askResults.appendChild(tokenPill(entity.title, entity.kind, () => showEntity(entity.id)));
  }
  for (const entry of state.queryResult.entries || []) {
    askResults.appendChild(createTimelineCard(entry));
  }
  for (const followUp of state.queryResult.followUps || []) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'follow-up';
    button.textContent = followUp;
    button.addEventListener('click', () => {
      askInput.value = followUp;
      state.queryResult = executeQuery(followUp, state.projection);
      renderAskResult();
    });
    followUps.appendChild(button);
  }
}

function renderEntityDrawer() {
  while (entityMeta.firstChild) entityMeta.removeChild(entityMeta.firstChild);
  while (entityFacts.firstChild) entityFacts.removeChild(entityFacts.firstChild);
  while (entityEntries.firstChild) entityEntries.removeChild(entityEntries.firstChild);

  const entity = state.projection.entitiesById[state.entityId];
  if (!entity) {
    hideEntity();
    return;
  }

  entityTitle.textContent = entity.title;

  const kind = document.createElement('span');
  kind.className = 'drawer-pill';
  kind.textContent = entity.kind || 'entity';
  entityMeta.appendChild(kind);

  if (entity.status) {
    const status = document.createElement('span');
    status.className = 'drawer-pill';
    status.textContent = entity.status;
    entityMeta.appendChild(status);
  }

  for (const waitingOn of entity.waitingOn) {
    const fact = document.createElement('p');
    fact.className = 'drawer-copy';
    fact.textContent = 'Waiting on: ' + waitingOn;
    entityFacts.appendChild(fact);
  }

  if (entity.summaries.length > 0) {
    const summary = document.createElement('p');
    summary.className = 'drawer-copy';
    summary.textContent = entity.summaries[0].text;
    entityFacts.appendChild(summary);
  }

  for (const entryId of entity.relatedEntryIds) {
    const entry = state.projection.entriesById[entryId];
    if (entry && !entry.archived) {
      entityEntries.appendChild(createTimelineCard(entry));
    }
  }
}

function renderVaultSheet() {
  vaultSelector.replaceChildren();
  for (const vault of state.vaults) {
    const option = document.createElement('option');
    option.value = vault.id;
    option.textContent = vault.name;
    option.selected = vault.id === state.activeVaultId;
    vaultSelector.appendChild(option);
  }
  if (state.activeVault) {
    vaultNameInput.value = state.activeVault.name || '';
    relayUrlInput.value = state.activeVault.relayUrl || '';
  }
  syncStatus.textContent = state.activeVault && state.activeVault.relayUrl
    ? 'Relay ready: ' + state.activeVault.relayUrl
    : 'Local-only mode. Add a relay URL when you want shared-key sync.';
}

function renderAppShell() {
  appTitle.textContent = 'LifeOS Capture';
  appVersion.textContent = 'v24';
  vaultPill.textContent = state.activeVault ? state.activeVault.name : 'Vault';
  renderHeadlineChips();
  renderTimeline();
  renderAskResult();
  if (state.entityId) renderEntityDrawer();
}

async function materializeVault(vault) {
  const events = await getEventsByVault(vault.id);
  const artifacts = await getArtifactsByVault(vault.id);
  const projection = buildProjection({ vault, events, artifacts });
  await saveProjection(vault.id, projection);
  return projection;
}

async function refreshState() {
  state.vaults = await listVaults();
  state.activeVault = await getVault(state.activeVaultId);
  state.projection = await materializeVault(state.activeVault);
  if (askInput.value.trim()) {
    state.queryResult = executeQuery(askInput.value.trim(), state.projection);
  }
  renderAppShell();
}

async function appendEntryEvents(events, artifacts) {
  if (artifacts && artifacts.length > 0) {
    await saveArtifacts(artifacts);
  }
  await appendEvents(events);
  await refreshState();
}

async function createTextCapture(text) {
  const value = String(text || '').trim();
  if (!value) return;
  const now = new Date().toISOString();
  const captureId = generateSortableId('capture');
  await appendEntryEvents([
    createEventEnvelope({
      vaultId: state.activeVaultId,
      deviceId: state.deviceId,
      kind: EVENT_KINDS.CAPTURE_CREATED,
      occurredAt: now,
      recordedAt: now,
      body: {
        captureId,
        captureType: looksLikeUrl(value) ? 'link' : 'text'
      }
    }),
    createEventEnvelope({
      vaultId: state.activeVaultId,
      deviceId: state.deviceId,
      kind: EVENT_KINDS.TEXT_EXTRACTED,
      occurredAt: now,
      recordedAt: now,
      sourceRefs: [{ type: 'capture', id: captureId }],
      body: {
        captureId,
        mode: 'manual',
        text: value
      }
    })
  ]);
  textInput.value = '';
  setCaptureMode('');
}

async function createLinkCapture(url, note) {
  const href = String(url || '').trim();
  if (!href) return;
  const now = new Date().toISOString();
  const captureId = generateSortableId('capture');
  const artifactId = generateSortableId('artifact');
  let label = href;
  try {
    const parsed = new URL(href);
    label = parsed.hostname + parsed.pathname;
  } catch (error) {
    // Keep raw URL string.
  }

  const events = [
    createEventEnvelope({
      vaultId: state.activeVaultId,
      deviceId: state.deviceId,
      kind: EVENT_KINDS.CAPTURE_CREATED,
      occurredAt: now,
      recordedAt: now,
      body: {
        captureId,
        captureType: 'link'
      }
    }),
    createEventEnvelope({
      vaultId: state.activeVaultId,
      deviceId: state.deviceId,
      kind: EVENT_KINDS.ARTIFACT_ATTACHED,
      occurredAt: now,
      recordedAt: now,
      sourceRefs: [{ type: 'capture', id: captureId }],
      body: {
        captureId,
        artifactId,
        artifactType: 'link'
      }
    }),
    createEventEnvelope({
      vaultId: state.activeVaultId,
      deviceId: state.deviceId,
      kind: EVENT_KINDS.TEXT_EXTRACTED,
      occurredAt: now,
      recordedAt: now,
      sourceRefs: [{ type: 'capture', id: captureId }],
      body: {
        captureId,
        mode: 'manual',
        text: note ? note + '\n' + href : label
      }
    })
  ];

  await appendEntryEvents(events, [{
    artifactId,
    vaultId: state.activeVaultId,
    captureId,
    kind: 'link',
    mimeType: 'text/uri-list',
    name: label,
    size: href.length,
    url: href,
    createdAt: now
  }]);

  linkInput.value = '';
  linkNoteInput.value = '';
  setCaptureMode('');
}

async function createFileCapture(file, kind) {
  if (!file) return;
  const now = new Date().toISOString();
  const captureId = generateSortableId('capture');
  const artifactId = generateSortableId('artifact');
  const noteText = stripExtension(file.name);

  const events = [
    createEventEnvelope({
      vaultId: state.activeVaultId,
      deviceId: state.deviceId,
      kind: EVENT_KINDS.CAPTURE_CREATED,
      occurredAt: now,
      recordedAt: now,
      body: {
        captureId,
        captureType: kind
      }
    }),
    createEventEnvelope({
      vaultId: state.activeVaultId,
      deviceId: state.deviceId,
      kind: EVENT_KINDS.ARTIFACT_ATTACHED,
      occurredAt: now,
      recordedAt: now,
      sourceRefs: [{ type: 'capture', id: captureId }],
      body: {
        captureId,
        artifactId,
        artifactType: kind
      }
    })
  ];

  if (noteText) {
    events.push(createEventEnvelope({
      vaultId: state.activeVaultId,
      deviceId: state.deviceId,
      kind: EVENT_KINDS.TEXT_EXTRACTED,
      occurredAt: now,
      recordedAt: now,
      sourceRefs: [{ type: 'capture', id: captureId }],
      body: {
        captureId,
        mode: 'metadata',
        text: noteText
      }
    }));
  }

  await appendEntryEvents(events, [{
    artifactId,
    vaultId: state.activeVaultId,
    captureId,
    kind,
    mimeType: file.type || 'application/octet-stream',
    name: file.name,
    size: file.size || 0,
    createdAt: now,
    blob: file
  }]);
}

async function updateEntryStatus(entry, nextStatus) {
  const now = new Date().toISOString();
  const events = [];
  if (entry.status) {
    events.push(createEventEnvelope({
      vaultId: state.activeVaultId,
      deviceId: state.deviceId,
      kind: EVENT_KINDS.FACT_RETRACTED,
      occurredAt: now,
      recordedAt: now,
      sourceRefs: [{ type: 'capture', id: entry.id }],
      body: {
        subjectId: entry.id,
        predicate: 'status',
        value: entry.status
      }
    }));
  }
  events.push(createEventEnvelope({
    vaultId: state.activeVaultId,
    deviceId: state.deviceId,
    kind: EVENT_KINDS.FACT_ASSERTED,
    occurredAt: now,
    recordedAt: now,
    sourceRefs: [{ type: 'capture', id: entry.id }],
    body: {
      subjectId: entry.id,
      predicate: 'kind',
      value: entry.kind || 'task',
      valueType: 'text'
    }
  }));
  events.push(createEventEnvelope({
    vaultId: state.activeVaultId,
    deviceId: state.deviceId,
    kind: EVENT_KINDS.FACT_ASSERTED,
    occurredAt: now,
    recordedAt: now,
    sourceRefs: [{ type: 'capture', id: entry.id }],
    body: {
      subjectId: entry.id,
      predicate: 'status',
      value: nextStatus,
      valueType: 'text'
    }
  }));
  events.push(createEventEnvelope({
    vaultId: state.activeVaultId,
    deviceId: state.deviceId,
    kind: EVENT_KINDS.USER_ACTION_RECORDED,
    occurredAt: now,
    recordedAt: now,
    sourceRefs: [{ type: 'capture', id: entry.id }],
    body: {
      targetId: entry.id,
      action: nextStatus === 'done' ? 'complete' : 'reopen'
    }
  }));
  await appendEntryEvents(events);
}

async function archiveEntry(entryId) {
  const now = new Date().toISOString();
  await appendEntryEvents([
    createEventEnvelope({
      vaultId: state.activeVaultId,
      deviceId: state.deviceId,
      kind: EVENT_KINDS.ENTRY_ARCHIVED,
      occurredAt: now,
      recordedAt: now,
      sourceRefs: [{ type: 'capture', id: entryId }],
      body: {
        captureId: entryId
      }
    }),
    createEventEnvelope({
      vaultId: state.activeVaultId,
      deviceId: state.deviceId,
      kind: EVENT_KINDS.USER_ACTION_RECORDED,
      occurredAt: now,
      recordedAt: now,
      sourceRefs: [{ type: 'capture', id: entryId }],
      body: {
        targetId: entryId,
        action: 'archive'
      }
    })
  ]);
}

async function saveEditorChanges() {
  const text = editorInput.value.trim();
  if (!state.editingEntryId || !text) return;
  const now = new Date().toISOString();
  await appendEntryEvents([
    createEventEnvelope({
      vaultId: state.activeVaultId,
      deviceId: state.deviceId,
      kind: EVENT_KINDS.TEXT_EXTRACTED,
      occurredAt: now,
      recordedAt: now,
      sourceRefs: [{ type: 'capture', id: state.editingEntryId }],
      provenance: { source: 'user', actor: 'editor' },
      body: {
        captureId: state.editingEntryId,
        mode: 'manual',
        text
      }
    }),
    createEventEnvelope({
      vaultId: state.activeVaultId,
      deviceId: state.deviceId,
      kind: EVENT_KINDS.USER_ACTION_RECORDED,
      occurredAt: now,
      recordedAt: now,
      sourceRefs: [{ type: 'capture', id: state.editingEntryId }],
      body: {
        targetId: state.editingEntryId,
        action: 'edit-text'
      }
    })
  ]);
  hideEditor();
}

async function syncActiveVault() {
  if (!state.activeVault || !state.activeVault.relayUrl) {
    syncStatus.textContent = 'Add a relay URL to enable shared-key sync.';
    return;
  }

  syncStatus.textContent = 'Syncing vault...';
  try {
    const syncState = await getSyncState(state.activeVault.id);
    const transport = createHttpSyncTransport(state.activeVault);
    const currentEvents = await getEventsByVault(state.activeVault.id);
    const currentArtifacts = await getArtifactsByVault(state.activeVault.id);
    const pushResult = await transport.push(currentEvents, syncState);
    const pushArtifactResult = await transport.pushArtifacts(currentArtifacts, syncState);
    const pullResult = await transport.pull(syncState);
    const pullArtifactResult = await transport.pullArtifacts(syncState);
    await appendEvents(pullResult.events || []);
    await saveArtifacts(pullArtifactResult.artifacts || []);
    await saveSyncState({
      id: state.activeVault.id,
      vaultId: state.activeVault.id,
      relayUrl: state.activeVault.relayUrl || '',
      lastPushCursor: pushResult.cursor || syncState.lastPushCursor || '',
      lastPullCursor: pullResult.cursor || syncState.lastPullCursor || '',
      lastArtifactPushCursor: pushArtifactResult.cursor || syncState.lastArtifactPushCursor || '',
      lastArtifactPullCursor: pullArtifactResult.cursor || syncState.lastArtifactPullCursor || '',
      lastSyncedAt: new Date().toISOString(),
      lastError: ''
    });
    syncStatus.textContent = 'Synced at ' + formatDate(new Date().toISOString()) + '.';
    await refreshState();
  } catch (error) {
    syncStatus.textContent = error.message || 'Sync failed.';
    await saveSyncState({
      ...(await getSyncState(state.activeVault.id)),
      id: state.activeVault.id,
      vaultId: state.activeVault.id,
      relayUrl: state.activeVault.relayUrl || '',
      lastError: error.message || 'Sync failed.'
    });
  }
}

function startTimer() {
  timerEl.classList.add('active');
  timerInterval = setInterval(() => {
    timerEl.textContent = formatDuration((Date.now() - recordingStartTime) / 1000);
  }, 200);
}

function stopTimer() {
  clearInterval(timerInterval);
  timerInterval = null;
  timerEl.classList.remove('active');
  timerEl.textContent = '0:00';
}

function startWaveform(stream) {
  if (!waveformCtx) return;

  if (!audioContext || audioContext.state === 'closed') {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
  }
  analyser = audioContext.createAnalyser();
  analyser.fftSize = 2048;
  const source = audioContext.createMediaStreamSource(stream);
  source.connect(analyser);
  const data = new Uint8Array(analyser.fftSize);

  const width = 320;
  const height = 72;
  waveformCanvas.width = width;
  waveformCanvas.height = height;

  function draw() {
    waveformFrameId = requestAnimationFrame(draw);
    analyser.getByteTimeDomainData(data);
    waveformCtx.clearRect(0, 0, width, height);
    waveformCtx.fillStyle = 'rgba(255,255,255,0.08)';
    waveformCtx.fillRect(0, 0, width, height);
    waveformCtx.lineWidth = 2;
    waveformCtx.strokeStyle = '#9ff55a';
    waveformCtx.beginPath();
    const sliceWidth = width / data.length;
    let x = 0;
    for (let i = 0; i < data.length; i += 1) {
      const v = data[i] / 128;
      const y = (v * height) / 2;
      if (i === 0) waveformCtx.moveTo(x, y);
      else waveformCtx.lineTo(x, y);
      x += sliceWidth;
    }
    waveformCtx.lineTo(width, height / 2);
    waveformCtx.stroke();
  }

  draw();
}

function stopWaveform() {
  if (waveformFrameId) {
    cancelAnimationFrame(waveformFrameId);
    waveformFrameId = null;
  }
  if (waveformCtx) {
    waveformCtx.clearRect(0, 0, waveformCanvas.width, waveformCanvas.height);
  }
}

function startTranscription() {
  if (!SpeechRecognition) return;
  transcriptionResult = '';

  function createRecognition() {
    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.lang = navigator.language || 'en-US';
    recognition.onresult = (event) => {
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        if (!event.results[i].isFinal) continue;
        const text = event.results[i][0].transcript.trim();
        if (text) transcriptionResult += (transcriptionResult ? ' ' : '') + text;
      }
    };
    recognition.onerror = () => {
      if (isRecording && speechRecognition === recognition) {
        try { recognition.stop(); } catch (error) {}
      }
    };
    recognition.onend = () => {
      if (isRecording && speechRecognition === recognition) {
        const restarted = createRecognition();
        restarted.start();
        speechRecognition = restarted;
      }
    };
    return recognition;
  }

  speechRecognition = createRecognition();
  speechRecognition.start();
}

function stopTranscription() {
  if (!speechRecognition) {
    const text = transcriptionResult;
    transcriptionResult = '';
    return Promise.resolve(text);
  }

  return new Promise((resolve) => {
    const recognition = speechRecognition;
    speechRecognition = null;
    recognition.onend = () => {
      const text = transcriptionResult;
      transcriptionResult = '';
      resolve(text);
    };
    recognition.onerror = recognition.onend;
    try {
      recognition.stop();
    } catch (error) {
      resolve(transcriptionResult);
      transcriptionResult = '';
    }
  });
}

async function startRecording() {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const mimeTypes = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
  let mimeType = '';
  for (const candidate of mimeTypes) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(candidate)) {
      mimeType = candidate;
      break;
    }
  }
  mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  audioChunks = [];
  mediaRecorder.ondataavailable = (event) => {
    if (event.data.size > 0) audioChunks.push(event.data);
  };
  mediaRecorder.start(100);
  recordingStartTime = Date.now();
  startTimer();
  startWaveform(stream);
  startTranscription();
}

async function stopRecording() {
  if (!mediaRecorder || mediaRecorder.state === 'inactive') return null;
  const recorder = mediaRecorder;

  const blobPromise = new Promise((resolve) => {
    recorder.onstop = () => resolve(new Blob(audioChunks, { type: recorder.mimeType }));
  });

  recorder.stop();
  const [blob, transcription] = await Promise.all([blobPromise, stopTranscription()]);
  const duration = Math.round((Date.now() - recordingStartTime) / 1000);
  recorder.stream.getTracks().forEach((track) => track.stop());
  mediaRecorder = null;
  audioChunks = [];
  stopTimer();
  stopWaveform();
  return { blob, transcription, duration };
}

async function saveVoiceCapture(result) {
  const now = new Date().toISOString();
  const captureId = generateSortableId('capture');
  const artifactId = generateSortableId('artifact');

  const events = [
    createEventEnvelope({
      vaultId: state.activeVaultId,
      deviceId: state.deviceId,
      kind: EVENT_KINDS.CAPTURE_CREATED,
      occurredAt: now,
      recordedAt: now,
      body: {
        captureId,
        captureType: 'voice'
      }
    }),
    createEventEnvelope({
      vaultId: state.activeVaultId,
      deviceId: state.deviceId,
      kind: EVENT_KINDS.ARTIFACT_ATTACHED,
      occurredAt: now,
      recordedAt: now,
      sourceRefs: [{ type: 'capture', id: captureId }],
      body: {
        captureId,
        artifactId,
        artifactType: 'audio',
        duration: result.duration
      }
    })
  ];

  if (result.transcription && result.transcription.trim()) {
    events.push(createEventEnvelope({
      vaultId: state.activeVaultId,
      deviceId: state.deviceId,
      kind: EVENT_KINDS.TEXT_EXTRACTED,
      occurredAt: now,
      recordedAt: now,
      sourceRefs: [{ type: 'capture', id: captureId }],
      body: {
        captureId,
        mode: 'transcript',
        text: result.transcription.trim()
      }
    }));
  }

  await appendEntryEvents(events, [{
    artifactId,
    vaultId: state.activeVaultId,
    captureId,
    kind: 'audio',
    mimeType: result.blob.type || 'audio/webm',
    name: 'Voice capture',
    size: result.blob.size || 0,
    createdAt: now,
    blob: result.blob
  }]);
}

async function toggleRecording() {
  if (recordBusy) return;

  try {
    recordBusy = true;
    if (isRecording) {
      recordBtn.classList.remove('recording');
      recorderEl.classList.remove('recording');
      recordHint.textContent = 'Tap to record';
      const result = await stopRecording();
      isRecording = false;
      if (result && result.duration > 0) {
        await saveVoiceCapture(result);
      } else if (result) {
        recordHint.textContent = 'Hold a bit longer for a usable capture.';
      }
    } else {
      await startRecording();
      isRecording = true;
      recordBtn.classList.add('recording');
      recorderEl.classList.add('recording');
      recordHint.textContent = 'Tap to save';
    }
  } catch (error) {
    isRecording = false;
    recordBtn.classList.remove('recording');
    recorderEl.classList.remove('recording');
    stopTimer();
    stopWaveform();
    recordHint.textContent = 'Microphone capture is unavailable right now.';
  } finally {
    recordBusy = false;
  }
}

async function saveVaultSettings() {
  if (!state.activeVault) return;
  const nextVault = {
    ...state.activeVault,
    name: vaultNameInput.value.trim() || state.activeVault.name,
    relayUrl: relayUrlInput.value.trim()
  };
  await saveVault(nextVault);
  state.activeVault = nextVault;
  await refreshState();
  renderVaultSheet();
}

async function createNewVault() {
  const vault = createVaultDescriptor(vaultNameInput.value.trim() || 'New Vault', relayUrlInput.value.trim());
  await saveVault(vault);
  state.activeVaultId = vault.id;
  await setActiveVaultId(vault.id);
  await refreshState();
  renderVaultSheet();
}

async function applyInvite() {
  const invite = parseVaultInvite(inviteInput.value);
  if (!invite) {
    syncStatus.textContent = 'That invite code could not be parsed.';
    return;
  }

  const existing = await getVault(invite.vaultId);
  const vault = {
    id: invite.vaultId,
    name: invite.name || (existing && existing.name) || 'Shared Vault',
    relayUrl: invite.relayUrl || (existing && existing.relayUrl) || '',
    createdAt: (existing && existing.createdAt) || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: 'active',
    vaultKey: invite.vaultKey,
    readKey: invite.readKey,
    writeKey: invite.writeKey
  };
  await saveVault(vault);
  state.activeVaultId = vault.id;
  await setActiveVaultId(vault.id);
  inviteInput.value = '';
  await refreshState();
  renderVaultSheet();
  syncStatus.textContent = 'Joined ' + vault.name + '.';
}

captureActions.addEventListener('click', (event) => {
  const button = event.target.closest('.capture-action');
  if (!button) return;
  const action = button.dataset.action;
  if (action === 'file') {
    fileInput.click();
    return;
  }
  if (action === 'photo') {
    photoInput.click();
    return;
  }
  setCaptureMode(state.captureMode === action ? '' : action);
});

textForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  await createTextCapture(textInput.value);
});

linkForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  await createLinkCapture(linkInput.value, linkNoteInput.value);
});

fileInput.addEventListener('change', async () => {
  if (fileInput.files && fileInput.files[0]) {
    await createFileCapture(fileInput.files[0], 'file');
  }
  fileInput.value = '';
});

photoInput.addEventListener('change', async () => {
  if (photoInput.files && photoInput.files[0]) {
    await createFileCapture(photoInput.files[0], 'photo');
  }
  photoInput.value = '';
});

askForm.addEventListener('submit', (event) => {
  event.preventDefault();
  state.queryResult = executeQuery(askInput.value.trim(), state.projection);
  renderAskResult();
});

tabInbox.addEventListener('click', () => setTab('inbox'));
tabAsk.addEventListener('click', () => setTab('ask'));
settingsBtn.addEventListener('click', showVaultSheet);
vaultPill.addEventListener('click', showVaultSheet);
vaultBackdrop.addEventListener('click', hideVaultSheet);
vaultCloseBtn.addEventListener('click', hideVaultSheet);
saveVaultBtn.addEventListener('click', saveVaultSettings);
createVaultBtn.addEventListener('click', createNewVault);
generateInviteBtn.addEventListener('click', () => {
  if (!state.activeVault) return;
  inviteOutput.value = createVaultInvite(state.activeVault);
  inviteOutput.focus();
  inviteOutput.select();
});
applyInviteBtn.addEventListener('click', applyInvite);
vaultSelector.addEventListener('change', async () => {
  state.activeVaultId = vaultSelector.value;
  await setActiveVaultId(state.activeVaultId);
  await refreshState();
  renderVaultSheet();
});
syncBtn.addEventListener('click', syncActiveVault);
recordBtn.addEventListener('click', toggleRecording);
entityBackdrop.addEventListener('click', hideEntity);
entityCloseBtn.addEventListener('click', hideEntity);
editorBackdrop.addEventListener('click', hideEditor);
editorCloseBtn.addEventListener('click', hideEditor);
editorSaveBtn.addEventListener('click', saveEditorChanges);

async function init() {
  const vaultState = await ensureVaultState();
  state.deviceId = vaultState.deviceId;
  state.activeVaultId = vaultState.activeVaultId;
  await migrateLegacyData(state.activeVaultId);
  await refreshState();
  setTab('inbox');

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

init().catch((error) => {
  appTitle.textContent = 'LifeOS Capture';
  syncStatus.textContent = 'Startup failed: ' + (error.message || error);
});
