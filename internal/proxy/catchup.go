package proxy

import (
	"net/http"
	"net/url"
	"path"
	"strings"
)

// Xtream panels commonly expose catch-up in two equivalent URL shapes:
//
//   /timeshift/{user}/{pass}/{duration}/{start}/{stream}.{ext}
//   /streaming/timeshift.php?username=...&password=...&stream=...&start=...&duration=...
//
// The proxy accepts and forwards both. The path form is normally preferable for
// MPEG-TS archives because it is a straight finite recording response, while the
// PHP form is retained as a compatibility fallback for panels that do not expose
// the path route.
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

// timeshiftPHPAlternate converts a path-style Xtream timeshift URL to the PHP
// query form without changing credentials, start time, duration or stream id.
// Any provider base path and unrelated query parameters are preserved.
func timeshiftPHPAlternate(target *url.URL) (*url.URL, bool) {
	segments, index, ok := timeshiftPathParts(target)
	if !ok {
		return nil, false
	}

	username := segments[index+1]
	password := segments[index+2]
	duration := segments[index+3]
	start := segments[index+4]
	streamFile := segments[index+5]
	streamID := strings.TrimSuffix(streamFile, path.Ext(streamFile))
	if username == "" || password == "" || duration == "" || start == "" || streamID == "" {
		return nil, false
	}

	alternate := *target
	newSegments := append([]string{}, segments[:index]...)
	newSegments = append(newSegments, "streaming", "timeshift.php")
	alternate.Path = "/" + strings.Join(newSegments, "/")
	alternate.RawPath = ""
	q := alternate.Query()
	q.Set("username", username)
	q.Set("password", password)
	q.Set("stream", streamID)
	q.Set("start", start)
	q.Set("duration", duration)
	alternate.RawQuery = q.Encode()
	return &alternate, true
}

func timeshiftPathParts(target *url.URL) ([]string, int, bool) {
	if target == nil {
		return nil, -1, false
	}
	segments := strings.Split(strings.Trim(target.Path, "/"), "/")
	for index, segment := range segments {
		if !strings.EqualFold(segment, "timeshift") {
			continue
		}
		// timeshift + username + password + duration + start + stream
		if len(segments) < index+6 {
			return nil, -1, false
		}
		return segments, index, true
	}
	return nil, -1, false
}

// shouldTryTimeshiftPHPFallback is deliberately conservative. A missing or
// unsupported path route is worth retrying through timeshift.php; an account,
// authorization, rate-limit or provider-session refusal is not. Retrying those
// would only create another provider connection and can make one-session panels
// less reliable.
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
		458: // Xtream panels commonly use 458 for an account/session limit.
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
// endpoint. Do not delay a normal .ts archive by peeking into its body looking
// for a hidden HLS manifest. Explicit HLS remains supported through URL/content
// type detection, and non-catch-up media keeps the compatibility sniff.
func shouldSniffHiddenHLS(target *url.URL) bool {
	return !isXtreamCatchupTarget(target)
}
