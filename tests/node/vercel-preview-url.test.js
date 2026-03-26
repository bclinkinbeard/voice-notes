import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildAutomationBypassUrl,
  parseDotenv,
} from '../../scripts/vercel-preview-url.mjs';

test('parseDotenv ignores comments and parses quoted values', () => {
  const parsed = parseDotenv(`
# comment
FOO=bar
BAR="baz"
BAZ='qux'
`);

  assert.deepEqual(parsed, {
    FOO: 'bar',
    BAR: 'baz',
    BAZ: 'qux',
  });
});

test('buildAutomationBypassUrl appends vercel automation params', () => {
  const output = buildAutomationBypassUrl(
    'https://example.vercel.app/path?foo=bar',
    'secret123'
  );
  const url = new URL(output);

  assert.equal(url.origin, 'https://example.vercel.app');
  assert.equal(url.pathname, '/path');
  assert.equal(url.searchParams.get('foo'), 'bar');
  assert.equal(url.searchParams.get('x-vercel-protection-bypass'), 'secret123');
  assert.equal(url.searchParams.get('x-vercel-set-bypass-cookie'), 'true');
});

test('buildAutomationBypassUrl throws when secret is missing', () => {
  assert.throws(
    () => buildAutomationBypassUrl('https://example.vercel.app', ''),
    /Missing VERCEL_AUTOMATION_BYPASS_SECRET/
  );
});
