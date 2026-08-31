package proxy

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"net/url"
	"path"
	"strings"
	"time"

	"github.com/abdulmalik813/iptv-proxy/internal/provider"
)

const (
	catchupProbeBytes = 1024
	catchupFormatTTL  = 30 * 24 * time.Hour
)

type catchupCandidate struct {
	URL    *url.URL
	Format string
}

type catchupDescriptor struct {
	original     *url.URL
	baseSegments []string
	username     string
	password     string
	duration     string
	start        string
	streamID     string
	extension    string
	extraQuery   url.Values
	layout       string
}

type replayReadCloser struct {
	io.Reader
	io.Closer
}

// Xtream panels commonly expose catch-up in two equivalent URL shapes:
//
//	/timeshift/{user}/{pass}/{duration}/{start}/{stream}.{ext}
//	/streaming/timeshift.php?username=...&password=...&stream=...&start=...&duration=...
//
// Real panels are inconsistent about which timestamp spelling they accept and
// can return HTTP 200 with an HTML/PHP error body. Candidate negotiation below
// deliberately mirrors the compatibility approach used by mature IPTV proxies:
// try one provider request at a time, validate the body before accepting it,
// and remember the winning provider format for the next request.
func isXtreamCatchupTarget(target *url.URL) bool {
	return isTimeshiftPathTarget(target) || isStreamingTimeshiftTarget(target)
}

func isTimeshiftPathTarget(target *url.URL) bool {
	_, _, ok := timeshiftPathParts(target)
	return ok
}

func isStreamingTimeshiftTarget(target *url.URL) bool {
	if target == nil {
		return false
	}
	segments := strings.Split(strings.Trim(target.Path, "/"), "/")
	if len(segments) < 2 {
		return false
	}
	return strings.EqualFold(segments[len(segments)-2], "streaming") &&
		strings.EqualFold(segments[len(segments)-1], "timeshift.php")
}

func isExplicitCatchupHLS(target *url.URL) bool {
	if target == nil {
		return false
	}
	if strings.EqualFold(path.Ext(target.Path), ".m3u8") {
		return true
	}
	q := target.Query()
	for _, key := range []string{"output", "format", "container", "type"} {
		value := strings.ToLower(strings.TrimSpace(q.Get(key)))
		if value == "m3u8" || value == "hls" {
			return true
		}
	}
	return false
}

// timeshiftPHPAlternate converts a path-style Xtream timeshift URL to the PHP
// query form without changing credentials, start time, duration or stream id.
// Any provider base path and unrelated query parameters are preserved.
func timeshiftPHPAlternate(target *url.URL) (*url.URL, bool) {
	descriptor, ok := describeCatchupTarget(target)
	if !ok || descriptor.layout != "path" {
		return nil, false
	}
	return buildCatchupCandidateURL(descriptor, "query_original"), true
}

func timeshiftPathParts(target *url.URL) ([]string, int, bool) {
	if target == nil {
		return nil, -1, false
	}
	segments := strings.Split(strings.Trim(target.Path, "/"), "/")
	// Search backward from the last position that can still contain the complete
	// six-segment Xtream route. A provider may itself be mounted below a base path
	// containing the word "timeshift"; the endpoint nearest the stream id is the
	// actual route and must win over an earlier base-path segment.
	for index := len(segments) - 6; index >= 0; index-- {
		if strings.EqualFold(segments[index], "timeshift") {
			return segments, index, true
		}
	}
	return nil, -1, false
}

