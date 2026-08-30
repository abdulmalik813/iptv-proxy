import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), 'utf8');
}

test('providers page no longer includes the route resolution simulator', async () => {
  const page = await source('app/providers/page.tsx');
  assert.doesNotMatch(page, /Route Resolution Simulator/);
  assert.doesNotMatch(page, /handleTestRoute/);
  assert.doesNotMatch(page, /testPath/);
});

test('provider test UI parses JSON safely and shows non-JSON diagnostics as text', async () => {
  const page = await source('app/providers/tests/page.tsx');
  assert.match(page, /await response\.text\(\)/);
  assert.match(page, /JSON\.parse\(raw\)/);
  assert.match(page, /Raw Response Body/);
  assert.match(page, /Response Headers/);
  assert.match(page, /Final URL/);
  assert.doesNotMatch(page, /await response\.json\(\)/);
  assert.doesNotMatch(page, /dangerouslySetInnerHTML/);
  assert.doesNotMatch(page, /<iframe/);
});

test('provider account test returns useful upstream diagnostics without exposing credentials', async () => {
  const route = await source('app/api/providers/[id]/test/route.ts');
  assert.match(route, /upstreamStatusText/);
  assert.match(route, /responseHeaders/);
  assert.match(route, /finalUrl/);
  assert.match(route, /redactUrl/);
  assert.match(route, /searchParams\.set\('password', '\[redacted\]'\)/);
  assert.doesNotMatch(route, /set-cookie/i);
});
