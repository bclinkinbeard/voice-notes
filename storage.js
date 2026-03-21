'use strict';

const DB_NAME = 'voiceNotesDB';
const DB_VERSION = 3;

export const EVENT_SCHEMA_VERSION = 1;
export const DEFAULT_VAULT_NAME = 'Personal Vault';

export const EVENT_KINDS = {
  CAPTURE_CREATED: 'capture.created',
  ARTIFACT_ATTACHED: 'artifact.attached',
  TEXT_EXTRACTED: 'text.extracted',
  FACT_ASSERTED: 'fact.asserted',
  FACT_RETRACTED: 'fact.retracted',
  SUMMARY_GENERATED: 'summary.generated',
  ENTITY_MERGED: 'entity.merged',
  ENTITY_SPLIT: 'entity.split',
  ENTRY_ARCHIVED: 'entry.archived',
  USER_ACTION_RECORDED: 'user.action.recorded'
};

const STORE = {
  NOTES: 'notes',
  LISTS: 'lists',
  VAULTS: 'vaults',
  EVENTS: 'events',
  ARTIFACTS: 'artifacts',
  PROJECTIONS: 'projections',
  SYNC_STATE: 'sync_state',
  META: 'meta'
};

let dbPromise = null;

function hasStore(db, name) {
  return Array.from(db.objectStoreNames).includes(name);
}

function hasIndex(store, name) {
  return Array.from(store.indexNames).includes(name);
}

function createStoreIfMissing(db, name, options) {
  if (!hasStore(db, name)) {
    db.createObjectStore(name, options);
  }
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = (event) => reject(event.target.error);
  });
}

function transactionDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = (event) => reject(event.target.error || tx.error);
    tx.onabort = (event) => reject(event.target.error || tx.error);
  });
}

function randomBase64Url(byteLength) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  const binary = Array.from(bytes).map((byte) => String.fromCharCode(byte)).join('');
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function generateSortableId(prefix, now = Date.now()) {
  const time = Math.floor(now).toString(36).padStart(10, '0');
  return prefix + ':' + time + ':' + randomBase64Url(8);
}

export function generateSecret() {
  return randomBase64Url(24);
}

function normalizeVaultDescriptor(vault) {
  if (!vault) return null;
  return {
    ...vault,
    name: String(vault.name || DEFAULT_VAULT_NAME).trim() || DEFAULT_VAULT_NAME,
    relayUrl: String(vault.relayUrl || '').trim(),
    status: vault.status || 'active',
    vaultKey: vault.vaultKey || generateSecret(),
    readKey: vault.readKey || generateSecret(),
    writeKey: vault.writeKey || generateSecret()
  };
}

function vaultDescriptorChanged(original, normalized) {
  return Boolean(
    original
    && normalized
    && (
      original.name !== normalized.name
      || String(original.relayUrl || '') !== normalized.relayUrl
      || original.status !== normalized.status
      || original.vaultKey !== normalized.vaultKey
      || original.readKey !== normalized.readKey
      || original.writeKey !== normalized.writeKey
    )
  );
}

async function putVaultRecord(vault, touchUpdatedAt = true) {
  const normalized = normalizeVaultDescriptor(vault);
  if (!normalized) return null;
  const db = await openDB();
  const tx = db.transaction(STORE.VAULTS, 'readwrite');
  tx.objectStore(STORE.VAULTS).put({
    ...normalized,
    updatedAt: touchUpdatedAt ? new Date().toISOString() : (normalized.updatedAt || new Date().toISOString())
  });
  await transactionDone(tx);
  return normalized;
}

export function isRetiredDerivedEvent(event) {
  return Boolean(
    event
    && event.provenance
    && event.provenance.actor === 'first-party-enricher'
  );
}

export function createVaultDescriptor(name, relayUrl) {
  const now = new Date().toISOString();
  return {
    id: generateSortableId('vault'),
    name: String(name || DEFAULT_VAULT_NAME).trim() || DEFAULT_VAULT_NAME,
    relayUrl: String(relayUrl || '').trim(),
    createdAt: now,
    updatedAt: now,
    status: 'active',
    vaultKey: generateSecret(),
    readKey: generateSecret(),
    writeKey: generateSecret()
  };
}

