package proxy

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/abdulmalik813/iptv-proxy/internal/provider"
	"github.com/abdulmalik813/iptv-proxy/internal/routing"
)

const maxXtreamFormBytes = 1 << 20
const maxDirectMetadataBytes = 256 << 20

func isMetadataEndpoint(endpoint string) bool {
	switch endpoint {
	case "player_api.php", "get.php", "xmltv.php":
		return true
	default:
		return false
	}
}

// xtreamRequestValues accepts both the normal Xtream GET form and the POST
// application/x-www-form-urlencoded form used by players such as Smarters.
// POST values override query-string values, matching normal HTML form behavior.
// The body is restored because request logging and any later handler may still
// need to inspect it.
func xtreamRequestValues(r *http.Request) (url.Values, error) {
	values := cloneURLValues(r.URL.Query())
	if r.Method != http.MethodPost || r.Body == nil {
		return values, nil
	}

	body, err := io.ReadAll(io.LimitReader(r.Body, maxXtreamFormBytes+1))
	if err != nil {
		return nil, fmt.Errorf("read Xtream form body: %w", err)
	}
	r.Body = io.NopCloser(bytes.NewReader(body))
	if len(body) == 0 {
		return values, nil
	}
	if len(body) > maxXtreamFormBytes {
		return nil, fmt.Errorf("Xtream form body is too large")
	}

	form, err := url.ParseQuery(string(body))
	if err != nil {
		return nil, fmt.Errorf("parse Xtream form body: %w", err)
	}
	for key, items := range form {
		values[key] = append([]string(nil), items...)
	}
	return values, nil
}

func cloneURLValues(input url.Values) url.Values {
	output := make(url.Values, len(input))
	for key, items := range input {
		output[key] = append([]string(nil), items...)
	}
	return output
}