func describeCatchupTarget(target *url.URL) (catchupDescriptor, bool) {
	if target == nil {
		return catchupDescriptor{}, false
	}
	if segments, index, ok := timeshiftPathParts(target); ok {
		streamFile := segments[index+5]
		extension := path.Ext(streamFile)
		if extension == "" {
			extension = ".ts"
		}
		streamID := strings.TrimSuffix(streamFile, path.Ext(streamFile))
		if segments[index+1] == "" || segments[index+2] == "" || segments[index+3] == "" || segments[index+4] == "" || streamID == "" {
			return catchupDescriptor{}, false
		}
		return catchupDescriptor{
			original:     cloneURL(target),
			baseSegments: append([]string(nil), segments[:index]...),
			username:     segments[index+1],
			password:     segments[index+2],
			duration:     segments[index+3],
			start:        segments[index+4],
			streamID:     streamID,
			extension:    extension,
			extraQuery:   cloneURLValues(target.Query()),
			layout:       "path",
		}, true
	}

	if !isStreamingTimeshiftTarget(target) {
		return catchupDescriptor{}, false
	}
	q := target.Query()
	username := q.Get("username")
	password := q.Get("password")
	duration := q.Get("duration")
	start := q.Get("start")
	streamValue := q.Get("stream")
	if username == "" || password == "" || duration == "" || start == "" || streamValue == "" {
		return catchupDescriptor{}, false
	}
	extension := path.Ext(streamValue)
	streamID := streamValue
	if extension != "" {
		streamID = strings.TrimSuffix(streamValue, extension)
	} else {
		extension = ".ts"
	}
	segments := strings.Split(strings.Trim(target.Path, "/"), "/")
	extra := cloneURLValues(q)
	for _, key := range []string{"username", "password", "duration", "start", "stream"} {
		extra.Del(key)
	}
	return catchupDescriptor{
		original:     cloneURL(target),
		baseSegments: append([]string(nil), segments[:len(segments)-2]...),
		username:     username,
		password:     password,
		duration:     duration,
		start:        start,
		streamID:     streamID,
		extension:    extension,
		extraQuery:   extra,
		layout:       "query",
	}, true
}

func cloneURL(input *url.URL) *url.URL {
	if input == nil {
		return nil
	}
	cloned := *input
	return &cloned
}

func parseCatchupStart(value string) (time.Time, bool) {
	trimmed := strings.TrimSpace(value)
	layouts := []string{
		"2006-01-02:15-04",
		"2006-01-02_15-04",
		"20060102-15",
		"2006-01-02:15:04:05",
		"2006-01-02:15:04",
		"2006-01-02 15:04:05",
		"2006-01-02T15:04:05",
		time.RFC3339,
	}
	for _, layout := range layouts {
		if parsed, err := time.Parse(layout, trimmed); err == nil {
			return parsed, true
		}
	}
	return time.Time{}, false
}

func catchupStartForFormat(parsed time.Time, format string) string {
	switch format {
	case "path_colon_dash", "query_colon_dash":
		return parsed.Format("2006-01-02:15-04")
	case "path_underscore", "query_underscore":
		return parsed.Format("2006-01-02_15-04")
	case "path_compact_hour", "query_compact_hour":
		return parsed.Format("20060102-15")
	case "path_colon_seconds", "query_colon_seconds":
		return parsed.Format("2006-01-02:15:04:05")
	case "query_sql":
		return parsed.Format("2006-01-02 15:04:05")
	default:
		return ""
	}
}

func buildCatchupCandidateURL(descriptor catchupDescriptor, format string) *url.URL {
	candidate := cloneURL(descriptor.original)
	if candidate == nil {
		return nil
	}
	start := descriptor.start
	if format != "path_original" && format != "query_original" {
		parsed, ok := parseCatchupStart(descriptor.start)
		if !ok {
			return nil
		}
		start = catchupStartForFormat(parsed, format)
		if start == "" {
			return nil
		}
	}

	if strings.HasPrefix(format, "path_") {
		segments := append([]string(nil), descriptor.baseSegments...)
		segments = append(segments, "timeshift", descriptor.username, descriptor.password, descriptor.duration, start, descriptor.streamID+descriptor.extension)
		candidate.Path = "/" + strings.Join(segments, "/")
		candidate.RawPath = ""
		candidate.RawQuery = cloneURLValues(descriptor.extraQuery).Encode()
		return candidate
	}
	if strings.HasPrefix(format, "query_") {
		segments := append([]string(nil), descriptor.baseSegments...)
		segments = append(segments, "streaming", "timeshift.php")
		candidate.Path = "/" + strings.Join(segments, "/")
		candidate.RawPath = ""
		q := cloneURLValues(descriptor.extraQuery)
		q.Set("username", descriptor.username)
		q.Set("password", descriptor.password)
		q.Set("stream", descriptor.streamID)
		q.Set("start", start)
		q.Set("duration", descriptor.duration)
		candidate.RawQuery = q.Encode()
		return candidate
	}
	return nil
}

