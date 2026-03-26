'use strict';

import {
  SYNC_KEY_HEADER,
  SYNC_SNAPSHOT_VERSION,
  normalizeSyncKey,
  sanitizeSyncSnapshot,
} from './sync-snapshot.js';

const SYNC_KEY_STORAGE = 'voice-notes-cloud-sync-key';

function buildHeaders(syncKey, headers = {}) {
  const out = { ...headers };
  if (syncKey) out[SYNC_KEY_HEADER] = syncKey;
  return out;
}

async function apiJson(path, options = {}, syncKey = '') {
  const requestHeaders = buildHeaders(syncKey, options.headers || {});
  const requestOptions = {
    credentials: 'same-origin',
    ...options,
    headers: requestHeaders,
  };

  if (options.body && !requestHeaders['content-type']) {
    requestOptions.headers = {
      ...requestOptions.headers,
      'content-type': 'application/json',
    };
  }

  const response = await fetch(path, requestOptions);

  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }

  if (!response.ok || (data && data.ok === false)) {
    const fallback = `Request failed (${response.status})`;
    const message = data && typeof data.error === 'string' ? data.error : fallback;
    throw new Error(message);
  }

  return data || {};
}

async function buildSnapshotPayload(exportData) {
  const notes = (exportData.notes || []).map((note) => {
    const next = { ...note };
    delete next.audioBlob;
    delete next.audioHash;
    delete next.audioMimeType;
    return next;
  });

  return {
    snapshot: sanitizeSyncSnapshot({
      version: SYNC_SNAPSHOT_VERSION,
      lists: exportData.lists || [],
      notes,
      exportedAt: new Date().toISOString(),
    }),
  };
}

async function fetchCloudMeta(syncKey) {
  return apiJson('/api/sync/meta', { method: 'GET' }, syncKey);
}

async function pushSnapshot(snapshot, syncKey, onStatus = () => {}) {
  onStatus('Uploading snapshot...');
  return apiJson('/api/sync/push', {
    method: 'POST',
    body: JSON.stringify({ snapshot }),
  }, syncKey);
}

async function pullSnapshot(syncKey) {
  return apiJson('/api/sync/pull', { method: 'GET' }, syncKey);
}

export {
  SYNC_KEY_STORAGE,
  buildSnapshotPayload,
  fetchCloudMeta,
  normalizeSyncKey,
  pullSnapshot,
  pushSnapshot,
};
