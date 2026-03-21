'use strict';

const TOKEN_SPLIT_RE = /[^a-z0-9]+/i;

export const DEFAULT_PREDICATES = [
  'kind',
  'title',
  'about',
  'status',
  'next_step',
  'waiting_on',
  'participant',
  'due_at',
  'source_entry',
  'belongs_to_collection'
];

export function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s:/.-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function slugify(value) {
  return normalizeText(value)
    .replace(/[/:.]+/g, ' ')
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function titleCase(value) {
  return String(value || '')
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export function tokenizeText(value) {
  return normalizeText(value)
    .split(TOKEN_SPLIT_RE)
    .map((token) => token.trim())
    .filter(Boolean);
}

export function unique(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

export function factSignature({ subjectId, predicate, objectId, value }) {
  const right = objectId ? 'obj:' + objectId : 'val:' + String(value ?? '');
  return [subjectId, predicate, right].join('|');
}

function eventTimestamp(event) {
  return Date.parse(event.recordedAt || event.occurredAt || 0) || 0;
}

function provenanceRank(provenance) {
  const source = provenance && provenance.source ? provenance.source : '';
  if (source === 'user') return 4;
  if (source === 'system') return 3;
  if (source === 'sync') return 3;
  if (source === 'migration') return 2;
  if (source === 'legacy') return 2;
  if (source === 'model') return 1;
  return 0;
}

function comparePreference(a, b) {
  if (!b) return 1;
  const aRank = provenanceRank(a.provenance);
  const bRank = provenanceRank(b.provenance);
  if (aRank !== bRank) return aRank - bRank;
  const aTime = eventTimestamp(a);
  const bTime = eventTimestamp(b);
  if (aTime !== bTime) return aTime - bTime;
  return String(a.eventId || '').localeCompare(String(b.eventId || ''));
}

function pushUnique(list, value) {
  if (!value) return;
  if (!list.includes(value)) list.push(value);
}

function ensureEntry(entriesById, captureId, createdAt) {
  if (!entriesById[captureId]) {
    entriesById[captureId] = {
      id: captureId,
      captureType: 'entry',
      occurredAt: createdAt || new Date(0).toISOString(),
      recordedAt: createdAt || new Date(0).toISOString(),
      archived: false,
      title: '',
      text: '',
      textVersions: [],
      artifactIds: [],
      artifacts: [],
      aboutIds: [],
      collectionIds: [],
      participantIds: [],
      waitingOn: [],
      factSignatures: [],
      sourceEventIds: [],
      summaries: [],
      status: '',
      kind: '',
      nextStep: '',
      dueAt: '',
      derivedTags: [],
      lastUpdatedAt: createdAt || new Date(0).toISOString()
    };
  }
  return entriesById[captureId];
}

function ensureEntity(entitiesById, entityId) {
  if (!entityId) return null;
  if (!entitiesById[entityId]) {
    entitiesById[entityId] = {
      id: entityId,
      kind: '',
      title: '',
      status: '',
      waitingOn: [],
      participantIds: [],
      relatedEntryIds: [],
      factSignatures: [],
      summaries: [],
      aliases: [],
      sourceEntryIds: [],
      lastSeenAt: '',
      mergedInto: '',
      splitFrom: ''
    };
  }
  return entitiesById[entityId];
}

function attachSummary(target, event) {
  const summary = {
    eventId: event.eventId,
    summaryType: event.body.summaryType || 'summary',
    text: event.body.text || '',
    citations: event.body.citations || []
  };
  target.summaries.push(summary);
}

function setPreferredField(target, field, value, event) {
  if (value === undefined || value === null || value === '') return;
  const nextCandidate = {
    value,
    provenance: event.provenance,
    eventId: event.eventId,
    occurredAt: event.occurredAt,
    recordedAt: event.recordedAt
  };
  const preferenceKey = '_pref_' + field;
  const current = target[preferenceKey];
  if (comparePreference(nextCandidate, current) > 0) {
    target[preferenceKey] = nextCandidate;
    target[field] = value;
  }
}

function finalizeEntry(entry) {
  const textVersions = entry.textVersions.slice().sort((a, b) => comparePreference(a, b));
  if (textVersions.length > 0) {
    entry.text = textVersions[textVersions.length - 1].text;
  }
  if (!entry.title) {
    const summaryCandidate = entry.text || (entry.artifacts[0] && entry.artifacts[0].name) || entry.captureType;
    entry.title = String(summaryCandidate || 'Untitled entry').trim().slice(0, 80);
  }
  entry.aboutIds = unique(entry.aboutIds);
  entry.collectionIds = unique(entry.collectionIds);
  entry.participantIds = unique(entry.participantIds);
  entry.waitingOn = unique(entry.waitingOn);
  entry.derivedTags = unique(entry.derivedTags);
  entry.factSignatures = unique(entry.factSignatures);
  entry.sourceEventIds = unique(entry.sourceEventIds);
  delete entry._pref_title;
  delete entry._pref_kind;
  delete entry._pref_status;
  delete entry._pref_nextStep;
  delete entry._pref_dueAt;
}

function finalizeEntity(entity) {
  entity.waitingOn = unique(entity.waitingOn);
  entity.participantIds = unique(entity.participantIds);
  entity.relatedEntryIds = unique(entity.relatedEntryIds);
  entity.factSignatures = unique(entity.factSignatures);
  entity.aliases = unique(entity.aliases);
  entity.sourceEntryIds = unique(entity.sourceEntryIds);
  if (!entity.title) {
    const slug = entity.id.split(':').pop() || entity.id;
    entity.title = titleCase(slug.replace(/-/g, ' '));
  }
  delete entity._pref_title;
  delete entity._pref_kind;
  delete entity._pref_status;
}

function valueLabel(fact, entitiesById) {
  if (fact.objectId) {
    const entity = entitiesById[fact.objectId];
    return entity ? entity.title : fact.objectId;
  }
  return String(fact.value ?? '');
}

export function upcastEvent(event) {
  if (!event) return event;
  if (!event.schemaVersion) {
    return {
      ...event,
      schemaVersion: 1,
      sourceRefs: event.sourceRefs || [],
      provenance: event.provenance || { source: 'legacy' }
    };
  }
  return event;
}

export function buildProjection({ vault, events, artifacts }) {
  const sortedEvents = events.map(upcastEvent).slice().sort((a, b) => {
    const aTime = eventTimestamp(a);
    const bTime = eventTimestamp(b);
    if (aTime !== bTime) return aTime - bTime;
    return String(a.eventId).localeCompare(String(b.eventId));
  });

  const artifactsById = {};
  for (const artifact of artifacts) {
    artifactsById[artifact.artifactId] = artifact;
  }

  const entriesById = {};
  const entitiesById = {};
  const factMap = {};
  const unknownEvents = [];

  for (const event of sortedEvents) {
    if (!event || !event.kind || !event.body) {
      unknownEvents.push(event);
      continue;
    }

    if (event.kind === 'capture.created') {
      const entry = ensureEntry(entriesById, event.body.captureId, event.occurredAt || event.recordedAt);
      entry.captureType = event.body.captureType || entry.captureType;
      entry.recordedAt = event.recordedAt || entry.recordedAt;
      entry.lastUpdatedAt = event.recordedAt || entry.lastUpdatedAt;
      pushUnique(entry.sourceEventIds, event.eventId);
      continue;
    }

    if (event.kind === 'artifact.attached') {
      const entry = ensureEntry(entriesById, event.body.captureId, event.occurredAt || event.recordedAt);
      pushUnique(entry.artifactIds, event.body.artifactId);
      const artifact = artifactsById[event.body.artifactId];
      if (artifact) {
        const artifactView = {
          artifactId: artifact.artifactId,
          kind: artifact.kind,
          mimeType: artifact.mimeType,
          name: artifact.name,
          size: artifact.size,
          url: artifact.url || '',
          createdAt: artifact.createdAt
        };
        if (!entry.artifacts.some((item) => item.artifactId === artifact.artifactId)) {
          entry.artifacts.push(artifactView);
        }
      }
      entry.lastUpdatedAt = event.recordedAt || entry.lastUpdatedAt;
      pushUnique(entry.sourceEventIds, event.eventId);
      continue;
    }

    if (event.kind === 'text.extracted') {
      const entry = ensureEntry(entriesById, event.body.captureId, event.occurredAt || event.recordedAt);
      entry.textVersions.push({
        eventId: event.eventId,
        text: String(event.body.text || '').trim(),
        mode: event.body.mode || 'text',
        provenance: event.provenance,
        occurredAt: event.occurredAt,
        recordedAt: event.recordedAt
      });
      entry.lastUpdatedAt = event.recordedAt || entry.lastUpdatedAt;
      pushUnique(entry.sourceEventIds, event.eventId);
      continue;
    }

    if (event.kind === 'summary.generated') {
      const targetId = event.body.targetId;
      if (String(targetId || '').startsWith('capture:')) {
        attachSummary(ensureEntry(entriesById, targetId, event.occurredAt || event.recordedAt), event);
      } else {
        attachSummary(ensureEntity(entitiesById, targetId), event);
      }
      continue;
    }

    if (event.kind === 'entry.archived') {
      const entry = ensureEntry(entriesById, event.body.captureId, event.occurredAt || event.recordedAt);
      entry.archived = true;
      entry.status = entry.status || 'archived';
      entry.lastUpdatedAt = event.recordedAt || entry.lastUpdatedAt;
      pushUnique(entry.sourceEventIds, event.eventId);
      continue;
    }

    if (event.kind === 'entity.merged') {
      const target = ensureEntity(entitiesById, event.body.toId);
      const fromIds = event.body.fromIds || [];
      for (const fromId of fromIds) {
        const entity = ensureEntity(entitiesById, fromId);
        entity.mergedInto = target.id;
      }
      continue;
    }

    if (event.kind === 'entity.split') {
      const source = ensureEntity(entitiesById, event.body.sourceId);
      const newIds = event.body.newIds || [];
      for (const newId of newIds) {
        const entity = ensureEntity(entitiesById, newId);
        entity.splitFrom = source.id;
      }
      continue;
    }

    if (event.kind === 'user.action.recorded') {
      if (event.body.targetId && String(event.body.targetId).startsWith('capture:')) {
        const entry = ensureEntry(entriesById, event.body.targetId, event.occurredAt || event.recordedAt);
        pushUnique(entry.sourceEventIds, event.eventId);
      }
      continue;
    }

    if (event.kind === 'fact.asserted') {
      const fact = {
        signature: factSignature(event.body),
        subjectId: event.body.subjectId,
        predicate: event.body.predicate,
        objectId: event.body.objectId || '',
        value: event.body.value,
        valueType: event.body.valueType || '',
        eventId: event.eventId,
        occurredAt: event.occurredAt,
        recordedAt: event.recordedAt,
        provenance: event.provenance,
        confidence: event.confidence || null
      };
      factMap[fact.signature] = fact;
      continue;
    }

    if (event.kind === 'fact.retracted') {
      delete factMap[factSignature(event.body)];
      continue;
    }

    unknownEvents.push(event);
  }

  const facts = Object.values(factMap).sort((a, b) => {
    const aTime = Date.parse(a.recordedAt || 0) || 0;
    const bTime = Date.parse(b.recordedAt || 0) || 0;
    if (aTime !== bTime) return aTime - bTime;
    return String(a.eventId).localeCompare(String(b.eventId));
  });

  for (const fact of facts) {
    const subjectIsCapture = String(fact.subjectId || '').startsWith('capture:');
    const subject = subjectIsCapture
      ? ensureEntry(entriesById, fact.subjectId, fact.recordedAt)
      : ensureEntity(entitiesById, fact.subjectId);

    if (!subject) continue;
    pushUnique(subject.factSignatures, fact.signature);

    if (fact.objectId && String(fact.objectId).startsWith('entity:')) {
      const objectEntity = ensureEntity(entitiesById, fact.objectId);
      if (objectEntity && subjectIsCapture) {
        pushUnique(objectEntity.relatedEntryIds, fact.subjectId);
        objectEntity.lastSeenAt = fact.recordedAt || objectEntity.lastSeenAt;
      }
    }

    if (subjectIsCapture) {
      if (fact.predicate === 'title') setPreferredField(subject, 'title', fact.value, fact);
      if (fact.predicate === 'kind') setPreferredField(subject, 'kind', fact.value, fact);
      if (fact.predicate === 'status') setPreferredField(subject, 'status', fact.value, fact);
      if (fact.predicate === 'next_step') setPreferredField(subject, 'nextStep', fact.value, fact);
      if (fact.predicate === 'due_at') setPreferredField(subject, 'dueAt', fact.value, fact);
      if (fact.predicate === 'about' && fact.objectId) {
        pushUnique(subject.aboutIds, fact.objectId);
        const related = ensureEntity(entitiesById, fact.objectId);
        if (related) {
          pushUnique(related.relatedEntryIds, subject.id);
          related.lastSeenAt = fact.recordedAt || related.lastSeenAt;
          if (related.kind === 'topic') {
            pushUnique(subject.derivedTags, related.title);
          }
        }
      }
      if (fact.predicate === 'belongs_to_collection' && fact.objectId) {
        pushUnique(subject.collectionIds, fact.objectId);
        const related = ensureEntity(entitiesById, fact.objectId);
        if (related) pushUnique(related.relatedEntryIds, subject.id);
      }
      if (fact.predicate === 'participant' && fact.objectId) {
        pushUnique(subject.participantIds, fact.objectId);
      }
      if (fact.predicate === 'waiting_on') {
        pushUnique(subject.waitingOn, valueLabel(fact, entitiesById));
      }
      continue;
    }

    if (fact.predicate === 'title') setPreferredField(subject, 'title', fact.value, fact);
    if (fact.predicate === 'kind') setPreferredField(subject, 'kind', fact.value, fact);
    if (fact.predicate === 'status') setPreferredField(subject, 'status', fact.value, fact);
    if (fact.predicate === 'waiting_on') pushUnique(subject.waitingOn, valueLabel(fact, entitiesById));
    if (fact.predicate === 'participant' && fact.objectId) pushUnique(subject.participantIds, fact.objectId);
    if (fact.predicate === 'source_entry' && fact.objectId) {
      pushUnique(subject.sourceEntryIds, fact.objectId);
      pushUnique(subject.relatedEntryIds, fact.objectId);
    }
    if (fact.predicate === 'about' && fact.objectId) {
      pushUnique(subject.aliases, valueLabel(fact, entitiesById));
    }
  }

  const entries = Object.values(entriesById);
  const entities = Object.values(entitiesById);

  for (const entity of entities) {
    for (const entryId of entity.relatedEntryIds) {
      const entry = entriesById[entryId];
      if (entry) {
        entity.lastSeenAt = entity.lastSeenAt || entry.recordedAt;
        for (const waitingOn of entity.waitingOn) {
          pushUnique(entry.waitingOn, waitingOn);
        }
      }
    }
    finalizeEntity(entity);
  }

  for (const entry of entries) {
    for (const entityId of entry.aboutIds) {
      const entity = entitiesById[entityId];
      if (entity && entity.kind === 'topic') {
        pushUnique(entry.derivedTags, entity.title);
      }
    }
    finalizeEntry(entry);
  }

  const searchIndex = {};
  for (const entry of entries) {
    const entityNames = entry.aboutIds.map((entityId) => {
      const entity = entitiesById[entityId];
      return entity ? entity.title : '';
    });
    const indexTokens = tokenizeText([
      entry.title,
      entry.text,
      entry.captureType,
      entry.derivedTags.join(' '),
      entityNames.join(' '),
      entry.artifacts.map((artifact) => artifact.name || artifact.url || '').join(' ')
    ].join(' '));

    for (const token of unique(indexTokens)) {
      if (!searchIndex[token]) searchIndex[token] = [];
      searchIndex[token].push(entry.id);
    }
  }

  entries.sort((a, b) => {
    const aTime = Date.parse(a.recordedAt || a.occurredAt || 0) || 0;
    const bTime = Date.parse(b.recordedAt || b.occurredAt || 0) || 0;
    if (aTime !== bTime) return bTime - aTime;
    return String(a.id).localeCompare(String(b.id));
  });

  entities.sort((a, b) => {
    const aRank = a.kind === 'project' ? 0 : a.kind === 'topic' ? 1 : 2;
    const bRank = b.kind === 'project' ? 0 : b.kind === 'topic' ? 1 : 2;
    if (aRank !== bRank) return aRank - bRank;
    return String(a.title).localeCompare(String(b.title));
  });

  return {
    vaultId: vault.id,
    builtAt: new Date().toISOString(),
    entries,
    entriesById,
    entities,
    entitiesById,
    collections: entities.filter((entity) => entity.kind === 'collection'),
    facts,
    searchIndex,
    stats: {
      entryCount: entries.length,
      entityCount: entities.length,
      factCount: facts.length,
      archivedCount: entries.filter((entry) => entry.archived).length,
      unknownEventCount: unknownEvents.length
    },
    unknownEvents: unknownEvents.map((event) => event && event.eventId).filter(Boolean)
  };
}
