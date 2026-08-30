package proxy

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"

	"github.com/abdulmalik813/iptv-proxy/internal/provider"
)

func TestReplaceM3ULogoAttributePreservesLine(t *testing.T) {
	line := []byte(`#EXTINF:-1 tvg-id="abc" tvg-logo="https://provider.test/images/logo.png" group-title="News",Channel`)
	rewrites := map[string]string{
		"https://provider.test/images/logo.png": "https://proxy.test/p/_artwork/token",
	}
	got := replaceArtworkAttributeValues(line, m3uLogoDouble, rewrites)
	text := string(got)
	if !strings.Contains(text, `tvg-logo="https://proxy.test/p/_artwork/token"`) {
		t.Fatalf("logo was not rewritten: %s", text)
	}
	if !strings.Contains(text, `group-title="News",Channel`) {
		t.Fatalf("unrelated EXTINF data changed: %s", text)
	}
}

func TestReplaceXMLTVIconOnlyTouchesIconSrc(t *testing.T) {
	body := []byte(`<tv><channel id="a"><icon src="https://provider.test/logo.png"/><display-name>One</display-name></channel><programme channel="a"><icon src='https://provider.test/show.jpg'/></programme></tv>`)
	rewrites := map[string]string{
		"https://provider.test/logo.png": "https://proxy.test/p/_artwork/channel",
		"https://provider.test/show.jpg":  "https://proxy.test/p/_artwork/show",
	}
	got := xmlIconTag.ReplaceAllFunc(body, func(tag []byte) []byte {
		tag = replaceArtworkAttributeValues(tag, xmlSrcDouble, rewrites)
		tag = replaceArtworkAttributeValues(tag, xmlSrcSingle, rewrites)
		return tag
	})
	text := string(got)
	if !strings.Contains(text, `src="https://proxy.test/p/_artwork/channel"`) || !strings.Contains(text, `src='https://proxy.test/p/_artwork/show'`) {
		t.Fatalf("XMLTV artwork not rewritten: %s", text)
	}
}

func TestJSONArtworkRewritePreservesNumbers(t *testing.T) {
	body := []byte(`[{"stream_id":1234567890123456789,"stream_icon":"https://provider.test/live.png","nested":{"backdrop_path":["https://provider.test/a.jpg"]}}]`)
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		t.Fatal(err)
	}
	rewrites := map[string]string{
		"https://provider.test/live.png": "https://proxy.test/p/_artwork/live",
		"https://provider.test/a.jpg":    "https://proxy.test/p/_artwork/a",
	}
	replaceJSONArtwork(value, "", rewrites)
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	text := string(encoded)
	if !strings.Contains(text, `"stream_id":1234567890123456789`) {
		t.Fatalf("numeric ID changed during JSON rewrite: %s", text)
	}
	if !strings.Contains(text, `"stream_icon":"https://proxy.test/p/_artwork/live"`) || !strings.Contains(text, `"backdrop_path":["https://proxy.test/p/_artwork/a"]`) {
		t.Fatalf("JSON artwork not rewritten: %s", text)
	}
}

func TestResolveArtworkTargetSupportsProviderRelativeURLs(t *testing.T) {
	p := provider.Provider{Host: "https://provider.test/panel"}
	target, ok := resolveArtworkTarget(p, "/images/logo.png?x=1&amp;y=2")
	if !ok {
		t.Fatal("relative provider artwork was not resolved")
	}
	if target.String() != "https://provider.test/images/logo.png?x=1&y=2" {
		t.Fatalf("target=%q", target.String())
	}
}

func TestLooksLikeArtworkURLAcceptsRelativePaths(t *testing.T) {
	if !looksLikeArtworkURL("images/channels/logo.png") {
		t.Fatal("relative artwork path should be proxied")
	}
}
