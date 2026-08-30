package proxy

import (
	"net/http"
	"net/url"
	"time"

	"github.com/abdulmalik813/iptv-proxy/internal/provider"
)

func (h *Handler) serveDirect(w http.ResponseWriter, r *http.Request, p provider.Provider, target *url.URL) {
	started := time.Now()
	outgoingURL := safeURLString(target.String())
	req, err := http.NewRequestWithContext(r.Context(), r.Method, target.String(), r.Body)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	copySafeRequestHeaders(req.Header, r.Header)
	h.trace(r.Context(), "info", "upstream.request", "Outgoing media request to IPTV provider", map[string]any{
		"direction":     "outgoing",
		"method":        r.Method,
		"url":           outgoingURL,
		"outgoingUrl":   outgoingURL,
		"providerId":    p.ID,
		"providerName":  p.Name,
		"providerRoute": p.Route,
	})
	resp, err := h.streamClient.Do(req)
	if err != nil {
		h.trace(r.Context(), "error", "upstream.error", "Outgoing media request to IPTV provider failed", map[string]any{
			"direction":    "outgoing",
			"method":       r.Method,
			"url":          outgoingURL,
			"outgoingUrl":  outgoingURL,
			"providerId":   p.ID,
			"providerName": p.Name,
			"elapsedMs":    time.Since(started).Milliseconds(),
			"error":        err.Error(),
		})
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	detectedHLS := false
	if r.Method != http.MethodHead && resp.StatusCode >= 200 && resp.StatusCode < 300 {
		detectedHLS = prepareHLSResponse(resp, target)
	}
	h.trace(r.Context(), "info", "upstream.response", "Incoming media response from IPTV provider", map[string]any{
		"direction":     "incoming",
		"method":        r.Method,
		"url":           outgoingURL,
		"outgoingUrl":   outgoingURL,
		"providerId":    p.ID,
		"providerName":  p.Name,
		"providerRoute": p.Route,
		"status":        resp.StatusCode,
		"contentType":   resp.Header.Get("Content-Type"),
		"contentLength": resp.ContentLength,
		"detectedHls":   detectedHLS,
		"elapsedMs":     time.Since(started).Milliseconds(),
	})

	if r.Method == http.MethodHead {
		copyResponseHeaders(w.Header(), resp.Header)
		w.WriteHeader(resp.StatusCode)
		return
	}
	if detectedHLS {
		h.serveHLSPlaylist(w, r.Context(), p, resp)
		return
	}
	copyResponseHeaders(w.Header(), resp.Header)
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
