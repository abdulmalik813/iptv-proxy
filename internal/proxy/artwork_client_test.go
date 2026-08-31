package proxy

import (
	"bytes"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"

	"github.com/abdulmalik813/iptv-proxy/internal/provider"
)

func TestNewArtworkHTTPClientUsesShortTimeouts(t *testing.T) {
	client := newArtworkHTTPClient()
	if client.Timeout != artworkTotalTimeout || client.Timeout > 10*time.Second {
		t.Fatalf("artwork timeout=%s", client.Timeout)
	}
	transport, ok := client.Transport.(*http.Transport)
	if !ok {
		t.Fatalf("transport type=%T", client.Transport)
	}
	if transport.ResponseHeaderTimeout != artworkHeaderTimeout || transport.TLSHandshakeTimeout != artworkHeaderTimeout {
		t.Fatalf("header=%s tls=%s", transport.ResponseHeaderTimeout, transport.TLSHandshakeTimeout)
	}
}

func TestSniffArtworkContentTypeRejectsHTML(t *testing.T) {
	if got := sniffArtworkContentType([]byte("<html><body><svg></svg></body></html>")); got != "" {
		t.Fatalf("HTML classified as %q", got)
	}
	if got := sniffArtworkContentType([]byte("\x89PNG\r\n\x1a\nrest")); got != "image/png" {
		t.Fatalf("PNG classified as %q", got)
	}
	if got := sniffArtworkContentType([]byte("  <svg xmlns=\"http://www.w3.org/2000/svg\"></svg>")); got != "image/svg+xml" {
		t.Fatalf("SVG classified as %q", got)
	}
}

func TestSniffArtworkContentTypeSupportsModernFormats(t *testing.T) {
	avif := append([]byte{0, 0, 0, 24}, []byte("ftypavif\x00\x00\x00\x00avifmif1")...)
	if got := sniffArtworkContentType(avif); got != "image/avif" {
		t.Fatalf("AVIF classified as %q", got)
	}
	heic := append([]byte{0, 0, 0, 24}, []byte("ftypheic\x00\x00\x00\x00heicmif1")...)
	if got := sniffArtworkContentType(heic); got != "image/heic" {
		t.Fatalf("HEIC classified as %q", got)
	}
	tiff := []byte{'I', 'I', 0x2a, 0x00, 1, 2, 3, 4}
	if got := sniffArtworkContentType(tiff); got != "image/tiff" {
		t.Fatalf("TIFF classified as %q", got)
	}
}

func TestServeArtworkValidatesAndReturnsImage(t *testing.T) {
	image := []byte("\x89PNG\r\n\x1a\nvalidated-image")
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/octet-stream")
		_, _ = w.Write(image)
	}))
	defer upstream.Close()
	target, _ := url.Parse(upstream.URL + "/poster.png")

	h := &Handler{}
	r := httptest.NewRequest(http.MethodGet, "http://proxy/_artwork/token", nil)
	w := httptest.NewRecorder()
	h.serveArtwork(w, r, provider.Provider{ID: "p1", Name: "Provider"}, target, "")

	resp := w.Result()
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK || resp.Header.Get("Content-Type") != "image/png" || !bytes.Equal(body, image) {
		t.Fatalf("status=%d type=%q body=%q", resp.StatusCode, resp.Header.Get("Content-Type"), body)
	}
	if resp.Header.Get("X-Content-Type-Options") != "nosniff" {
		t.Fatal("missing nosniff header")
	}
}

func TestServeArtworkHEADUsesUpstreamGETAndReturnsNoBody(t *testing.T) {
	image := []byte("\x89PNG\r\n\x1a\nvalidated-image")
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			t.Fatalf("upstream method=%s want GET", r.Method)
		}
		if r.Header.Get("If-None-Match") != "" || r.Header.Get("Range") != "" {
			t.Fatalf("conditional/range headers leaked upstream: %#v", r.Header)
		}
		w.Header().Set("Content-Type", "image/png")
		_, _ = w.Write(image)
	}))
	defer upstream.Close()
	target, _ := url.Parse(upstream.URL + "/poster.png")

	h := &Handler{}
	r := httptest.NewRequest(http.MethodHead, "http://proxy/_artwork/token", nil)
	r.Header.Set("If-None-Match", "etag")
	r.Header.Set("Range", "bytes=0-10")
	w := httptest.NewRecorder()
	h.serveArtwork(w, r, provider.Provider{ID: "p1", Name: "Provider"}, target, "")

	resp := w.Result()
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK || resp.Header.Get("Content-Type") != "image/png" {
		t.Fatalf("status=%d type=%q", resp.StatusCode, resp.Header.Get("Content-Type"))
	}
	if len(body) != 0 {
		t.Fatalf("HEAD returned %d body bytes", len(body))
	}
	if resp.Header.Get("Content-Length") != "23" {
		t.Fatalf("Content-Length=%q", resp.Header.Get("Content-Length"))
	}
}

func TestServeArtworkRejectsHTMLHTTP200(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "image/png")
		_, _ = io.WriteString(w, "<html>not an image</html>")
	}))
	defer upstream.Close()
	target, _ := url.Parse(upstream.URL + "/poster.png")

	h := &Handler{}
	r := httptest.NewRequest(http.MethodGet, "http://proxy/_artwork/token", nil)
	w := httptest.NewRecorder()
	h.serveArtwork(w, r, provider.Provider{ID: "p1", Name: "Provider"}, target, "")
	if w.Code != http.StatusBadGateway {
		t.Fatalf("status=%d", w.Code)
	}
}

func TestServeArtworkDoesNotUseVideoLengthTimeouts(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		time.Sleep(250 * time.Millisecond)
		_, _ = w.Write([]byte("\x89PNG\r\n\x1a\nlate"))
	}))
	defer upstream.Close()
	target, _ := url.Parse(upstream.URL + "/slow.png")

	previous := artworkHTTPClient
	artworkHTTPClient = &http.Client{Timeout: 50 * time.Millisecond}
	defer func() { artworkHTTPClient = previous }()

	h := &Handler{}
	r := httptest.NewRequest(http.MethodGet, "http://proxy/_artwork/token", nil)
	w := httptest.NewRecorder()
	started := time.Now()
	h.serveArtwork(w, r, provider.Provider{ID: "p1", Name: "Provider"}, target, "")
	if w.Code != http.StatusBadGateway {
		t.Fatalf("status=%d", w.Code)
	}
	if elapsed := time.Since(started); elapsed > time.Second {
		t.Fatalf("artwork timeout took %s", elapsed)
	}
}
