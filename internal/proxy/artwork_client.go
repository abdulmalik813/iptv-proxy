package proxy

import (
	"bytes"
	"errors"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const (
	artworkConnectTimeout = 3 * time.Second
	artworkHeaderTimeout  = 5 * time.Second
	artworkTotalTimeout   = 10 * time.Second
	artworkFailureTTL     = 5 * time.Minute
	artworkMaxBytes       = 5 * 1024 * 1024
	artworkMaxRedirects   = 5
)

var artworkHTTPClient = newArtworkHTTPClient()

func newArtworkHTTPClient() *http.Client {
	dialer := &net.Dialer{
		Timeout:   artworkConnectTimeout,
		KeepAlive: 30 * time.Second,
	}
	transport := &http.Transport{
		Proxy:                 http.ProxyFromEnvironment,
		DialContext:           dialer.DialContext,
		ForceAttemptHTTP2:     false,
		MaxIdleConns:          64,
		MaxIdleConnsPerHost:   8,
		IdleConnTimeout:       30 * time.Second,
		TLSHandshakeTimeout:   artworkHeaderTimeout,
		ResponseHeaderTimeout: artworkHeaderTimeout,
		DisableCompression:    true,
	}
	return &http.Client{
		Transport: transport,
		Timeout:   artworkTotalTimeout,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= artworkMaxRedirects {
				return errors.New("artwork redirect limit exceeded")
			}
			if !safeArtworkURL(req.URL) {
				return errors.New("unsafe artwork redirect target")
			}
			return nil
		},
	}
}

func safeArtworkURL(target *url.URL) bool {
	if target == nil || target.Hostname() == "" {
		return false
	}
	if !strings.EqualFold(target.Scheme, "http") && !strings.EqualFold(target.Scheme, "https") {
		return false
	}
	host := strings.TrimSpace(strings.ToLower(target.Hostname()))
	if host == "localhost" || strings.HasSuffix(host, ".localhost") {
		return false
	}
	if parsed := net.ParseIP(host); parsed != nil {
		if parsed.IsLoopback() || parsed.IsUnspecified() || parsed.IsLinkLocalUnicast() || parsed.IsLinkLocalMulticast() {
			return false
		}
	}
	return true
}

func sniffArtworkContentType(body []byte) string {
	if len(body) == 0 {
		return ""
	}
	if len(body) >= 3 && bytes.Equal(body[:3], []byte{0xff, 0xd8, 0xff}) {
		return "image/jpeg"
	}
	if len(body) >= 8 && bytes.Equal(body[:8], []byte("\x89PNG\r\n\x1a\n")) {
		return "image/png"
	}
	if len(body) >= 6 && (bytes.Equal(body[:6], []byte("GIF87a")) || bytes.Equal(body[:6], []byte("GIF89a"))) {
		return "image/gif"
	}
	if len(body) >= 12 && bytes.Equal(body[:4], []byte("RIFF")) && bytes.Equal(body[8:12], []byte("WEBP")) {
		return "image/webp"
	}
	if len(body) >= 4 && (bytes.Equal(body[:4], []byte{0x00, 0x00, 0x01, 0x00}) || bytes.Equal(body[:4], []byte{0x00, 0x00, 0x02, 0x00})) {
		return "image/x-icon"
	}
	if len(body) >= 2 && bytes.Equal(body[:2], []byte("BM")) {
		return "image/bmp"
	}

	sample := bytes.TrimSpace(body[:min(len(body), 8192)])
	if len(sample) >= 3 && bytes.Equal(sample[:3], []byte{0xef, 0xbb, 0xbf}) {
		sample = bytes.TrimSpace(sample[3:])
	}
	lower := bytes.ToLower(sample)
	if bytes.HasPrefix(lower, []byte("<!doctype html")) ||
		bytes.HasPrefix(lower, []byte("<html")) ||
		bytes.HasPrefix(lower, []byte("<head")) ||
		bytes.HasPrefix(lower, []byte("<body")) ||
		bytes.Contains(lower, []byte("<html")) {
		return ""
	}
	if bytes.Contains(lower, []byte("<svg")) {
		return "image/svg+xml"
	}
	return ""
}