func originalCatchupFormat(descriptor catchupDescriptor) string {
	parsed, ok := parseCatchupStart(descriptor.start)
	if !ok {
		return descriptor.layout + "_original"
	}
	var formats []string
	if descriptor.layout == "path" {
		formats = []string{"path_colon_dash", "path_underscore", "path_compact_hour", "path_colon_seconds"}
	} else {
		formats = []string{"query_underscore", "query_sql", "query_colon_dash", "query_compact_hour", "query_colon_seconds"}
	}
	for _, format := range formats {
		if descriptor.start == catchupStartForFormat(parsed, format) {
			return format
		}
	}
	return descriptor.layout + "_original"
}

func buildCatchupCandidates(target *url.URL, preferred string) ([]catchupCandidate, bool) {
	descriptor, ok := describeCatchupTarget(target)
	if !ok {
		return nil, false
	}
	standard := []string{
		"path_colon_dash",
		"path_underscore",
		"path_compact_hour",
		"path_colon_seconds",
		"query_underscore",
		"query_sql",
		"query_colon_dash",
		"query_compact_hour",
		"query_colon_seconds",
	}
	candidates := make([]catchupCandidate, 0, len(standard)+2)
	seen := map[string]bool{}
	appendCandidate := func(candidateURL *url.URL, format string) {
		if candidateURL == nil {
			return
		}
		key := candidateURL.String()
		if seen[key] {
			return
		}
		seen[key] = true
		candidates = append(candidates, catchupCandidate{URL: candidateURL, Format: format})
	}

	if preferred != "" {
		appendCandidate(buildCatchupCandidateURL(descriptor, preferred), preferred)
	}
	appendCandidate(cloneURL(target), originalCatchupFormat(descriptor))
	for _, format := range standard {
		appendCandidate(buildCatchupCandidateURL(descriptor, format), format)
	}
	return candidates, true
}

func catchupFormatKey(providerID string) string {
	return "catchup:format:" + providerID
}

func (h *Handler) preferredCatchupFormat(ctx context.Context, p provider.Provider) string {
	if h.redis == nil || p.ID == "" {
		return ""
	}
	value, err := h.redis.Get(ctx, catchupFormatKey(p.ID)).Result()
	if err != nil {
		return ""
	}
	return value
}

func (h *Handler) rememberCatchupFormat(ctx context.Context, p provider.Provider, format string) {
	if h.redis == nil || p.ID == "" || format == "" || strings.HasSuffix(format, "_original") {
		return
	}
	_ = h.redis.Set(ctx, catchupFormatKey(p.ID), format, catchupFormatTTL).Err()
}

func isDecisiveCatchupStatus(status int) bool {
	switch status {
	case http.StatusUnauthorized,
		http.StatusForbidden,
		http.StatusNotAcceptable,
		http.StatusRequestTimeout,
		http.StatusTooManyRequests,
		458: // Common Xtream account/session-limit status.
		return true
	default:
		return false
	}
}

func catchupLooksLikeDocument(contentType string, body []byte) bool {
	lowerType := strings.ToLower(contentType)
	if strings.Contains(lowerType, "html") || strings.Contains(lowerType, "json") || strings.Contains(lowerType, "xml") {
		return true
	}
	trimmed := bytes.TrimSpace(body)
	if len(trimmed) == 0 {
		return false
	}
	lower := strings.ToLower(string(trimmed[:min(len(trimmed), 64)]))
	return strings.HasPrefix(lower, "<!doctype html") ||
		strings.HasPrefix(lower, "<html") ||
		strings.HasPrefix(lower, "<?xml") ||
		strings.HasPrefix(lower, "{") ||
		strings.HasPrefix(lower, "[")
}

