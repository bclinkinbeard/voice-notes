import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

function emptyState() {
  return {
    vaults: {}
  };
}

export function createFileRelayBackend(filePath) {
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
    state = {
      vaults: Object.fromEntries(Object.entries((state && state.vaults) || {}).map(([vaultId, vault]) => [vaultId, {
        readKey: String(vault?.readKey || ''),
        writeKey: String(vault?.writeKey || ''),
        createdAt: String(vault?.createdAt || ''),
        events: Object.fromEntries(Object.entries(vault?.events || {}).map(([eventId, entry]) => [eventId, entry?.record || entry]).filter(([, value]) => value)),
        artifacts: Object.fromEntries(Object.entries(vault?.artifacts || {}).map(([artifactId, entry]) => [artifactId, entry?.record || entry]).filter(([, value]) => value))
      }]))
    };
    loaded = true;
  }

  async function persist() {
    persistChain = persistChain.then(async () => {
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, JSON.stringify(state, null, 2));
    });
    return persistChain;
  }

  function getVault(vaultId) {
    return state.vaults[vaultId] || null;
  }

  return {
    async getVaultMeta(vaultId) {
      await ensureLoaded();
      const vault = getVault(vaultId);
      return vault ? {
        readKey: vault.readKey,
        writeKey: vault.writeKey,
        createdAt: vault.createdAt || ''
      } : null;
    },

    async createVault(vaultId, meta) {
      await ensureLoaded();
      state.vaults[vaultId] = {
        readKey: meta.readKey,
        writeKey: meta.writeKey,
        createdAt: meta.createdAt || '',
        events: {},
        artifacts: {}
      };
      await persist();
    },

    async listRecords(vaultId, collectionName) {
      await ensureLoaded();
      const vault = getVault(vaultId);
      return Object.values(vault?.[collectionName] || {});
    },

    async putRecord(vaultId, collectionName, recordId, record) {
      await ensureLoaded();
      const vault = getVault(vaultId);
      vault[collectionName][recordId] = record;
      await persist();
    }
  };
}
