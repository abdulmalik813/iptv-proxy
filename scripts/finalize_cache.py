from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    if old not in text:
        raise RuntimeError(f"{label}: expected source pattern was not found")
    return text.replace(old, new, 1)


# ---- cache manager: immutable staged generations + atomic pointer swap ----
manager_path = Path("internal/cache/manager.go")
manager = manager_path.read_text()

if "stagingGenerationTTL" not in manager:
    manager = replace_once(
        manager,
        "\tlockTTL           = 12 * time.Minute\n)",
        "\tlockTTL                 = 12 * time.Minute\n\tstagingGenerationTTL      = 2 * time.Hour\n\tretiredGenerationGrace    = 30 * time.Minute\n)",
        "cache constants",
    )

if "publishGenerationScript" not in manager:
    marker = "\treleaseLockScript             = redis.NewScript(`if redis.call(\"GET\", KEYS[1]) == ARGV[1] then return redis.call(\"DEL\", KEYS[1]) else return 0 end`)\n"
    replacement = marker + '''\tpublishGenerationScript         = redis.NewScript(`\nfor i = 2, #KEYS do\n  if redis.call("EXISTS", KEYS[i]) == 0 then\n    return redis.error_reply("missing staged cache chunk")\n  end\nend\nfor i = 2, #KEYS do\n  redis.call("PERSIST", KEYS[i])\nend\nredis.call("HSET", KEYS[1],\n  "status", ARGV[1],\n  "content_type", ARGV[2],\n  "meta", ARGV[3],\n  "descriptor", ARGV[4],\n  "generation", ARGV[5],\n  "chunk_count", ARGV[6])\nredis.call("HDEL", KEYS[1], "body")\nreturn 1\n`)\n'''
    manager = replace_once(manager, marker, replacement, "publish script")

manager = manager.replace(
    'm.client.HStrLen(ctx, key, "body").Result()',
    'm.client.Do(ctx, "HSTRLEN", key, "body").Int64()',
)

# Manual Refresh and Purge had identical safe-repull semantics. Keep one manual
# operation (Purge) and leave automatic refresh as the scheduled lifecycle.
refresh_method = '''func (m *Manager) RefreshNow(ctx context.Context, key string) error {\n\treturn m.replaceNow(ctx, key, "refresh")\n}\n\n'''
manager = manager.replace(refresh_method, "")

old_publish = '''\t_, err = m.client.TxPipelined(ctx, func(pipe redis.Pipeliner) error {\n\t\tpipe.HSet(ctx, spec.Key, map[string]any{\n\t\t\t"status":       response.Status,\n\t\t\t"content_type": response.ContentType,\n\t\t\t"meta":         string(metaJSON),\n\t\t\t"descriptor":   string(descriptorJSON),\n\t\t\t"generation":   generation,\n\t\t\t"chunk_count":  chunkCount,\n\t\t})\n\t\tpipe.HDel(ctx, spec.Key, "body")\n\t\treturn nil\n\t})\n\tif err != nil {\n\t\treturn err\n\t}\n'''
new_publish = '''\tkeys := make([]string, 1, chunkCount+1)\n\tkeys[0] = spec.Key\n\tfor i := 0; i < chunkCount; i++ {\n\t\tkeys = append(keys, bodyKey(spec.Key, generation, i))\n\t}\n\tif _, err = publishGenerationScript.Run(\n\t\tctx,\n\t\tm.client,\n\t\tkeys,\n\t\tresponse.Status,\n\t\tresponse.ContentType,\n\t\tstring(metaJSON),\n\t\tstring(descriptorJSON),\n\t\tgeneration,\n\t\tchunkCount,\n\t).Result(); err != nil {\n\t\treturn err\n\t}\n'''
if old_publish in manager:
    manager = manager.replace(old_publish, new_publish, 1)
elif "publishGenerationScript.Run" not in manager:
    raise RuntimeError("atomic publication block was not found")

manager = manager.replace(
    'm.cleanupGeneration(context.Background(), spec.Key, oldManifest.Generation, oldManifest.ChunkCount)',
    'm.retireGeneration(context.Background(), spec.Key, oldManifest.Generation, oldManifest.ChunkCount)',
    1,
)

manager = manager.replace(
    'm.client.Set(ctx, bodyKey(key, generation, i), body[start:end], 0).Err()',
    'm.client.Set(ctx, bodyKey(key, generation, i), body[start:end], stagingGenerationTTL).Err()',
)