export function createEventEnvelope({
  vaultId,
  deviceId,
  kind,
  body,
  sourceRefs,
  provenance,
  confidence,
  occurredAt,
  recordedAt,
  authorLabel,
  eventId
}) {
  return {
    eventId: eventId || generateSortableId('evt'),
    vaultId,
    occurredAt: occurredAt || new Date().toISOString(),
    recordedAt: recordedAt || new Date().toISOString(),
    deviceId,
    authorLabel: authorLabel || '',
    kind,
    schemaVersion: EVENT_SCHEMA_VERSION,
    sourceRefs: sourceRefs || [],
    body: body || {},
    provenance: provenance || { source: 'user' },
    confidence: confidence === undefined ? null : confidence
  };
}

export async function openDB() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;

      createStoreIfMissing(db, STORE.VAULTS, { keyPath: 'id' });
      createStoreIfMissing(db, STORE.EVENTS, { keyPath: 'eventId' });
      createStoreIfMissing(db, STORE.ARTIFACTS, { keyPath: 'artifactId' });
      createStoreIfMissing(db, STORE.PROJECTIONS, { keyPath: 'id' });
      createStoreIfMissing(db, STORE.SYNC_STATE, { keyPath: 'id' });
      createStoreIfMissing(db, STORE.META, { keyPath: 'key' });

      const tx = event.target.transaction;
      if (tx) {
        const vaultStore = tx.objectStore(STORE.VAULTS);
        const eventStore = tx.objectStore(STORE.EVENTS);
        const artifactStore = tx.objectStore(STORE.ARTIFACTS);
        const projectionStore = tx.objectStore(STORE.PROJECTIONS);
        const syncStore = tx.objectStore(STORE.SYNC_STATE);

        if (!hasIndex(vaultStore, 'updatedAt')) vaultStore.createIndex('updatedAt', 'updatedAt', { unique: false });
        if (!hasIndex(eventStore, 'vaultId')) eventStore.createIndex('vaultId', 'vaultId', { unique: false });
        if (!hasIndex(eventStore, 'recordedAt')) eventStore.createIndex('recordedAt', 'recordedAt', { unique: false });
        if (!hasIndex(eventStore, 'kind')) eventStore.createIndex('kind', 'kind', { unique: false });
        if (!hasIndex(artifactStore, 'vaultId')) artifactStore.createIndex('vaultId', 'vaultId', { unique: false });
        if (!hasIndex(artifactStore, 'captureId')) artifactStore.createIndex('captureId', 'captureId', { unique: false });
        if (!hasIndex(projectionStore, 'vaultId')) projectionStore.createIndex('vaultId', 'vaultId', { unique: true });
        if (!hasIndex(syncStore, 'vaultId')) syncStore.createIndex('vaultId', 'vaultId', { unique: true });
      }
    };

    request.onsuccess = (event) => resolve(event.target.result);
    request.onerror = (event) => {
      dbPromise = null;
      reject(event.target.error);
    };
  });

  return dbPromise;
}

async function getMetaRecord(key) {
  const db = await openDB();
  const tx = db.transaction(STORE.META, 'readonly');
  const result = await requestToPromise(tx.objectStore(STORE.META).get(key));
  await transactionDone(tx);
  return result;
}

export async function setMetaValue(key, value) {
  const db = await openDB();
  const tx = db.transaction(STORE.META, 'readwrite');
  tx.objectStore(STORE.META).put({ key, value });
  await transactionDone(tx);
}

