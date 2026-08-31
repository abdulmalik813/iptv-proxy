package proxy

import (
	"bytes"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/abdulmalik813/iptv-proxy/internal/provider"
)

func testTSPayload(packets int) []byte {
	body := make([]byte, packets*188)
	for packet := 0; packet < packets; packet++ {
		offset := packet * 188
		body[offset] = 0x47
		body[offset+1] = byte(packet)
		for index := offset + 2; index < offset+188; index++ {
			body[index] = byte((packet + index) % 251)
		}
	}
	return body
}

func TestTimeshiftPHPAlternatePreservesProviderBasePathAndValues(t *testing.T) {
	target, _ := url.Parse("https://provider.test/panel/timeshift/up/pass/60/2026-08-30:01-00/123.ts?token=abc")
	alternate, ok := timeshiftPHPAlternate(target)
	if !ok {
		t.Fatal("expected alternate")
	}
	if alternate.Path != "/panel/streaming/timeshift.php" {
		t.Fatalf("path=%q", alternate.Path)
	}
	q := alternate.Query()
	if q.Get("username") != "up" || q.Get("password") != "pass" || q.Get("stream") != "123" || q.Get("start") != "2026-08-30:01-00" || q.Get("duration") != "60" || q.Get("token") != "abc" {
		t.Fatalf("query=%v", q)
	}
}

func TestTimeshiftPHPAlternateUsesFinalTimeshiftRoute(t *testing.T) {
	target, _ := url.Parse("https://provider.test/timeshift/panel/timeshift/up/pass/60/2026-08-30:01-00/123.ts")
	alternate, ok := timeshiftPHPAlternate(target)
	if !ok {
		t.Fatal("expected alternate")
	}
	if alternate.Path != "/timeshift/panel/streaming/timeshift.php" {
		t.Fatalf("path=%q", alternate.Path)
	}
	q := alternate.Query()
	if q.Get("username") != "up" || q.Get("password") != "pass" || q.Get("stream") != "123" || q.Get("start") != "2026-08-30:01-00" || q.Get("duration") != "60" {
		t.Fatalf("query=%v", q)
	}
}

func TestShouldTryTimeshiftPHPFallbackOnlyForCompatibleFailures(t *testing.T) {
	target, _ := url.Parse("http://provider.test/timeshift/up/pass/60/2026-08-30:01-00/123.ts")
	for _, status := range []int{http.StatusBadRequest, http.StatusNotFound, http.StatusMethodNotAllowed, http.StatusUnsupportedMediaType, http.StatusUnprocessableEntity} {
		resp := &http.Response{StatusCode: status, Header: make(http.Header)}
		if !shouldTryTimeshiftPHPFallback(resp, target) {
			t.Fatalf("status %d should fall back", status)
		}
	}
	for _, status := range []int{http.StatusUnauthorized, http.StatusForbidden, http.StatusRequestTimeout, http.StatusTooManyRequests, 458, http.StatusInternalServerError} {
		resp := &http.Response{StatusCode: status, Header: make(http.Header)}
		if shouldTryTimeshiftPHPFallback(resp, target) {
			t.Fatalf("status %d must not create a duplicate provider request", status)
		}
	}
	resp := &http.Response{StatusCode: http.StatusOK, Header: http.Header{"Content-Type": []string{"text/html; charset=utf-8"}}}
	if !shouldTryTimeshiftPHPFallback(resp, target) {
		t.Fatal("HTML success response should fall back")
	}
}

func TestBuildCatchupCandidatesSupportsDispatcharrTimestampShapes(t *testing.T) {
	target, _ := url.Parse("https://provider.test/timeshift/up/pass/60/2026-08-30:01-00/123.ts")
	candidates, ok := buildCatchupCandidates(target, "query_sql")
	if !ok || len(candidates) < 7 {
		t.Fatalf("candidate count=%d ok=%v", len(candidates), ok)
	}
	if candidates[0].Format != "query_sql" || candidates[0].URL.Query().Get("start") != "2026-08-30 01:00:00" {
		t.Fatalf("preferred candidate=%s url=%s", candidates[0].Format, candidates[0].URL)
	}
	seen := map[string]bool{}
	for _, candidate := range candidates {
		seen[candidate.Format] = true
	}
	for _, format := range []string{"path_colon_dash", "path_underscore", "path_colon_seconds", "query_underscore", "query_sql", "query_colon_dash", "query_colon_seconds"} {
		if !seen[format] {
			t.Fatalf("missing format %s", format)
		}
	}
}

