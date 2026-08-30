package proxy

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"path"
	"regexp"
	"strings"
	"time"

	"github.com/abdulmalik813/iptv-proxy/internal/provider"
	"github.com/abdulmalik813/iptv-proxy/internal/routing"
	"github.com/redis/go-redis/v9"
)

const hlsTokenTTL = 6 * time.Hour

var uriAttribute = regexp.MustCompile(`URI="([^"]+)"`)

type hlsTarget struct {
	ProviderID string `json:"providerId"`
	URL        string `json:"url"`
}

type bufferedReadCloser struct {
	reader *bufio.Reader
	closer io.Closer
}

func (b *bufferedReadCloser) Read(p []byte) (int, error) {
	return b.reader.Read(p)
}

func (b *bufferedReadCloser) Close() error {
	return b.closer.Close()
}

func isHLSResponse(resp *http.Response, requested *url.URL) bool {
	contentType := strings.ToLower(resp.Header.Get("Content-Type"))
	responsePath := ""
	if resp.Request != nil && resp.Request.URL != nil {
		responsePath = resp.Request.URL.Path
	}
	requestedPath := ""
	if requested != nil {
		requestedPath = requested.Path
	}
	return strings.Contains(contentType, "mpegurl") ||
		strings.EqualFold(path.Ext(responsePath), ".m3u8") ||
		strings.EqualFold(path.Ext(requestedPath), ".m3u8")
}

// prepareHLSResponse preserves the response body while peeking at its prefix.
// Some Xtream providers return an HLS playlist from a .ts or extensionless URL
// with an incorrect Content-Type; sniffing #EXTM3U keeps those responses on the
// HLS rewrite path instead of accidentally streaming the playlist as MPEG-TS.
func prepareHLSResponse(resp *http.Response, requested *url.URL) bool {
	if isHLSResponse(resp, requested) || resp.Body == nil {
		return isHLSResponse(resp, requested)
	}

	reader := bufio.NewReaderSize(resp.Body, 4*1024)
	prefix, _ := reader.Peek(64)
	resp.Body = &bufferedReadCloser{reader: reader, closer: resp.Body}
	if !looksLikeHLSPlaylistPrefix(prefix) {
		return false
	}
	resp.Header.Set("Content-Type", "application/vnd.apple.mpegurl")
	return true
}

func looksLikeHLSPlaylistPrefix(prefix []byte) bool {
	prefix = bytes.TrimPrefix(prefix, []byte{0xEF, 0xBB, 0xBF})
	prefix = bytes.TrimLeft(prefix, " \t\r\n")
	return bytes.HasPrefix(prefix, []byte("#EXTM3U"))
}

func (h *Handler) serveHLSPlaylist(w http.ResponseWriter, ctx context.Context, p provider.Provider, resp *http.Response) {
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxHLSPlaylistBytes+1))
	if err != nil || len(body) > maxHLSPlaylistBytes {
		http.Error(w, "invalid HLS playlist", http.StatusBadGateway)
		return
	}
	base := resp.Request.URL
	h.serveHLSBytes(w, ctx, p, base, resp.StatusCode, body)
}

func (h *Handler) serveHLSBytes(w http.ResponseWriter, ctx context.Context, p provider.Provider, base *url.URL, status int, body []byte) {
	rewritten, err := h.rewritePlaylist(ctx, p, base, body)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Del("Content-Length")
	w.WriteHeader(status)
	_, _ = w.Write(rewritten)
}

func (h *Handler) rewritePlaylist(ctx context.Context, p provider.Provider, base *url.URL, body []byte) ([]byte, error) {
	var out strings.Builder
	scanner := bufio.NewScanner(bytes.NewReader(body))
	scanner.Buffer(make([]byte, 64*1024), maxHLSPlaylistBytes)
	firstLine := true
	for scanner.Scan() {
		line := scanner.Text()
		if firstLine {
			line = strings.TrimPrefix(line, "\uFEFF")
			firstLine = false
		}
		trimmed := strings.TrimSpace(line)
		var err error
		if strings.HasPrefix(trimmed, "#") {
			// Normalize harmless indentation so tags are always recognized while
			// still preserving every tag value and URI attribute.
			line, err = h.rewriteURIAttributes(ctx, p, base, trimmed)
		} else if trimmed != "" {
			line, err = h.storeHLSTarget(ctx, p, base, trimmed)
		}
		if err != nil {
			return nil, err
		}
		out.WriteString(line)
		out.WriteByte('\n')
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	return []byte(out.String()), nil
}

func (h *Handler) rewriteURIAttributes(ctx context.Context, p provider.Provider, base *url.URL, line string) (string, error) {
	matches := uriAttribute.FindAllStringSubmatchIndex(line, -1)
	if len(matches) == 0 {
		return line, nil
	}
	var out strings.Builder
	last := 0
	for _, match := range matches {
		if len(match) != 4 {
			continue
		}
		out.WriteString(line[last:match[2]])
		proxyURL, err := h.storeHLSTarget(ctx, p, base, line[match[2]:match[3]])
		if err != nil {
			return "", err
		}
		out.WriteString(proxyURL)
		last = match[3]
	}
	out.WriteString(line[last:])
	return out.String(), nil
}

func (h *Handler) storeHLSTarget(ctx context.Context, p provider.Provider, base *url.URL, raw string) (string, error) {
	relative, err := url.Parse(raw)
	if err != nil {
		return "", err
	}
	target := base.ResolveReference(relative)
	if strings.EqualFold(target.Scheme, "data") {
		// Inline keys/maps are already self-contained and must stay inline.
		return raw, nil
	}
	if target.Scheme != "http" && target.Scheme != "https" {
		return "", errors.New("unsupported HLS child URL scheme")
	}
	tokenBytes := make([]byte, 18)
	if _, err := rand.Read(tokenBytes); err != nil {
		return "", err
	}
	token := base64.RawURLEncoding.EncodeToString(tokenBytes)
	encoded, err := json.Marshal(hlsTarget{ProviderID: p.ID, URL: target.String()})
	if err != nil {
		return "", err
	}
	if err := h.redis.Set(ctx, "hls:"+token, encoded, hlsTokenTTL).Err(); err != nil {
		return "", err
	}
	prefix := h.appURL
	if route := strings.Trim(p.Route, "/"); route != "" {
		prefix += "/" + route
	}
	return prefix + "/_hls/" + token, nil
}

func (h *Handler) serveHLSToken(w http.ResponseWriter, r *http.Request, resolved routing.Resolved) {
	token := strings.TrimPrefix(resolved.RemainingPath, "/_hls/")
	if token == "" || strings.Contains(token, "/") {
		http.NotFound(w, r)
		return
	}
	key := "hls:" + token
	encoded, err := h.redis.Get(r.Context(), key).Bytes()
	if err != nil {
		if errors.Is(err, redis.Nil) {
			http.NotFound(w, r)
			return
		}
		http.Error(w, "HLS token store unavailable", http.StatusBadGateway)
		return
	}
	// Keep active HLS sessions alive while the player is still requesting
	// playlist children; idle sessions still expire naturally.
	_ = h.redis.Expire(r.Context(), key, hlsTokenTTL).Err()

	var target hlsTarget
	if err := json.Unmarshal(encoded, &target); err != nil || target.ProviderID != resolved.Provider.ID {
		http.NotFound(w, r)
		return
	}
	parsed, err := url.Parse(target.URL)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		http.Error(w, "invalid HLS target", http.StatusBadGateway)
		return
	}
	h.serveDirect(w, r, resolved.Provider, parsed)
}
