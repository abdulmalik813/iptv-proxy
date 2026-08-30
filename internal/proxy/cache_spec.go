package proxy

import (
	"context"
	"net/http"
	"net/url"
	"strings"
	"time"

	cachepkg "github.com/abdulmalik813/iptv-proxy/internal/cache"
	"github.com/abdulmalik813/iptv-proxy/internal/provider"
)

func (h *Handler) newCacheSpec(p provider.Provider, endpoint string, target *url.URL, sourceHeaders http.Header) cachepkg.Spec {
	descriptor := cacheDescriptor(p.ID, endpoint, target, sourceHeaders)
	return h.cacheSpecFromDescriptor(descriptor, time.Duration(p.CacheDurationHours)*time.Hour)
}

func (h *Handler) cacheSpecFromDescriptor(descriptor cachepkg.Descriptor, ttl time.Duration) cachepkg.Spec {
	return cachepkg.Spec{
		Key:        descriptor.CacheKey(),
		TTL:        ttl,
		Descriptor: descriptor,
		Fetch: func(ctx context.Context) (cachepkg.Response, error) {
			ctx = ensureTrace(ctx)
			currentProvider, target, headers, err := h.targetFromCacheDescriptor(ctx, descriptor)
			if err != nil {
				return cachepkg.Response{}, err
			}
			return h.fetchCacheable(ctx, currentProvider, descriptor.Endpoint, target, headers)
		},
	}
}

func cacheDescriptor(providerID, endpoint string, target *url.URL, sourceHeaders http.Header) cachepkg.Descriptor {
	query := target.Query()
	query.Del("username")
	query.Del("password")
	return cachepkg.Descriptor{
		ProviderID: providerID,
		Endpoint:   endpoint,
		Query:      query.Encode(),
		Headers:    metadataHeaders(sourceHeaders),
	}
}

func metadataHeaders(source http.Header) map[string]string {
	headers := map[string]string{}
	if source != nil {
		if value := strings.TrimSpace(source.Get("User-Agent")); value != "" {
			headers["User-Agent"] = value
		}
		if value := strings.TrimSpace(source.Get("Accept")); value != "" {
			headers["Accept"] = value
		}
	}
	if headers["User-Agent"] == "" {
		headers["User-Agent"] = "IPTV-Proxy/1.0"
	}
	if headers["Accept"] == "" {
		headers["Accept"] = "*/*"
	}
	return headers
}

func (h *Handler) targetFromCacheDescriptor(ctx context.Context, descriptor cachepkg.Descriptor) (provider.Provider, *url.URL, http.Header, error) {
	p, err := h.resolver.ProviderByID(ctx, descriptor.ProviderID)
	if err != nil {
		return provider.Provider{}, nil, nil, err
	}
	target, err := url.Parse(strings.TrimSuffix(p.Host, "/") + "/" + strings.TrimPrefix(descriptor.Endpoint, "/"))
	if err != nil {
		return provider.Provider{}, nil, nil, err
	}
	query, err := url.ParseQuery(descriptor.Query)
	if err != nil {
		return provider.Provider{}, nil, nil, err
	}
	query.Set("username", p.UpstreamUsername)
	query.Set("password", p.UpstreamPassword)
	target.RawQuery = query.Encode()

	headers := make(http.Header)
	for key, value := range descriptor.Headers {
		if strings.TrimSpace(value) != "" {
			headers.Set(key, value)
		}
	}
	return p, target, headers, nil
}
