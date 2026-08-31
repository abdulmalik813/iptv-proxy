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

	"github.com/abdulmalik813/iptv-proxy/internal/provider"
	"github.com/abdulmalik813/iptv-proxy/internal/routing"
)

const maxXtreamFormBytes = 1 << 20
const maxDirectMetadataBytes = 256 << 20

// xtreamRequestValues accepts the normal Xtream query-string form, POST
// application/x-www-form-urlencoded, the empty JSON object sent by some
// Smarters builds, and simple JSON object POSTs used by a few compatible apps.
// POST values override query values. The body is restored because logging or a
// later handler may still need to inspect it.
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

	trimmed := bytes.TrimSpace(body)
	if bytes.Equal(trimmed, []byte("{}")) {
		return values, nil
	}
	if len(trimmed) > 0 && trimmed[0] == '{' {
		decoder := json.NewDecoder(bytes.NewReader(trimmed))
		decoder.UseNumber()
		var payload map[string]any
		if err := decoder.Decode(&payload); err != nil {
			return nil, fmt.Errorf("parse Xtream JSON body: %w", err)
		}
		for key, raw := range payload {
			switch value := raw.(type) {
			case string:
				values.Set(key, value)
			case json.Number:
				values.Set(key, value.String())
			case bool:
				values.Set(key, strconv.FormatBool(value))
			case nil:
				values.Del(key)
			}
		}
		return values, nil
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

// rewriteXtreamBootstrap keeps the provider's real subscription/account facts
// but replaces the credentials and server identity echoed by Player/Panel APIs.
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
