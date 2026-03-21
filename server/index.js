import http from 'node:http';
import { join } from 'node:path';

import { createRelayRequestHandler } from './relay-routes.js';
import { createRelayStore } from './relay-store.js';

function defaultStoreFile() {
  return join(process.cwd(), 'server', '.relay-store.json');
}

export function createRelayServer(options = {}) {
  const store = createRelayStore(options.filePath || defaultStoreFile());
  return http.createServer(createRelayRequestHandler(store));
}

export async function startRelayServer(options = {}) {
  const server = options.server || createRelayServer(options);
  const host = options.host || '127.0.0.1';
  const port = options.port === undefined ? Number(process.env.PORT || 8787) : options.port;

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  return server;
}

if (import.meta.url === new URL(process.argv[1], 'file://').href) {
  const server = await startRelayServer();
  const address = server.address();
  const location = typeof address === 'object' && address
    ? `http://${address.address}:${address.port}`
    : 'relay';
  console.log(`Relay listening at ${location}`);
}
