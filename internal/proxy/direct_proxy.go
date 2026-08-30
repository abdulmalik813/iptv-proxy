package proxy

import (
	"net/http"
	"net/url"

	"github.com/abdulmalik813/iptv-proxy/internal/provider"
)

func (h *Handler) serveDirect(w http.ResponseWriter, r *http.Request, p provider.Provider, target *url.URL) {
	req, err := http.NewRequestWithContext(r.Context(), r.Method, target.String(), r.Body)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	copySafeRequestHeaders(req.Header, r.Header)
	resp, err := h.streamClient.Do(req)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	if isHLSResponse(resp, target) {
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
