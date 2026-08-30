package proxy

import (
	"net/http"
	"testing"
)

func TestCopySafeRequestHeadersStripsClientIdentityAndAdminSecrets(t *testing.T) {
	src := make(http.Header)
	src.Set("Cookie", "iptv_proxy_session=admin-secret")
	src.Set("Authorization", "Bearer browser-secret")
	src.Set("X-Forwarded-For", "203.0.113.10")
	src.Set("X-Real-IP", "203.0.113.10")
	src.Set("CF-Connecting-IP", "203.0.113.10")
	src.Set("Forwarded", "for=203.0.113.10")
	src.Set("Range", "bytes=10-19")
	src.Set("User-Agent", "OwnTV-Test/1.0")

	dst := make(http.Header)
	copySafeRequestHeaders(dst, src)

	for _, key := range []string{"Cookie", "Authorization", "X-Forwarded-For", "X-Real-IP", "CF-Connecting-IP", "Forwarded"} {
		if dst.Get(key) != "" {
			t.Fatalf("sensitive header %s leaked upstream", key)
		}
	}
	if dst.Get("Range") != "bytes=10-19" || dst.Get("User-Agent") != "OwnTV-Test/1.0" {
		t.Fatalf("required media headers were not preserved: %#v", dst)
	}
}

func TestCopyResponseHeadersBlocksUpstreamCookieInjection(t *testing.T) {
	src := make(http.Header)
	src.Add("Set-Cookie", "iptv_proxy_session=attacker; Path=/")
	src.Set("Content-Type", "video/mp2t")
	dst := make(http.Header)
	copyResponseHeaders(dst, src)
	if dst.Get("Set-Cookie") != "" {
		t.Fatal("upstream provider Set-Cookie must not reach the proxy domain")
	}
	if dst.Get("Content-Type") != "video/mp2t" {
		t.Fatal("safe response headers should be preserved")
	}
}
