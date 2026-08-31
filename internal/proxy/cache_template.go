package proxy

import (
	"bytes"
	"net/url"
	"strings"

	"github.com/abdulmalik813/iptv-proxy/internal/provider"
)

const (
	cacheTemplateContentTypePrefix = "x-iptv-cache-template-v1|"
	cachePathUserPlaceholder       = "__IPTV_PATH_USER_V1__"
	cachePathPassPlaceholder       = "__IPTV_PATH_PASS_V1__"
	cacheQueryUserPlaceholder      = "__IPTV_QUERY_USER_V1__"
	cacheQueryPassPlaceholder      = "__IPTV_QUERY_PASS_V1__"
)

type xtreamRewriteCredentials struct {
	PathUsername  string
	PathPassword  string
	QueryUsername string
	QueryPassword string
}

func clientXtreamCredentials(user provider.User) xtreamRewriteCredentials {
	return xtreamRewriteCredentials{
		PathUsername:  user.Username,
		PathPassword:  user.ClientPassword,
		QueryUsername: user.Username,
		QueryPassword: user.ClientPassword,
	}
}

func canonicalCacheCredentials() xtreamRewriteCredentials {
	return xtreamRewriteCredentials{
		PathUsername:  cachePathUserPlaceholder,
		PathPassword:  cachePathPassPlaceholder,
		QueryUsername: cacheQueryUserPlaceholder,
		QueryPassword: cacheQueryPassPlaceholder,
	}
}

func markCanonicalCacheContentType(contentType string) string {
	return cacheTemplateContentTypePrefix + contentType
}

func canonicalCacheContentType(contentType string) (string, bool) {
	if !strings.HasPrefix(contentType, cacheTemplateContentTypePrefix) {
		return contentType, false
	}
	return strings.TrimPrefix(contentType, cacheTemplateContentTypePrefix), true
}

// personalizeCanonicalCache performs only bounded literal substitutions on a
// cache hit. All URL discovery, JSON/M3U parsing, artwork rewriting and opaque
// media tokenization were already completed once when this generation was
// fetched. Path and query placeholders are separate so arbitrary client
// credentials retain correct URL escaping semantics in both locations.
func personalizeCanonicalCache(body []byte, user provider.User) []byte {
	if len(body) == 0 || user.Username == "" || user.ClientPassword == "" {
		return body
	}
	replacements := []struct {
		marker []byte
		value  []byte
	}{
		{[]byte(cachePathUserPlaceholder), []byte(url.PathEscape(user.Username))},
		{[]byte(cachePathPassPlaceholder), []byte(url.PathEscape(user.ClientPassword))},
		{[]byte(cacheQueryUserPlaceholder), []byte(url.QueryEscape(user.Username))},
		{[]byte(cacheQueryPassPlaceholder), []byte(url.QueryEscape(user.ClientPassword))},
	}
	out := body
	for _, replacement := range replacements {
		if !bytes.Contains(out, replacement.marker) {
			continue
		}
		out = bytes.ReplaceAll(out, replacement.marker, replacement.value)
	}
	return out
}
