from pathlib import Path

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