if "func (m *Manager) retireGeneration" not in manager:
    marker = "func (m *Manager) cleanupGeneration(ctx context.Context, key, generation string, chunkCount int) {"
    retire = '''func (m *Manager) retireGeneration(ctx context.Context, key, generation string, chunkCount int) {\n\tif generation == "" || chunkCount <= 0 {\n\t\treturn\n\t}\n\tfor i := 0; i < chunkCount; i++ {\n\t\t_ = m.client.Expire(ctx, bodyKey(key, generation, i), retiredGenerationGrace).Err()\n\t}\n}\n\n'''
    manager = replace_once(manager, marker, retire + marker, "retired generation helper")

manager_path.write_text(manager)


# ---- tests: vet-safe assertions + generation/lock/staging guarantees ----
direct_path = Path("internal/proxy/direct_test.go")
direct = direct_path.read_text()
direct = direct.replace('t.Fatalf("User-Agent=%q", got)', 't.Errorf("User-Agent=%q", got)')
direct = direct.replace('t.Fatalf("Accept=%q", got)', 't.Errorf("Accept=%q", got)')
direct_path.write_text(direct)

manager_test_path = Path("internal/cache/manager_test.go")
manager_test = manager_test_path.read_text()
manager_test = manager_test.replace(
    '''\t\t\t\t\tif scenario%2 == 0 {\n\t\t\t\t\t\terr = manager.RefreshNow(context.Background(), spec.normalized().Key)\n\t\t\t\t\t} else {\n\t\t\t\t\t\terr = manager.Purge(context.Background(), spec.normalized().Key)\n\t\t\t\t\t}\n''',
    '''\t\t\t\t\terr = manager.Purge(context.Background(), spec.normalized().Key)\n''',
)

if "TestPublishedGenerationSwitchKeepsPreviousGenerationDuringGrace" not in manager_test:
    manager_test += r'''

func TestPublishedGenerationSwitchKeepsPreviousGenerationDuringGrace(t *testing.T) {
	client := testRedis(t)
	manager := NewManager(client)
	defer stopManager(manager)
	ctx := context.Background()

	var version atomic.Int32
	version.Store(1)
	body1 := bytes.Repeat([]byte("old-cache-"), bodyChunkSize/10+2)
	body2 := bytes.Repeat([]byte("new-cache-"), bodyChunkSize/10+2)
	spec := testSpec("generation-swap", "get_vod_streams", "", func(context.Context) (Response, error) {
		if version.Load() == 1 {
			return Response{Status: 200, Body: body1, ItemCount: 1, ItemCountKnown: true}, nil
		}
		return Response{Status: 200, Body: body2, ItemCount: 1, ItemCountKnown: true}, nil
	})
	if err := manager.Warm(ctx, spec); err != nil {
		t.Fatal(err)
	}
	key := spec.normalized().Key
	oldManifest, found, err := manager.loadManifest(ctx, key)
	if err != nil || !found || oldManifest.Generation == "" {
		t.Fatalf("old generation unavailable: found=%v generation=%q err=%v", found, oldManifest.Generation, err)
	}
	oldChunk := bodyKey(key, oldManifest.Generation, 0)
	if ttl := client.TTL(ctx, oldChunk).Val(); ttl != -1 {
		t.Fatalf("active generation must be persistent, TTL=%v", ttl)
	}

	version.Store(2)
	if err := manager.Purge(ctx, key); err != nil {
		t.Fatal(err)
	}
	newManifest, found, err := manager.loadManifest(ctx, key)
	if err != nil || !found || newManifest.Generation == oldManifest.Generation {
		t.Fatalf("generation pointer did not switch: old=%q new=%q found=%v err=%v", oldManifest.Generation, newManifest.Generation, found, err)
	}
	response, hit, err := manager.GetOrFetch(ctx, spec)
	if err != nil || !hit || !bytes.Equal(response.Body, body2) {
		t.Fatalf("new generation is not active: hit=%v len=%d err=%v", hit, len(response.Body), err)
	}
	if exists := client.Exists(ctx, oldChunk).Val(); exists != 1 {
		t.Fatal("previous generation was deleted immediately after pointer switch")
	}
	if ttl := client.TTL(ctx, oldChunk).Val(); ttl <= 0 || ttl > retiredGenerationGrace {
		t.Fatalf("previous generation grace TTL=%v", ttl)
	}
}

func TestStagedGenerationExpiresUnlessPublished(t *testing.T) {
	client := testRedis(t)
	manager := NewManager(client)
	defer stopManager(manager)
	ctx := context.Background()
	key := testSpec("staging", "get_series", "", func(context.Context) (Response, error) { return Response{}, nil }).normalized().Key
	generation := newID()
	body := bytes.Repeat([]byte("staged"), bodyChunkSize/6+2)
	chunks, err := manager.writeGeneration(ctx, key, generation, body)
	if err != nil {
		t.Fatal(err)
	}
	if chunks < 1 {
		t.Fatal("expected staged chunks")
	}
	for i := 0; i < chunks; i++ {
		ttl := client.TTL(ctx, bodyKey(key, generation, i)).Val()
		if ttl <= 0 || ttl > stagingGenerationTTL {
			t.Fatalf("staged chunk %d has unsafe TTL %v", i, ttl)
		}
	}
}

func TestLockReleaseDoesNotDeleteAnotherOwnersLock(t *testing.T) {
	client := testRedis(t)
	manager := NewManager(client)
	defer stopManager(manager)
	ctx := context.Background()
	spec := testSpec("lock-owner", "get_live_streams", "", func(context.Context) (Response, error) {
		return Response{Status: 200, Body: []byte("ok")}, nil
	}).normalized()
	locked, err := manager.acquire(ctx, spec, "test", "owner-a")
	if err != nil || !locked {
		t.Fatalf("owner-a failed to acquire lock: locked=%v err=%v", locked, err)
	}
	if err := client.Set(ctx, lockKey(spec.Key), "owner-b", lockTTL).Err(); err != nil {
		t.Fatal(err)
	}
	manager.release(spec.Key, "owner-a")
	if owner := client.Get(ctx, lockKey(spec.Key)).Val(); owner != "owner-b" {
		t.Fatalf("stale owner removed a newer lock: owner=%q", owner)
	}
}
'''
manager_test_path.write_text(manager_test)


