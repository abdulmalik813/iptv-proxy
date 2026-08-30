package proxy

import (
	"net/http/httptest"
	"strings"
	"testing"
)

func TestSafeURLStringRedactsXtreamCredentials(t *testing.T) {
	raw := "https://provider.example/live/upstream-user/upstream-pass/12345.ts?username=query-user&password=query-pass&action=get_live_streams"
	got := safeURLString(raw)

	for _, secret := range []string{"upstream-user", "upstream-pass", "query-user", "query-pass"} {
		if strings.Contains(got, secret) {
			t.Fatalf("credential %q leaked into logged URL: %s", secret, got)
		}
	}
	if !strings.Contains(got, "/live/REDACTED/REDACTED/12345.ts") {
		t.Fatalf("stream identity was not preserved in sanitized URL: %s", got)
	}
	if !strings.Contains(got, "action=get_live_streams") {
		t.Fatalf("non-sensitive query parameters should remain visible: %s", got)
	}
}

func TestSafeURLStringRedactsHLSToken(t *testing.T) {
	got := safeURLString("https://proxy.example/provider/_hls/super-secret-token")
	if strings.Contains(got, "super-secret-token") {
		t.Fatalf("HLS token leaked into logged URL: %s", got)
	}
	if !strings.Contains(got, "/_hls/REDACTED") {
		t.Fatalf("expected HLS route shape to remain visible: %s", got)
	}
}

func TestRequestFullURLUsesPublicAppURL(t *testing.T) {
	req := httptest.NewRequest("GET", "http://127.0.0.1:8080/provider/player_api.php?username=client&password=secret&action=get_vod_streams", nil)
	got := requestFullURL("https://iptv.example.test", req)

	if !strings.HasPrefix(got, "https://iptv.example.test/provider/player_api.php?") {
		t.Fatalf("unexpected public request URL: %s", got)
	}
	if strings.Contains(got, "client") || strings.Contains(got, "secret") {
		t.Fatalf("client credentials leaked into logged incoming URL: %s", got)
	}
	if !strings.Contains(got, "action=get_vod_streams") {
		t.Fatalf("action should remain searchable in logged URL: %s", got)
	}
}
