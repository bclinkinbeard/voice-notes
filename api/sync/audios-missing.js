import { badRequest, jsonResponse, readJson, serverError } from '../../server/json.js';
import { requireSyncNamespace } from '../../server/sync-key.js';
import { normalizeAudioHash } from '../../sync-snapshot.js';
import { binaryExists, buildAudioPath } from '../../server/storage.js';

export async function POST(request) {
  try {
    const { namespace, response } = requireSyncNamespace(request);
    if (response) return response;

    const body = await readJson(request);
    const hashes = Array.isArray(body?.hashes) ? body.hashes.map((hash) => normalizeAudioHash(hash)).filter(Boolean) : [];
    if (hashes.length === 0) {
      return badRequest('Request body must include a hashes array.');
    }

    const uniqueHashes = [...new Set(hashes)];
    const checks = await Promise.all(
      uniqueHashes.map(async (hash) => ({
        hash,
        exists: await binaryExists(buildAudioPath(namespace, hash)),
      }))
    );

    return jsonResponse({
      ok: true,
      missing: checks.filter((entry) => !entry.exists).map((entry) => entry.hash),
    });
  } catch (error) {
    return serverError(error.message || 'Failed to check cloud audio files.');
  }
}
