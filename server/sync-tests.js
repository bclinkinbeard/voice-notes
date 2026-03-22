import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createFileSyncBackend } from './sync-file-backend.js';
import { startSyncServer } from './index.js';
import { runSyncBehaviorSuite } from './sync-test-suite.js';

async function withSync(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'voice-notes-sync-file-'));
  const filePath = join(dir, 'sync-store.json');
  const server = await startSyncServer({
    port: 0,
    backend: createFileSyncBackend(filePath)
  });
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    await fn(baseUrl);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
    await rm(dir, { recursive: true, force: true });
  }
}

const counts = await runSyncBehaviorSuite('File backend', withSync);

console.log('\n========================================');
console.log(`${counts.passed}/${counts.total} file backend server tests passed`);
console.log('========================================');
