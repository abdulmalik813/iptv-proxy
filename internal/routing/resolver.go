package routing

import (
	"context"
	"errors"
	"strings"

	"github.com/abdulmalik813/iptv-proxy/internal/provider"
)

type MatchType string

const (
	MatchRoute   MatchType = "route"
	MatchDefault MatchType = "default"
)

type Resolved struct {
	Provider      provider.Provider
	MatchedBy     MatchType
	RemainingPath string
}

type Resolver struct {
	registry *provider.Registry
}

func NewResolver(registry *provider.Registry) *Resolver {
	return &Resolver{registry: registry}
}

func (r *Resolver) Resolve(ctx context.Context, requestPath string) (Resolved, error) {
	providers, err := r.registry.Snapshot(ctx)
	if err != nil {
		return Resolved{}, err
	}
	if len(providers) == 0 {
		return Resolved{}, errors.New("no enabled IPTV providers are configured")
	}

	trimmed := strings.TrimPrefix(requestPath, "/")
	segments := strings.Split(trimmed, "/")
	first := ""
	if len(segments) > 0 {
		first = strings.ToLower(strings.TrimSpace(segments[0]))
	}

	for _, p := range providers {
		if strings.EqualFold(p.Route, first) {
			remaining := strings.Join(segments[1:], "/")
			if remaining == "" {
				remaining = "/"
			} else {
				remaining = "/" + remaining
			}
			return Resolved{Provider: p, MatchedBy: MatchRoute, RemainingPath: remaining}, nil
		}
	}

	for _, p := range providers {
		if p.IsDefault == 1 {
			remaining := requestPath
			if remaining == "" {
				remaining = "/"
			}
			return Resolved{Provider: p, MatchedBy: MatchDefault, RemainingPath: remaining}, nil
		}
	}

	return Resolved{}, errors.New("no default provider is configured and no provider route matched")
}
