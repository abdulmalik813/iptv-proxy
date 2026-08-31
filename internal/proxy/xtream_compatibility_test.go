package proxy

import (
	"net/http"
	"net/url"
	"strings"
	"testing"

	"github.com/abdulmalik813/iptv-proxy/internal/provider"
	"github.com/abdulmalik813/iptv-proxy/internal/routing"
)

const proxyKnownPasswordHash = "pbkdf2_sha256$210000$dGVzdC1zYWx0LTEyMzQ1Ng$Hupa5cSZRN9sT9l6L6yAEhEJJGpbXBP-m5ez_0-UY7w"

func xtreamTestProvider() provider.Provider {
	return provider.Provider{
		ID:               "provider-1",
		Name:             "Test Provider",
		Host:             "http://provider.test/base",
		Route:            "trex",
		UpstreamUsername: "UPSTREAM",
		UpstreamPassword: "UPSTREAM-PASS",
		Users: []provider.User{{
			ID:           "user-1",
			Username:     "client",
			PasswordHash: proxyKnownPasswordHash,
			Enabled:      1,
		}},
	}
}

func xtreamResolved(path string) routing.Resolved {
	return routing.Resolved{
		Provider:      xtreamTestProvider(),
		MatchedBy:     routing.MatchRoute,
		RemainingPath: path,
	}
}

func TestBuildUpstreamURLSupportsXtreamMetadataSurface(t *testing.T) {
	for _, endpoint := range []string{"player_api.php", "panel_api.php", "enigma2.php", "get.php", "xmltv.php"} {
		t.Run(endpoint, func(t *testing.T) {
			r := &http.Request{URL: &url.URL{RawQuery: "username=client&password=secret&action=get_live_categories"}}
			target, gotEndpoint, user, err := buildUpstreamURL(xtreamResolved("/"+endpoint), r)
			if err != nil {
				t.Fatal(err)
			}
			if gotEndpoint != endpoint || user.Username != "client" || user.ClientPassword != "secret" {
				t.Fatalf("endpoint=%q user=%#v", gotEndpoint, user)
			}
			if target.Path != "/base/"+endpoint {
				t.Fatalf("path=%q", target.Path)
			}
			q := target.Query()
			if q.Get("username") != "UPSTREAM" || q.Get("password") != "UPSTREAM-PASS" {
				t.Fatalf("provider credentials not rewritten: %s", target)
			}
			if q.Get("action") != "get_live_categories" {
				t.Fatalf("action was not preserved: %s", target)
			}
		})
	}
}

func TestBuildUpstreamURLPreservesBareLiveShape(t *testing.T) {
	r := &http.Request{URL: &url.URL{}}
	target, endpoint, user, err := buildUpstreamURL(xtreamResolved("/client/secret/123.ts"), r)
	if err != nil {
		t.Fatal(err)
	}
	if endpoint != "live" || user.Username != "client" {
		t.Fatalf("endpoint=%q user=%#v", endpoint, user)
	}
	if target.Path != "/base/UPSTREAM/UPSTREAM-PASS/123.ts" {
		t.Fatalf("bare live path=%q", target.Path)
	}
}

func TestBuildUpstreamURLSupportsNativeHLSSegments(t *testing.T) {
	r := &http.Request{URL: &url.URL{RawQuery: "token=abc"}}
	target, endpoint, _, err := buildUpstreamURL(xtreamResolved("/hls/client/secret/123/123_1000.ts"), r)
	if err != nil {
		t.Fatal(err)
	}
	if endpoint != "hls" || target.Path != "/base/hls/UPSTREAM/UPSTREAM-PASS/123/123_1000.ts" {
		t.Fatalf("endpoint=%q target=%s", endpoint, target)
	}
	if target.Query().Get("token") != "abc" {
		t.Fatalf("HLS token lost: %s", target)
	}
}

func TestLiveRangeAndNativeHLSSegmentsBypassMultiplexer(t *testing.T) {
	target, _ := url.Parse("http://provider.test/live/u/p/123.ts")
	r, _ := http.NewRequest(http.MethodGet, "http://proxy/live/u/p/123.ts", nil)
	r.Header.Set("Range", "bytes=0-1023")
	if shouldMultiplexLive(r, "live", target) {
		t.Fatal("live Range request must preserve direct HTTP range semantics")
	}

	tokenTarget, _ := url.Parse("http://provider.test/live/u/p/123_1000.ts?token=abc")
	r2, _ := http.NewRequest(http.MethodGet, "http://proxy/live/u/p/123_1000.ts?token=abc", nil)
	if shouldMultiplexLive(r2, "live", tokenTarget) {
		t.Fatal("finite native HLS segment must not join continuous live multiplexer")
	}
}

func TestXtreamRequestValuesAcceptsEmptyAndJSONPostBodies(t *testing.T) {
	emptyJSON, _ := http.NewRequest(http.MethodPost, "https://proxy.test/get.php?username=client&password=secret", strings.NewReader("{}"))
	values, err := xtreamRequestValues(emptyJSON)
	if err != nil {
		t.Fatal(err)
	}
	if values.Get("username") != "client" || values.Get("password") != "secret" || values.Has("{}") {
		t.Fatalf("empty JSON body polluted query values: %#v", values)
	}

	jsonPost, _ := http.NewRequest(http.MethodPost, "https://proxy.test/player_api.php", strings.NewReader(`{"username":"client","password":"secret","action":"get_short_epg","stream_id":123,"limit":4}`))
	jsonPost.Header.Set("Content-Type", "application/json")
	values, err = xtreamRequestValues(jsonPost)
	if err != nil {
		t.Fatal(err)
	}
	if values.Get("username") != "client" || values.Get("password") != "secret" || values.Get("action") != "get_short_epg" || values.Get("stream_id") != "123" || values.Get("limit") != "4" {
		t.Fatalf("JSON Xtream body not normalized: %#v", values)
	}
}

