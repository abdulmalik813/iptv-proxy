from pathlib import Path

path = Path("tests/go-core-foundation.test.mjs")
text = path.read_text()
replacements = {
    r"assert.match(cache, /m\.refillMissing\(spec\)/);": r"assert.match(cache, /m\.refillMissing\(activeSpec\)/);",
    r"  assert.match(cache, /RefreshNow/);\n": r"  assert.doesNotMatch(cache, /RefreshNow/);\n",
}
for old, new in replacements.items():
    if old not in text:
        raise RuntimeError(f"cache source contract pattern not found: {old}")
    text = text.replace(old, new, 1)
path.write_text(text)
