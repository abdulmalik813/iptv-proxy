import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), 'utf8');
}

test('providers page stays focused on provider management', async () => {
  const page = await source('app/providers/page.tsx');
  assert.doesNotMatch(page, /Route Resolution Simulator/);
  assert.doesNotMatch(page, /handleTestRoute/);
  assert.doesNotMatch(page, /testPath/);
  assert.match(page, /AppShell/);
  assert.match(page, /Dialog/);
  assert.match(page, /Table/);
});

test('provider test UI uses the shared safe JSON reader and shows only HTTP status for non-JSON responses', async () => {
  const page = await source('app/providers/tests/page.tsx');
  const api = await source('lib/client/api.ts');

  assert.match(page, /readJson/);
  assert.match(page, /Non-JSON responses are shown as HTTP status only/);
  assert.match(page, /state\.data\?\.upstreamStatus/);
  assert.match(api, /await response\.text\(\)/);
  assert.match(api, /JSON\.parse\(raw\)/);
  assert.doesNotMatch(page, /Raw Response Body/);
  assert.doesNotMatch(page, /Response Headers/);
  assert.doesNotMatch(page, /Final URL/);
  assert.doesNotMatch(page, /dangerouslySetInnerHTML/);
  assert.doesNotMatch(page, /<iframe/);
});

test('provider account test captures upstream diagnostics without exposing credentials', async () => {
  const route = await source('app/api/providers/[id]/test/route.ts');
  assert.match(route, /upstreamStatusText/);
  assert.match(route, /responseHeaders/);
  assert.match(route, /finalUrl/);
  assert.match(route, /redactUrl/);
  assert.match(route, /searchParams\.set\('password', '\[redacted\]'\)/);
  assert.doesNotMatch(route, /set-cookie/i);
});