func TestRewriteXtreamAbsoluteURLCoversMetadataMediaAndBareRoutes(t *testing.T) {
	p := xtreamTestProvider()
	user := provider.User{Username: "client", ClientPassword: "secret"}
	publicBase := "https://proxy.test/trex"

	cases := map[string]string{}
	cases["http://provider.test/base/player_api.php?username=UPSTREAM&password=UPSTREAM-PASS&action=get_series"] = "https://proxy.test/trex/player_api.php?action=get_series&password=secret&username=client"
	cases["http://provider.test/base/live/UPSTREAM/UPSTREAM-PASS/123.ts"] = "https://proxy.test/trex/live/client/secret/123.ts"
	cases["http://provider.test/base/hls/UPSTREAM/UPSTREAM-PASS/123/segment.ts?token=x"] = "https://proxy.test/trex/hls/client/secret/123/segment.ts?token=x"
	cases["http://provider.test/base/UPSTREAM/UPSTREAM-PASS/456"] = "https://proxy.test/trex/live/client/secret/456"

	for raw, want := range cases {
		got, ok := rewriteXtreamAbsoluteURL(p, user, publicBase, raw)
		if !ok || got != want {
			t.Fatalf("rewrite %q => %q ok=%v, want %q", raw, got, ok, want)
		}
	}
}

func TestM3URewritesEPGHeaderRelativeStreamsAndPipeOptions(t *testing.T) {
	h := &Handler{appURL: "https://proxy.test"}
	p := xtreamTestProvider()
	user := provider.User{Username: "client", ClientPassword: "secret"}
	body := []byte("#EXTM3U x-tvg-url=\"/base/xmltv.php?username=UPSTREAM&password=UPSTREAM-PASS\" url-tvg='http://provider.test/base/xmltv.php?username=UPSTREAM&password=UPSTREAM-PASS'\n#EXTINF:-1,Channel\n/base/live/UPSTREAM/UPSTREAM-PASS/123.ts|User-Agent=Player\n")
	got := string(h.rewriteM3UPlaylist(p, user, body))
	if strings.Contains(got, "UPSTREAM") || strings.Contains(got, "provider.test") {
		t.Fatalf("provider credentials/host leaked from M3U: %s", got)
	}
	if !strings.Contains(got, "https://proxy.test/trex/xmltv.php?password=secret&username=client") {
		t.Fatalf("EPG URL not rewritten: %s", got)
	}
	if !strings.Contains(got, "https://proxy.test/trex/live/client/secret/123.ts|User-Agent=Player") {
		t.Fatalf("relative stream URL or pipe options not preserved: %s", got)
	}
}

func TestEnigma2CDATAURLsStayInsideProxy(t *testing.T) {
	p := xtreamTestProvider()
	user := provider.User{Username: "client", ClientPassword: "secret"}
	body := []byte(`<?xml version="1.0"?><items><playlist_url><![CDATA[http://provider.test/base/enigma2.php?username=UPSTREAM&password=UPSTREAM-PASS&type=get_live_categories]]></playlist_url><stream_url><![CDATA[http://provider.test/base/live/UPSTREAM/UPSTREAM-PASS/123.ts]]></stream_url></items>`)
	got := string(rewriteXtreamXMLURLs(p, user, "https://proxy.test/trex", body))
	if strings.Contains(got, "UPSTREAM") || strings.Contains(got, "provider.test") {
		t.Fatalf("Enigma2 response leaked provider identity: %s", got)
	}
	if !strings.Contains(got, "https://proxy.test/trex/enigma2.php?password=secret&type=get_live_categories&username=client") || !strings.Contains(got, "https://proxy.test/trex/live/client/secret/123.ts") {
		t.Fatalf("Enigma2 URLs not rewritten: %s", got)
	}
}

func TestSanitizeXtreamDirectSourceForcesStandardProxyPlayback(t *testing.T) {
	value := map[string]any{"stream_id": "123", "direct_source": "http://provider.test/raw.ts"}
	if !sanitizeXtreamDirectSources(value) {
		t.Fatal("expected direct_source to be sanitized")
	}
	if value["direct_source"] != "" {
		t.Fatalf("direct_source=%v", value["direct_source"])
	}
}

func TestCatchupCandidatesIncludeXtreamCompactHourTimestamp(t *testing.T) {
	target, _ := url.Parse("http://provider.test/timeshift/u/p/60/2026-08-31:12-00/123.ts")
	candidates, ok := buildCatchupCandidates(target, "")
	if !ok {
		t.Fatal("catch-up request was not recognized")
	}
	pathCompact := false
	queryCompact := false
	for _, candidate := range candidates {
		if strings.Contains(candidate.URL.Path, "/20260831-12/") {
			pathCompact = true
		}
		if candidate.URL.Query().Get("start") == "20260831-12" {
			queryCompact = true
		}
	}
	if !pathCompact || !queryCompact {
		t.Fatalf("compact Xtream timestamp candidates missing: path=%v query=%v", pathCompact, queryCompact)
	}
}
