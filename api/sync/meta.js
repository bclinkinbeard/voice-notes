import { jsonResponse, serverError } from '../../server/json.js';
import { requireSyncNamespace } from '../../server/sync-key.js';
import { buildMetaPath, getJson } from '../../server/storage.js';

export async function GET(request) {
  try {
    const { namespace, response } = requireSyncNamespace(request);
    if (response) return response;

    const metaPath = buildMetaPath(namespace);
    const meta = await getJson(metaPath);

    return jsonResponse({
      ok: true,
      hasSnapshot: Boolean(meta && meta.snapshotPath),
      meta: meta || null,
    });
  } catch (error) {
    return serverError(error.message || 'Failed to fetch sync metadata.');
  }
}
