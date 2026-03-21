'use strict';

import { normalizeText, tokenizeText, unique } from './projections.js';
import { TOPIC_KEYWORDS } from './analysis.js';

function expandTokens(tokens) {
  const expanded = new Set(tokens);
  for (const token of tokens) {
    if (TOPIC_KEYWORDS[token]) {
      for (const keyword of TOPIC_KEYWORDS[token]) {
        expanded.add(keyword);
      }
    }
    if (token === 'nutrition') {
      for (const alias of ['diet', 'protein', 'calories', 'food', 'meal']) {
        expanded.add(alias);
      }
    }
  }
  return Array.from(expanded);
}

function rankEntry(entry, projection, tokens) {
  const entityNames = entry.aboutIds.map((entityId) => {
    const entity = projection.entitiesById[entityId];
    return entity ? entity.title : '';
  }).join(' ');
  const haystack = normalizeText([
    entry.title,
    entry.text,
    entry.captureType,
    entry.derivedTags.join(' '),
    entityNames,
    entry.waitingOn.join(' ')
  ].join(' '));

  let score = 0;
  for (const token of tokens) {
    if (!token) continue;
    if (haystack.includes(token)) score += 1;
    if (normalizeText(entry.title).includes(token)) score += 2;
    if (normalizeText(entityNames).includes(token)) score += 2;
    if (entry.waitingOn.some((value) => normalizeText(value).includes(token))) score += 2;
  }

  return score;
}

