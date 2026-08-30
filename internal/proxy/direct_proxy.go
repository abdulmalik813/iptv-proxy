package proxy

import (
	"net/http"
	"net/url"
	"time"

	"github.com/abdulmalik813/iptv-proxy/internal/provider"
)

type directUpstreamResult struct {
	resp        *http.Response
	started     time.Time
	outgoingURL string
}

func (h *Handler) doDirectUpstream(r *http.Request, p provider.Provider, target *url.URL) (directUpstreamResult, error) {
	started := time.Now()
	outgoingURL := safeURLString(target.String())
	req, err := http.NewRequestWithContext(r.Context(), r.Method, target.String(), r.Body)
	if err != nil {
		return directUpstreamResult{}, err
	}
	copySafeRequestHeaders(req.Header, r.Header)
	// IPTV media is already compressed at the codec/container layer. Keeping an
	// HTTP Accept-Encoding header can make an HLS manifest arrive gzip-compressed,
	// which prevents playlist inspection/rewriting and provides no benefit to TS.
	req.Header.Del("Accept-Encoding")
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
		return directUpstreamResult{}, err
	}
	return directUpstreamResult{resp: resp, started: started, outgoingURL: outgoingURL}, nil
}

func (h *Handler) traceDirectResponse(r *http.Request, p provider.Provider, result directUpstreamResult, detectedHLS bool, extra map[string]any) {
	meta := map[string]any{
		"direction":     "incoming",
		"method":        r.Method,
		"url":           result.outgoingURL,
		"outgoingUrl":   result.outgoingURL,
		"providerId":    p.ID,
		"providerName":  p.Name,
		"providerRoute": p.Route,
		"status":        result.resp.StatusCode,
		"contentType":   result.resp.Header.Get("Content-Type"),
		"contentLength": result.resp.ContentLength,
		"detectedHls":   detectedHLS,
		"elapsedMs":     time.Since(result.started).Milliseconds(),
	}
	for key, value := range extra {
		meta[key] = value
	}
	h.trace(r.Context(), "info", "upstream.response", "Incoming media response from IPTV provider", meta)
}

func (h *Handler) serveDirect(w http.ResponseWriter, r *http.Request, p provider.Provider, target *url.URL) {
	result, err := h.doDirectUpstream(r, p, target)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}

	// Some Xtream installations expose only streaming/timeshift.php even though
	// clients commonly request the path form. Retry only when the first response
	// clearly says the path route is unsupported. Account/session refusals are
	// intentionally never duplicated.
	if (r.Method == http.MethodGet || r.Method == http.MethodHead) && shouldTryTimeshiftPHPFallback(result.resp, target) {
		alternate, ok := timeshiftPHPAlternate(target)
		if ok {
			h.traceDirectResponse(r, p, result, false, map[string]any{"catchupFallback": true})
			_ = result.resp.Body.Close()
			h.trace(r.Context(), "warning", "catchup.fallback", "Xtream timeshift path rejected; trying PHP catch-up endpoint", map[string]any{
				"providerId":    p.ID,
				"providerName":  p.Name,
				"providerRoute": p.Route,
				"fromUrl":       safeURLString(target.String()),
				"toUrl":         safeURLString(alternate.String()),
				"status":        result.resp.StatusCode,
				"contentType":   result.resp.Header.Get("Content-Type"),
			})
			target = alternate
			result, err = h.doDirectUpstream(r, p, target)
			if err != nil {
				http.Error(w, err.Error(), http.StatusBadGateway)
				return
			}
		}
	}
	defer result.resp.Body.Close()

	detectedHLS := false
	if r.Method != http.MethodHead && result.resp.StatusCode >= 200 && result.resp.StatusCode < 300 {
		if shouldSniffHiddenHLS(target) {
			detectedHLS = prepareHLSResponse(result.resp, target)
		} else {
			// Catch-up .ts is expected to be a finite MPEG-TS recording. Honor an
			// explicitly requested/reported HLS response, but do not block playback
			// by peeking into an ordinary TS archive before forwarding its first bytes.
			detectedHLS = isHLSResponse(result.resp, target)
		}
	}
	h.traceDirectResponse(r, p, result, detectedHLS, nil)

	if r.Method == http.MethodHead {
		copyResponseHeaders(w.Header(), result.resp.Header)
		w.WriteHeader(result.resp.StatusCode)
		return
	}
	if detectedHLS {
		h.serveHLSPlaylist(w, r.Context(), p, result.resp)
		return
	}
	copyResponseHeaders(w.Header(), result.resp.Header)
	w.WriteHeader(result.resp.StatusCode)
	controller := http.NewResponseController(w)
	buf := make([]byte, 128*1024)
	for {
		n, readErr := result.resp.Body.Read(buf)
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
