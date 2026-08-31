package proxy

import (
	"bytes"
	"encoding/json"
	"net/url"
	"regexp"
	"strings"

	"github.com/abdulmalik813/iptv-proxy/internal/provider"
)

var xtreamCDATAURL = regexp.MustCompile(`(?is)<!\[CDATA\[(https?://[^\]]+)\]\]>`)

func (h *Handler) xtreamProviderPublicBase(p provider.Provider) string {
	base := strings.TrimSuffix(h.appURL, "/")
	if route := strings.Trim(p.Route, "/"); route != "" {
		base += "/" + route
	}
	return base
}

// rewriteXtreamAbsoluteURL converts a provider-owned Xtream URL into the local
// proxy namespace while preserving the route shape, stream id, extension and
// unrelated query parameters. Third-party URLs and unknown provider paths are
// deliberately left untouched; artwork has its own opaque-token proxy.
func rewriteXtreamAbsoluteURL(p provider.Provider, clientUser provider.User, publicBase, raw string) (string, bool) {
	return rewriteXtreamAbsoluteURLWithCredentials(p, clientXtreamCredentials(clientUser), publicBase, raw)
}

func rewriteXtreamAbsoluteURLWithCredentials(p provider.Provider, credentials xtreamRewriteCredentials, publicBase, raw string) (string, bool) {
	if credentials.PathUsername == "" || credentials.PathPassword == "" || credentials.QueryUsername == "" || credentials.QueryPassword == "" || strings.TrimSpace(raw) == "" {
		return "", false
	}
	target, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || target.Scheme == "" || target.Host == "" {
		return "", false
	}
	providerBase, err := url.Parse(strings.TrimSuffix(p.Host, "/"))
	if err != nil || providerBase.Host == "" || !strings.EqualFold(target.Host, providerBase.Host) {
		return "", false
	}

	streamPath := target.Path
	if basePath := strings.TrimSuffix(providerBase.Path, "/"); basePath != "" {
		if streamPath == basePath {
			streamPath = "/"
		} else if strings.HasPrefix(streamPath, basePath+"/") {
			streamPath = strings.TrimPrefix(streamPath, basePath)
		}
	}
	segments := strings.Split(strings.TrimPrefix(streamPath, "/"), "/")
	if len(segments) == 0 || segments[0] == "" {
		return "", false
	}

	q := target.Query()
	rewrittenPath := streamPath
	switch strings.ToLower(segments[0]) {
	case "player_api.php", "panel_api.php", "enigma2.php", "get.php", "xmltv.php":
		q.Set("username", credentials.QueryUsername)
		q.Set("password", credentials.QueryPassword)
	case "live", "movie", "series", "timeshift", "hls":
		if len(segments) < 4 || segments[1] != p.UpstreamUsername || segments[2] != p.UpstreamPassword {
			return "", false
		}
		segments[1] = credentials.PathUsername
		segments[2] = credentials.PathPassword
		rewrittenPath = "/" + strings.Join(segments, "/")
	case "streaming":
		if len(segments) < 2 || !strings.EqualFold(segments[1], "timeshift.php") {
			return "", false
		}
		if q.Get("username") != p.UpstreamUsername || q.Get("password") != p.UpstreamPassword {
			return "", false
		}
		q.Set("username", credentials.QueryUsername)
		q.Set("password", credentials.QueryPassword)
	default:
		// Xtream's newer nginx rewrite permits /{user}/{pass}/{stream_id}
		// as a live alias. Normalize provider-emitted bare URLs to canonical
		// /live/... so every local player follows one well-tested stream route.
		if len(segments) < 3 || segments[0] != p.UpstreamUsername || segments[1] != p.UpstreamPassword {
			return "", false
		}
		segments = append([]string{"live", credentials.PathUsername, credentials.PathPassword}, segments[2:]...)
		rewrittenPath = "/" + strings.Join(segments, "/")
	}

	localBase, err := url.Parse(strings.TrimSuffix(publicBase, "/"))
	if err != nil || localBase.Scheme == "" || localBase.Host == "" {
		return "", false
	}
	localBase.Path = strings.TrimSuffix(localBase.Path, "/") + rewrittenPath
	localBase.RawQuery = q.Encode()
	localBase.Fragment = target.Fragment
	return localBase.String(), true
}

// rewriteXtreamJSONURLs handles provider API fields such as stream_url,
// playlist_url and other embedded Xtream URLs without relying on a fixed field
// name list. Only URLs on the configured provider origin and recognized Xtream
// route shapes are changed.
func rewriteXtreamJSONURLs(p provider.Provider, clientUser provider.User, publicBase string, body []byte) []byte {
	return rewriteXtreamJSONURLsWithCredentials(p, clientXtreamCredentials(clientUser), publicBase, body)
}

func rewriteXtreamJSONURLsWithCredentials(p provider.Provider, credentials xtreamRewriteCredentials, publicBase string, body []byte) []byte {
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return body
	}
	if !rewriteXtreamJSONValue(value, p, credentials, publicBase) {
		return body
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		return body
	}
	return encoded
}

func rewriteXtreamJSONValue(value any, p provider.Provider, credentials xtreamRewriteCredentials, publicBase string) bool {
	changed := false
	switch typed := value.(type) {
	case map[string]any:
		for key, child := range typed {
			if raw, ok := child.(string); ok {
				if replacement, ok := rewriteXtreamAbsoluteURLWithCredentials(p, credentials, publicBase, raw); ok {
					typed[key] = replacement
					changed = true
					continue
				}
			}
			if rewriteXtreamJSONValue(child, p, credentials, publicBase) {
				changed = true
			}
		}
	case []any:
		for index, child := range typed {
			if raw, ok := child.(string); ok {
				if replacement, ok := rewriteXtreamAbsoluteURLWithCredentials(p, credentials, publicBase, raw); ok {
					typed[index] = replacement
					changed = true
					continue
				}
			}
			if rewriteXtreamJSONValue(child, p, credentials, publicBase) {
				changed = true
			}
		}
	}
	return changed
}

// Enigma2 returns provider API/stream links inside XML CDATA blocks. Rewriting
// those URLs is essential because otherwise the receiver leaves the proxy after
// the first menu request and exposes the upstream credentials.
func rewriteXtreamXMLURLs(p provider.Provider, clientUser provider.User, publicBase string, body []byte) []byte {
	matches := xtreamCDATAURL.FindAllSubmatchIndex(body, -1)
	if len(matches) == 0 {
		return body
	}
	credentials := clientXtreamCredentials(clientUser)
	out := append([]byte(nil), body...)
	for index := len(matches) - 1; index >= 0; index-- {
		match := matches[index]
		if len(match) < 4 || match[2] < 0 || match[3] < 0 {
			continue
		}
		raw := string(out[match[2]:match[3]])
		replacement, ok := rewriteXtreamAbsoluteURLWithCredentials(p, credentials, publicBase, raw)
		if !ok {
			continue
		}
		updated := make([]byte, 0, len(out)-(match[3]-match[2])+len(replacement))
		updated = append(updated, out[:match[2]]...)
		updated = append(updated, replacement...)
		updated = append(updated, out[match[3]:]...)
		out = updated
	}
	return out
}