func TestServeDirectCascadesUntilValidTimeshiftTS(t *testing.T) {
	var calls atomic.Int32
	payload := testTSPayload(4)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if strings.Contains(r.URL.Path, "/timeshift/") {
			w.Header().Set("Content-Type", "text/html")
			w.WriteHeader(http.StatusOK)
			_, _ = io.WriteString(w, "<html>path form rejected</html>")
			return
		}
		if r.URL.Path != "/streaming/timeshift.php" {
			t.Errorf("candidate path=%q", r.URL.Path)
		}
		q := r.URL.Query()
		if q.Get("username") != "up" || q.Get("password") != "pass" || q.Get("stream") != "123" || q.Get("duration") != "60" {
			t.Errorf("candidate query=%v", q)
		}
		if q.Get("start") != "2026-08-30 01:00:00" {
			w.Header().Set("Content-Type", "text/html")
			_, _ = io.WriteString(w, "<html>wrong timestamp shape</html>")
			return
		}
		w.Header().Set("Content-Type", "video/mp2t")
		_, _ = w.Write(payload)
	}))
	defer upstream.Close()

	target, _ := url.Parse(upstream.URL + "/timeshift/up/pass/60/2026-08-30:01-00/123.ts")
	h := &Handler{streamClient: upstream.Client()}
	r := httptest.NewRequest(http.MethodGet, "http://proxy/timeshift/local/secret/60/2026-08-30:01-00/123.ts", nil)
	w := httptest.NewRecorder()
	h.serveDirect(w, r, provider.Provider{ID: "provider-1", Name: "Test"}, target)

	resp := w.Result()
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK || !bytes.Equal(body, payload) {
		t.Fatalf("status=%d bytes=%d", resp.StatusCode, len(body))
	}
	if calls.Load() != 5 {
		t.Fatalf("provider calls=%d want=5", calls.Load())
	}
}

func TestServeDirectRejectsFakeCatchupHTTP200(t *testing.T) {
	var calls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		w.Header().Set("Content-Type", "text/html")
		_, _ = io.WriteString(w, "<html>provider error</html>")
	}))
	defer upstream.Close()

	target, _ := url.Parse(upstream.URL + "/timeshift/up/pass/60/2026-08-30:01-00/123.ts")
	h := &Handler{streamClient: upstream.Client()}
	r := httptest.NewRequest(http.MethodGet, "http://proxy/timeshift/local/secret/60/2026-08-30:01-00/123.ts", nil)
	w := httptest.NewRecorder()
	h.serveDirect(w, r, provider.Provider{ID: "provider-1", Name: "Test"}, target)

	if w.Code != http.StatusBadGateway {
		t.Fatalf("status=%d", w.Code)
	}
	if calls.Load() < 2 {
		t.Fatalf("expected format cascade, calls=%d", calls.Load())
	}
}

func TestServeDirectAcceptsBinaryPartialCatchupRange(t *testing.T) {
	var calls atomic.Int32
	partial := bytes.Repeat([]byte{0x12, 0x34, 0x56, 0x78}, 100)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.Header.Get("Range") == "" {
			t.Error("Range header was not forwarded")
		}
		w.Header().Set("Content-Type", "video/mp2t")
		w.WriteHeader(http.StatusPartialContent)
		_, _ = w.Write(partial)
	}))
	defer upstream.Close()

	target, _ := url.Parse(upstream.URL + "/timeshift/up/pass/60/2026-08-30:01-00/123.ts")
	h := &Handler{streamClient: upstream.Client()}
	r := httptest.NewRequest(http.MethodGet, "http://proxy/timeshift/local/secret/60/2026-08-30:01-00/123.ts", nil)
	r.Header.Set("Range", "bytes=5000-")
	w := httptest.NewRecorder()
	h.serveDirect(w, r, provider.Provider{ID: "provider-1", Name: "Test"}, target)

	resp := w.Result()
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusPartialContent || !bytes.Equal(body, partial) {
		t.Fatalf("status=%d body=%d", resp.StatusCode, len(body))
	}
	if calls.Load() != 1 {
		t.Fatalf("provider calls=%d want=1", calls.Load())
	}
}

func TestServeDirectDoesNotFallbackOnSessionLimit(t *testing.T) {
	var calls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		w.WriteHeader(458)
		_, _ = io.WriteString(w, "session limit")
	}))
	defer upstream.Close()

	target, _ := url.Parse(upstream.URL + "/timeshift/up/pass/60/2026-08-30:01-00/123.ts")
	h := &Handler{streamClient: upstream.Client()}
	r := httptest.NewRequest(http.MethodGet, "http://proxy/timeshift/local/secret/60/2026-08-30:01-00/123.ts", nil)
	w := httptest.NewRecorder()
	h.serveDirect(w, r, provider.Provider{ID: "provider-1", Name: "Test"}, target)

	if w.Code != 458 {
		t.Fatalf("status=%d", w.Code)
	}
	if calls.Load() != 1 {
		t.Fatalf("provider calls=%d want=1", calls.Load())
	}
}
