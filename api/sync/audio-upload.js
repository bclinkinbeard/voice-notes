import { badRequest, jsonResponse, serverError } from '../../server/json.js';
import { requireSyncNamespace } from '../../server/sync-key.js';
import { normalizeAudioHash } from '../../sync-snapshot.js';
import { binaryExists, buildAudioPath, putBinary } from '../../server/storage.js';

const MAX_AUDIO_BYTES = 20 * 1024 * 1024;

export async function POST(request) {
  try {
    const { namespace, response } = requireSyncNamespace(request);
    if (response) return response;

    const url = new URL(request.url);
    const hash = normalizeAudioHash(url.searchParams.get('hash'));
    if (!hash) {
      return badRequest('Missing or invalid audio hash.');
    }

    const pathname = buildAudioPath(namespace, hash);
    if (await binaryExists(pathname)) {
      return jsonResponse({ ok: true, uploaded: false, exists: true });
    }

    const audioBuffer = await request.arrayBuffer();
    if (!audioBuffer || audioBuffer.byteLength === 0) {
      return badRequest('Audio upload body is empty.');
    }
    if (audioBuffer.byteLength > MAX_AUDIO_BYTES) {
      return badRequest(`Audio file too large (${audioBuffer.byteLength} bytes).`);
    }

    const contentType = request.headers.get('content-type') || 'application/octet-stream';
    await putBinary(pathname, audioBuffer, contentType);

    return jsonResponse({ ok: true, uploaded: true, exists: false });
  } catch (error) {
    return serverError(error.message || 'Failed to upload audio.');
  }
}
