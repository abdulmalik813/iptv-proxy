package proxy

import (
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"
	"testing"

	"github.com/abdulmalik813/iptv-proxy/internal/provider"
	"github.com/abdulmalik813/iptv-proxy/internal/routing"
)

func TestXtreamRequestValuesSupportsPostForm(t *testing.T) {
	req, err := http.NewRequest(http.MethodPost, "https://proxy.test/player_api.php?extra=1", strings.NewReader("username=local-user&password=local-pass&action=get_live_categories"))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	values, err := xtreamRequestValues(req)
	if err != nil {
		t.Fatal(err)
	}
	if values.Get("username") != "local-user" || values.Get("password") != "local-pass" {
		t.Fatalf("credentials were not parsed from POST form: %#v", values)
	}
	if values.Get("action") != "get_live_categories" || values.Get("extra") != "1" {
		t.Fatalf("POST/query values were not merged: %#v", values)
	}
	body, err := io.ReadAll(req.Body)
	if err != nil {
		t.Fatal(err)
	}
	if string(body) != "username=local-user&password=local-pass&action=get_live_categories" {
		t.Fatalf("request body was not restored: %q", body)
	}
}

func TestRewriteXtreamBootstrapUsesLocalCredentialsAndDefaultBase(t *testing.T) {
	h := &Handler{appURL: "https://iptv.example.test"}
	resolved := routing.Resolved{
		Provider: provider.Provider{ID: "provider-1", Route: "trex"},
		MatchedBy: routing.MatchDefault,
	}
	clientUser := provider.User{Username: "living-room", ClientPassword: "local-secret"}
	body := []byte(`{"user_info":{"username":"UPSTREAM","password":"UPSTREAM-PASS","auth":1,"status":"Active","max_connections":"1"},"server_info":{"url":"http://provider.invalid","port":"80","timezone":"UTC"}}`)

	rewritten := h.rewriteXtreamBootstrap(resolved, clientUser, body)
	var payload map[string]any
	if err := json.Unmarshal(rewritten, &payload); err != nil {
		t.Fatal(err)
	}
	userInfo := payload["user_info"].(map[string]any)
	if userInfo["username"] != "living-room" || userInfo["password"] != "local-secret" {
		t.Fatalf("bootstrap leaked upstream credentials: %#v", userInfo)
	}
	if userInfo["status"] != "Active" || userInfo["max_connections"] != "1" {
		t.Fatalf("provider account fields were not preserved: %#v", userInfo)
	}
	serverInfo := payload["server_info"].(map[string]any)
	if serverInfo["url"] != "https://iptv.example.test" {
		t.Fatalf("default provider URL=%v", serverInfo["url"])
	}
	if serverInfo["server_protocol"] != "https" || serverInfo["port"] != "443" || serverInfo["https_port"] != "443" {
		t.Fatalf("proxy server identity not advertised correctly: %#v", serverInfo)
	}
}

func TestRewriteXtreamBootstrapPreservesProviderRoute(t *testing.T) {
	h := &Handler{appURL: "https://iptv.example.test"}
	resolved := routing.Resolved{
		Provider: provider.Provider{ID: "provider-2", Route: "backup"},
		MatchedBy: routing.MatchRoute,
	}
	clientUser := provider.User{Username: "user", ClientPassword: "pass"}
	body := []byte(`{"user_info":{"username":"up","password":"up-pass","auth":"1"},"server_info":{}}`)

	rewritten := h.rewriteXtreamBootstrap(resolved, clientUser, body)
	var payload struct {
		ServerInfo map[string]any `json:"server_info"`
	}
	if err := json.Unmarshal(rewritten, &payload); err != nil {
		t.Fatal(err)
	}
	if payload.ServerInfo["url"] != "https://iptv.example.test/backup" {
		t.Fatalf("routed provider URL=%v", payload.ServerInfo["url"])
	}
}

func TestCloneURLValuesDoesNotAliasInput(t *testing.T) {
	original := url.Values{"a": {"1"}}
	cloned := cloneURLValues(original)
	cloned.Set("a", "2")
	if original.Get("a") != "1" {
		t.Fatalf("clone modified input: %#v", original)
	}
}
