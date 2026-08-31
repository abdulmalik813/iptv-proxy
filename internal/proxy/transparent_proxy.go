package proxy

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"path"
	"strconv"
	"strings"
	"time"

	"github.com/abdulmalik813/iptv-proxy/internal/provider"
	"github.com/abdulmalik813/iptv-proxy/internal/routing"
)

func looksLikeJSONResponse(resp *http.Response, target *url.URL) bool {
	contentType := strings.ToLower(resp.Header.Get("Content-Type"))
	if strings.Contains(contentType, "json") {
		return true
	}
	return target != nil && strings.EqualFold(path.Ext(target.Path), ".json")
}

func looksLikeXMLResponse(resp *http.Response, target *url.URL, endpoint string) bool {
	if endpoint == "xmltv.php" || endpoint == "enigma2.php" {
		return true
	}
	contentType := strings.ToLower(resp.Header.Get("Content-Type"))
	if strings.Contains(contentType, "xml") {
		return true
	}
	if target == nil {
		return false
	}
	ext := strings.ToLower(path.Ext(target.Path))
	return ext == ".xml" || ext == ".xmltv"
}

func looksLikeM3UResponse(resp *http.Response, target *url.URL, endpoint string) bool {
	if endpoint == "get.php" {
		return true
	}
	if target != nil {
		ext := strings.ToLower(path.Ext(target.Path))
		if ext == ".m3u" {
			return true
		}
	}
	contentType := strings.ToLower(resp.Header.Get("Content-Type"))
	return strings.Contains(contentType, "mpegurl") || strings.Contains(contentType, "x-mpegurl")
}

func looksLikeHLSBody(body []byte) bool {
	trimmed := bytes.TrimSpace(body)
	if !bytes.HasPrefix(trimmed, []byte("#EXTM3U")) {
		return false
	}
	upper := bytes.ToUpper(trimmed)
	return bytes.Contains(upper, []byte("#EXT-X-"))
}

func (h *Handler) rewriteTransparentBody(ctxRequest *http.Request, resolved routing.Resolved, clientUser provider.User, endpoint string, target *url.URL, resp *http.Response, body []byte) ([]byte, string) {
	publicBase := h.xtreamPublicBase(resolved)
	if looksLikeJSONResponse(resp, target) || json.Valid(bytes.TrimSpace(body)) {
		body = h.rewriteXtreamBootstrap(resolved, clientUser, body)
		body = rewriteXtreamJSONURLs(resolved.Provider, clientUser, publicBase, body)
		body = h.rewriteJSONArtwork(ctxRequest.Context(), resolved.Provider, body)
		return body, "application/json"
	}

	if looksLikeXMLResponse(resp, target, endpoint) {
		body = rewriteXtreamXMLURLs(resolved.Provider, clientUser, publicBase, body)
		body = h.rewriteXMLTVArtwork(ctxRequest.Context(), resolved.Provider, body)
		return body, "application/xml"
	}

	if looksLikeM3UResponse(resp, target, endpoint) && bytes.HasPrefix(bytes.TrimSpace(body), []byte("#EXTM3U")) {
		if endpoint != "get.php" && looksLikeHLSBody(body) {
			base := target
			if resp.Request != nil && resp.Request.URL != nil {
				base = resp.Request.URL
			}
			rewritten, err := h.rewritePlaylist(ctxRequest.Context(), resolved.Provider, base, body)
			if err == nil {
				return rewritten, "application/vnd.apple.mpegurl"
			}
			return body, resp.Header.Get("Content-Type")
		}
		body = h.rewriteM3UArtwork(ctxRequest.Context(), resolved.Provider, body)
		body = h.rewriteM3UPlaylist(resolved.Provider, clientUser, body)
		return body, "audio/x-mpegurl"
	}
	return body, resp.Header.Get("Content-Type")
}

// serveTransparent forwards an authenticated request without requiring a
// predeclared Xtream endpoint. Application headers/method/body are preserved;
// only proxy infrastructure headers and previously translated credentials are
// different. Structured responses are rewritten back into the local namespace.
func (h *Handler) serveTransparent(w http.ResponseWriter, r *http.Request, resolved routing.Resolved, clientUser provider.User, endpoint string, target *url.URL) {
	started := time.Now()
	outgoingURL := safeURLString(target.String())
	req, err := http.NewRequestWithContext(r.Context(), r.Method, target.String(), r.Body)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	copySafeRequestHeaders(req.Header, r.Header)

	h.trace(r.Context(), "info", "upstream.request", "Outgoing transparent IPTV request to provider", map[string]any{
		"direction":     "outgoing",
		"method":        r.Method,
		"url":           outgoingURL,
		"outgoingUrl":   outgoingURL,
		"providerId":    resolved.Provider.ID,
		"providerName":  resolved.Provider.Name,
		"providerRoute": resolved.Provider.Route,
		"endpoint":      endpoint,
		"transparent":   true,
		"userAgent":     req.UserAgent(),
	})

	resp, err := h.streamClient.Do(req)
	if err != nil {
		h.trace(r.Context(), "error", "upstream.error", "Outgoing transparent IPTV request failed", map[string]any{
			"direction":    "outgoing",
			"method":       r.Method,
			"url":          outgoingURL,
			"outgoingUrl":  outgoingURL,
			"providerId":   resolved.Provider.ID,
			"providerName": resolved.Provider.Name,
			"endpoint":     endpoint,
			"transparent":  true,
			"elapsedMs":    time.Since(started).Milliseconds(),
			"error":        err.Error(),
		})
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	h.trace(r.Context(), "info", "upstream.response", "Incoming transparent IPTV response from provider", map[string]any{
		"direction":     "incoming",
		"method":        r.Method,
		"url":           outgoingURL,
		"outgoingUrl":   outgoingURL,
		"providerId":    resolved.Provider.ID,
		"providerName":  resolved.Provider.Name,
		"providerRoute": resolved.Provider.Route,
		"endpoint":      endpoint,
		"transparent":   true,
		"status":        resp.StatusCode,
		"contentType":   resp.Header.Get("Content-Type"),
		"contentLength": resp.ContentLength,
		"elapsedMs":     time.Since(started).Milliseconds(),
	})

	copyResponseHeaders(w.Header(), resp.Header)
	if r.Method == http.MethodHead {
		w.WriteHeader(resp.StatusCode)
		return
	}

	structured := looksLikeJSONResponse(resp, target) || looksLikeXMLResponse(resp, target, endpoint) || looksLikeM3UResponse(resp, target, endpoint)
	if !structured || resp.Header.Get("Content-Encoding") != "" {
		w.WriteHeader(resp.StatusCode)
		controller := http.NewResponseController(w)
		buf := make([]byte, 128*1024)
		for {
			n, readErr := resp.Body.Read(buf)
			if n > 0 {
				if _, writeErr := w.Write(buf[:n]); writeErr != nil {
					return
				}
				_ = controller.Flush()
			}
			if readErr != nil {
				return
			}
		}
	}

	body, err := io.ReadAll(io.LimitReader(resp.Body, maxDirectMetadataBytes+1))
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	if len(body) > maxDirectMetadataBytes {
		http.Error(w, "provider structured response is too large", http.StatusBadGateway)
		return
	}
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		var contentType string
		body, contentType = h.rewriteTransparentBody(r, resolved, clientUser, endpoint, target, resp, body)
		if contentType != "" {
			w.Header().Set("Content-Type", contentType)
		}
	}
	w.Header().Del("Content-Length")
	w.Header().Set("Content-Length", strconv.Itoa(len(body)))
	w.WriteHeader(resp.StatusCode)
	_, _ = w.Write(body)
}
