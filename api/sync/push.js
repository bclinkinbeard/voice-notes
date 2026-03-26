import { badRequest, jsonResponse, readJson, serverError } from '../../server/json.js';
import { requireSyncNamespace } from '../../server/sync-key.js';
import {
  buildMetaPath,
  buildSnapshotId,
  buildSnapshotPath,
  getJson,
  putJson,
  sanitizeSnapshot,
} from '../../server/storage.js';

const MAX_SNAPSHOT_BYTES = 3 * 1024 * 1024;

function hasInlineAudioData(snapshot) {
  return (snapshot.notes || []).some(
    (note) =>
      Boolean(note?.audioBlob) ||
      (typeof note?.audioDataUrl === 'string' && note.audioDataUrl.startsWith('data:audio/')) ||
      typeof note?.audioBase64 === 'string'
  );
}

export async function POST(request) {
  try {
    const { namespace, response } = requireSyncNamespace(request);
    if (response) return response;

    const body = await readJson(request);
    if (!body || typeof body !== 'object' || !body.snapshot || typeof body.snapshot !== 'object') {
      return badRequest('Request body must include a snapshot object.');
    }

    let snapshot;
    try {
      snapshot = sanitizeSnapshot(body.snapshot);
    } catch (error) {
      return badRequest(error.message || 'Invalid snapshot payload.');
    }

    if (hasInlineAudioData(snapshot)) {
      return badRequest('Snapshot notes must not include inline audio data. Upload audio separately.');
    }

    const serialized = JSON.stringify(snapshot);
    if (serialized.length > MAX_SNAPSHOT_BYTES) {
      return badRequest(`Snapshot too large (${serialized.length} bytes).`);
    }

    const metaPath = buildMetaPath(namespace);
    const previousMeta = await getJson(metaPath);

    const snapshotId = buildSnapshotId();
    const snapshotPath = buildSnapshotPath(namespace, snapshotId);
    await putJson(snapshotPath, snapshot);

    const nextVersion = Number.isInteger(previousMeta?.version) ? previousMeta.version + 1 : 1;
    const nextMeta = {
      version: nextVersion,
      snapshotId,
      snapshotPath,
      updatedAt: new Date().toISOString(),
      snapshotBytes: serialized.length,
      lists: snapshot.lists.length,
      notes: snapshot.notes.length,
    };

    await putJson(metaPath, nextMeta);

    return jsonResponse({ ok: true, meta: nextMeta });
  } catch (error) {
    return serverError(error.message || 'Failed to push cloud snapshot.');
  }
}
