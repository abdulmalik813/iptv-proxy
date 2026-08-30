package proxy

import (
	"context"
	"net/http"
	"net/url"
	"time"

	"github.com/abdulmalik813/iptv-proxy/internal/provider"
)

func (h *Handler) serveLiveMultiplexed(w http.ResponseWriter, r *http.Request, p provider.Provider, target *url.URL) {
	key := liveStreamKey(p.ID, target)
	outgoingURL := safeURLString(target.String())
	session, viewer, err := h.live.Subscribe(r.Context(), key, func(ctx context.Context) (*http.Response, error) {
		started := time.Now()
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, target.String(), nil)
		if err != nil {
			return nil, err
		}
		copySafeRequestHeaders(req.Header, r.Header)
		req.Header.Del("Range")
		h.trace(ctx, "info", "upstream.request", "Outgoing multiplexed live request to IPTV provider", map[string]any{
			"direction":     "outgoing",
			"method":        http.MethodGet,
			"url":           outgoingURL,
			"outgoingUrl":   outgoingURL,
			"providerId":    p.ID,
			"providerName":  p.Name,
			"providerRoute": p.Route,
			"streamKey":     key,
			"multiplexed":   true,
		})
		resp, err := h.streamClient.Do(req)
		if err != nil {
			h.trace(ctx, "error", "upstream.error", "Outgoing multiplexed live request failed", map[string]any{
				"direction":    "outgoing",
				"method":       http.MethodGet,
				"url":          outgoingURL,
				"outgoingUrl":  outgoingURL,
				"providerId":   p.ID,
				"providerName": p.Name,
				"streamKey":    key,
				"elapsedMs":    time.Since(started).Milliseconds(),
				"error":        err.Error(),
			})
			return nil, err
		}
		h.trace(ctx, "info", "upstream.response", "Incoming multiplexed live response from IPTV provider", map[string]any{
			"direction":     "incoming",
			"method":        http.MethodGet,
			"url":           outgoingURL,
			"outgoingUrl":   outgoingURL,
			"providerId":    p.ID,
			"providerName":  p.Name,
			"providerRoute": p.Route,
			"streamKey":     key,
			"multiplexed":   true,
			"status":        resp.StatusCode,
			"contentType":   resp.Header.Get("Content-Type"),
			"contentLength": resp.ContentLength,
			"elapsedMs":     time.Since(started).Milliseconds(),
		})
		return resp, nil
	})
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	defer session.Remove(viewer)

	copyResponseHeaders(w.Header(), session.Header())
	w.Header().Del("Content-Length")
	w.Header().Set("X-IPTV-Multiplexed", "1")
	w.WriteHeader(session.StatusCode())
	controller := http.NewResponseController(w)
	for {
		chunk, err := viewer.Next(r.Context())
		if err != nil {
			return
		}
		if len(chunk) == 0 {
			continue
		}
		if _, err := w.Write(chunk); err != nil {
			return
		}
		_ = controller.Flush()
	}
}
