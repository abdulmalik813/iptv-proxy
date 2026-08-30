package proxy

import (
	"bytes"
	"context"
	"encoding/json"
	"regexp"
	"strings"

	"github.com/abdulmalik813/iptv-proxy/internal/provider"
)

var (
	m3uLogoDouble = regexp.MustCompile(`(?i)\btvg-logo\s*=\s*"([^"]*)"`)
	m3uLogoSingle = regexp.MustCompile(`(?i)\btvg-logo\s*=\s*'([^']*)'`)
	xmlIconTag    = regexp.MustCompile(`(?is)<icon\b[^>]*>`)
	xmlSrcDouble  = regexp.MustCompile(`(?i)\bsrc\s*=\s*"([^"]*)"`)
	xmlSrcSingle  = regexp.MustCompile(`(?i)\bsrc\s*=\s*'([^']*)'`)
)

var jsonArtworkKeys = map[string]bool{
	"stream_icon":   true,
	"cover":         true,
	"cover_big":     true,
	"movie_image":   true,
	"backdrop_path": true,
	"poster_path":   true,
	"logo":          true,
	"icon":          true,
}

// rewriteCachedArtwork rewrites provider-supplied artwork once, when the shared
// metadata body is fetched/refreshed. The rewritten body is then shared by every
// local user, while M3U stream URLs are still personalized later at response time.
func (h *Handler) rewriteCachedArtwork(ctx context.Context, p provider.Provider, endpoint string, body []byte) []byte {
	switch endpoint {
	case "player_api.php":
		return h.rewriteJSONArtwork(ctx, p, body)
	case "get.php":
		return h.rewriteM3UArtwork(ctx, p, body)
	case "xmltv.php":
		return h.rewriteXMLTVArtwork(ctx, p, body)
	default:
		return body
	}
}

func (h *Handler) rewriteJSONArtwork(ctx context.Context, p provider.Provider, body []byte) []byte {
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return body
	}

	raws := make([]string, 0)
	collectJSONArtwork(value, "", &raws)
	rewrites := h.storeArtworkTargets(ctx, p, raws)
	if len(rewrites) == 0 {
		return body
	}
	replaceJSONArtwork(value, "", rewrites)
	encoded, err := json.Marshal(value)
	if err != nil {
		return body
	}
	return encoded
}

func collectJSONArtwork(value any, key string, raws *[]string) {
	switch typed := value.(type) {
	case map[string]any:
		for childKey, child := range typed {
			collectJSONArtwork(child, strings.ToLower(childKey), raws)
		}
	case []any:
		for _, child := range typed {
			collectJSONArtwork(child, key, raws)
		}
	case string:
		if jsonArtworkKeys[key] && looksLikeArtworkURL(typed) {
			*raws = append(*raws, typed)
		}
	}
}

func replaceJSONArtwork(value any, key string, rewrites map[string]string) {
	switch typed := value.(type) {
	case map[string]any:
		for childKey, child := range typed {
			lowerKey := strings.ToLower(childKey)
			if raw, ok := child.(string); ok && jsonArtworkKeys[lowerKey] {
				if replacement := rewrites[raw]; replacement != "" {
					typed[childKey] = replacement
					continue
				}
			}
			if list, ok := child.([]any); ok && jsonArtworkKeys[lowerKey] {
				for index, item := range list {
					if raw, ok := item.(string); ok {
						if replacement := rewrites[raw]; replacement != "" {
							list[index] = replacement
						}
					}
				}
			}
			replaceJSONArtwork(child, lowerKey, rewrites)
		}
	case []any:
		for _, child := range typed {
			replaceJSONArtwork(child, key, rewrites)
		}
	}
}

func looksLikeArtworkURL(raw string) bool {
	value := strings.TrimSpace(raw)
	if value == "" {
		return false
	}
	lower := strings.ToLower(value)
	return strings.HasPrefix(lower, "http://") ||
		strings.HasPrefix(lower, "https://") ||
		strings.HasPrefix(value, "/") ||
		strings.Contains(value, "/")
}

func (h *Handler) rewriteM3UArtwork(ctx context.Context, p provider.Provider, body []byte) []byte {
	lines := bytes.Split(body, []byte("\n"))
	raws := make([]string, 0)
	for _, line := range lines {
		raws = append(raws, artworkAttributeValues(line, m3uLogoDouble)...)
		raws = append(raws, artworkAttributeValues(line, m3uLogoSingle)...)
	}
	rewrites := h.storeArtworkTargets(ctx, p, raws)
	if len(rewrites) == 0 {
		return body
	}
	for index, line := range lines {
		line = replaceArtworkAttributeValues(line, m3uLogoDouble, rewrites)
		line = replaceArtworkAttributeValues(line, m3uLogoSingle, rewrites)
		lines[index] = line
	}
	return bytes.Join(lines, []byte("\n"))
}

func (h *Handler) rewriteXMLTVArtwork(ctx context.Context, p provider.Provider, body []byte) []byte {
	raws := make([]string, 0)
	for _, tagIndex := range xmlIconTag.FindAllIndex(body, -1) {
		tag := body[tagIndex[0]:tagIndex[1]]
		raws = append(raws, artworkAttributeValues(tag, xmlSrcDouble)...)
		raws = append(raws, artworkAttributeValues(tag, xmlSrcSingle)...)
	}
	rewrites := h.storeArtworkTargets(ctx, p, raws)
	if len(rewrites) == 0 {
		return body
	}
	return xmlIconTag.ReplaceAllFunc(body, func(tag []byte) []byte {
		tag = replaceArtworkAttributeValues(tag, xmlSrcDouble, rewrites)
		tag = replaceArtworkAttributeValues(tag, xmlSrcSingle, rewrites)
		return tag
	})
}

func artworkAttributeValues(input []byte, expression *regexp.Regexp) []string {
	matches := expression.FindAllSubmatch(input, -1)
	values := make([]string, 0, len(matches))
	for _, match := range matches {
		if len(match) >= 2 && len(match[1]) > 0 {
			values = append(values, string(match[1]))
		}
	}
	return values
}

func replaceArtworkAttributeValues(input []byte, expression *regexp.Regexp, rewrites map[string]string) []byte {
	matches := expression.FindAllSubmatchIndex(input, -1)
	if len(matches) == 0 {
		return input
	}
	out := append([]byte(nil), input...)
	for index := len(matches) - 1; index >= 0; index-- {
		match := matches[index]
		if len(match) < 4 || match[2] < 0 || match[3] < 0 {
			continue
		}
		raw := string(out[match[2]:match[3]])
		replacement := rewrites[raw]
		if replacement == "" {
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
