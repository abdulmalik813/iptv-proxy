package main

import (
	"fmt"
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"strings"
	"time"
)

func main() {
	addr := os.Getenv("GO_PROXY_ADDR")
	if addr == "" {
		addr = ":8080"
	}

	uiURL := os.Getenv("UI_URL")
	if uiURL == "" {
		uiURL = "http://localhost:3000/ui"
	}
	parsedUIURL, err := url.Parse(uiURL)
	if err != nil {
		log.Fatalf("invalid UI_URL: %v", err)
	}
	uiBasePath := strings.TrimSuffix(parsedUIURL.Path, "/")
	if uiBasePath == "" {
		uiBasePath = "/"
	}

	uiTarget, _ := url.Parse("http://127.0.0.1:3000")
	uiProxy := httputil.NewSingleHostReverseProxy(uiTarget)
	uiProxy.ErrorHandler = func(w http.ResponseWriter, _ *http.Request, proxyErr error) {
		log.Printf("admin UI proxy error: %v", proxyErr)
		http.Error(w, "Admin UI is unavailable", http.StatusBadGateway)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})

	if uiBasePath == "/" {
		mux.Handle("/", uiProxy)
	} else {
		mux.Handle(uiBasePath, uiProxy)
		mux.Handle(uiBasePath+"/", uiProxy)
		mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path != "/" {
				http.NotFound(w, r)
				return
			}
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.WriteHeader(http.StatusOK)
			_, _ = fmt.Fprint(w, `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>IPTV Proxy Go Core</title></head><body><main><h1>I'm working</h1><p>IPTV Proxy Go core is running.</p></main></body></html>`)
		})
	}

	server := &http.Server{
		Addr:              addr,
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	log.Printf("IPTV Proxy Go core listening on %s; admin UI path %s forwards to 127.0.0.1:3000", addr, uiBasePath)
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
}
