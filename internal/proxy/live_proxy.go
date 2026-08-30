package proxy

import (
	"context"
	"net/http"
	"net/url"

	"github.com/abdulmalik813/iptv-proxy/internal/provider"
)

func (h *Handler) serveLiveMultiplexed(w http.ResponseWriter, r *http.Request, p provider.Provider, target *url.URL) {
	key := liveStreamKey(p.ID, target)
	session, viewer, err := h.live.Subscribe(r.Context(), key, func(ctx context.Context) (*http.Response, error) {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, target.String(), nil)
		if err != nil {
			return nil, err
		}
		copySafeRequestHeaders(req.Header, r.Header)
		req.Header.Del("Range")
		return h.streamClient.Do(req)
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
