import crypto from 'node:crypto';
import { SYNC_KEY_HEADER, normalizeSyncKey } from '../sync-snapshot.js';
import { unauthorized } from './json.js';

function deriveNamespaceFromKey(syncKey) {
  const pepper = process.env.SYNC_KEY_PEPPER || '';
  return crypto
    .createHash('sha256')
    .update(`voice-notes-sync-v1:${pepper}:${syncKey}`)
    .digest('hex');
}

function requireSyncNamespace(request) {
  const key = normalizeSyncKey(request.headers.get(SYNC_KEY_HEADER) || '');
  if (!key) {
    return {
      namespace: null,
      response: unauthorized('Missing or invalid sync key.'),
    };
  }

  return {
    namespace: deriveNamespaceFromKey(key),
    response: null,
  };
}

export { deriveNamespaceFromKey, requireSyncNamespace };