# ---- one manual safe-repull control in the admin UI ----
page_path = Path("app/cache/page.tsx")
page = page_path.read_text()
lines = page.splitlines()
lines = [line for line in lines if " const refreshEntry=async" not in line]
page = "\n".join(lines) + "\n"
refresh_button = '<button onClick={()=>void refreshEntry(entry.key)} disabled={busyKey===entry.key} className="border border-neutral-700 bg-black px-2.5 py-1.5 text-[10px] font-bold uppercase hover:border-white disabled:opacity-50">Refresh</button>'
page = page.replace(refresh_button, "")
page = page.replace('<th className="p-3 text-right">Actions</th>', '<th className="p-3 text-right">Action</th>')
page_path.write_text(page)


# ---- remove duplicate manual refresh HTTP API ----
main_path = Path("cmd/proxy/main.go")
main = main_path.read_text()
start = main.find('\tmux.HandleFunc("/internal/cache/refresh"')
if start != -1:
    end = main.find('\tmux.HandleFunc("/internal/cache/start"', start)
    if end == -1:
        raise RuntimeError("cache refresh endpoint end marker missing")
    main = main[:start] + main[end:]
main_path.write_text(main)

route_path = Path("app/api/system/cache/route.ts")
route = route_path.read_text()
old_post = '''  const key = new URL(req.url).searchParams.get('key')?.trim();\n  const target = key\n    ? `http://127.0.0.1:8080/internal/cache/refresh?key=${encodeURIComponent(key)}`\n    : 'http://127.0.0.1:8080/internal/cache/start';\n'''
route = route.replace(old_post, "  const target = 'http://127.0.0.1:8080/internal/cache/start';\n")
route_path.write_text(route)


