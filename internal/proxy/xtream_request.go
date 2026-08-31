package proxy

import (
	"errors"
	"net/http"
	"net/url"
	"strings"

	"github.com/abdulmalik813/iptv-proxy/internal/provider"
	"github.com/abdulmalik813/iptv-proxy/internal/routing"
)

// Transparent player forwarding is intentionally denylist-based rather than
// endpoint-allowlist-based. Xtream-compatible apps and panels regularly add
// client routes/actions that are not part of a single canonical specification.
// Normal local IPTV credentials may pass through those routes, but they must
// never turn this proxy into an authenticated tunnel to provider management or
// MAG/Stalker control surfaces.
var blockedXtreamRoutes = map[string]bool{
	"admin_api.php":    true,
	"adminapi.php":     true,
	"reseller_api.php": true,
	"reseller.php":     true,
	"api.php":          true,
	"portal.php":       true,
	"stalker_portal":   true,
	"mag":              true,
	"c":                true,
}

func isBlockedXtreamRoute(remaining string) bool {
	parts := strings.Split(strings.Trim(remaining, "/"), "/")
	if len(parts) == 0 || parts[0] == "" {
		return false
	}
	first := strings.ToLower(parts[0])
	if blockedXtreamRoutes[first] {
		return true
	}
	// Common MAG/Stalker loader path. Do not block a generic path named server;
	// only the management/portal loader shape is denied.
	return first == "server" && len(parts) > 1 && strings.EqualFold(parts[1], "load.php")
}

func authenticateXtreamClient(p provider.Provider, username, password string) (provider.User, bool) {
	if user, ok := p.Authenticate(username, password); ok {
		return user, true
	}
	// Some clients send literal '+' characters without percent-encoding them;
	// net/url decodes those as spaces. Exact credentials always win, and this
	// compatibility fallback is attempted only after exact authentication fails.
	plusUsername := strings.ReplaceAll(username, " ", "+")
	plusPassword := strings.ReplaceAll(password, " ", "+")
	if (plusUsername != username || plusPassword != password) && plusUsername != "" && plusPassword != "" {
		if user, ok := p.Authenticate(plusUsername, plusPassword); ok {
			return user, true
		}
	}
	return provider.User{}, false
}

func providerHasClientUsername(p provider.Provider, username string) bool {
	for _, user := range p.Users {
		if user.Enabled == 1 && user.Username == username {
			return true
		}
	}
	return false
}

func sameClientUser(left, right provider.User) bool {
	if left.ID != "" && right.ID != "" {
		return left.ID == right.ID
	}
	return left.Username != "" && left.Username == right.Username
}

// buildUpstreamURL is now the transparent Xtream request translator. Instead of
// owning a fixed list of player endpoints, it discovers the authenticated local
// credential pair in the query/path, replaces only that pair with provider
// credentials, preserves the rest of the path/query, and forwards future
// authenticated Xtream-compatible routes by default.
func buildUpstreamURL(resolved routing.Resolved, r *http.Request) (*url.URL, string, provider.User, error) {
	p := resolved.Provider
	base, err := url.Parse(strings.TrimSuffix(p.Host, "/"))
	if err != nil {
		return nil, "", provider.User{}, err
	}
	remaining := resolved.RemainingPath
	if isBlockedXtreamRoute(remaining) {
		return nil, "", provider.User{}, errors.New("provider management endpoint is not available through IPTV proxy")
	}

	segments := strings.Split(strings.TrimPrefix(remaining, "/"), "/")
	endpoint := ""
	if len(segments) > 0 {
		endpoint = strings.ToLower(segments[0])
	}

	selectedUser := provider.User{}
	selectUser := func(user provider.User) error {
		if selectedUser.Username != "" && !sameClientUser(selectedUser, user) {
			return errors.New("conflicting IPTV credentials in request")
		}
		selectedUser = user
		return nil
	}

	q := r.URL.Query()
	for _, pair := range [][2]string{{"username", "password"}, {"user", "pass"}} {
		username := q.Get(pair[0])
		password := q.Get(pair[1])
		if username == "" || password == "" {
			continue
		}
		user, ok := authenticateXtreamClient(p, username, password)
		if !ok {
			return nil, endpoint, provider.User{}, errors.New("invalid IPTV credentials")
		}
		if err := selectUser(user); err != nil {
			return nil, endpoint, provider.User{}, err
		}
		q.Set(pair[0], p.UpstreamUsername)
		q.Set(pair[1], p.UpstreamPassword)
	}

	firstPathCredential := -1
	// Search only segments that match an enabled local username before paying the
	// password-verification cost. This lets future Xtream route shapes such as
	// /new-route/{user}/{pass}/... pass through without hard-coding new endpoints.
	for index := 0; index+1 < len(segments); index++ {
		if !providerHasClientUsername(p, segments[index]) {
			continue
		}
		user, ok := authenticateXtreamClient(p, segments[index], segments[index+1])
		if !ok {
			continue
		}
		if err := selectUser(user); err != nil {
			return nil, endpoint, provider.User{}, err
		}
		segments[index] = p.UpstreamUsername
		segments[index+1] = p.UpstreamPassword
		if firstPathCredential < 0 {
			firstPathCredential = index
		}
		index++
	}

	if selectedUser.Username == "" {
		return nil, endpoint, provider.User{}, errors.New("invalid IPTV credentials")
	}

	// /{user}/{pass}/{stream} is the legacy/bare Xtream live shape. Preserve the
	// exact provider-facing route instead of manufacturing a new URL, but label it
	// live internally so the one-upstream stream multiplexer can still be used.
	if firstPathCredential == 0 && len(segments) >= 3 {
		endpoint = "live"
	}

	if len(segments) > 0 {
		remaining = "/" + strings.Join(segments, "/")
	}
	base.Path = strings.TrimSuffix(base.Path, "/") + remaining
	base.RawQuery = q.Encode()
	return base, endpoint, selectedUser, nil
}
