import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

function emptyState() {
  return {
    vaults: {}
  };
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

export function createFileSyncBackend(filePath) {
  if (!filePath) {
    throw new Error('File sync backend requires a file path.');
  }

  let loaded = false;
  let state = emptyState();
  let persistChain = Promise.resolve();

  async function ensureLoaded() {
    if (loaded) return;
    try {
      state = JSON.parse(await readFile(filePath, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      state = emptyState();
    }

    if (!state || typeof state !== 'object' || typeof state.vaults !== 'object') {
      state = emptyState();
    }

    loaded = true;
  }

  async function persist() {
    persistChain = persistChain.then(async () => {
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, JSON.stringify(state, null, 2));
    });
    return persistChain;
  }

  return {
    async loadVault(vaultId) {
      await ensureLoaded();
      return clone(state.vaults[vaultId] || null);
    },

    async saveVault(vaultId, vault) {
      await ensureLoaded();
      state.vaults[vaultId] = clone(vault);
      await persist();
    }
  };
}
