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

func (h *Handler) writeDirectResult(w http.ResponseWriter, r *http.Request, p provider.Provider, result directUpstreamResult, detectedHLS bool, extra map[string]any) {
	defer result.resp.Body.Close()
	h.traceDirectResponse(r, p, result, detectedHLS, extra)

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

func (h *Handler) serveCatchupDirect(w http.ResponseWriter, r *http.Request, p provider.Provider, target *url.URL) {
	preferred := h.preferredCatchupFormat(r.Context(), p)
	candidates, ok := buildCatchupCandidates(target, preferred)
	if !ok || len(candidates) == 0 {
		http.Error(w, "invalid catch-up request", http.StatusBadRequest)
		return
	}

	lastStatus := 0
	var lastErr error
	invalidSuccess := false
	rangeHeader := r.Header.Get("Range")
	for index, candidate := range candidates {
		h.trace(r.Context(), "debug", "catchup.candidate", "Trying Xtream catch-up provider format", map[string]any{
			"providerId":      p.ID,
			"providerName":    p.Name,
			"providerRoute":   p.Route,
			"candidateIndex":  index,
			"candidateFormat": candidate.Format,
			"preferred":       preferred != "" && candidate.Format == preferred,
			"outgoingUrl":     safeURLString(candidate.URL.String()),
		})

		result, err := h.doDirectUpstream(r, p, candidate.URL)
		if err != nil {
			lastErr = err
			continue
		}
		status := result.resp.StatusCode
		lastStatus = status

		// Session/account failures are not format failures. Never turn them into a
		// burst of extra provider connections by trying alternate URL spellings.
		if isDecisiveCatchupStatus(status) {
			h.writeDirectResult(w, r, p, result, false, map[string]any{
				"catchupCandidate": candidate.Format,
				"catchupDecisive":  true,
			})
			return
		}
		// Range EOF/probe responses are meaningful to video players and should be
		// passed through rather than converted into another provider request.
		if status == http.StatusRequestedRangeNotSatisfiable && rangeHeader != "" {
			h.writeDirectResult(w, r, p, result, false, map[string]any{
				"catchupCandidate": candidate.Format,
			})
			return
		}

		if status == http.StatusOK || status == http.StatusPartialContent {
			accepted, detectedHLS, reason, probeErr := probeCatchupResponse(result.resp, candidate.URL, rangeHeader)
			if probeErr != nil {
				lastErr = probeErr
			}
			if accepted {
				if r.Method == http.MethodGet {
					h.rememberCatchupFormat(r.Context(), p, candidate.Format)
				}
				h.trace(r.Context(), "info", "catchup.selected", "Xtream catch-up provider format validated", map[string]any{
					"providerId":      p.ID,
					"providerName":    p.Name,
					"providerRoute":   p.Route,
					"candidateFormat": candidate.Format,
					"validation":      reason,
					"outgoingUrl":     safeURLString(candidate.URL.String()),
				})
				h.writeDirectResult(w, r, p, result, detectedHLS, map[string]any{
					"catchupCandidate": candidate.Format,
					"catchupValidation": reason,
				})
				return
			}
			invalidSuccess = true
			h.traceDirectResponse(r, p, result, false, map[string]any{
				"catchupCandidate": candidate.Format,
				"catchupRejected":  true,
				"rejectionReason":  reason,
			})
			h.trace(r.Context(), "warning", "catchup.candidate_rejected", "Xtream catch-up success response did not contain usable archive media", map[string]any{
				"providerId":      p.ID,
				"providerName":    p.Name,
				"providerRoute":   p.Route,
				"candidateFormat": candidate.Format,
				"status":          status,
				"reason":          reason,
				"outgoingUrl":     safeURLString(candidate.URL.String()),
			})
			_ = result.resp.Body.Close()
			continue
		}

		h.traceDirectResponse(r, p, result, false, map[string]any{
			"catchupCandidate": candidate.Format,
			"catchupRejected":  true,
		})
		_ = result.resp.Body.Close()
	}

	if invalidSuccess {
		http.Error(w, "provider catch-up returned no valid MPEG-TS archive", http.StatusBadGateway)
		return
	}
	if lastStatus >= 400 {
		http.Error(w, "provider catch-up request failed", lastStatus)
		return
	}
	if lastErr != nil {
		http.Error(w, lastErr.Error(), http.StatusBadGateway)
		return
	}
	http.Error(w, "provider catch-up unavailable", http.StatusBadGateway)
}

func (h *Handler) serveDirect(w http.ResponseWriter, r *http.Request, p provider.Provider, target *url.URL) {
	if (r.Method == http.MethodGet || r.Method == http.MethodHead) && isXtreamCatchupTarget(target) && !isExplicitCatchupHLS(target) {
		h.serveCatchupDirect(w, r, p, target)
		return
	}

	result, err := h.doDirectUpstream(r, p, target)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}

	// Explicit HLS catch-up keeps the narrow path->PHP compatibility fallback;
	// ordinary TS catch-up is handled by the validated candidate resolver above.
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

	detectedHLS := false
	if r.Method != http.MethodHead && result.resp.StatusCode >= 200 && result.resp.StatusCode < 300 {
		if shouldSniffHiddenHLS(target) {
			detectedHLS = prepareHLSResponse(result.resp, target)
		} else {
			detectedHLS = isHLSResponse(result.resp, target)
		}
	}
	h.writeDirectResult(w, r, p, result, detectedHLS, nil)
}
