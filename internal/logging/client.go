package logging

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type Client struct {
	endpoint string
	token    string
	http     *http.Client
}

type entry struct {
	Level    string         `json:"level"`
	Source   string         `json:"source"`
	Category string         `json:"category"`
	Message  string         `json:"message"`
	Metadata map[string]any `json:"metadata,omitempty"`
}

func New(uiURL, token string) *Client {
	parsed, err := url.Parse(uiURL)
	if err != nil {
		return nil
	}
	basePath := strings.TrimSuffix(parsed.Path, "/")
	return &Client{
		endpoint: "http://127.0.0.1:3000" + basePath + "/api/logs",
		token:    token,
		http:     &http.Client{Timeout: 3 * time.Second},
	}
}

func (c *Client) Write(level, category, message string, metadata map[string]any) {
	if c == nil || c.token == "" {
		return
	}
	go func() {
		body, err := json.Marshal(entry{
			Level:    level,
			Source:   "proxy",
			Category: category,
			Message:  message,
			Metadata: metadata,
		})
		if err != nil {
			return
		}
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.endpoint, bytes.NewReader(body))
		if err != nil {
			return
		}
		req.Header.Set("Authorization", "Bearer "+c.token)
		req.Header.Set("Content-Type", "application/json")
		resp, err := c.http.Do(req)
		if err == nil && resp.Body != nil {
			_ = resp.Body.Close()
		}
	}()
}
