package proxy

import (
	"net/http"
	"net/url"

	"github.com/abdulmalik813/iptv-proxy/internal/provider"
)

// cacheTargetForRequest maps both GET and POST Xtream metadata calls onto the
// same provider GET identity. This lets Smarters, OwnTV and other clients share
// one large catalog generation even when they submit the action/credentials in
// different HTTP forms.
func cacheTargetForRequest(r *http.Request, p provider.Provider, endpoint string, upstream *url.URL) (*url.URL, bool) {
	if r == nil || upstream == nil {
		return upstream, false
	}
	values := cloneURLValues(upstream.Query())
	if r.Method == http.MethodPost {
		parsed, err := xtreamRequestValues(r)
		if err != nil {
			return upstream, false
		}
		for key, items := range parsed {
			values[key] = append([]string(nil), items...)
		}
	}

	// The cache is provider-scoped and must never be keyed/fetched with a local
	// client's credentials. The descriptor later removes these values from the
	// cache key entirely, while target reconstruction adds current provider creds.
	if values.Has("username") || values.Has("password") {
		values.Set("username", p.UpstreamUsername)
		values.Set("password", p.UpstreamPassword)
	}
	if !isCacheable(endpoint, values) {
		return upstream, false
	}
	canonical := *upstream
	canonical.RawQuery = values.Encode()
	return &canonical, true
}