export async function ensureVaultState() {
  const existingVaults = await listVaults();
  let activeVaultId = ((await getMetaRecord('activeVaultId')) || {}).value;
  let deviceId = ((await getMetaRecord('deviceId')) || {}).value;

  if (!deviceId) {
    deviceId = generateSortableId('device');
    await setMetaValue('deviceId', deviceId);
  }

  if (existingVaults.length === 0) {
    const vault = createVaultDescriptor(DEFAULT_VAULT_NAME, '');
    await saveVault(vault);
    activeVaultId = vault.id;
    await setMetaValue('activeVaultId', activeVaultId);
    return { deviceId, activeVaultId, vault };
  }

  if (!activeVaultId || !existingVaults.some((vault) => vault.id === activeVaultId)) {
    activeVaultId = existingVaults[0].id;
    await setMetaValue('activeVaultId', activeVaultId);
  }

  return {
    deviceId,
    activeVaultId,
    vault: existingVaults.find((candidate) => candidate.id === activeVaultId)
  };
}

export async function setActiveVaultId(vaultId) {
  await setMetaValue('activeVaultId', vaultId);
}

export async function listVaults() {
  const db = await openDB();
  const tx = db.transaction(STORE.VAULTS, 'readonly');
  const vaults = await requestToPromise(tx.objectStore(STORE.VAULTS).getAll());
  await transactionDone(tx);
  const normalizedVaults = vaults.map((vault) => normalizeVaultDescriptor(vault));
  for (let index = 0; index < vaults.length; index += 1) {
    if (vaultDescriptorChanged(vaults[index], normalizedVaults[index])) {
      await putVaultRecord(normalizedVaults[index], false);
    }
  }
  return normalizedVaults.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}

export async function getVault(vaultId) {
  const db = await openDB();
  const tx = db.transaction(STORE.VAULTS, 'readonly');
  const vault = await requestToPromise(tx.objectStore(STORE.VAULTS).get(vaultId));
  await transactionDone(tx);
  const normalized = normalizeVaultDescriptor(vault);
  if (vaultDescriptorChanged(vault, normalized)) {
    await putVaultRecord(normalized, false);
  }
  return normalized || null;
}

export async function saveVault(vault) {
  await putVaultRecord(vault, true);
}

export async function appendEvents(events) {
  const byId = {};
  for (const event of events || []) {
    if (event && event.eventId && !isRetiredDerivedEvent(event)) byId[event.eventId] = event;
  }
  const incoming = Object.values(byId);
  if (incoming.length === 0) return 0;

  const existingIds = new Set(await getExistingEventIds(incoming.map((event) => event.eventId)));
  const missing = incoming.filter((event) => !existingIds.has(event.eventId));
  if (missing.length === 0) return 0;

  const db = await openDB();
  const tx = db.transaction(STORE.EVENTS, 'readwrite');
  const store = tx.objectStore(STORE.EVENTS);
  for (const event of missing) {
    store.put(event);
  }
  await transactionDone(tx);
  return missing.length;
}

async function getExistingEventIds(eventIds) {
  const ids = eventIds.filter(Boolean);
  if (ids.length === 0) return [];
  const db = await openDB();
  const tx = db.transaction(STORE.EVENTS, 'readonly');
  const store = tx.objectStore(STORE.EVENTS);
  const found = [];
  for (const id of ids) {
    const result = await requestToPromise(store.get(id));
    if (result) found.push(id);
  }
  await transactionDone(tx);
  return found;
}

export async function getEventsByVault(vaultId) {
  const db = await openDB();
  const tx = db.transaction(STORE.EVENTS, 'readonly');
  const store = tx.objectStore(STORE.EVENTS);
  const request = hasIndex(store, 'vaultId')
    ? store.index('vaultId').getAll(vaultId)
    : store.getAll();
  const events = await requestToPromise(request);
  await transactionDone(tx);
  return events.filter((event) => event.vaultId === vaultId && !isRetiredDerivedEvent(event));
}

export async function saveArtifacts(artifacts) {
  const items = (artifacts || []).filter(Boolean);
  if (items.length === 0) return;
  const db = await openDB();
  const tx = db.transaction(STORE.ARTIFACTS, 'readwrite');
  const store = tx.objectStore(STORE.ARTIFACTS);
  for (const artifact of items) {
    store.put(artifact);
  }
  await transactionDone(tx);
}

