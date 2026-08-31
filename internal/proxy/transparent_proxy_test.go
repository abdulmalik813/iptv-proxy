package proxy

import (
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/abdulmalik813/iptv-proxy/internal/provider"
	"github.com/abdulmalik813/iptv-proxy/internal/routing"
)

func TestTransparentTranslatorRejectsInvalidBodyCredentialsEvenWithValidQueryAuth(t *testing.T) {
	r := httptest.NewRequest(http.MethodPost, "https://proxy.test/future_api.php?username=client&password=secret", strings.NewReader(`{"username":"client","password":"wrong","action":"future"}`))
	r.Header.Set("Content-Type", "application/json")
	_, _, _, err := buildTransparentUpstreamURL(xtreamResolved("/future_api.php"), r)
	if err == nil || !strings.Contains(err.Error(), "invalid IPTV credentials") {
		t.Fatalf("invalid body credentials were not rejected: %v", err)
	}
}

func TestTransparentTranslatorRejectsDisabledUserInFuturePathShape(t *testing.T) {
	p := xtreamTestProvider()
	p.Users = append(p.Users, provider.User{ID: "disabled", Username: "disabled", PasswordHash: proxyKnownPasswordHash, Enabled: 0})
	resolved := routing.Resolved{Provider: p, MatchedBy: routing.MatchRoute, RemainingPath: "/future/disabled/secret/123.bin"}
	r := &http.Request{URL: &url.URL{}}
	_, _, _, err := buildTransparentUpstreamURL(resolved, r)
	if err == nil || !strings.Contains(err.Error(), "invalid IPTV credentials") {
		t.Fatalf("disabled path credentials were not rejected: %v", err)
	}
}

func TestOpaqueMediaClassificationDoesNotWrapArbitraryProviderURLs(t *testing.T) {
	admin, _ := url.Parse("https://provider.test/admin_api.php?foo=bar")
	if isLikelyOpaqueMediaURL(admin) {
		t.Fatal("arbitrary provider API URL must not become an opaque media capability")
	}
	media, _ := url.Parse("https://cdn.test/path/movie.mp4")
	if !isLikelyOpaqueMediaURL(media) {
		t.Fatal("known media extension should be eligible for opaque media wrapping")
	}
	signed, _ := url.Parse("https://cdn.test/playback?id=123&signature=abc&expires=999999")
	if !isLikelyOpaqueMediaURL(signed) {
		t.Fatal("signed temporary media URL should be eligible for opaque media wrapping")
	}
}

func TestServeTransparentSniffsTextPlainJSONAndPreservesPostFraming(t *testing.T) {
	requestBody := `{"username":"UPSTREAM","password":"UPSTREAM-PASS","action":"future"}`
	var upstreamURL string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Errorf("method=%s want POST", r.Method)
		}
		if r.ContentLength != int64(len(requestBody)) {
			t.Errorf("content length=%d want=%d", r.ContentLength, len(requestBody))
		}
		if r.Header.Get("Accept-Encoding") != "" {
			t.Errorf("Accept-Encoding should be stripped, got %q", r.Header.Get("Accept-Encoding"))
		}
		body, _ := io.ReadAll(r.Body)
		if string(body) != requestBody {
			t.Errorf("body=%q want=%q", body, requestBody)
		}
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		_, _ = io.WriteString(w, `{"stream_url":"`+upstreamURL+`/live/UPSTREAM/UPSTREAM-PASS/123.ts","future":"kept"}`)
	}))
	defer upstream.Close()
	upstreamURL = upstream.URL

	p := provider.Provider{
		ID:               "provider-1",
		Name:             "Test Provider",
		Host:             upstream.URL,
		Route:            "trex",
		UpstreamUsername: "UPSTREAM",
		UpstreamPassword: "UPSTREAM-PASS",
	}
	resolved := routing.Resolved{Provider: p, MatchedBy: routing.MatchRoute, RemainingPath: "/future_api.php"}
	clientUser := provider.User{ID: "user-1", Username: "client", ClientPassword: "secret", Enabled: 1}
	target, _ := url.Parse(upstream.URL + "/future_api.php")
	r := httptest.NewRequest(http.MethodPost, "https://proxy.test/trex/future_api.php", strings.NewReader(requestBody))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Accept-Encoding", "gzip")
	w := httptest.NewRecorder()
	h := &Handler{
		appURL: "https://proxy.test",
		streamClient: &http.Client{Transport: &http.Transport{
			DisableCompression: true,
		}},
	}

	h.serveTransparent(w, r, resolved, clientUser, "future_api.php", target)
	resp := w.Result()
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status=%d body=%s", resp.StatusCode, body)
	}
	if !strings.Contains(resp.Header.Get("Content-Type"), "application/json") {
		t.Fatalf("content type=%q", resp.Header.Get("Content-Type"))
	}
	result := string(body)
	if strings.Contains(result, upstream.URL) || strings.Contains(result, "UPSTREAM-PASS") {
		t.Fatalf("provider identity leaked from text/plain JSON: %s", result)
	}
	if !strings.Contains(result, "https://proxy.test/trex/live/client/secret/123.ts") || !strings.Contains(result, `"future":"kept"`) {
		t.Fatalf("transparent JSON was not rewritten/preserved correctly: %s", result)
	}
}
