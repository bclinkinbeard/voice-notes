import { badRequest, serverError } from '../../server/json.js';
import { requireSyncNamespace } from '../../server/sync-key.js';
import { normalizeAudioHash } from '../../sync-snapshot.js';
import { buildAudioPath, getBinary } from '../../server/storage.js';

export async function GET(request) {
  try {
    const { namespace, response } = requireSyncNamespace(request);
    if (response) return response;

    const url = new URL(request.url);
    const hash = normalizeAudioHash(url.searchParams.get('hash'));
    if (!hash) {
      return badRequest('Missing or invalid audio hash.');
    }

    const file = await getBinary(buildAudioPath(namespace, hash));
    if (!file) {
      return new Response('Not found', {
        status: 404,
        headers: { 'cache-control': 'no-store' },
      });
    }

    return new Response(file.stream, {
      status: 200,
      headers: {
        'content-type': file.contentType || 'application/octet-stream',
        'cache-control': 'no-store',
      },
    });
  } catch (error) {
    return serverError(error.message || 'Failed to fetch audio.');
  }
}
