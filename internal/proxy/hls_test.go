package proxy

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/abdulmalik813/iptv-proxy/internal/provider"
	"github.com/abdulmalik813/iptv-proxy/internal/stream"
)

func TestPrepareHLSResponseSniffsMislabeledPlaylistAndPreservesBody(t *testing.T) {
	body := "\uFEFF  #EXTM3U\n#EXT-X-VERSION:3\nsegment.ts\n"
	requested, _ := url.Parse("http://provider.test/live/up/pass/123.ts")
	resp := &http.Response{
		StatusCode: http.StatusOK,
		Header:     http.Header{"Content-Type": []string{"video/mp2t"}},
		Body:       io.NopCloser(strings.NewReader(body)),
		Request:    &http.Request{URL: requested},
	}

	if !prepareHLSResponse(resp, requested) {
		t.Fatal("expected #EXTM3U body to be detected as HLS")
	}
	if got := resp.Header.Get("Content-Type"); got != "application/vnd.apple.mpegurl" {
		t.Fatalf("Content-Type=%q", got)
	}
	preserved, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	if string(preserved) != body {
		t.Fatalf("peek consumed response body: %q", preserved)
	}
}

func TestPrepareHLSResponseLeavesTransportStreamUntouched(t *testing.T) {
	body := string(append([]byte{0x47, 0x40, 0x00, 0x10}, []byte("mpeg-ts-payload")...))
	requested, _ := url.Parse("http://provider.test/live/up/pass/123.ts")
	resp := &http.Response{
		StatusCode: http.StatusOK,
		Header:     http.Header{"Content-Type": []string{"video/mp2t"}},
		Body:       io.NopCloser(strings.NewReader(body)),
		Request:    &http.Request{URL: requested},
	}

	if prepareHLSResponse(resp, requested) {
		t.Fatal("transport stream was incorrectly detected as HLS")
	}
	preserved, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	if string(preserved) != body {
		t.Fatal("transport stream prefix was consumed while sniffing")
	}
}

func TestRewritePlaylistAcceptsBOMIndentedTagsAndInlineDataURI(t *testing.T) {
	base, _ := url.Parse("http://provider.test/live/up/pass/index.m3u8")
	input := []byte("\uFEFF  #EXTM3U\n  #EXT-X-KEY:METHOD=AES-128,URI=\"data:text/plain;base64,QUJD\"\n#EXT-X-ENDLIST\n")
	h := &Handler{}

	got, err := h.rewritePlaylist(context.Background(), provider.Provider{}, base, input)
	if err != nil {
		t.Fatal(err)
	}
	text := string(got)
	if !strings.HasPrefix(text, "#EXTM3U\n") {
		t.Fatalf("BOM/indented HLS header was not normalized: %q", text)
	}
	if !strings.Contains(text, `URI="data:text/plain;base64,QUJD"`) {
		t.Fatalf("inline data URI was unexpectedly rewritten: %q", text)
	}
}

func TestServeDirectSwitchesMislabeledTimeshiftTSToHLS(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "video/mp2t")
		_, _ = io.WriteString(w, "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-ENDLIST\n")
	}))
	defer upstream.Close()

	target, _ := url.Parse(upstream.URL + "/timeshift/up/pass/60/2026-08-30:01-00/123.ts")
	h := &Handler{streamClient: upstream.Client()}
	r := httptest.NewRequest(http.MethodGet, "http://proxy/timeshift/local/secret/60/2026-08-30:01-00/123.ts", nil)
	w := httptest.NewRecorder()

	h.serveDirect(w, r, provider.Provider{}, target)

	resp := w.Result()
	defer resp.Body.Close()
	if got := resp.Header.Get("Content-Type"); got != "application/vnd.apple.mpegurl" {
		t.Fatalf("Content-Type=%q", got)
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(string(body), "#EXTM3U\n") {
		t.Fatalf("body=%q", body)
	}
}

func TestServeLiveMultiplexedSwitchesMislabeledTSToHLS(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "video/mp2t")
		_, _ = io.WriteString(w, "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-ENDLIST\n")
	}))
	defer upstream.Close()

	target, _ := url.Parse(upstream.URL + "/live/up/pass/123.ts")
	h := &Handler{streamClient: upstream.Client(), live: stream.NewManager()}
	r := httptest.NewRequest(http.MethodGet, "http://proxy/live/local/secret/123.ts", nil)
	w := httptest.NewRecorder()

	h.serveLiveMultiplexed(w, r, provider.Provider{ID: "provider-1", Name: "Test"}, target)

	resp := w.Result()
	defer resp.Body.Close()
	if got := resp.Header.Get("Content-Type"); got != "application/vnd.apple.mpegurl" {
		t.Fatalf("Content-Type=%q", got)
	}
	if got := resp.Header.Get("X-IPTV-Multiplexed"); got != "" {
		t.Fatalf("HLS response incorrectly exposed TS multiplex header %q", got)
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(string(body), "#EXTM3U\n") {
		t.Fatalf("body=%q", body)
	}
}
