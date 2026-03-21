'use strict';

import { normalizeText, slugify, titleCase, tokenizeText, unique } from './projections.js';

export const TOPIC_KEYWORDS = {
  todo: ['need to', 'have to', 'should', 'must', 'remember to', 'task', 'to do', 'follow up'],
  project: ['project', 'launch', 'migration', 'initiative', 'remodel', 'renovation', 'move'],
  work: ['meeting', 'client', 'deadline', 'presentation', 'team', 'email', 'report'],
  personal: ['family', 'weekend', 'birthday', 'vacation', 'friend', 'home'],
  health: ['doctor', 'workout', 'exercise', 'sleep', 'medication', 'symptom'],
  nutrition: ['nutrition', 'protein', 'calories', 'meal', 'meals', 'food', 'diet', 'vitamin', 'macros'],
  finance: ['budget', 'expense', 'bill', 'invoice', 'salary', 'rent', 'money'],
  waiting: ['waiting on', 'waiting for', 'blocked on', 'pending from'],
  idea: ['idea', 'maybe', 'what if', 'could', 'should we'],
  question: ['how do', 'what is', 'why', 'when will', 'where is', 'who is']
};

const PROJECT_PATTERNS = [
  /\b([a-z0-9]+(?:\s+[a-z0-9]+){0,3}\s+(?:project|remodel|renovation|launch|migration|move|trip|initiative|plan))\b/gi
];

const WAITING_PATTERN = /\bwaiting\s+(?:on|for)\s+([^.!?\n]+)/i;
const NEXT_STEP_PATTERN = /\bnext step(?: is|:)?\s+([^.!?\n]+)/i;
const DUE_PATTERN = /\b(?:due|by)\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|next week|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)/i;

function createDerivedEventId(parts) {
  return parts.filter(Boolean).join(':').replace(/[^a-zA-Z0-9:_-]+/g, '-');
}

function makeFactEvent({ vaultId, subjectId, predicate, objectId, value, valueType, sourceEntryId, eventId, occurredAt, recordedAt }) {
  return {
    eventId,
    vaultId,
    occurredAt: occurredAt || new Date().toISOString(),
    recordedAt: recordedAt || occurredAt || new Date().toISOString(),
    deviceId: 'system-enricher',
    kind: 'fact.asserted',
    schemaVersion: 1,
    sourceRefs: sourceEntryId ? [{ type: 'capture', id: sourceEntryId }] : [],
    body: {
      subjectId,
      predicate,
      objectId: objectId || '',
      value,
      valueType: valueType || (objectId ? 'entity' : 'text')
    },
    provenance: { source: 'model', actor: 'first-party-enricher' },
    confidence: 0.72
  };
}

function makeSummaryEvent({ vaultId, targetId, eventId, text, summaryType, citations, occurredAt, recordedAt }) {
  return {
    eventId,
    vaultId,
    occurredAt: occurredAt || new Date().toISOString(),
    recordedAt: recordedAt || occurredAt || new Date().toISOString(),
    deviceId: 'system-enricher',
    kind: 'summary.generated',
    schemaVersion: 1,
    sourceRefs: citations || [],
    body: {
      targetId,
      summaryType,
      text,
      citations: citations || []
    },
    provenance: { source: 'model', actor: 'first-party-enricher' },
    confidence: 0.6
  };
}

function matchTopics(text) {
  const lower = normalizeText(text);
  const matches = [];
  for (const [topic, keywords] of Object.entries(TOPIC_KEYWORDS)) {
    if (keywords.some((keyword) => lower.includes(keyword))) {
      matches.push(topic);
    }
  }
  return matches;
}

function detectProjects(text) {
  const matches = [];
  for (const pattern of PROJECT_PATTERNS) {
    pattern.lastIndex = 0;
    let result = pattern.exec(text);
    while (result) {
      const phrase = result[1] || result[0];
      const normalized = normalizeText(phrase);
      if (normalized && normalized !== 'project update') {
        matches.push(titleCase(normalized));
      }
      result = pattern.exec(text);
    }
  }
  return unique(matches);
}

function detectWaitingOn(text) {
  const match = text.match(WAITING_PATTERN);
  if (!match) return '';
  return String(match[1] || '').trim().replace(/\s+/g, ' ');
}

function detectNextStep(text) {
  const match = text.match(NEXT_STEP_PATTERN);
  if (!match) return '';
  return String(match[1] || '').trim().replace(/\s+/g, ' ');
}

