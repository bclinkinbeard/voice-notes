import fs from 'node:fs';
import path from 'node:path';

function parseDotenv(text) {
  const env = {};

  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const eqIndex = line.indexOf('=');
    if (eqIndex === -1) continue;

    const key = line.slice(0, eqIndex).trim();
    let value = line.slice(eqIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith('\'') && value.endsWith('\''))
    ) {
      value = value.slice(1, -1);
    }

    if (key) env[key] = value;
  }

  return env;
}

function loadLocalEnv(cwd = process.cwd()) {
  const envPath = path.join(cwd, '.env.local');
  if (!fs.existsSync(envPath)) return {};
  return parseDotenv(fs.readFileSync(envPath, 'utf8'));
}

function getAutomationBypassSecret(env = process.env, cwd = process.cwd()) {
  const localEnv = loadLocalEnv(cwd);
  return (
    String(env.VERCEL_AUTOMATION_BYPASS_SECRET || '').trim() ||
    String(localEnv.VERCEL_AUTOMATION_BYPASS_SECRET || '').trim()
  );
}

function buildAutomationBypassUrl(inputUrl, secret) {
  const normalizedSecret = String(secret || '').trim();
  if (!normalizedSecret) {
    throw new Error('Missing VERCEL_AUTOMATION_BYPASS_SECRET.');
  }

  const url = new URL(inputUrl);
  url.searchParams.set('x-vercel-protection-bypass', normalizedSecret);
  url.searchParams.set('x-vercel-set-bypass-cookie', 'true');
  return url.toString();
}

function main() {
  const inputUrl = process.argv[2];
  if (!inputUrl) {
    console.error('Usage: node scripts/vercel-preview-url.mjs <url>');
    process.exit(1);
  }

  const secret = getAutomationBypassSecret();
  const outputUrl = buildAutomationBypassUrl(inputUrl, secret);
  process.stdout.write(outputUrl + '\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (error) {
    console.error(error.message || 'Failed to build preview URL.');
    process.exit(1);
  }
}

export {
  buildAutomationBypassUrl,
  getAutomationBypassSecret,
  loadLocalEnv,
  parseDotenv,
};
