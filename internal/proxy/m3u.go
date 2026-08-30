package proxy

import (
	"bufio"
	"bytes"
	"net/url"
	"strings"

	"github.com/abdulmalik813/iptv-proxy/internal/provider"
)

func (h *Handler) rewriteM3UPlaylist(p provider.Provider, body []byte) []byte {
	var out strings.Builder
	scanner := bufio.NewScanner(bytes.NewReader(body))
	scanner.Buffer(make([]byte, 64*1024), maxMetadataBytes)
	for scanner.Scan() {
		line := scanner.Text()
		trimmed := strings.TrimSpace(line)
		if trimmed != "" && !strings.HasPrefix(trimmed, "#") {
			if rewritten, ok := h.rewriteM3UTarget(p, trimmed); ok {
				line = rewritten
			}
		}
		out.WriteString(line)
		out.WriteByte('\n')
	}
	if scanner.Err() != nil {
		return body
	}
	return []byte(out.String())
}

func (h *Handler) rewriteM3UTarget(p provider.Provider, raw string) (string, bool) {
	target, err := url.Parse(raw)
	if err != nil || target.Scheme == "" || target.Host == "" {
		return "", false
	}

	providerBase, err := url.Parse(strings.TrimSuffix(p.Host, "/"))
	if err != nil {
		return "", false
	}
	streamPath := target.Path
	if basePath := strings.TrimSuffix(providerBase.Path, "/"); basePath != "" && strings.HasPrefix(streamPath, basePath+"/") {
		streamPath = strings.TrimPrefix(streamPath, basePath)
	}

	segments := strings.Split(strings.TrimPrefix(streamPath, "/"), "/")
	if len(segments) == 0 {
		return "", false
	}
	switch segments[0] {
	case "live", "movie", "series", "timeshift":
		if len(segments) < 4 {
			return "", false
		}
		segments[1] = p.LocalUsername
		segments[2] = p.LocalPassword
		streamPath = "/" + strings.Join(segments, "/")
	case "streaming":
		q := target.Query()
		if q.Get("username") == "" && q.Get("password") == "" {
			return "", false
		}
		q.Set("username", p.LocalUsername)
		q.Set("password", p.LocalPassword)
		target.RawQuery = q.Encode()
	default:
		return "", false
	}

	publicBase := strings.TrimSuffix(h.appURL, "/") + "/" + p.Route
	return publicBase + streamPath + querySuffix(target.RawQuery), true
}

func querySuffix(rawQuery string) string {
	if rawQuery == "" {
		return ""
	}
	return "?" + rawQuery
}
