package proxy

import (
	"bytes"
	"net/url"
	"regexp"
	"strings"

	"github.com/abdulmalik813/iptv-proxy/internal/provider"
)

var (
	m3uEPGDouble = regexp.MustCompile(`(?i)\b(?:x-tvg-url|url-tvg)\s*=\s*"([^"]*)"`)
	m3uEPGSingle = regexp.MustCompile(`(?i)\b(?:x-tvg-url|url-tvg)\s*=\s*'([^']*)'`)
)

func (h *Handler) rewriteM3UPlaylist(p provider.Provider, clientUser provider.User, body []byte) []byte {
	return h.rewriteM3UPlaylistWithCredentials(p, clientXtreamCredentials(clientUser), body)
}

func (h *Handler) rewriteM3UPlaylistWithCredentials(p provider.Provider, credentials xtreamRewriteCredentials, body []byte) []byte {
	lines := bytes.Split(body, []byte("\n"))
	for i, rawLine := range lines {
		line := string(rawLine)
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(strings.ToUpper(trimmed), "#EXTM3U") {
			line = h.rewriteM3UEPGAttributesWithCredentials(p, credentials, line)
		} else if trimmed != "" && !strings.HasPrefix(trimmed, "#") {
			if rewritten, ok := h.rewriteM3UTargetWithCredentials(p, credentials, trimmed); ok {
				line = rewritten
			}
		}
		lines[i] = []byte(line)
	}
	return bytes.Join(lines, []byte("\n"))
}

func (h *Handler) rewriteM3UTarget(p provider.Provider, clientUser provider.User, raw string) (string, bool) {
	return h.rewriteM3UTargetWithCredentials(p, clientXtreamCredentials(clientUser), raw)
}

func (h *Handler) rewriteM3UTargetWithCredentials(p provider.Provider, credentials xtreamRewriteCredentials, raw string) (string, bool) {
	if credentials.PathUsername == "" || credentials.PathPassword == "" || credentials.QueryUsername == "" || credentials.QueryPassword == "" {
		return "", false
	}
	urlPart, pipeOptions := splitM3UPipeOptions(raw)
	target, ok := resolveProviderReference(p, urlPart)
	if !ok || !m3uXtreamMediaTarget(p, target) {
		return "", false
	}
	publicBase := strings.TrimSuffix(h.appURL, "/")
	if route := strings.Trim(p.Route, "/"); route != "" {
		publicBase += "/" + route
	}
	rewritten, ok := rewriteXtreamAbsoluteURLWithCredentials(p, credentials, publicBase, target.String())
	if !ok {
		return "", false
	}
	return rewritten + pipeOptions, true
}

// m3uXtreamMediaTarget keeps M3U stream-line rewriting deliberately limited to
// Xtream media routes. This prevents arbitrary provider-origin links embedded in
// a playlist from silently becoming generic proxy routes while still covering
// canonical live/VOD/series/catch-up, native HLS, and the bare live alias.
func m3uXtreamMediaTarget(p provider.Provider, target *url.URL) bool {
	if target == nil {
		return false
	}
	providerBase, err := url.Parse(strings.TrimSuffix(p.Host, "/"))
	if err != nil || providerBase.Host == "" || !strings.EqualFold(target.Host, providerBase.Host) {
		return false
	}
	streamPath := target.Path
	if basePath := strings.TrimSuffix(providerBase.Path, "/"); basePath != "" {
		if streamPath == basePath {
			return false
		}
		if strings.HasPrefix(streamPath, basePath+"/") {
			streamPath = strings.TrimPrefix(streamPath, basePath)
		}
	}
	segments := strings.Split(strings.TrimPrefix(streamPath, "/"), "/")
	if len(segments) == 0 || segments[0] == "" {
		return false
	}
	switch strings.ToLower(segments[0]) {
	case "live", "movie", "series", "timeshift":
		return len(segments) >= 4
	case "hls":
		return len(segments) >= 5
	case "streaming":
		return len(segments) >= 2 && strings.EqualFold(segments[1], "timeshift.php")
	default:
		return len(segments) >= 3 && segments[0] == p.UpstreamUsername && segments[1] == p.UpstreamPassword
	}
}

func resolveProviderReference(p provider.Provider, raw string) (*url.URL, bool) {
	target, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return nil, false
	}
	providerBase, err := url.Parse(strings.TrimSuffix(p.Host, "/") + "/")
	if err != nil || providerBase.Scheme == "" || providerBase.Host == "" {
		return nil, false
	}
	if target.Scheme == "" && target.Host == "" {
		target = providerBase.ResolveReference(target)
	}
	if target.Scheme == "" || target.Host == "" {
		return nil, false
	}
	return target, true
}

func (h *Handler) rewriteM3UEPGAttributes(p provider.Provider, clientUser provider.User, line string) string {
	return h.rewriteM3UEPGAttributesWithCredentials(p, clientXtreamCredentials(clientUser), line)
}

func (h *Handler) rewriteM3UEPGAttributesWithCredentials(p provider.Provider, credentials xtreamRewriteCredentials, line string) string {
	out := []byte(line)
	for _, expression := range []*regexp.Regexp{m3uEPGDouble, m3uEPGSingle} {
		matches := expression.FindAllSubmatchIndex(out, -1)
		for index := len(matches) - 1; index >= 0; index-- {
			match := matches[index]
			if len(match) < 4 || match[2] < 0 || match[3] < 0 {
				continue
			}
			raw := string(out[match[2]:match[3]])
			replacement := h.rewriteM3UURLListWithCredentials(p, credentials, raw)
			if replacement == raw {
				continue
			}
			updated := make([]byte, 0, len(out)-(match[3]-match[2])+len(replacement))
			updated = append(updated, out[:match[2]]...)
			updated = append(updated, replacement...)
			updated = append(updated, out[match[3]:]...)
			out = updated
		}
	}
	return string(out)
}

func (h *Handler) rewriteM3UURLList(p provider.Provider, clientUser provider.User, raw string) string {
	return h.rewriteM3UURLListWithCredentials(p, clientXtreamCredentials(clientUser), raw)
}

func (h *Handler) rewriteM3UURLListWithCredentials(p provider.Provider, credentials xtreamRewriteCredentials, raw string) string {
	parts := strings.Split(raw, ",")
	changed := false
	for index, part := range parts {
		trimmed := strings.TrimSpace(part)
		target, ok := resolveProviderReference(p, trimmed)
		if !ok {
			continue
		}
		if replacement, ok := rewriteXtreamAbsoluteURLWithCredentials(p, credentials, h.xtreamProviderPublicBase(p), target.String()); ok {
			prefix := part[:len(part)-len(strings.TrimLeft(part, " \t"))]
			suffix := part[len(strings.TrimRight(part, " \t")):]
			parts[index] = prefix + replacement + suffix
			changed = true
		}
	}
	if !changed {
		return raw
	}
	return strings.Join(parts, ",")
}

func splitM3UPipeOptions(raw string) (string, string) {
	index := strings.IndexByte(raw, '|')
	if index < 0 {
		return raw, ""
	}
	return raw[:index], raw[index:]
}

func querySuffix(rawQuery string) string {
	if rawQuery == "" {
		return ""
	}
	return "?" + rawQuery
}