# ---- source contracts reflect the final architecture ----
contract_path = Path("tests/go-core-foundation.test.mjs")
contract = contract_path.read_text()
contract = contract.replace('assert.match(cache, /HStrLen/);', 'assert.match(cache, /HSTRLEN/);')
old_contract = '''test('refresh purge and start pull use safe generation publication', async () => {\n  const cache = compact(await source('internal/cache/manager.go'));\n  const page = await source('app/cache/page.tsx');\n  assert.match(cache, /func \\(m \\*Manager\\) Purge\\(/);\n  assert.match(cache, /return m\\.replaceNow\\(ctx, key, "purge"\\)/);\n  assert.match(cache, /func \\(m \\*Manager\\) RefreshNow/);\n  assert.match(cache, /return m\\.replaceNow\\(ctx, key, "refresh"\\)/);\n  assert.match(cache, /writeGeneration/);\n  assert.match(cache, /TxPipelined/);\n  assert.match(cache, /cleanupGeneration/);\n  assert.match(page, /previous generation stayed active until the swap/);\n});\n'''
new_contract = '''test('automatic refresh purge and start pull use immutable zero-downtime generations', async () => {\n  const cache = compact(await source('internal/cache/manager.go'));\n  const page = await source('app/cache/page.tsx');\n  assert.match(cache, /func \\(m \\*Manager\\) Purge\\(/);\n  assert.match(cache, /return m\\.replaceNow\\(ctx, key, "purge"\\)/);\n  assert.match(cache, /replaceWithSpec\\(ctx, spec, "refresh"\\)/);\n  assert.match(cache, /stagingGenerationTTL/);\n  assert.match(cache, /retiredGenerationGrace/);\n  assert.match(cache, /publishGenerationScript/);\n  assert.match(cache, /PERSIST/);\n  assert.match(cache, /retireGeneration/);\n  assert.doesNotMatch(cache, /func \\(m \\*Manager\\) RefreshNow/);\n  assert.match(page, /previous generation stayed active until the swap/);\n});\n'''
if old_contract in contract:
    contract = contract.replace(old_contract, new_contract, 1)
else:
    raise RuntimeError("cache publication source contract changed unexpectedly")
contract_path.write_text(contract)


# ---- restore strict production CI with real Redis integration tests ----
Path(".github/workflows/test.yml").write_text('''name: Test

on:
  push:
    branches:
      - main
  pull_request:
  workflow_dispatch:

permissions:
  contents: read

concurrency:
  group: test-${{ github.ref }}
  cancel-in-progress: true

jobs:
  test:
    name: Production checks
    runs-on: ubuntu-latest
    env:
      UI_URL: https://iptv.example.test/ui
      APP_URL: https://iptv.example.test
      SESSION_SECRET: ci-session-secret-not-for-production
      INTERNAL_API_TOKEN: ci-internal-api-token-not-for-production
    services:
      redis:
        image: redis:8-alpine
        ports:
          - 6379:6379
        options: >-
          --health-cmd "redis-cli ping"
          --health-interval 2s
          --health-timeout 2s
          --health-retries 20
    steps:
      - name: Checkout
        uses: actions/checkout@v4
      - name: Set up pnpm
        uses: pnpm/action-setup@v4
        with:
          version: 11.24.0
          run_install: false
      - name: Set up Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 22
      - name: Set up Go
        uses: actions/setup-go@v6
        with:
          go-version: 1.27.x
          cache: true
      - name: Install dependencies
        run: pnpm install --no-frozen-lockfile
      - name: Regression contracts
        run: pnpm test
      - name: Go formatting
        run: test -z "$(gofmt -l .)"
      - name: Go vet
        run: go vet ./...
      - name: Go tests
        run: go test ./... -count=1
      - name: Go build
        run: go build ./cmd/proxy
      - name: Lint
        run: pnpm lint
      - name: Typecheck
        run: pnpm typecheck
      - name: Production Next.js build
        run: pnpm build
      - name: Validate local Compose
        run: docker compose -f docker-compose.yml config >/dev/null
      - name: Validate Dokploy Compose
        run: docker compose -f docker-compose.dokploy.yml config >/dev/null
''')


doc_path = Path("docs/cache-design-review.md")
doc = doc_path.read_text()
final_rule = '''\n## Final zero-downtime generation rule\n\nActive cache bodies are immutable generations. A replacement is written to staged chunk keys with a temporary TTL, validated, and then a Redis script atomically persists the new chunks and switches the stable manifest pointer. Failed or crashed staging pulls never move the pointer and their chunks expire automatically. The previous active generation receives a 30-minute grace TTL after the pointer switch so readers that resolved it before the swap can finish. Manual Purge, Start Pull, cold-fill, and automatic refresh all use this same publication engine.\n'''
if "## Final zero-downtime generation rule" not in doc:
    doc += final_rule
doc_path.write_text(doc)
