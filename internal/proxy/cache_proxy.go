package proxy

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"

	cachepkg "github.com/abdulmalik813/iptv-proxy/internal/cache"
	"github.com/abdulmalik813/iptv-proxy/internal/provider"
)

const metadataProgressBytes = 16 * 1024 * 1024
const metadataProgressInterval = 5 * time.Second

func (h *Handler) serveCached(w http.ResponseWriter, r *http.Request, p provider.Provider, clientUser provider.User, endpoint string, upstreamURL *url.URL) {
	spec := h.newCacheSpec(p, endpoint, upstreamURL, r.Header.Clone())
	response, fromCache, err := h.cache.GetOrFetch(r.Context(), spec)
	if err != nil {
		h.trace(r.Context(), "error", "cache.fetch", "Cached IPTV metadata request failed", map[string]any{
			"providerId":   p.ID,
			"providerName": p.Name,
			"endpoint":     endpoint,
			"action":       upstreamURL.Query().Get("action"),
			"cacheKey":     spec.Key,
			"outgoingUrl":  safeURLString(upstreamURL.String()),
			"error":        err.Error(),
		})
		status := http.StatusBadGateway
		if errors.Is(err, cachepkg.ErrCacheUnavailable) {
			status = http.StatusServiceUnavailable
			w.Header().Set("Retry-After", "2")
		}
		http.Error(w, err.Error(), status)
		return
	}
	// Keep the selected generation pinned until this HTTP request is finished.
	// If a refresh swaps the manifest while the client is still receiving this
	// response, the old Redis body is retired only after this deferred release.
	defer response.Release()

	cacheState := "HIT"
	if !fromCache && spec.TTL <= 0 {
		cacheState = "BYPASS"
	}
	w.Header().Set("X-IPTV-Cache", cacheState)
	contentType, canonical := canonicalCacheContentType(response.ContentType)
	if contentType != "" {
		w.Header().Set("Content-Type", contentType)
	}

	body := response.Body
	if canonical {
		// New cache generations are already fully rewritten to the local proxy
		// namespace. A cache hit performs only literal credential placeholder
		// substitution; there is no JSON/M3U parsing, URL discovery, artwork
		// processing or media-token creation on this request.
		body = personalizeCanonicalCache(body, clientUser)
	} else {
		// Backward compatibility for Redis generations created before canonical
		// templates existed. They remain usable until the next refresh/purge swaps
		// in a new generation, so deploys never require destructive cache clears.
		if endpoint == "player_api.php" || endpoint == "panel_api.php" {
			body = rewriteXtreamJSONURLs(p, clientUser, h.xtreamProviderPublicBase(p), body)
			body = h.rewriteOpaqueMediaJSON(r.Context(), p, body)
		}
		if endpoint == "get.php" {
			body = h.rewriteM3UPlaylist(p, clientUser, body)
			body = h.rewriteOpaqueMediaM3U(r.Context(), p, body)
		}
	}

	// Cached bodies can contain per-client placeholders, so advertise the final
	// local representation's exact size. HEAD returns identical headers without
	// writing the body itself.
	w.Header().Set("Content-Length", fmt.Sprintf("%d", len(body)))
	items := -1
	if response.ItemCountKnown {
		items = response.ItemCount
	}
	h.trace(r.Context(), "debug", "cache.result", "IPTV metadata response ready", map[string]any{
		"providerId":     p.ID,
		"providerName":   p.Name,
		"clientUsername": clientUser.Username,
		"endpoint":       endpoint,
		"action":         upstreamURL.Query().Get("action"),
		"cacheKey":       spec.Key,
		"cache":          cacheState,
		"canonical":      canonical,
		"status":         response.Status,
		"bytes":          len(body),
		"items":          items,
		"outgoingUrl":    safeURLString(upstreamURL.String()),
	})
	w.WriteHeader(response.Status)
	if r.Method == http.MethodHead {
		return
	}
	_, _ = w.Write(body)
}

