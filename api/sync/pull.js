import { jsonResponse, serverError } from '../../server/json.js';
import { requireSyncNamespace } from '../../server/sync-key.js';
import { buildMetaPath, getJson } from '../../server/storage.js';

export async function GET(request) {
  try {
    const { namespace, response } = requireSyncNamespace(request);
    if (response) return response;

    const metaPath = buildMetaPath(namespace);
    const meta = await getJson(metaPath);

    if (!meta || !meta.snapshotPath) {
      return jsonResponse({ ok: true, hasSnapshot: false, snapshot: null, meta: null });
    }

    const snapshot = await getJson(meta.snapshotPath);
    if (!snapshot) {
      return jsonResponse({ ok: true, hasSnapshot: false, snapshot: null, meta: null });
    }

    return jsonResponse({
      ok: true,
      hasSnapshot: true,
      snapshot,
      meta,
    });
  } catch (error) {
    return serverError(error.message || 'Failed to pull cloud snapshot.');
  }
}