function detectDueAt(text) {
  const match = text.match(DUE_PATTERN);
  if (!match) return '';
  return String(match[1] || '').trim();
}

function createEntityFacts(vaultId, entityId, kind, title, sourceEntryId, occurredAt, recordedAt) {
  return [
    makeFactEvent({
      vaultId,
      subjectId: entityId,
      predicate: 'kind',
      value: kind,
      valueType: 'text',
      sourceEntryId,
      eventId: createDerivedEventId(['derive', 'kind', entityId, kind]),
      occurredAt,
      recordedAt
    }),
    makeFactEvent({
      vaultId,
      subjectId: entityId,
      predicate: 'title',
      value: title,
      valueType: 'text',
      sourceEntryId,
      eventId: createDerivedEventId(['derive', 'title', entityId, slugify(title)]),
      occurredAt,
      recordedAt
    }),
    makeFactEvent({
      vaultId,
      subjectId: entityId,
      predicate: 'source_entry',
      objectId: sourceEntryId,
      sourceEntryId,
      eventId: createDerivedEventId(['derive', 'source-entry', entityId, sourceEntryId]),
      occurredAt,
      recordedAt
    })
  ];
}

function createTopicEvents(vaultId, entry, topic) {
  const entityId = 'entity:topic:' + slugify(topic);
  return [
    ...createEntityFacts(vaultId, entityId, 'topic', titleCase(topic), entry.id, entry.occurredAt, entry.recordedAt),
    makeFactEvent({
      vaultId,
      subjectId: entry.id,
      predicate: 'about',
      objectId: entityId,
      sourceEntryId: entry.id,
      eventId: createDerivedEventId(['derive', 'about', entry.id, entityId]),
      occurredAt: entry.occurredAt,
      recordedAt: entry.recordedAt
    })
  ];
}

function createProjectEvents(vaultId, entry, projectName) {
  const entityId = 'entity:project:' + slugify(projectName);
  return [
    ...createEntityFacts(vaultId, entityId, 'project', projectName, entry.id, entry.occurredAt, entry.recordedAt),
    makeFactEvent({
      vaultId,
      subjectId: entry.id,
      predicate: 'about',
      objectId: entityId,
      sourceEntryId: entry.id,
      eventId: createDerivedEventId(['derive', 'about', entry.id, entityId]),
      occurredAt: entry.occurredAt,
      recordedAt: entry.recordedAt
    })
  ];
}

function createWaitingEvents(vaultId, entry, waitingOn, aboutProjectIds) {
  const targets = aboutProjectIds.length > 0 ? aboutProjectIds : [entry.id];
  return targets.map((subjectId) => makeFactEvent({
    vaultId,
    subjectId,
      predicate: 'waiting_on',
      value: waitingOn,
      valueType: 'text',
      sourceEntryId: entry.id,
      eventId: createDerivedEventId(['derive', 'waiting-on', subjectId, slugify(waitingOn)]),
      occurredAt: entry.occurredAt,
      recordedAt: entry.recordedAt
    }));
}

function createNextStepEvent(vaultId, entry, value) {
  return makeFactEvent({
    vaultId,
    subjectId: entry.id,
    predicate: 'next_step',
    value,
    valueType: 'text',
    sourceEntryId: entry.id,
    eventId: createDerivedEventId(['derive', 'next-step', entry.id, slugify(value)]),
    occurredAt: entry.occurredAt,
    recordedAt: entry.recordedAt
  });
}

function createDueAtEvent(vaultId, entry, value) {
  return makeFactEvent({
    vaultId,
    subjectId: entry.id,
    predicate: 'due_at',
    value,
    valueType: 'text',
    sourceEntryId: entry.id,
    eventId: createDerivedEventId(['derive', 'due-at', entry.id, slugify(value)]),
    occurredAt: entry.occurredAt,
    recordedAt: entry.recordedAt
  });
}

function createFileMetadataSummary(vaultId, entry) {
  const fileArtifacts = entry.artifacts.filter((artifact) => artifact.kind === 'file' || artifact.kind === 'photo');
  if (fileArtifacts.length === 0) return null;
  const labels = fileArtifacts.map((artifact) => {
    const size = artifact.size ? Math.round(artifact.size / 1024) + ' KB' : 'unknown size';
    return (artifact.name || artifact.kind) + ' (' + size + ')';
  });
  return makeSummaryEvent({
    vaultId,
    targetId: entry.id,
    eventId: createDerivedEventId(['derive', 'file-summary', entry.id]),
    summaryType: 'artifact-metadata',
    text: 'Attached artifacts: ' + labels.join(', '),
    citations: [{ type: 'capture', id: entry.id }],
    occurredAt: entry.occurredAt,
    recordedAt: entry.recordedAt
  });
}

