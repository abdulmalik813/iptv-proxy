package provider

import (
	"encoding/json"
	"strings"
	"testing"
)

const knownProviderPasswordHash = "pbkdf2_sha256$210000$dGVzdC1zYWx0LTEyMzQ1Ng$Hupa5cSZRN9sT9l6L6yAEhEJJGpbXBP-m5ez_0-UY7w"

func TestVerifyProviderPassword(t *testing.T) {
	if !verifyProviderPassword("secret", knownProviderPasswordHash) {
		t.Fatal("expected known password verifier to match")
	}
	if verifyProviderPassword("wrong", knownProviderPasswordHash) {
		t.Fatal("wrong password must not match")
	}
}

func TestAuthenticateKeepsPlaintextRequestPasswordOutOfJSON(t *testing.T) {
	p := Provider{Users: []User{{ID: "u1", Username: "client", PasswordHash: knownProviderPasswordHash, Enabled: 1}}}
	user, ok := p.Authenticate("client", "secret")
	if !ok || user.ClientPassword != "secret" {
		t.Fatal("expected authenticated request password to be available only for this request")
	}
	encoded, err := json.Marshal(user)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), "secret") || strings.Contains(string(encoded), "ClientPassword") {
		t.Fatalf("request password leaked through JSON: %s", encoded)
	}
}