function resolveEntity(subject, projection) {
  const normalized = normalizeText(subject);
  if (!normalized) return null;

  const direct = projection.entities.find((entity) => {
    const title = normalizeText(entity.title);
    if (title === normalized) return true;
    if (title.includes(normalized)) return true;
    return entity.aliases.some((alias) => normalizeText(alias).includes(normalized));
  });

  if (direct) return direct;

  const ranked = projection.entities
    .map((entity) => {
      const title = normalizeText(entity.title);
      let score = 0;
      if (title.includes(normalized)) score += 3;
      if (normalized.includes(title)) score += 2;
      if (entity.relatedEntryIds.some((entryId) => {
        const entry = projection.entriesById[entryId];
        return entry ? normalizeText(entry.text).includes(normalized) : false;
      })) {
        score += 1;
      }
      return { entity, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.entity.title.localeCompare(b.entity.title));

  return ranked[0] ? ranked[0].entity : null;
}

function searchEntries(query, projection) {
  const expandedTokens = expandTokens(tokenizeText(query));
  const ranked = projection.entries
    .filter((entry) => !entry.archived)
    .map((entry) => ({
      entry,
      score: rankEntry(entry, projection, expandedTokens)
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || String(b.entry.recordedAt).localeCompare(String(a.entry.recordedAt)));

  return ranked.map((item) => item.entry);
}

export function planQuery(query) {
  const normalized = normalizeText(query);
  if (!normalized) return { kind: 'empty', tokens: [] };

  if (normalized.includes('current projects')) {
    return { kind: 'current-projects', tokens: tokenizeText(normalized) };
  }

  const waitingMatch = normalized.match(/waiting on(?: with| for)? (.+)$/);
  if (waitingMatch) {
    return { kind: 'waiting-on', subject: waitingMatch[1].trim(), tokens: tokenizeText(waitingMatch[1]) };
  }

  const entriesAboutMatch = normalized.match(/(?:show me )?entries about (.+)$/);
  if (entriesAboutMatch) {
    return { kind: 'entries-about', subject: entriesAboutMatch[1].trim(), tokens: tokenizeText(entriesAboutMatch[1]) };
  }

  return { kind: 'search', tokens: tokenizeText(normalized), raw: query };
}

function summarizeEntries(entries) {
  if (entries.length === 0) return 'No matching entries yet.';
  if (entries.length === 1) return 'Found 1 matching entry.';
  return 'Found ' + entries.length + ' matching entries.';
}

function summarizeProjects(projects) {
  if (projects.length === 0) return 'No active projects yet.';
  return 'Current projects: ' + projects.map((project) => project.title).join(', ') + '.';
}

function collectWaitingOn(entity, projection) {
  const values = entity.waitingOn.slice();
  const supportingEntries = [];

  for (const entryId of entity.relatedEntryIds) {
    const entry = projection.entriesById[entryId];
    if (!entry) continue;
    if (entry.waitingOn.length > 0) {
      values.push(...entry.waitingOn);
      supportingEntries.push(entry);
    } else if (normalizeText(entry.text).includes('waiting on') || normalizeText(entry.text).includes('waiting for')) {
      supportingEntries.push(entry);
    }
  }

  return {
    values: unique(values),
    supportingEntries: unique(supportingEntries)
  };
}

export function executeQuery(query, projection) {
  const plan = planQuery(query);

  if (plan.kind === 'empty') {
    return {
      plan,
      answer: 'Ask about projects, waiting-on items, or entries by topic.',
      entities: [],
      entries: [],
      citations: [],
      followUps: ['What are my current projects?', 'Show me entries about nutrition.']
    };
  }

  if (plan.kind === 'current-projects') {
    const projects = projection.entities
      .filter((entity) => entity.kind === 'project' && entity.status !== 'done' && entity.mergedInto === '')
      .sort((a, b) => String(b.lastSeenAt || '').localeCompare(String(a.lastSeenAt || '')));

    return {
      plan,
      answer: summarizeProjects(projects),
      entities: projects,
      entries: projects.flatMap((project) => project.relatedEntryIds.map((entryId) => projection.entriesById[entryId]).filter(Boolean)).slice(0, 8),
      citations: projects.flatMap((project) => project.relatedEntryIds.slice(0, 2).map((entryId) => ({ type: 'capture', id: entryId }))),
      followUps: projects.slice(0, 3).map((project) => 'What are we waiting on with ' + project.title + '?')
    };
  }

  if (plan.kind === 'waiting-on') {
    const entity = resolveEntity(plan.subject, projection);
    if (!entity) {
      const entries = searchEntries(plan.subject, projection).slice(0, 8);
      return {
        plan,
        answer: 'I could not resolve that item yet, but here are the closest related entries.',
        entities: [],
        entries,
        citations: entries.map((entry) => ({ type: 'capture', id: entry.id })),
        followUps: ['Show me entries about ' + plan.subject + '.']
      };
    }

    const waiting = collectWaitingOn(entity, projection);
    const supportingEntries = waiting.supportingEntries.length > 0
      ? waiting.supportingEntries
      : entity.relatedEntryIds.map((entryId) => projection.entriesById[entryId]).filter(Boolean);
    const answer = waiting.values.length > 0
      ? 'Waiting on ' + entity.title + ': ' + waiting.values.join('; ') + '.'
      : 'No explicit waiting-on items found for ' + entity.title + ' yet.';

    return {
      plan,
      answer,
      entities: [entity],
      entries: supportingEntries.slice(0, 8),
      citations: supportingEntries.slice(0, 6).map((entry) => ({ type: 'capture', id: entry.id })),
      followUps: ['Show me entries about ' + entity.title + '.', 'What are my current projects?']
    };
  }

  if (plan.kind === 'entries-about') {
    const entity = resolveEntity(plan.subject, projection);
    let entries = [];
    let entities = [];

    if (entity) {
      entities = [entity];
      entries = entity.relatedEntryIds.map((entryId) => projection.entriesById[entryId]).filter(Boolean);
    } else {
      entries = searchEntries(plan.subject, projection);
    }

    return {
      plan,
      answer: summarizeEntries(entries),
      entities,
      entries: entries.slice(0, 12),
      citations: entries.slice(0, 8).map((entry) => ({ type: 'capture', id: entry.id })),
      followUps: entity ? ['What are we waiting on with ' + entity.title + '?'] : ['What are my current projects?']
    };
  }

  const entries = searchEntries(plan.raw || query, projection);
  return {
    plan,
    answer: summarizeEntries(entries),
    entities: [],
    entries: entries.slice(0, 12),
    citations: entries.slice(0, 8).map((entry) => ({ type: 'capture', id: entry.id })),
    followUps: ['What are my current projects?', 'Show me entries about nutrition.']
  };
}
