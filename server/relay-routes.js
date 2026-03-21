import { RelayStoreError } from './relay-store.js';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Vault-Read-Key, X-Vault-Write-Key',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
};

function writeJson(res, status, payload) {
  res.writeHead(status, {
    ...CORS_HEADERS,
    'Content-Type': 'application/json'
  });
  res.end(JSON.stringify(payload));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(new RelayStoreError(400, 'Request body must be valid JSON.'));
      }
    });
    req.on('error', reject);
  });
}

function matchVaultRoute(pathname) {
  const match = pathname.match(/^\/v1\/vaults\/([^/]+)\/(events|artifacts)$/);
  if (!match) return null;
  return {
    vaultId: decodeURIComponent(match[1]),
    resource: match[2]
  };
}

function authFromRequest(req) {
  return {
    readKey: String(req.headers['x-vault-read-key'] || ''),
    writeKey: String(req.headers['x-vault-write-key'] || '')
  };
}

export function createRelayRequestHandler(store) {
  return async function relayRequestHandler(req, res) {
    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, CORS_HEADERS);
        res.end();
        return;
      }

      const url = new URL(req.url, 'http://127.0.0.1');
      const route = matchVaultRoute(url.pathname);
      if (!route) {
        writeJson(res, 404, { error: 'Not found.' });
        return;
      }

      const auth = authFromRequest(req);

      if (req.method === 'POST' && route.resource === 'events') {
        const payload = await readJson(req);
        const result = await store.upsertEvents(route.vaultId, auth, payload.events || []);
        writeJson(res, 200, result);
        return;
      }

      if (req.method === 'GET' && route.resource === 'events') {
        const result = await store.readEvents(route.vaultId, auth, url.searchParams.get('since') || '');
        writeJson(res, 200, {
          cursor: result.cursor,
          events: result.records
        });
        return;
      }

      if (req.method === 'POST' && route.resource === 'artifacts') {
        const payload = await readJson(req);
        const result = await store.upsertArtifacts(route.vaultId, auth, payload.artifacts || []);
        writeJson(res, 200, result);
        return;
      }

      if (req.method === 'GET' && route.resource === 'artifacts') {
        const result = await store.readArtifacts(route.vaultId, auth, url.searchParams.get('since') || '');
        writeJson(res, 200, {
          cursor: result.cursor,
          artifacts: result.records
        });
        return;
      }

      writeJson(res, 405, { error: 'Method not allowed.' });
    } catch (error) {
      if (error instanceof RelayStoreError) {
        writeJson(res, error.status, { error: error.message });
        return;
      }

      writeJson(res, 500, { error: error.message || 'Unexpected relay error.' });
    }
  };
}
