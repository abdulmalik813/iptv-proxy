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

test('provider test UI displays raw HTML or text instead of throwing JSON parse errors', async () => {
  const page = await source('app/providers/tests/page.tsx');
  assert.match(page, /await response\.text\(\)/);
  assert.match(page, /JSON\.parse\(raw\)/);
  assert.match(page, /Raw Response/);
  assert.doesNotMatch(page, /await response\.json\(\)/);
});
