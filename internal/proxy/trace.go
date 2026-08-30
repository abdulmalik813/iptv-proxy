package proxy

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"net/http"
	"net/url"
	"path"
	"strings"
	"time"

	"github.com/abdulmalik813/iptv-proxy/internal/provider"
)

type traceContextKey struct{}

type traceInfo struct {
	ID      string
	Started time.Time
}

type responseRecorder struct {
	http.ResponseWriter
	status int
	bytes  int64
}

func (r *responseRecorder) WriteHeader(status int) {
	if r.status == 0 {
		r.status = status
	}
	r.ResponseWriter.WriteHeader(status)
}

func (r *responseRecorder) Write(body []byte) (int, error) {
	if r.status == 0 {
		r.status = http.StatusOK
	}
	n, err := r.ResponseWriter.Write(body)
	r.bytes += int64(n)
	return n, err
}

func (r *responseRecorder) Unwrap() http.ResponseWriter {
	return r.ResponseWriter
}

func newTraceID() string {
	buf := make([]byte, 8)
	if _, err := rand.Read(buf); err != nil {
		return time.Now().UTC().Format("20060102T150405.000000000")
	}
	return hex.EncodeToString(buf)
}

func withTrace(ctx context.Context) (context.Context, traceInfo) {
	info := traceInfo{ID: newTraceID(), Started: time.Now()}
	return context.WithValue(ctx, traceContextKey{}, info), info
}

func ensureTrace(ctx context.Context) context.Context {
	if _, ok := ctx.Value(traceContextKey{}).(traceInfo); ok {
		return ctx
	}
	traced, _ := withTrace(ctx)
	return traced
}

func traceFrom(ctx context.Context) traceInfo {
	if value, ok := ctx.Value(traceContextKey{}).(traceInfo); ok {
		return value
	}
	return traceInfo{ID: "untracked", Started: time.Now()}
}

func (h *Handler) trace(ctx context.Context, level, category, message string, metadata map[string]any) {
	if h.logger == nil {
		return
	}
	info := traceFrom(ctx)
	if metadata == nil {
		metadata = map[string]any{}
	}
	metadata["traceId"] = info.ID
	h.logger.Write(level, category, message, metadata)
}

func safeRequestMeta(r *http.Request) map[string]any {
	meta := map[string]any{
		"method":     r.Method,
		"remoteAddr": clientIP(r),
		"userAgent":  r.UserAgent(),
	}
	parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
	if len(parts) > 0 && parts[0] != "" {
		meta["firstSegment"] = parts[0]
	}
	if action := r.URL.Query().Get("action"); action != "" {
		meta["action"] = action
	}
	if len(parts) > 0 {
		last := parts[len(parts)-1]
		if last != "" && !strings.Contains(last, ".php") {
			meta["resource"] = last
		}
	}
	return meta
}

func requestFullURL(appURL string, r *http.Request) string {
	base, err := url.Parse(strings.TrimSuffix(appURL, "/"))
	if err == nil && base.Scheme != "" && base.Host != "" {
		base.Path = strings.TrimSuffix(base.Path, "/") + r.URL.Path
		base.RawPath = ""
		base.RawQuery = r.URL.RawQuery
		return safeURLString(base.String())
	}

	scheme := strings.TrimSpace(strings.Split(r.Header.Get("X-Forwarded-Proto"), ",")[0])
	if scheme == "" {
		scheme = "http"
	}
	host := strings.TrimSpace(strings.Split(r.Header.Get("X-Forwarded-Host"), ",")[0])
	if host == "" {
		host = r.Host
	}
	fallback := &url.URL{Scheme: scheme, Host: host, Path: r.URL.Path, RawQuery: r.URL.RawQuery}
	return safeURLString(fallback.String())
}

func safeURLString(raw string) string {
	parsed, err := url.Parse(raw)
	if err != nil {
		return "[invalid URL]"
	}
	parsed.User = nil
	parsed.Path = redactCredentialPath(parsed.Path)
	parsed.RawPath = ""
	query := parsed.Query()
	for key := range query {
		if sensitiveURLParameter(key) {
			query.Set(key, "REDACTED")
		}
	}
	parsed.RawQuery = query.Encode()
	return parsed.String()
}

func sensitiveURLParameter(key string) bool {
	lower := strings.ToLower(strings.TrimSpace(key))
	if lower == "username" || lower == "user" || lower == "password" || lower == "pass" || lower == "authorization" || lower == "auth" || lower == "apikey" || lower == "api_key" {
		return true
	}
	return strings.Contains(lower, "password") || strings.Contains(lower, "token") || strings.Contains(lower, "secret")
}

func redactCredentialPath(rawPath string) string {
	segments := strings.Split(rawPath, "/")
	for i, segment := range segments {
		switch strings.ToLower(segment) {
		case "live", "movie", "series", "timeshift":
			if i+1 < len(segments) {
				segments[i+1] = "REDACTED"
			}
			if i+2 < len(segments) {
				segments[i+2] = "REDACTED"
			}
		case "_hls":
			if i+1 < len(segments) {
				segments[i+1] = "REDACTED"
			}
		}
	}
	return strings.Join(segments, "/")
}

func providerMeta(p provider.Provider, endpoint string, target *url.URL) map[string]any {
	meta := map[string]any{
		"providerId":    p.ID,
		"providerName":  p.Name,
		"providerRoute": p.Route,
		"endpoint":      endpoint,
	}
	if target != nil {
		meta["outgoingUrl"] = safeURLString(target.String())
		if action := target.Query().Get("action"); action != "" {
			meta["action"] = action
		}
		if resource := path.Base(target.Path); resource != "." && resource != "/" {
			meta["resource"] = resource
		}
	}
	return meta
}

func clientIP(r *http.Request) string {
	if forwarded := strings.TrimSpace(strings.Split(r.Header.Get("X-Forwarded-For"), ",")[0]); forwarded != "" {
		return forwarded
	}
	return r.RemoteAddr
}
