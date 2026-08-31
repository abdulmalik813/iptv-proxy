package proxy

import (
	"net/http"
	"net/url"
	"strings"
	"testing"
)

func TestHeavyCatalogGETAndPOSTResolveToSameCacheKey(t *testing.T) {
	p := xtreamTestProvider()

	getReq, _ := http.NewRequest(http.MethodGet, "https://proxy.test/player_api.php?username=client&password=secret&action=get_vod_streams", nil)
	getTarget, endpoint, _, err := buildTransparentUpstreamURL(xtreamResolved("/player_api.php"), getReq)
	if err != nil {
		t.Fatal(err)
	}
	getCacheTarget, ok := cacheTargetForRequest(getReq, p, endpoint, getTarget)
	if !ok {
		t.Fatal("GET heavy catalog was not cacheable")
	}

	postReq, _ := http.NewRequest(http.MethodPost, "https://proxy.test/player_api.php", strings.NewReader("username=client&password=secret&action=get_vod_streams"))
	postReq.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	postTarget, postEndpoint, _, err := buildTransparentUpstreamURL(xtreamResolved("/player_api.php"), postReq)
	if err != nil {
		t.Fatal(err)
	}
	postCacheTarget, ok := cacheTargetForRequest(postReq, p, postEndpoint, postTarget)
	if !ok {
		t.Fatal("POST heavy catalog was not cacheable")
	}

	getDescriptor := cacheDescriptor(p.ID, endpoint, getCacheTarget, http.Header{"User-Agent": []string{"Smarters"}})
	postDescriptor := cacheDescriptor(p.ID, postEndpoint, postCacheTarget, http.Header{"User-Agent": []string{"OwnTV"}})
	if getDescriptor.CacheKey() != postDescriptor.CacheKey() {
		t.Fatalf("GET/POST cache keys differ: %q != %q", getDescriptor.CacheKey(), postDescriptor.CacheKey())
	}
	if getCacheTarget.Query().Get("username") != p.UpstreamUsername || postCacheTarget.Query().Get("username") != p.UpstreamUsername {
		t.Fatal("cache targets must use provider credentials")
	}
}

func TestHeavyCatalogCacheKeyDoesNotVaryByClientApplicationHeaders(t *testing.T) {
	p := xtreamTestProvider()
	target, _ := url.Parse("http://provider.test/base/player_api.php?username=UPSTREAM&password=UPSTREAM-PASS&action=get_series")
	smarters := cacheDescriptor(p.ID, "player_api.php", target, http.Header{"User-Agent": []string{"IPTV Smarters Pro"}, "Accept": []string{"*/*"}})
	ownTV := cacheDescriptor(p.ID, "player_api.php", target, http.Header{"User-Agent": []string{"ExoPlayer/OwnTV"}, "Accept": []string{"application/json"}})
	if smarters.CacheKey() != ownTV.CacheKey() {
		t.Fatalf("client application headers split a shared catalog cache: %q != %q", smarters.CacheKey(), ownTV.CacheKey())
	}
	if smarters.Headers["User-Agent"] == ownTV.Headers["User-Agent"] {
		t.Fatal("descriptor should still remember the request header used for an upstream fill")
	}
}
