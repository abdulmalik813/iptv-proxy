package proxy

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/abdulmalik813/iptv-proxy/internal/provider"
	"github.com/abdulmalik813/iptv-proxy/internal/stream"
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
		detectedHLS := prepareHLSResponse(resp, target)
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
			"detectedHls":   detectedHLS,
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

	if strings.Contains(strings.ToLower(session.Header().Get("Content-Type")), "mpegurl") {
		body, err := readMultiplexedHLS(r.Context(), viewer)
		if err != nil {
			h.trace(r.Context(), "error", "hls.read", "Failed to collect HLS playlist returned by live endpoint", map[string]any{
				"providerId":   p.ID,
				"providerName": p.Name,
				"streamKey":    key,
				"error":        err.Error(),
			})
			http.Error(w, "invalid HLS playlist", http.StatusBadGateway)
			return
		}
		base := session.ResponseURL()
		if base == nil {
			base = target
		}
		h.trace(r.Context(), "info", "hls.detected", "Live endpoint returned HLS and was switched from TS multiplexing to playlist rewriting", map[string]any{
			"providerId":   p.ID,
			"providerName": p.Name,
			"streamKey":    key,
			"bytes":        len(body),
		})
		h.serveHLSBytes(w, r.Context(), p, base, session.StatusCode(), body)
		return
	}

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

func readMultiplexedHLS(ctx context.Context, viewer *stream.Viewer) ([]byte, error) {
	var body bytes.Buffer
	for {
		chunk, err := viewer.Next(ctx)
		if len(chunk) > 0 {
			if body.Len()+len(chunk) > maxHLSPlaylistBytes {
				return nil, errors.New("HLS playlist exceeds maximum size")
			}
			_, _ = body.Write(chunk)
		}
		if err != nil {
			if errors.Is(err, io.EOF) {
				return body.Bytes(), nil
			}
			return nil, err
		}
	}
}
