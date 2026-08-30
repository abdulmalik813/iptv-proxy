package proxy

import (
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/abdulmalik813/iptv-proxy/internal/provider"
)

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

func TestServeDirectFallsBackFromPathTimeshiftToPHP(t *testing.T) {
	var calls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if strings.Contains(r.URL.Path, "/timeshift/") {
			w.Header().Set("Content-Type", "text/html")
			w.WriteHeader(http.StatusNotFound)
			_, _ = io.WriteString(w, "missing path route")
			return
		}
		if r.URL.Path != "/streaming/timeshift.php" {
			t.Errorf("fallback path=%q", r.URL.Path)
		}
		q := r.URL.Query()
		if q.Get("username") != "up" || q.Get("password") != "pass" || q.Get("stream") != "123" || q.Get("start") != "2026-08-30:01-00" || q.Get("duration") != "60" {
			t.Errorf("fallback query=%v", q)
		}
		w.Header().Set("Content-Type", "video/mp2t")
		_, _ = io.WriteString(w, "TS-ARCHIVE")
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
	if resp.StatusCode != http.StatusOK || string(body) != "TS-ARCHIVE" {
		t.Fatalf("status=%d body=%q", resp.StatusCode, body)
	}
	if calls.Load() != 2 {
		t.Fatalf("provider calls=%d want=2", calls.Load())
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