export async function getArtifactsByVault(vaultId) {
  const db = await openDB();
  const tx = db.transaction(STORE.ARTIFACTS, 'readonly');
  const store = tx.objectStore(STORE.ARTIFACTS);
  const request = hasIndex(store, 'vaultId')
    ? store.index('vaultId').getAll(vaultId)
    : store.getAll();
  const artifacts = await requestToPromise(request);
  await transactionDone(tx);
  return artifacts.filter((artifact) => artifact.vaultId === vaultId);
}

export async function getArtifact(artifactId) {
  const db = await openDB();
  const tx = db.transaction(STORE.ARTIFACTS, 'readonly');
  const artifact = await requestToPromise(tx.objectStore(STORE.ARTIFACTS).get(artifactId));
  await transactionDone(tx);
  return artifact || null;
}

export async function saveProjection(vaultId, projection) {
  const db = await openDB();
  const tx = db.transaction(STORE.PROJECTIONS, 'readwrite');
  tx.objectStore(STORE.PROJECTIONS).put({
    id: vaultId,
    vaultId,
    builtAt: projection.builtAt,
    projection
  });
  await transactionDone(tx);
}

export async function getProjection(vaultId) {
  const db = await openDB();
  const tx = db.transaction(STORE.PROJECTIONS, 'readonly');
  const record = await requestToPromise(tx.objectStore(STORE.PROJECTIONS).get(vaultId));
  await transactionDone(tx);
  return record ? record.projection : null;
}

export async function getSyncState(vaultId) {
  const db = await openDB();
  const tx = db.transaction(STORE.SYNC_STATE, 'readonly');
  const record = await requestToPromise(tx.objectStore(STORE.SYNC_STATE).get(vaultId));
  await transactionDone(tx);
  return record || {
    id: vaultId,
    vaultId,
    relayUrl: '',
    lastPushCursor: '',
    lastPullCursor: '',
    lastArtifactPushCursor: '',
    lastArtifactPullCursor: '',
    lastSyncedAt: '',
    lastError: ''
  };
}

export async function saveSyncState(syncState) {
  const db = await openDB();
  const tx = db.transaction(STORE.SYNC_STATE, 'readwrite');
  tx.objectStore(STORE.SYNC_STATE).put(syncState);
  await transactionDone(tx);
}

function legacyListToCollectionEvents(vaultId, list) {
  const entityId = 'entity:collection:' + String(list.id || 'default').replace(/[^a-zA-Z0-9:_-]+/g, '-');
  return [
    {
      eventId: 'legacy:list:' + list.id + ':kind',
      vaultId,
      occurredAt: list.createdAt || new Date().toISOString(),
      recordedAt: list.createdAt || new Date().toISOString(),
      deviceId: 'legacy-migration',
      kind: EVENT_KINDS.FACT_ASSERTED,
      schemaVersion: 1,
      sourceRefs: [{ type: 'legacy-list', id: list.id }],
      body: {
        subjectId: entityId,
        predicate: 'kind',
        value: 'collection',
        valueType: 'text'
      },
      provenance: { source: 'migration', actor: 'legacy-v2' },
      confidence: 1
    },
    {
      eventId: 'legacy:list:' + list.id + ':title',
      vaultId,
      occurredAt: list.createdAt || new Date().toISOString(),
      recordedAt: list.createdAt || new Date().toISOString(),
      deviceId: 'legacy-migration',
      kind: EVENT_KINDS.FACT_ASSERTED,
      schemaVersion: 1,
      sourceRefs: [{ type: 'legacy-list', id: list.id }],
      body: {
        subjectId: entityId,
        predicate: 'title',
        value: list.name || 'Legacy List',
        valueType: 'text'
      },
      provenance: { source: 'migration', actor: 'legacy-v2' },
      confidence: 1
    }
  ];
}

