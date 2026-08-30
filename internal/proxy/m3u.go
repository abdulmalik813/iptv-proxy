package proxy

import (
	"bytes"
	"net/url"
	"strings"

	"github.com/abdulmalik813/iptv-proxy/internal/provider"
)

func (h *Handler) rewriteM3UPlaylist(p provider.Provider, clientUser provider.User, body []byte) []byte {
	lines := bytes.Split(body, []byte("\n"))
	for i, rawLine := range lines {
		line := string(rawLine)
		trimmed := strings.TrimSpace(line)
		if trimmed != "" && !strings.HasPrefix(trimmed, "#") {
			if rewritten, ok := h.rewriteM3UTarget(p, clientUser, trimmed); ok {
				line = rewritten
			}
		}
		lines[i] = []byte(line)
	}
	return bytes.Join(lines, []byte("\n"))
}

func (h *Handler) rewriteM3UTarget(p provider.Provider, clientUser provider.User, raw string) (string, bool) {
	if clientUser.Username == "" || clientUser.ClientPassword == "" {
		return "", false
	}
	urlPart, pipeOptions := splitM3UPipeOptions(raw)
	target, err := url.Parse(urlPart)
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
		segments[1] = clientUser.Username
		segments[2] = clientUser.ClientPassword
		streamPath = "/" + strings.Join(segments, "/")
	case "streaming":
		q := target.Query()
		if q.Get("username") == "" && q.Get("password") == "" {
			return "", false
		}
		q.Set("username", clientUser.Username)
		q.Set("password", clientUser.ClientPassword)
		target.RawQuery = q.Encode()
	default:
		return "", false
	}

	publicBase := strings.TrimSuffix(h.appURL, "/") + "/" + p.Route
	return publicBase + streamPath + querySuffix(target.RawQuery) + pipeOptions, true
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