func findMPEGTSSync(body []byte) int {
	for offset := 0; offset < len(body); offset++ {
		if body[offset] != 0x47 {
			continue
		}
		second := offset + 188
		if second >= len(body) || body[second] != 0x47 {
			continue
		}
		third := second + 188
		if third < len(body) && body[third] != 0x47 {
			continue
		}
		return offset
	}
	return -1
}

// probeCatchupResponse validates successful finite archive responses before we
// expose HTTP 200 to the IPTV player. It intentionally reads only a small prefix
// and then replays those bytes. A ranged 206 can begin mid-packet, so a non-empty
// non-document partial response is accepted without requiring a sync byte at the
// first position.
func probeCatchupResponse(resp *http.Response, target *url.URL, rangeHeader string) (accepted bool, detectedHLS bool, reason string, err error) {
	if resp == nil {
		return false, false, "missing response", nil
	}
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusPartialContent {
		return false, false, "non-success status", nil
	}
	if isHLSResponse(resp, target) {
		return true, true, "hls", nil
	}
	if resp.Request != nil && resp.Request.Method == http.MethodHead {
		return true, false, "head", nil
	}

	originalBody := resp.Body
	prefix, readErr := io.ReadAll(io.LimitReader(originalBody, catchupProbeBytes))
	if readErr != nil {
		return false, false, "prefix read failed", readErr
	}
	if len(prefix) == 0 {
		return false, false, "empty success body", nil
	}
	if catchupLooksLikeDocument(resp.Header.Get("Content-Type"), prefix) {
		resp.Body = &replayReadCloser{Reader: io.MultiReader(bytes.NewReader(prefix), originalBody), Closer: originalBody}
		return false, false, "HTML/JSON/XML success body", nil
	}

	if resp.StatusCode == http.StatusPartialContent && strings.TrimSpace(rangeHeader) != "" {
		resp.Body = &replayReadCloser{Reader: io.MultiReader(bytes.NewReader(prefix), originalBody), Closer: originalBody}
		return true, false, "partial archive", nil
	}

	offset := findMPEGTSSync(prefix)
	if offset < 0 {
		resp.Body = &replayReadCloser{Reader: io.MultiReader(bytes.NewReader(prefix), originalBody), Closer: originalBody}
		return false, false, "no MPEG-TS sync in successful response", nil
	}
	resp.Body = &replayReadCloser{Reader: io.MultiReader(bytes.NewReader(prefix[offset:]), originalBody), Closer: originalBody}
	if offset > 0 && resp.ContentLength >= 0 {
		resp.ContentLength -= int64(offset)
		if value := resp.Header.Get("Content-Length"); value != "" {
			resp.Header.Del("Content-Length")
		}
	}
	return true, false, "mpeg-ts", nil
}

// shouldTryTimeshiftPHPFallback remains as a small compatibility predicate for
// explicit HLS/HEAD paths and older tests. Normal TS catch-up now uses the full
// candidate resolver rather than a single path->PHP retry.
func shouldTryTimeshiftPHPFallback(resp *http.Response, target *url.URL) bool {
	if resp == nil || !isTimeshiftPathTarget(target) {
		return false
	}

	switch resp.StatusCode {
	case http.StatusBadRequest,
		http.StatusNotFound,
		http.StatusMethodNotAllowed,
		http.StatusUnsupportedMediaType,
		http.StatusUnprocessableEntity:
		return true
	case http.StatusUnauthorized,
		http.StatusForbidden,
		http.StatusRequestTimeout,
		http.StatusTooManyRequests,
		458:
		return false
	}

	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		contentType := strings.ToLower(resp.Header.Get("Content-Type"))
		return strings.Contains(contentType, "text/html") ||
			strings.Contains(contentType, "application/xhtml+xml")
	}
	return false
}

// Catch-up is a finite archive response, not the continuously remuxed live
// endpoint. Do not run the broad hidden-HLS body sniff used for live media.
func shouldSniffHiddenHLS(target *url.URL) bool {
	return !isXtreamCatchupTarget(target)
}