func (h *Handler) fetchCacheable(ctx context.Context, p provider.Provider, endpoint string, target *url.URL, sourceHeaders http.Header) (cachepkg.Response, error) {
	started := time.Now()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target.String(), nil)
	if err != nil {
		return cachepkg.Response{}, err
	}
	copySafeRequestHeaders(req.Header, sourceHeaders)
	// Cache validation/rewrite operates on decompressed provider bytes. Leave
	// Accept-Encoding unset so the metadata transport can negotiate gzip and Go
	// can transparently decompress it before this function sees the body.
	req.Header.Del("Accept-Encoding")
	outgoingURL := safeURLString(target.String())
	h.trace(ctx, "info", "upstream.request", "Outgoing metadata request to IPTV provider", map[string]any{
		"direction":     "outgoing",
		"method":        http.MethodGet,
		"url":           outgoingURL,
		"outgoingUrl":   outgoingURL,
		"providerId":    p.ID,
		"providerName":  p.Name,
		"providerRoute": p.Route,
		"endpoint":      endpoint,
		"action":        target.Query().Get("action"),
		"userAgent":     req.UserAgent(),
	})

	resp, err := h.metadataClient.Do(req)
	if err != nil {
		h.trace(ctx, "error", "upstream.error", "Outgoing metadata request to IPTV provider failed", map[string]any{
			"direction":    "outgoing",
			"method":       http.MethodGet,
			"url":          outgoingURL,
			"outgoingUrl":  outgoingURL,
			"providerId":   p.ID,
			"providerName": p.Name,
			"endpoint":     endpoint,
			"action":       target.Query().Get("action"),
			"elapsedMs":    time.Since(started).Milliseconds(),
			"error":        err.Error(),
		})
		return cachepkg.Response{}, err
	}
	defer resp.Body.Close()

	body, err := h.readMetadataBodyWithProgress(ctx, p, endpoint, target, resp.Body, resp.ContentLength, resp.Uncompressed, started)
	if err != nil {
		return cachepkg.Response{}, err
	}
	itemCount, itemCountKnown := jsonItemCount(endpoint, body)
	itemsForLog := -1
	if itemCountKnown {
		itemsForLog = itemCount
	}
	h.trace(ctx, "info", "upstream.response", "Incoming metadata response from IPTV provider", map[string]any{
		"direction":     "incoming",
		"method":        http.MethodGet,
		"url":           outgoingURL,
		"outgoingUrl":   outgoingURL,
		"providerId":    p.ID,
		"providerName":  p.Name,
		"endpoint":      endpoint,
		"action":        target.Query().Get("action"),
		"status":        resp.StatusCode,
		"contentType":   resp.Header.Get("Content-Type"),
		"contentLength": resp.ContentLength,
		"uncompressed":  resp.Uncompressed,
		"bytes":         len(body),
		"items":         itemsForLog,
		"elapsedMs":     time.Since(started).Milliseconds(),
	})
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return cachepkg.Response{}, fmt.Errorf("provider returned HTTP %d", resp.StatusCode)
	}
	if err := validateCacheBody(endpoint, body); err != nil {
		return cachepkg.Response{}, err
	}

	rewriteStarted := time.Now()
	h.trace(ctx, "debug", "cache.rewrite.start", "Canonical cache rewrite started", map[string]any{
		"providerId":   p.ID,
		"providerName": p.Name,
		"endpoint":     endpoint,
		"action":       target.Query().Get("action"),
		"bytes":        len(body),
	})
	// Do every expensive shared rewrite exactly once for this generation, after
	// validation but before Redis publish. Artwork and direct_source cleanup are
	// shared. Provider-owned URLs are converted to the local proxy namespace with
	// neutral path/query credential placeholders, and remaining signed/CDN media
	// is wrapped behind deterministic opaque tokens. Cache hits never repeat this
	// discovery/parsing work.
	body = h.rewriteCachedArtwork(ctx, p, endpoint, body)
	credentials := canonicalCacheCredentials()
	switch endpoint {
	case "player_api.php", "panel_api.php":
		body = rewriteXtreamJSONURLsWithCredentials(p, credentials, h.xtreamProviderPublicBase(p), body)
		body = h.rewriteOpaqueMediaJSON(ctx, p, body)
	case "get.php":
		body = h.rewriteM3UPlaylistWithCredentials(p, credentials, body)
		body = h.rewriteOpaqueMediaM3U(ctx, p, body)
	}
	h.trace(ctx, "debug", "cache.rewrite.completed", "Canonical cache rewrite completed", map[string]any{
		"providerId":   p.ID,
		"providerName": p.Name,
		"endpoint":     endpoint,
		"action":       target.Query().Get("action"),
		"bytes":        len(body),
		"elapsedMs":    time.Since(rewriteStarted).Milliseconds(),
	})

	return cachepkg.Response{
		Status:         resp.StatusCode,
		ContentType:    markCanonicalCacheContentType(resp.Header.Get("Content-Type")),
		Body:           body,
		ItemCount:      itemCount,
		ItemCountKnown: itemCountKnown,
	}, nil
}

func (h *Handler) readMetadataBodyWithProgress(ctx context.Context, p provider.Provider, endpoint string, target *url.URL, reader io.Reader, contentLength int64, uncompressed bool, started time.Time) ([]byte, error) {
	var buffer bytes.Buffer
	if contentLength > 0 && contentLength <= int64(^uint(0)>>1) {
		buffer.Grow(int(contentLength))
	}
	scratch := make([]byte, 256*1024)
	var total int64
	var lastLoggedBytes int64
	lastLoggedAt := time.Now()
	for {
		n, err := reader.Read(scratch)
		if n > 0 {
			_, _ = buffer.Write(scratch[:n])
			total += int64(n)
			if total-lastLoggedBytes >= metadataProgressBytes || time.Since(lastLoggedAt) >= metadataProgressInterval {
				h.trace(ctx, "debug", "cache.download.progress", "IPTV metadata download is still progressing", map[string]any{
					"providerId":    p.ID,
					"providerName":  p.Name,
					"endpoint":      endpoint,
					"action":        target.Query().Get("action"),
					"bytesReceived": total,
					"contentLength": contentLength,
					"uncompressed":  uncompressed,
					"elapsedMs":     time.Since(started).Milliseconds(),
				})
				lastLoggedBytes = total
				lastLoggedAt = time.Now()
			}
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, err
		}
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
	}
	return buffer.Bytes(), nil
}

func validateCacheBody(endpoint string, body []byte) error {
	trimmed := bytes.TrimSpace(body)
	if len(trimmed) == 0 {
		return errors.New("provider returned an empty response")
	}
	switch endpoint {
	case "player_api.php", "panel_api.php":
		var value any
		if json.Unmarshal(trimmed, &value) != nil {
			return errors.New("provider returned invalid JSON")
		}
	case "get.php":
		if !bytes.HasPrefix(trimmed, []byte("#EXTM3U")) {
			return errors.New("provider returned an invalid M3U playlist")
		}
	case "xmltv.php":
		lower := bytes.ToLower(trimmed)
		if !bytes.Contains(lower, []byte("<tv")) {
			return errors.New("provider returned invalid XMLTV data")
		}
	}
	return nil
}

func jsonItemCount(endpoint string, body []byte) (int, bool) {
	if endpoint != "player_api.php" && endpoint != "panel_api.php" {
		return 0, false
	}
	var list []json.RawMessage
	if err := json.Unmarshal(bytes.TrimSpace(body), &list); err == nil {
		return len(list), true
	}
	return 0, false
}
