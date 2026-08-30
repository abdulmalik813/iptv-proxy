from pathlib import Path

# Source contracts must match the reviewed fail-closed cache implementation.
path = Path("tests/go-core-foundation.test.mjs")
text = path.read_text()
old_refill = r"assert.match(cache, /m\.refillMissing\(spec\)/);"
new_refill = r"assert.match(cache, /m\.refillMissing\(activeSpec\)/);"
if old_refill in text:
    text = text.replace(old_refill, new_refill, 1)
elif new_refill not in text:
    raise RuntimeError("cold-fill source contract is missing")
old_refresh = "  assert.match(cache, /RefreshNow/);\n"
new_refresh = "  assert.doesNotMatch(cache, /RefreshNow/);\n"
if old_refresh in text:
    text = text.replace(old_refresh, new_refresh, 1)
elif new_refresh not in text:
    raise RuntimeError("manual refresh source contract is missing")
path.write_text(text)

# Manual Refresh and Purge had the same safe replacement semantics. Tests use
# the single remaining manual operation, Purge, while automatic refresh remains
# timer-driven inside the cache manager.
manager_test_path = Path("internal/cache/manager_test.go")
manager_test = manager_test_path.read_text().replace(
    "manager.RefreshNow(context.Background(), spec.normalized().Key)",
    "manager.Purge(context.Background(), spec.normalized().Key)",
)
manager_test_path.write_text(manager_test)

# M3U rewriting must not inherit a removed metadata-size ceiling. The playlist
# body has already been fetched into memory, so split the body directly rather
# than imposing a bufio.Scanner maximum token size.
m3u_path = Path("internal/proxy/m3u.go")
m3u = m3u_path.read_text()
m3u = m3u.replace('\t"bufio"\n', '')
old = '''\tvar out strings.Builder\n\tscanner := bufio.NewScanner(bytes.NewReader(body))\n\tscanner.Buffer(make([]byte, 64*1024), maxMetadataBytes)\n\tfor scanner.Scan() {\n\t\tline := scanner.Text()\n\t\ttrimmed := strings.TrimSpace(line)\n\t\tif trimmed != "" && !strings.HasPrefix(trimmed, "#") {\n\t\t\tif rewritten, ok := h.rewriteM3UTarget(p, trimmed); ok {\n\t\t\t\tline = rewritten\n\t\t\t}\n\t\t}\n\t\tout.WriteString(line)\n\t\tout.WriteByte('\\n')\n\t}\n\tif scanner.Err() != nil {\n\t\treturn body\n\t}\n\treturn []byte(out.String())\n'''
new = '''\tlines := bytes.Split(body, []byte("\\n"))\n\tfor i, rawLine := range lines {\n\t\tline := string(rawLine)\n\t\ttrimmed := strings.TrimSpace(line)\n\t\tif trimmed != "" && !strings.HasPrefix(trimmed, "#") {\n\t\t\tif rewritten, ok := h.rewriteM3UTarget(p, trimmed); ok {\n\t\t\t\tline = rewritten\n\t\t\t}\n\t\t}\n\t\tlines[i] = []byte(line)\n\t}\n\treturn bytes.Join(lines, []byte("\\n"))\n'''
if old in m3u:
    m3u = m3u.replace(old, new, 1)
elif "maxMetadataBytes" in m3u or "bufio.NewScanner" in m3u:
    raise RuntimeError("M3U scanner block changed unexpectedly")
m3u_path.write_text(m3u)
