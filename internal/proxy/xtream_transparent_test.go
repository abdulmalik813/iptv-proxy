package proxy

import (
	"net/http"
	"net/url"
	"strings"
	"testing"
)

func TestTransparentTranslatorForwardsUnknownAuthenticatedQueryRoute(t *testing.T) {
	r := &http.Request{URL: &url.URL{RawQuery: "username=client&password=secret&action=future_action&foo=bar"}}
	target, endpoint, user, err := buildTransparentUpstreamURL(xtreamResolved("/future_api.php"), r)
	if err != nil {
		t.Fatal(err)
	}
	if endpoint != "future_api.php" || user.Username != "client" || user.ClientPassword != "secret" {
		t.Fatalf("endpoint=%q user=%#v", endpoint, user)
	}
	if target.Path != "/base/future_api.php" {
		t.Fatalf("path=%q", target.Path)
	}
	q := target.Query()
	if q.Get("username") != "UPSTREAM" || q.Get("password") != "UPSTREAM-PASS" {
		t.Fatalf("provider credentials not substituted: %s", target)
	}
	if q.Get("action") != "future_action" || q.Get("foo") != "bar" {
		t.Fatalf("unknown query parameters were not preserved: %s", target)
	}
}

func TestTransparentTranslatorForwardsUnknownAuthenticatedPathRoute(t *testing.T) {
	r := &http.Request{URL: &url.URL{RawQuery: "token=keep-me"}}
	target, endpoint, user, err := buildTransparentUpstreamURL(xtreamResolved("/future-stream/client/secret/123/chunk.bin"), r)
	if err != nil {
		t.Fatal(err)
	}
	if endpoint != "future-stream" || user.Username != "client" {
		t.Fatalf("endpoint=%q user=%#v", endpoint, user)
	}
	if target.Path != "/base/future-stream/UPSTREAM/UPSTREAM-PASS/123/chunk.bin" {
		t.Fatalf("path=%q", target.Path)
	}
	if target.Query().Get("token") != "keep-me" {
		t.Fatalf("query token was not preserved: %s", target)
	}
}

func TestTransparentTranslatorPreservesBareLiveShape(t *testing.T) {
	r := &http.Request{URL: &url.URL{}}
	target, endpoint, _, err := buildTransparentUpstreamURL(xtreamResolved("/client/secret/123.ts"), r)
	if err != nil {
		t.Fatal(err)
	}
	if endpoint != "live" {
		t.Fatalf("endpoint=%q", endpoint)
	}
	if target.Path != "/base/UPSTREAM/UPSTREAM-PASS/123.ts" {
		t.Fatalf("bare live shape was not preserved: %q", target.Path)
	}
}

func TestTransparentTranslatorSupportsUserPassQueryAliases(t *testing.T) {
	r := &http.Request{URL: &url.URL{RawQuery: "user=client&pass=secret&mode=future"}}
	target, _, user, err := buildTransparentUpstreamURL(xtreamResolved("/future.php"), r)
	if err != nil {
		t.Fatal(err)
	}
	if user.Username != "client" || target.Query().Get("user") != "UPSTREAM" || target.Query().Get("pass") != "UPSTREAM-PASS" {
		t.Fatalf("alias credentials were not translated: user=%#v target=%s", user, target)
	}
	if target.Query().Get("mode") != "future" {
		t.Fatalf("unrelated query parameter lost: %s", target)
	}
}

func TestTransparentTranslatorDeniesProviderManagementSurfaces(t *testing.T) {
	for _, path := range []string{"/admin_api.php", "/reseller_api.php", "/api.php", "/portal.php", "/stalker_portal/server/load.php", "/server/load.php", "/c/"} {
		t.Run(path, func(t *testing.T) {
			r := &http.Request{URL: &url.URL{RawQuery: "username=client&password=secret"}}
			_, _, _, err := buildTransparentUpstreamURL(xtreamResolved(path), r)
			if err == nil || !strings.Contains(err.Error(), "management endpoint") {
				t.Fatalf("management path %q was not denied: %v", path, err)
			}
		})
	}
}

func TestTransparentTranslatorStillRequiresValidLocalCredentials(t *testing.T) {
	r := &http.Request{URL: &url.URL{RawQuery: "username=client&password=wrong&action=future"}}
	_, _, _, err := buildTransparentUpstreamURL(xtreamResolved("/future_api.php"), r)
	if err == nil || !strings.Contains(err.Error(), "invalid IPTV credentials") {
		t.Fatalf("invalid local credentials were not rejected: %v", err)
	}
}