// serveDirectMetadata handles metadata actions that intentionally bypass the
// persistent catalog cache. They still need the same credential isolation and
// artwork rewriting as cached responses. Client POST calls are normalized to a
// provider GET so local credentials from the POST body can never leak upstream.
func (h *Handler) serveDirectMetadata(w http.ResponseWriter, r *http.Request, resolved routing.Resolved, clientUser provider.User, endpoint string, target *url.URL) {
	if r.Method != http.MethodGet && r.Method != http.MethodPost && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, POST, HEAD")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	upstreamMethod := http.MethodGet
	if r.Method == http.MethodHead {
		upstreamMethod = http.MethodHead
	}
	started := time.Now()
	outgoingURL := safeURLString(target.String())
	req, err := http.NewRequestWithContext(r.Context(), upstreamMethod, target.String(), nil)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	copySafeRequestHeaders(req.Header, r.Header)
	req.Header.Del("Accept-Encoding")
	req.Header.Del("Content-Length")
	req.Header.Del("Content-Type")

	h.trace(r.Context(), "info", "upstream.request", "Outgoing metadata request to IPTV provider", map[string]any{
		"direction":     "outgoing",
		"method":        upstreamMethod,
		"url":           outgoingURL,
		"outgoingUrl":   outgoingURL,
		"providerId":    resolved.Provider.ID,
		"providerName":  resolved.Provider.Name,
		"providerRoute": resolved.Provider.Route,
		"endpoint":      endpoint,
		"action":        target.Query().Get("action"),
		"clientMethod":  r.Method,
	})

	resp, err := h.metadataClient.Do(req)
	if err != nil {
		h.trace(r.Context(), "error", "upstream.error", "Outgoing metadata request to IPTV provider failed", map[string]any{
			"direction":    "outgoing",
			"method":       upstreamMethod,
			"url":          outgoingURL,
			"outgoingUrl":  outgoingURL,
			"providerId":   resolved.Provider.ID,
			"providerName": resolved.Provider.Name,
			"endpoint":     endpoint,
			"action":       target.Query().Get("action"),
			"elapsedMs":    time.Since(started).Milliseconds(),
			"error":        err.Error(),
		})
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	copyResponseHeaders(w.Header(), resp.Header)
	if r.Method == http.MethodHead {
		h.traceDirectMetadataResponse(r, resolved.Provider, endpoint, target, resp, 0, started)
		w.WriteHeader(resp.StatusCode)
		return
	}

	body, err := io.ReadAll(io.LimitReader(resp.Body, maxDirectMetadataBytes+1))
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	if len(body) > maxDirectMetadataBytes {
		http.Error(w, "provider metadata response is too large", http.StatusBadGateway)
		return
	}

	if resp.StatusCode >= 200 && resp.StatusCode < 300 && resp.Header.Get("Content-Encoding") == "" {
		switch endpoint {
		case "player_api.php":
			// Apply this to every Player API action, not only the empty-action login.
			// rewriteXtreamBootstrap is a no-op for normal lists/details, but account
			// aliases such as get_account_info can return user_info and otherwise leak
			// the upstream username/password back to strict Xtream clients.
			body = h.rewriteXtreamBootstrap(resolved, clientUser, body)
			body = h.rewriteCachedArtwork(r.Context(), resolved.Provider, endpoint, body)
			if json.Valid(body) {
				w.Header().Set("Content-Type", "application/json")
			}
		case "get.php":
			body = h.rewriteCachedArtwork(r.Context(), resolved.Provider, endpoint, body)
			body = h.rewriteM3UPlaylist(resolved.Provider, clientUser, body)
			w.Header().Set("Content-Type", "audio/x-mpegurl")
		case "xmltv.php":
			body = h.rewriteCachedArtwork(r.Context(), resolved.Provider, endpoint, body)
			w.Header().Set("Content-Type", "application/xml")
		}
	}

	// Rewriting JSON/M3U/XML changes byte length, so never forward the provider's
	// stale Content-Length. We have the final body in memory and can advertise the
	// exact value Smarters and other strict clients expect.
	w.Header().Del("Content-Length")
	w.Header().Set("Content-Length", strconv.Itoa(len(body)))
	h.traceDirectMetadataResponse(r, resolved.Provider, endpoint, target, resp, len(body), started)
	w.WriteHeader(resp.StatusCode)
	_, _ = w.Write(body)
}

func (h *Handler) traceDirectMetadataResponse(r *http.Request, p provider.Provider, endpoint string, target *url.URL, resp *http.Response, bytesOut int, started time.Time) {
	h.trace(r.Context(), "info", "upstream.response", "Incoming metadata response from IPTV provider", map[string]any{
		"direction":     "incoming",
		"method":        resp.Request.Method,
		"url":           safeURLString(target.String()),
		"outgoingUrl":   safeURLString(target.String()),
		"providerId":    p.ID,
		"providerName":  p.Name,
		"providerRoute": p.Route,
		"endpoint":      endpoint,
		"action":        target.Query().Get("action"),
		"status":        resp.StatusCode,
		"contentType":   resp.Header.Get("Content-Type"),
		"contentLength": resp.ContentLength,
		"bytes":         bytesOut,
		"elapsedMs":     time.Since(started).Milliseconds(),
	})
}

// rewriteXtreamBootstrap keeps the provider's real subscription/account facts
// but replaces the credentials and server identity echoed by player_api.php.
// Some players reuse these fields for every subsequent API call; exposing the
// upstream values makes them leave the proxy and/or fail local authentication.
func (h *Handler) rewriteXtreamBootstrap(resolved routing.Resolved, clientUser provider.User, body []byte) []byte {
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.UseNumber()
	var payload map[string]any
	if err := decoder.Decode(&payload); err != nil {
		return body
	}
	userInfo, ok := payload["user_info"].(map[string]any)
	if !ok || userInfo == nil {
		return body
	}
	if clientUser.Username == "" || clientUser.ClientPassword == "" {
		return body
	}

	userInfo["username"] = clientUser.Username
	userInfo["password"] = clientUser.ClientPassword

	serverInfo, _ := payload["server_info"].(map[string]any)
	if serverInfo == nil {
		serverInfo = map[string]any{}
		payload["server_info"] = serverInfo
	}
	publicBase := h.xtreamPublicBase(resolved)
	if parsed, err := url.Parse(publicBase); err == nil && parsed.Host != "" {
		port := parsed.Port()
		if port == "" {
			if strings.EqualFold(parsed.Scheme, "https") {
				port = "443"
			} else {
				port = "80"
			}
		}
		serverInfo["url"] = publicBase
		serverInfo["server_protocol"] = parsed.Scheme
		serverInfo["port"] = port
		serverInfo["https_port"] = port
		serverInfo["rtmp_port"] = port
	}

	encoded, err := json.Marshal(payload)
	if err != nil {
		return body
	}
	return encoded
}

func (h *Handler) xtreamPublicBase(resolved routing.Resolved) string {
	base := strings.TrimSuffix(h.appURL, "/")
	if resolved.MatchedBy == routing.MatchRoute {
		if route := strings.Trim(resolved.Provider.Route, "/"); route != "" {
			base += "/" + route
		}
	}
	return base
}