function createLinkSummary(vaultId, entry) {
  const linkArtifact = entry.artifacts.find((artifact) => artifact.kind === 'link' && artifact.url);
  if (!linkArtifact) return null;
  try {
    const parsed = new URL(linkArtifact.url);
    return makeSummaryEvent({
      vaultId,
      targetId: entry.id,
      eventId: createDerivedEventId(['derive', 'link-summary', entry.id]),
      summaryType: 'url-metadata',
      text: 'Saved link from ' + parsed.hostname + parsed.pathname,
      citations: [{ type: 'capture', id: entry.id }],
      occurredAt: entry.occurredAt,
      recordedAt: entry.recordedAt
    });
  } catch (error) {
    return null;
  }
}

function inferKindForEntry(entry) {
  const text = normalizeText(entry.text);
  if (!text) return '';
  if (text.includes('need to') || text.includes('todo') || text.includes('follow up') || text.startsWith('buy ')) {
    return 'task';
  }
  return '';
}

function summarizeKeywords(entry) {
  const tokens = tokenizeText(entry.text).filter((token) => token.length > 3);
  const counts = {};
  for (const token of tokens) {
    counts[token] = (counts[token] || 0) + 1;
  }
  const top = Object.entries(counts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 4)
    .map(([token]) => token);
  return top;
}

export function runFirstPartyEnrichers({ vault, projection }) {
  const derivedEvents = [];
  for (const entry of projection.entries) {
    if (entry.archived) continue;
    if (!entry.text && entry.artifacts.length === 0) continue;

    const topicMatches = matchTopics(entry.text);
    for (const topic of topicMatches) {
      derivedEvents.push(...createTopicEvents(vault.id, entry, topic));
    }

    const inferredKind = inferKindForEntry(entry);
    if (inferredKind) {
      derivedEvents.push(makeFactEvent({
        vaultId: vault.id,
        subjectId: entry.id,
        predicate: 'kind',
        value: inferredKind,
        valueType: 'text',
        sourceEntryId: entry.id,
        eventId: createDerivedEventId(['derive', 'entry-kind', entry.id, inferredKind]),
        occurredAt: entry.occurredAt,
        recordedAt: entry.recordedAt
      }));
    }

    const projectMatches = detectProjects(entry.text);
    for (const projectName of projectMatches) {
      derivedEvents.push(...createProjectEvents(vault.id, entry, projectName));
    }

    const currentAboutIds = unique(
      entry.aboutIds.concat(
        projectMatches.map((projectName) => 'entity:project:' + slugify(projectName))
      )
    );
    const projectIds = currentAboutIds.filter((entityId) => entityId.startsWith('entity:project:'));

    const waitingOn = detectWaitingOn(entry.text);
    if (waitingOn) {
      derivedEvents.push(...createWaitingEvents(vault.id, entry, waitingOn, projectIds));
    }

    const nextStep = detectNextStep(entry.text);
    if (nextStep) {
      derivedEvents.push(createNextStepEvent(vault.id, entry, nextStep));
    }

    const dueAt = detectDueAt(entry.text);
    if (dueAt) {
      derivedEvents.push(createDueAtEvent(vault.id, entry, dueAt));
    }

    const keywordSummary = summarizeKeywords(entry);
    if (keywordSummary.length > 0) {
      derivedEvents.push(makeSummaryEvent({
        vaultId: vault.id,
        targetId: entry.id,
        eventId: createDerivedEventId(['derive', 'keywords', entry.id]),
        summaryType: 'keywords',
        text: 'Key terms: ' + keywordSummary.join(', '),
        citations: [{ type: 'capture', id: entry.id }],
        occurredAt: entry.occurredAt,
        recordedAt: entry.recordedAt
      }));
    }

    const fileSummary = createFileMetadataSummary(vault.id, entry);
    if (fileSummary) derivedEvents.push(fileSummary);

    const linkSummary = createLinkSummary(vault.id, entry);
    if (linkSummary) derivedEvents.push(linkSummary);
  }

  return derivedEvents;
}
