package main

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"strings"
	"time"

	cachepkg "github.com/abdulmalik813/iptv-proxy/internal/cache"
	proxylog "github.com/abdulmalik813/iptv-proxy/internal/logging"
	"github.com/abdulmalik813/iptv-proxy/internal/provider"
	proxycore "github.com/abdulmalik813/iptv-proxy/internal/proxy"
	"github.com/abdulmalik813/iptv-proxy/internal/routing"
	"github.com/redis/go-redis/v9"
)

func main() {
	addr := envOr("GO_PROXY_ADDR", ":8080")
	uiURL := envOr("UI_URL", "http://localhost:3000/ui")
	appURL := envOr("APP_URL", "http://localhost:8080")
	redisAddr := envOr("REDIS_ADDR", "redis:6379")
	internalToken := os.Getenv("INTERNAL_API_TOKEN")
	if internalToken == "" {
		log.Fatal("INTERNAL_API_TOKEN is required by the Go core")
	}

	parsedUIURL, err := url.Parse(uiURL)
	if err != nil {
		log.Fatalf("invalid UI_URL: %v", err)
	}
	uiBasePath := strings.TrimSuffix(parsedUIURL.Path, "/")
	if uiBasePath == "" {
		uiBasePath = "/"
	}

	redisClient := redis.NewClient(&redis.Options{Addr: redisAddr})
	pingCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	if err := waitForRedis(pingCtx, redisClient); err != nil {
		cancel()
		log.Fatalf("Redis is unavailable: %v", err)
	}
	cancel()

	registry, err := provider.NewRegistry(uiURL, internalToken)
	if err != nil {
		log.Fatal(err)
	}
	registry.Start(context.Background())
	resolver := routing.NewResolver(registry)
	cacheManager := cachepkg.NewManager(redisClient)
	traceLogger := proxylog.New(uiURL, internalToken)
	iptvHandler := proxycore.NewHandler(resolver, cacheManager, redisClient, traceLogger, appURL)

	rehydrateCtx, rehydrateCancel := context.WithTimeout(context.Background(), 30*time.Second)
	if count, err := iptvHandler.RehydratePersistedCache(rehydrateCtx); err != nil {
		log.Printf("persisted cache rehydration failed: %v", err)
	} else {
		log.Printf("rehydrated %d persisted IPTV cache fetch jobs", count)
	}
	rehydrateCancel()

	uiTarget, _ := url.Parse("http://127.0.0.1:3000")
	uiProxy := httputil.NewSingleHostReverseProxy(uiTarget)
	uiProxy.ErrorHandler = func(w http.ResponseWriter, _ *http.Request, proxyErr error) {
		log.Printf("admin UI proxy error: %v", proxyErr)
		http.Error(w, "Admin UI is unavailable", http.StatusBadGateway)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
		defer cancel()
		if err := cacheManager.Ping(ctx); err != nil {
			http.Error(w, "redis unavailable", http.StatusServiceUnavailable)
			return
		}
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	mux.HandleFunc("/internal/streams", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			methodNotAllowed(w, http.MethodGet)
			return
		}
		if !validInternalToken(r, internalToken) {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"success": true, "data": iptvHandler.LiveSnapshots()})
	})
	mux.HandleFunc("/internal/cache", func(w http.ResponseWriter, r *http.Request) {
		if !validInternalToken(r, internalToken) {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		switch r.Method {
		case http.MethodGet:
			ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
			defer cancel()
			entries, err := cacheManager.Entries(ctx)
			if err != nil {
				writeJSON(w, http.StatusInternalServerError, map[string]any{"success": false, "error": err.Error()})
				return
			}
			stats, err := cacheManager.Stats(ctx)
			if err != nil {
				writeJSON(w, http.StatusInternalServerError, map[string]any{"success": false, "error": err.Error()})
				return
			}
			writeJSON(w, http.StatusOK, map[string]any{"success": true, "data": entries, "stats": stats})
		case http.MethodDelete:
			ctx, cancel := context.WithTimeout(r.Context(), 10*time.Minute)
			defer cancel()
			key := r.URL.Query().Get("key")
			if key == "" {
				count, err := cacheManager.PurgeAll(ctx)
				if err != nil {
					writeJSON(w, http.StatusInternalServerError, map[string]any{"success": false, "error": err.Error(), "replaced": count})
					return
				}
				writeJSON(w, http.StatusOK, map[string]any{"success": true, "replaced": count})
				return
			}
			if err := cacheManager.Purge(ctx, key); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]any{"success": false, "error": err.Error()})
				return
			}
			writeJSON(w, http.StatusOK, map[string]any{"success": true, "replaced": 1})
		default:
			methodNotAllowed(w, http.MethodGet+", "+http.MethodDelete)
		}
	})
	mux.HandleFunc("/internal/cache/refresh", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			methodNotAllowed(w, http.MethodPost)
			return
		}
		if !validInternalToken(r, internalToken) {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		key := strings.TrimSpace(r.URL.Query().Get("key"))
		if key == "" {
			writeJSON(w, http.StatusBadRequest, map[string]any{"success": false, "error": "key is required"})
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 10*time.Minute)
		defer cancel()
		if err := cacheManager.RefreshNow(ctx, key); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"success": false, "error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"success": true, "replaced": 1})
	})
	mux.HandleFunc("/internal/cache/start", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			methodNotAllowed(w, http.MethodPost)
			return
		}
		if !validInternalToken(r, internalToken) {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 30*time.Minute)
		defer cancel()
		result := iptvHandler.WarmAllCache(ctx)
		status := http.StatusOK
		if result.Failed > 0 && result.Succeeded == 0 {
			status = http.StatusBadGateway
		}
		writeJSON(w, status, map[string]any{"success": result.Failed == 0, "data": result})
	})

	if uiBasePath == "/" {
		mux.Handle("/", uiProxy)
	} else {
		mux.Handle(uiBasePath, uiProxy)
		mux.Handle(uiBasePath+"/", uiProxy)
		mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path == "/" {
				w.Header().Set("Content-Type", "text/html; charset=utf-8")
				w.WriteHeader(http.StatusOK)
				_, _ = fmt.Fprint(w, `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>IPTV Proxy Go Core</title></head><body><main><h1>I'm working</h1><p>IPTV Proxy Go core is running.</p></main></body></html>`)
				return
			}
			iptvHandler.ServeHTTP(w, r)
		})
	}

	server := &http.Server{Addr: addr, Handler: mux, ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 90 * time.Second}
	log.Printf("IPTV Proxy Go core listening on %s; Redis %s; admin UI %s", addr, redisAddr, uiBasePath)
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
}

func envOr(name, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(name)); value != "" {
		return value
	}
	return fallback
}

func validInternalToken(r *http.Request, expected string) bool {
	authorization := r.Header.Get("Authorization")
	if !strings.HasPrefix(authorization, "Bearer ") {
		return false
	}
	provided := strings.TrimSpace(strings.TrimPrefix(authorization, "Bearer "))
	if provided == "" || len(provided) != len(expected) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(provided), []byte(expected)) == 1
}

func waitForRedis(ctx context.Context, client *redis.Client) error {
	ticker := time.NewTicker(250 * time.Millisecond)
	defer ticker.Stop()
	for {
		if err := client.Ping(ctx).Err(); err == nil {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func methodNotAllowed(w http.ResponseWriter, allow string) {
	w.Header().Set("Allow", allow)
	http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
}
