import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), 'utf8');
}

const protectedPages = [
  'app/dashboard/page.tsx',
  'app/providers/page.tsx',
  'app/providers/tests/page.tsx',
  'app/cache/page.tsx',
  'app/vpn/page.tsx',
  'app/logs/page.tsx',
  'app/settings/page.tsx',
];

test('UI is configured as a ShadCN source-component project', async () => {
  const config = JSON.parse(await source('components.json'));
  assert.equal(config.style, 'new-york');
  assert.equal(config.tsx, true);
  assert.equal(config.tailwind.css, 'app/globals.css');
  assert.equal(config.tailwind.cssVariables, true);
  assert.equal(config.aliases.ui, '@/components/ui');

  for (const component of ['button', 'card', 'input', 'dialog', 'table', 'tabs', 'alert', 'badge']) {
    assert.ok((await source(`components/ui/${component}.tsx`)).length > 0, `${component} primitive should exist`);
  }
});

test('every protected UI page uses the shared production application shell', async () => {
  for (const path of protectedPages) {
    const page = await source(path);
    assert.match(page, /AppShell/, `${path} should use AppShell`);
    assert.doesNotMatch(page, /<Sidebar/, `${path} should not duplicate the sidebar`);
    assert.doesNotMatch(page, /<TopBar/, `${path} should not duplicate the top bar`);
    assert.doesNotMatch(page, /setMobileOpen/, `${path} should not own shell mobile state`);
    assert.doesNotMatch(page, /font-mono text-neutral/, `${path} should not use the legacy terminal UI shell`);
  }
});

test('production UI uses explicit base-path-aware API routing with no global browser monkey patch', async () => {
  const layout = await source('app/layout.tsx');
  const api = await source('lib/client/api.ts');

  assert.doesNotMatch(layout, /UiRouteBridge/);
  assert.match(api, /NEXT_PUBLIC_UI_BASE_PATH/);
  assert.match(api, /export function apiPath/);

  for (const path of protectedPages.concat('app/login/page.tsx')) {
    const page = await source(path);
    if (/fetch\(/.test(page) || /EventSource\(/.test(page)) {
      assert.match(page, /apiPath/);
    }
    assert.doesNotMatch(page, /window\.fetch\s*=/);
    assert.doesNotMatch(page, /window\.EventSource\s*=/);
  }
});

test('global theme uses ShadCN semantic tokens instead of legacy selector overrides', async () => {
  const css = await source('app/globals.css');
  assert.match(css, /--background:/);
  assert.match(css, /--foreground:/);
  assert.match(css, /--card:/);
  assert.match(css, /--primary:/);
  assert.match(css, /--muted:/);
  assert.match(css, /--border:/);
  assert.match(css, /@theme inline/);
  assert.match(css, /\.dark \{/);
  assert.doesNotMatch(css, /data-theme='light'.*bg-black/s);
});

test('settings page contains operational settings only and no embedded developer architecture notes', async () => {
  const page = await source('app/settings/page.tsx');
  assert.match(page, /Log retention/);
  assert.match(page, /Storage/);
  assert.match(page, /Runtime/);
  assert.doesNotMatch(page, /Go IPTV Proxy \/ Core Engine Interface Reference/);
  assert.doesNotMatch(page, /Shared SQLite State/);
  assert.doesNotMatch(page, /zero IPC overhead/i);
  assert.doesNotMatch(page, /zero-allocation ring buffers/i);
});

test('CRUD-heavy pages use reusable dialogs instead of hand-rolled fixed modal markup', async () => {
  for (const path of ['app/providers/page.tsx', 'app/vpn/page.tsx', 'app/logs/page.tsx']) {
    const page = await source(path);
    assert.match(page, /DialogContent/);
    assert.doesNotMatch(page, /fixed inset-0 z-50 flex items-center justify-center bg-black\/80/);
  }
});

test('provider and VPN editor validation stays in the editor dialog', async () => {
  const providers = await source('app/providers/page.tsx');
  const vpn = await source('app/vpn/page.tsx');
  assert.match(providers, /formError/);
  assert.match(providers, /DialogContent[\s\S]*formError/);
  assert.match(vpn, /editorError/);
  assert.match(vpn, /DialogContent[\s\S]*editorError/);
});

test('login UI is concise and contains no internal implementation copy', async () => {
  const page = await source('app/login/page.tsx');
  assert.match(page, /Sign in/);
  assert.match(page, /Create administrator/);
  assert.doesNotMatch(page, /RESTRICTED ADMIN ACCESS/);
  assert.doesNotMatch(page, /SQLITE \/ DOCKER WAL/);
  assert.doesNotMatch(page, /INITIALIZING SECURE SESSION/);
});
