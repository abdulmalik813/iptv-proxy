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

var uriAttribute = regexp.MustCompile(`URI="([^"]+)"`)

type hlsTarget struct {
	ProviderID string `json:"providerId"`
	URL        string `json:"url"`
}

func isHLSResponse(resp *http.Response, requested *url.URL) bool {
	contentType := strings.ToLower(resp.Header.Get("Content-Type"))
	return strings.Contains(contentType, "mpegurl") ||
		strings.EqualFold(path.Ext(resp.Request.URL.Path), ".m3u8") ||
		strings.EqualFold(path.Ext(requested.Path), ".m3u8")
}

func (h *Handler) serveHLSPlaylist(w http.ResponseWriter, ctx context.Context, p provider.Provider, resp *http.Response) {
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxHLSPlaylistBytes+1))
	if err != nil || len(body) > maxHLSPlaylistBytes {
		http.Error(w, "invalid HLS playlist", http.StatusBadGateway)
		return
	}
	rewritten, err := h.rewritePlaylist(ctx, p, resp.Request.URL, body)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Del("Content-Length")
	w.WriteHeader(resp.StatusCode)
	_, _ = w.Write(rewritten)
}

func (h *Handler) rewritePlaylist(ctx context.Context, p provider.Provider, base *url.URL, body []byte) ([]byte, error) {
	var out strings.Builder
	scanner := bufio.NewScanner(bytes.NewReader(body))
	scanner.Buffer(make([]byte, 64*1024), maxHLSPlaylistBytes)
	for scanner.Scan() {
		line := scanner.Text()
		var err error
		if strings.HasPrefix(line, "#") {
			line, err = h.rewriteURIAttributes(ctx, p, base, line)
		} else if strings.TrimSpace(line) != "" {
			line, err = h.storeHLSTarget(ctx, p, base, strings.TrimSpace(line))
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
	if err := h.redis.Set(ctx, "hls:"+token, encoded, 6*time.Hour).Err(); err != nil {
		return "", err
	}
	return h.appURL + "/" + p.Route + "/_hls/" + token, nil
}

func (h *Handler) serveHLSToken(w http.ResponseWriter, r *http.Request, resolved routing.Resolved) {
	token := strings.TrimPrefix(resolved.RemainingPath, "/_hls/")
	if token == "" || strings.Contains(token, "/") {
		http.NotFound(w, r)
		return
	}
	encoded, err := h.redis.Get(r.Context(), "hls:"+token).Bytes()
	if err != nil {
		if errors.Is(err, redis.Nil) {
			http.NotFound(w, r)
			return
		}
		http.Error(w, "HLS token store unavailable", http.StatusBadGateway)
		return
	}
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