export function previewLegacyMigration(activeVaultId, lists, notes) {
  const listMap = {};
  for (const list of lists || []) listMap[list.id] = list;

  const artifactRecords = [];
  const migratedEvents = [];

  for (const list of lists || []) {
    migratedEvents.push(...legacyListToCollectionEvents(activeVaultId, list));
  }

  for (const note of notes || []) {
    const list = listMap[note.listId] || listMap.default || null;
    const captureId = 'capture:' + note.id;
    const occurredAt = note.createdAt || new Date().toISOString();
    const captureType = note.audioBlob ? 'voice' : 'text';
    migratedEvents.push({
      eventId: 'legacy:note:' + note.id + ':capture',
      vaultId: activeVaultId,
      occurredAt,
      recordedAt: occurredAt,
      deviceId: 'legacy-migration',
      kind: EVENT_KINDS.CAPTURE_CREATED,
      schemaVersion: 1,
      sourceRefs: [{ type: 'legacy-note', id: note.id }],
      body: {
        captureId,
        captureType: list && list.mode === 'accomplish' ? 'text' : captureType,
        legacyNoteId: note.id
      },
      provenance: { source: 'migration', actor: 'legacy-v2' },
      confidence: 1
    });

    if (note.audioBlob) {
      const artifactId = 'artifact:legacy:' + note.id + ':audio';
      artifactRecords.push({
        artifactId,
        vaultId: activeVaultId,
        captureId,
        kind: 'audio',
        mimeType: note.audioBlob.type || 'audio/webm',
        name: 'Legacy recording',
        size: note.audioBlob.size || 0,
        createdAt: occurredAt,
        blob: note.audioBlob
      });
      migratedEvents.push({
        eventId: 'legacy:note:' + note.id + ':audio',
        vaultId: activeVaultId,
        occurredAt,
        recordedAt: occurredAt,
        deviceId: 'legacy-migration',
        kind: EVENT_KINDS.ARTIFACT_ATTACHED,
        schemaVersion: 1,
        sourceRefs: [{ type: 'legacy-note', id: note.id }],
        body: {
          captureId,
          artifactId,
          artifactType: 'audio',
          duration: note.duration || 0
        },
        provenance: { source: 'migration', actor: 'legacy-v2' },
        confidence: 1
      });
    }

    if (note.transcription) {
      migratedEvents.push({
        eventId: 'legacy:note:' + note.id + ':text',
        vaultId: activeVaultId,
        occurredAt,
        recordedAt: occurredAt,
        deviceId: 'legacy-migration',
        kind: EVENT_KINDS.TEXT_EXTRACTED,
        schemaVersion: 1,
        sourceRefs: [{ type: 'legacy-note', id: note.id }],
        body: {
          captureId,
          mode: 'legacy',
          text: note.transcription
        },
        provenance: { source: 'migration', actor: 'legacy-v2' },
        confidence: 1
      });
    }

    if (list) {
      const collectionId = 'entity:collection:' + String(list.id).replace(/[^a-zA-Z0-9:_-]+/g, '-');
      migratedEvents.push({
        eventId: 'legacy:note:' + note.id + ':collection',
        vaultId: activeVaultId,
        occurredAt,
        recordedAt: occurredAt,
        deviceId: 'legacy-migration',
        kind: EVENT_KINDS.FACT_ASSERTED,
        schemaVersion: 1,
        sourceRefs: [{ type: 'legacy-note', id: note.id }],
        body: {
          subjectId: captureId,
          predicate: 'belongs_to_collection',
          objectId: collectionId,
          valueType: 'entity'
        },
        provenance: { source: 'migration', actor: 'legacy-v2' },
        confidence: 1
      });
      migratedEvents.push({
        eventId: 'legacy:note:' + note.id + ':kind',
        vaultId: activeVaultId,
        occurredAt,
        recordedAt: occurredAt,
        deviceId: 'legacy-migration',
        kind: EVENT_KINDS.FACT_ASSERTED,
        schemaVersion: 1,
        sourceRefs: [{ type: 'legacy-note', id: note.id }],
        body: {
          subjectId: captureId,
          predicate: 'kind',
          value: list.mode === 'accomplish' ? 'task' : 'entry',
          valueType: 'text'
        },
        provenance: { source: 'migration', actor: 'legacy-v2' },
        confidence: 1
      });
      if (list.mode === 'accomplish') {
        migratedEvents.push({
          eventId: 'legacy:note:' + note.id + ':status',
          vaultId: activeVaultId,
          occurredAt,
          recordedAt: occurredAt,
          deviceId: 'legacy-migration',
          kind: EVENT_KINDS.FACT_ASSERTED,
          schemaVersion: 1,
          sourceRefs: [{ type: 'legacy-note', id: note.id }],
          body: {
            subjectId: captureId,
            predicate: 'status',
            value: note.completed ? 'done' : 'open',
            valueType: 'text'
          },
          provenance: { source: 'migration', actor: 'legacy-v2' },
          confidence: 1
        });
      }
    }

    for (const category of note.categories || []) {
      const topicEntityId = 'entity:topic:' + category;
      migratedEvents.push({
        eventId: 'legacy:note:' + note.id + ':topic-title:' + category,
        vaultId: activeVaultId,
        occurredAt,
        recordedAt: occurredAt,
        deviceId: 'legacy-migration',
        kind: EVENT_KINDS.FACT_ASSERTED,
        schemaVersion: 1,
        sourceRefs: [{ type: 'legacy-note', id: note.id }],
        body: {
          subjectId: topicEntityId,
          predicate: 'title',
          value: category.charAt(0).toUpperCase() + category.slice(1),
          valueType: 'text'
        },
        provenance: { source: 'migration', actor: 'legacy-v2' },
        confidence: 1
      });
      migratedEvents.push({
        eventId: 'legacy:note:' + note.id + ':topic-kind:' + category,
        vaultId: activeVaultId,
        occurredAt,
        recordedAt: occurredAt,
        deviceId: 'legacy-migration',
        kind: EVENT_KINDS.FACT_ASSERTED,
        schemaVersion: 1,
        sourceRefs: [{ type: 'legacy-note', id: note.id }],
        body: {
          subjectId: topicEntityId,
          predicate: 'kind',
          value: 'topic',
          valueType: 'text'
        },
        provenance: { source: 'migration', actor: 'legacy-v2' },
        confidence: 1
      });
      migratedEvents.push({
        eventId: 'legacy:note:' + note.id + ':about:' + category,
        vaultId: activeVaultId,
        occurredAt,
        recordedAt: occurredAt,
        deviceId: 'legacy-migration',
        kind: EVENT_KINDS.FACT_ASSERTED,
        schemaVersion: 1,
        sourceRefs: [{ type: 'legacy-note', id: note.id }],
        body: {
          subjectId: captureId,
          predicate: 'about',
          objectId: topicEntityId,
          valueType: 'entity'
        },
        provenance: { source: 'migration', actor: 'legacy-v2' },
        confidence: 1
      });
    }
  }

  return { artifactRecords, migratedEvents };
}

export async function migrateLegacyData(activeVaultId) {
  const db = await openDB();
  const marker = await getMetaRecord('migration:legacy-v2-to-lifeos-v1');
  if (marker && marker.value) return false;

  if (!hasStore(db, STORE.NOTES) || !hasStore(db, STORE.LISTS)) {
    await setMetaValue('migration:legacy-v2-to-lifeos-v1', true);
    return false;
  }

  const tx = db.transaction([STORE.NOTES, STORE.LISTS], 'readonly');
  const lists = await requestToPromise(tx.objectStore(STORE.LISTS).getAll());
  const notes = await requestToPromise(tx.objectStore(STORE.NOTES).getAll());
  await transactionDone(tx);

  if (lists.length === 0 && notes.length === 0) {
    await setMetaValue('migration:legacy-v2-to-lifeos-v1', true);
    return false;
  }

  const { artifactRecords, migratedEvents } = previewLegacyMigration(activeVaultId, lists, notes);

  await saveArtifacts(artifactRecords);
  await appendEvents(migratedEvents);
  await setMetaValue('migration:legacy-v2-to-lifeos-v1', true);
  return true;
}
