package proxy

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/abdulmalik813/iptv-proxy/internal/provider"
)

func TestPersonalizeCanonicalCacheUsesCorrectPathAndQueryEscaping(t *testing.T) {
	user := provider.User{Username: "family user", ClientPassword: "p/a+s&?"}
	body := []byte("https://proxy.test/live/" + cachePathUserPlaceholder + "/" + cachePathPassPlaceholder + "/123.ts?username=" + cacheQueryUserPlaceholder + "&password=" + cacheQueryPassPlaceholder)
	got := string(personalizeCanonicalCache(body, user))
	want := "https://proxy.test/live/" + url.PathEscape(user.Username) + "/" + url.PathEscape(user.ClientPassword) + "/123.ts?username=" + url.QueryEscape(user.Username) + "&password=" + url.QueryEscape(user.ClientPassword)
	if got != want {
		t.Fatalf("personalized=%q want=%q", got, want)
	}
}

func TestPersonalizeCanonicalCacheReturnsOriginalWhenNoPlaceholdersExist(t *testing.T) {
	body := []byte(`[{"stream_id":123,"name":"Movie"}]`)
	got := personalizeCanonicalCache(body, provider.User{Username: "local", ClientPassword: "secret"})
	if string(got) != string(body) {
		t.Fatalf("body changed unexpectedly: %q", got)
	}
}

func TestCanonicalCacheContentTypeMarkerRoundTrips(t *testing.T) {
	stored := markCanonicalCacheContentType("application/json; charset=utf-8")
	got, ok := canonicalCacheContentType(stored)
	if !ok || got != "application/json; charset=utf-8" {
		t.Fatalf("content type=%q canonical=%v", got, ok)
	}
	if got, ok := canonicalCacheContentType("application/json"); ok || got != "application/json" {
		t.Fatalf("legacy content type=%q canonical=%v", got, ok)
	}
}

func TestFetchCacheableStoresCanonicalProxyTemplate(t *testing.T) {
	var upstreamURL string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`[{"stream_id":123,"stream_url":"` + upstreamURL + `/live/up/pass/123.ts"}]`))
	}))
	defer upstream.Close()
	upstreamURL = upstream.URL

	p := provider.Provider{ID: "provider-1", Host: upstream.URL, Route: "test", UpstreamUsername: "up", UpstreamPassword: "pass"}
	h := &Handler{metadataClient: upstream.Client(), appURL: "https://proxy.test"}
	target, _ := url.Parse(upstream.URL + "/player_api.php?username=up&password=pass&action=get_live_streams")
	response, err := h.fetchCacheable(context.Background(), p, "player_api.php", target, http.Header{"User-Agent": []string{"OwnTV-Test"}})
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := canonicalCacheContentType(response.ContentType); !ok {
		t.Fatalf("cache response was not marked canonical: %q", response.ContentType)
	}
	stored := string(response.Body)
	if !strings.Contains(stored, cachePathUserPlaceholder) || !strings.Contains(stored, cachePathPassPlaceholder) {
		t.Fatalf("canonical path placeholders missing: %s", stored)
	}
	if strings.Contains(stored, "/up/pass/") {
		t.Fatalf("upstream credentials leaked into canonical body: %s", stored)
	}
	personalized := string(personalizeCanonicalCache(response.Body, provider.User{Username: "local", ClientPassword: "secret"}))
	if !strings.Contains(personalized, "https://proxy.test/test/live/local/secret/123.ts") {
		t.Fatalf("unexpected personalized body: %s", personalized)
	}
}

func TestArtworkProviderFallbackReplacesOnlyUnsignedPublicIPOrigin(t *testing.T) {
	p := provider.Provider{Host: "http://vpn.trxdnscloud.ru"}
	target, _ := url.Parse("http://51.158.145.100/picons/logos/CANADA/176861.png")
	fallback, ok := artworkProviderFallback(p, target)
	if !ok {
		t.Fatal("expected raw-IP artwork fallback")
	}
	if got := fallback.String(); got != "http://vpn.trxdnscloud.ru/picons/logos/CANADA/176861.png" {
		t.Fatalf("fallback=%q", got)
	}

	signed, _ := url.Parse("http://51.158.145.100/picons/a.png?token=signed")
	if _, ok := artworkProviderFallback(p, signed); ok {
		t.Fatal("signed/query-sensitive artwork must not be host-swapped")
	}
	hostname, _ := url.Parse("http://images.example/picons/a.png")
	if _, ok := artworkProviderFallback(p, hostname); ok {
		t.Fatal("third-party hostname artwork must not be host-swapped")
	}
}
