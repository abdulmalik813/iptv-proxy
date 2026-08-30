package proxy

import (
	"strings"
	"testing"

	"github.com/abdulmalik813/iptv-proxy/internal/provider"
)

func TestRewriteM3UPlaylistUsesProxyAndLocalCredentials(t *testing.T) {
	handler := &Handler{appURL: "https://iptv.example.test"}
	p := provider.Provider{
		Host:             "http://upstream.example:8080",
		Route:            "dino",
		UpstreamUsername: "up-user",
		UpstreamPassword: "up-pass",
		LocalUsername:    "local-user",
		LocalPassword:    "local-pass",
	}
	playlist := []byte("#EXTM3U\n#EXTINF:-1,Channel\nhttp://upstream.example:8080/live/up-user/up-pass/123.ts\n#EXTINF:-1,Movie\nhttp://upstream.example:8080/movie/up-user/up-pass/456.mp4\n")

	rewritten := string(handler.rewriteM3UPlaylist(p, playlist))
	if strings.Contains(rewritten, "up-user") || strings.Contains(rewritten, "up-pass") || strings.Contains(rewritten, "upstream.example") {
		t.Fatalf("upstream details leaked in rewritten playlist: %s", rewritten)
	}
	for _, expected := range []string{
		"https://iptv.example.test/dino/live/local-user/local-pass/123.ts",
		"https://iptv.example.test/dino/movie/local-user/local-pass/456.mp4",
	} {
		if !strings.Contains(rewritten, expected) {
			t.Fatalf("expected %q in playlist: %s", expected, rewritten)
		}
	}
}

func TestRewriteM3UStreamingQueryCredentials(t *testing.T) {
	handler := &Handler{appURL: "https://iptv.example.test"}
	p := provider.Provider{
		Host:          "http://upstream.example",
		Route:         "main",
		LocalUsername: "local-user",
		LocalPassword: "local-pass",
	}

	rewritten, ok := handler.rewriteM3UTarget(p, "http://upstream.example/streaming/timeshift.php?username=up&password=secret&stream=100")
	if !ok {
		t.Fatal("expected streaming URL to be rewritten")
	}
	if strings.Contains(rewritten, "username=up") || strings.Contains(rewritten, "password=secret") {
		t.Fatalf("upstream query credentials leaked: %s", rewritten)
	}
	if !strings.Contains(rewritten, "username=local-user") || !strings.Contains(rewritten, "password=local-pass") {
		t.Fatalf("local credentials missing: %s", rewritten)
	}
}
