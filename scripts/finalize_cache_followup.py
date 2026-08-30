from pathlib import Path

path = Path("tests/go-core-foundation.test.mjs")
text = path.read_text()
old = r"assert.match(cache, /m\.refillMissing\(spec\)/);"
new = r"assert.match(cache, /m\.refillMissing\(activeSpec\)/);"
if old not in text:
    raise RuntimeError("cold-fill source contract pattern not found")
path.write_text(text.replace(old, new, 1))
