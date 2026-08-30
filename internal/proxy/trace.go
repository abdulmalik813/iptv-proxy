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

func traceFrom(ctx context.Context) traceInfo {
	if value, ok := ctx.Value(traceContextKey{}).(traceInfo); ok {
		return value
	}
	return traceInfo{ID: newTraceID(), Started: time.Now()}
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

func providerMeta(p provider.Provider, endpoint string, target *url.URL) map[string]any {
	meta := map[string]any{
		"providerId":    p.ID,
		"providerName":  p.Name,
		"providerRoute": p.Route,
		"endpoint":      endpoint,
	}
	if target != nil {
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
