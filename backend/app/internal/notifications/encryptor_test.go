package notifications

import (
	"bytes"
	"strings"
	"testing"
)

func TestEncryptRoundTrip(t *testing.T) {
	enc, err := NewEncryptor(strings.Repeat("ab", 32))
	if err != nil {
		t.Fatalf("NewEncryptor: %v", err)
	}
	plain := []byte(`{"code":"123456","requestId":"a1b2c3d4"}`)
	cipher, err := enc.Encrypt(plain)
	if err != nil {
		t.Fatalf("Encrypt: %v", err)
	}
	if bytes.Equal(cipher, plain) {
		t.Fatal("Encrypt must not return plaintext")
	}
	got, err := enc.Decrypt(cipher)
	if err != nil {
		t.Fatalf("Decrypt: %v", err)
	}
	if !bytes.Equal(got, plain) {
		t.Errorf("roundtrip mismatch: got %q, want %q", got, plain)
	}
}

func TestEncryptUsesFreshNoncePerPayload(t *testing.T) {
	enc, err := NewEncryptor(strings.Repeat("ab", 32))
	if err != nil {
		t.Fatalf("NewEncryptor: %v", err)
	}
	plain := []byte("same plaintext")
	first, err := enc.Encrypt(plain)
	if err != nil {
		t.Fatalf("Encrypt: %v", err)
	}
	second, err := enc.Encrypt(plain)
	if err != nil {
		t.Fatalf("Encrypt: %v", err)
	}
	if bytes.Equal(first, second) {
		t.Fatal("two encryptions of the same payload must differ (random nonce)")
	}
}

func TestDecryptWithWrongKeyFails(t *testing.T) {
	enc, err := NewEncryptor(strings.Repeat("ab", 32))
	if err != nil {
		t.Fatalf("NewEncryptor: %v", err)
	}
	cipher, err := enc.Encrypt([]byte("secret"))
	if err != nil {
		t.Fatalf("Encrypt: %v", err)
	}
	wrong, err := NewEncryptor(strings.Repeat("cd", 32))
	if err != nil {
		t.Fatalf("NewEncryptor: %v", err)
	}
	if _, err := wrong.Decrypt(cipher); err == nil {
		t.Fatal("Decrypt with the wrong key must fail")
	}
}

func TestDecryptCorruptPayloadFails(t *testing.T) {
	enc, err := NewEncryptor(strings.Repeat("ab", 32))
	if err != nil {
		t.Fatalf("NewEncryptor: %v", err)
	}
	if _, err := enc.Decrypt([]byte("not-base64!")); err == nil {
		t.Fatal("Decrypt of invalid base64 must fail")
	}
	if _, err := enc.Decrypt([]byte("YWJj")); err == nil {
		t.Fatal("Decrypt of truncated ciphertext must fail")
	}
}

func TestNewEncryptorRejectsBadKeys(t *testing.T) {
	cases := []struct {
		name string
		key  string
	}{
		{"empty", ""},
		{"not hex", "not-a-hex-key"},
		{"too short", "aabbccdd"},
		{"too long", strings.Repeat("ab", 33)},
	}
	for _, tc := range cases {
		if _, err := NewEncryptor(tc.key); err == nil {
			t.Errorf("NewEncryptor(%q) must fail", tc.name)
		}
	}
}
