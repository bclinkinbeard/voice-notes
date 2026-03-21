'use strict';

import { normalizeText, titleCase, tokenizeText, unique } from './projections.js';

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

function createFileMetadataSummary(artifacts) {
  const fileArtifacts = artifacts.filter((artifact) => artifact.kind === 'file' || artifact.kind === 'photo');
  if (fileArtifacts.length === 0) return null;
  const labels = fileArtifacts.map((artifact) => {
    const size = artifact.size ? Math.round(artifact.size / 1024) + ' KB' : 'unknown size';
    return (artifact.name || artifact.kind) + ' (' + size + ')';
  });
  return 'Attached artifacts: ' + labels.join(', ');
}

function createLinkSummary(artifacts) {
  const linkArtifact = artifacts.find((artifact) => artifact.kind === 'link' && artifact.url);
  if (!linkArtifact) return null;
  try {
    const parsed = new URL(linkArtifact.url);
    return 'Saved link from ' + parsed.hostname + parsed.pathname;
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

export function deriveEntryAnnotations(entry) {
  const artifacts = Array.isArray(entry && entry.artifacts) ? entry.artifacts : [];
  const text = String((entry && entry.text) || '').trim();
  const empty = {
    inferredKind: '',
    topicTitles: [],
    projectTitles: [],
    waitingOn: '',
    nextStep: '',
    dueAt: '',
    keywordSummary: '',
    artifactSummary: '',
    linkSummary: ''
  };

  if ((entry && entry.archived) || (!text && artifacts.length === 0)) {
    return empty;
  }

  const keywordSummary = summarizeKeywords({ ...entry, text });

  return {
    inferredKind: inferKindForEntry({ ...entry, text }),
    topicTitles: matchTopics(text).map((topic) => titleCase(topic)),
    projectTitles: detectProjects(text),
    waitingOn: detectWaitingOn(text),
    nextStep: detectNextStep(text),
    dueAt: detectDueAt(text),
    keywordSummary: keywordSummary.length > 0 ? 'Key terms: ' + keywordSummary.join(', ') : '',
    artifactSummary: createFileMetadataSummary(artifacts) || '',
    linkSummary: createLinkSummary(artifacts) || ''
  };
}
