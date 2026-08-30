package provider

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

type User struct {
	ID             string `json:"id"`
	Username       string `json:"username"`
	PasswordHash   string `json:"password_hash"`
	Enabled        int    `json:"enabled"`
	CreatedAt      string `json:"created_at"`
	UpdatedAt      string `json:"updated_at"`
	ClientPassword string `json:"-"`
}

type Provider struct {
	ID                 string `json:"id"`
	Name               string `json:"name"`
	Host               string `json:"host"`
	Route              string `json:"route"`
	UpstreamUsername   string `json:"upstream_username"`
	UpstreamPassword   string `json:"upstream_password"`
	LocalUsername      string `json:"local_username"`
	LocalPassword      string `json:"local_password"`
	Users              []User `json:"users"`
	IsDefault          int    `json:"is_default"`
	CacheDurationHours int    `json:"cache_duration_hours"`
	Enabled            int    `json:"enabled"`
}

func (p Provider) Authenticate(username, password string) (User, bool) {
	if username == "" || password == "" {
		return User{}, false
	}
	for _, user := range p.Users {
		if user.Enabled != 1 || user.Username != username {
			continue
		}
		if verifyProviderPassword(password, user.PasswordHash) {
			user.ClientPassword = password
			return user, true
		}
	}
	return User{}, false
}

type apiResponse struct {
	Success bool       `json:"success"`
	Error   string     `json:"error"`
	Data    []Provider `json:"data"`
}

type Registry struct {
	mu          sync.RWMutex
	providers   []Provider
	endpoint    string
	token       string
	client      *http.Client
	lastRefresh time.Time
}

func NewRegistry(uiURL, token string) (*Registry, error) {
	parsed, err := url.Parse(uiURL)
	if err != nil {
		return nil, fmt.Errorf("parse UI_URL: %w", err)
	}
	basePath := strings.TrimSuffix(parsed.Path, "/")
	endpoint := "http://127.0.0.1:3000" + basePath + "/api/internal/providers"
	return &Registry{
		endpoint: endpoint,
		token:    token,
		client: &http.Client{
			Timeout: 15 * time.Second,
		},
	}, nil
}

func (r *Registry) Refresh(ctx context.Context) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, r.endpoint, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+r.token)
	req.Header.Set("Accept", "application/json")

	resp, err := r.client.Do(req)
	if err != nil {
		return fmt.Errorf("load provider registry: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("load provider registry: HTTP %d", resp.StatusCode)
	}

	var payload apiResponse
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return fmt.Errorf("decode provider registry: %w", err)
	}
	if !payload.Success {
		if payload.Error == "" {
			payload.Error = "unknown error"
		}
		return errors.New(payload.Error)
	}

	enabled := make([]Provider, 0, len(payload.Data))
	for _, p := range payload.Data {
		if p.Enabled == 1 {
			enabled = append(enabled, p)
		}
	}

	r.mu.Lock()
	r.providers = enabled
	r.lastRefresh = time.Now()
	r.mu.Unlock()
	return nil
}

func (r *Registry) Start(ctx context.Context) {
	go func() {
		ticker := time.NewTicker(30 * time.Second)
		defer ticker.Stop()
		for {
			refreshCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
			_ = r.Refresh(refreshCtx)
			cancel()
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
		}
	}()
}

func (r *Registry) Snapshot(ctx context.Context) ([]Provider, error) {
	r.mu.RLock()
	providers := append([]Provider(nil), r.providers...)
	r.mu.RUnlock()
	if len(providers) > 0 {
		return providers, nil
	}
	if err := r.Refresh(ctx); err != nil {
		return nil, err
	}
	r.mu.RLock()
	defer r.mu.RUnlock()
	return append([]Provider(nil), r.providers...), nil
}
