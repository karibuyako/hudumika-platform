package payments

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"net/http"
	"testing"
)

// webhookUnitSecret is the key every unit test signs with.
const webhookUnitSecret = "webhook-unit-test-secret"

func webhookUnitBody() []byte {
	return []byte(`{"orderId":"00000000-0000-4000-8000-000000000000","reference":"REF-U-1","status":"paid"}`)
}

func webhookUnitHex(t *testing.T, body []byte) string {
	t.Helper()
	mac := hmac.New(sha256.New, []byte(webhookUnitSecret))
	mac.Write(body)
	return hex.EncodeToString(mac.Sum(nil))
}

func webhookUnitBase64(t *testing.T, body []byte) string {
	t.Helper()
	mac := hmac.New(sha256.New, []byte(webhookUnitSecret))
	mac.Write(body)
	return base64.StdEncoding.EncodeToString(mac.Sum(nil))
}

func webhookUnitHeaders(header, value string) http.Header {
	h := make(http.Header)
	h.Set(header, value)
	return h
}

// TestHMACVerifierHex: the default scheme accepts the plain hex digest in
// X-Webhook-Signature, both through the Verifier interface and through the
// VerifySignature convenience.
func TestHMACVerifierHex(t *testing.T) {
	body := webhookUnitBody()
	sig := webhookUnitHex(t, body)

	ok, err := (HMACVerifier{}).Verify([]byte(webhookUnitSecret), body,
		webhookUnitHeaders(HeaderWebhookSignature, sig))
	if err != nil || !ok {
		t.Fatalf("Verify = ok %v err %v, want true nil", ok, err)
	}
	if !VerifySignature([]byte(webhookUnitSecret), body, sig) {
		t.Fatal("VerifySignature = false, want true")
	}
}

// TestHMACVerifierHubForm: the GitHub-style X-Hub-Signature-256
// ("sha256=<hex>") form is accepted by the default scheme, and the plain hex
// value in that header works too.
func TestHMACVerifierHubForm(t *testing.T) {
	body := webhookUnitBody()
	for name, sig := range map[string]string{
		"hub-sha256-form": "sha256=" + webhookUnitHex(t, body),
		"hub-plain-hex":   webhookUnitHex(t, body),
	} {
		ok, err := (HMACVerifier{}).Verify([]byte(webhookUnitSecret), body,
			webhookUnitHeaders(HeaderHubSignature256, sig))
		if err != nil || !ok {
			t.Fatalf("%s: Verify = ok %v err %v, want true nil", name, ok, err)
		}
	}
}

// TestMPesaVerifierAcceptsAllForms: the mpesa (Daraja) scheme accepts the
// hex, the "sha256=" hub form and the "base64:" raw-digest variant — the
// latter in either signature header.
func TestMPesaVerifierAcceptsAllForms(t *testing.T) {
	body := webhookUnitBody()
	hexSig := webhookUnitHex(t, body)
	base64Sig := "base64:" + webhookUnitBase64(t, body)

	cases := []struct {
		name   string
		header string
		sig    string
	}{
		{"hex", HeaderWebhookSignature, hexSig},
		{"hub-sha256-form", HeaderWebhookSignature, "sha256=" + hexSig},
		{"hub-header", HeaderHubSignature256, "sha256=" + hexSig},
		{"base64-webhook-header", HeaderWebhookSignature, base64Sig},
		{"base64-hub-header", HeaderHubSignature256, base64Sig},
	}
	for _, tc := range cases {
		ok, err := (MPesaVerifier{}).Verify([]byte(webhookUnitSecret), body,
			webhookUnitHeaders(tc.header, tc.sig))
		if err != nil || !ok {
			t.Fatalf("%s: Verify = ok %v err %v, want true nil", tc.name, ok, err)
		}
	}
}

// TestMismatchedSignatureRejected: a digest of a different body is rejected
// under every scheme (hex and base64), with ok=false and no error — the
// signature decoded, it just did not match.
func TestMismatchedSignatureRejected(t *testing.T) {
	body := webhookUnitBody()
	other := []byte(`{"orderId":"00000000-0000-4000-8000-000000000000","reference":"REF-U-1","status":"failed"}`)
	wrongHex := webhookUnitHex(t, other)
	wrongBase64 := "base64:" + webhookUnitBase64(t, other)

	for _, tc := range []struct {
		name   string
		v      Verifier
		sig    string
		header string
	}{
		{"hmac-hex", HMACVerifier{}, wrongHex, HeaderWebhookSignature},
		{"hmac-hub", HMACVerifier{}, "sha256=" + wrongHex, HeaderHubSignature256},
		{"mpesa-hex", MPesaVerifier{}, wrongHex, HeaderWebhookSignature},
		{"mpesa-base64", MPesaVerifier{}, wrongBase64, HeaderWebhookSignature},
	} {
		ok, err := tc.v.Verify([]byte(webhookUnitSecret), body,
			webhookUnitHeaders(tc.header, tc.sig))
		if ok || err != nil {
			t.Fatalf("%s: Verify = ok %v err %v, want false nil", tc.name, ok, err)
		}
	}
}

// TestDefaultVerifiersRegistry: the registry covers every contract provider,
// mpesa mapping to MPesaVerifier and the rest to HMACVerifier.
func TestDefaultVerifiersRegistry(t *testing.T) {
	registry := DefaultVerifiers()
	for _, provider := range []string{"mpesa", "tigo", "airtel", "card", "cardtonic"} {
		if registry[provider] == nil {
			t.Fatalf("provider %s has no verifier", provider)
		}
	}
	if _, ok := registry["mpesa"].(MPesaVerifier); !ok {
		t.Fatalf("mpesa verifier = %T, want MPesaVerifier", registry["mpesa"])
	}
	for _, provider := range []string{"tigo", "airtel", "card", "cardtonic"} {
		if _, ok := registry[provider].(HMACVerifier); !ok {
			t.Fatalf("%s verifier = %T, want HMACVerifier", provider, registry[provider])
		}
	}
}

// TestDefaultVerifiersUnknownProviderFallsBack: an unregistered provider has
// no verifier in the registry; the handler's fallback — HMACVerifier — must
// accept the platform-default hex scheme so unregistered providers keep
// working on the default scheme.
func TestDefaultVerifiersUnknownProviderFallsBack(t *testing.T) {
	if v := DefaultVerifiers()["no-such-provider"]; v != nil {
		t.Fatalf("unknown provider verifier = %v, want nil", v)
	}
	body := webhookUnitBody()
	ok, err := (HMACVerifier{}).Verify([]byte(webhookUnitSecret), body,
		webhookUnitHeaders(HeaderWebhookSignature, webhookUnitHex(t, body)))
	if err != nil || !ok {
		t.Fatalf("fallback HMACVerifier = ok %v err %v, want true nil", ok, err)
	}
}

// TestMalformedSignaturesNoPanic: malformed input — broken base64 under the
// "base64:" prefix, a wrong-length digest, non-hex text, an empty marker and
// no signature at all — must fail closed under every scheme without panicking.
func TestMalformedSignaturesNoPanic(t *testing.T) {
	body := webhookUnitBody()
	bad := map[string]string{
		"no-header":         "",
		"empty":             "   ",
		"hex-garbage":       "zz-not-hex",
		"base64-broken":     "base64:%%not-base64%%",
		"base64-short":      "base64:AQID",
		"base64-empty":      "base64:",
		"hub-base64-broken": "sha256=base64:%%not-base64%%",
	}
	for name, sig := range bad {
		func() {
			defer func() {
				if r := recover(); r != nil {
					t.Fatalf("%q panicked: %v", name, r)
				}
			}()
			for _, v := range []Verifier{HMACVerifier{}, MPesaVerifier{}} {
				ok, _ := v.Verify([]byte(webhookUnitSecret), body,
					webhookUnitHeaders(HeaderWebhookSignature, sig))
				if ok {
					t.Fatalf("%q: %T verified a malformed signature", name, v.Name())
				}
			}
		}()
	}
}

// TestVerifyRejectsEmptySecretOrBody: a missing secret or empty body never
// verifies, matching the historical VerifySignature contract.
func TestVerifyRejectsEmptySecretOrBody(t *testing.T) {
	body := webhookUnitBody()
	for _, v := range []Verifier{HMACVerifier{}, MPesaVerifier{}} {
		ok, err := v.Verify(nil, body, webhookUnitHeaders(HeaderWebhookSignature, webhookUnitHex(t, body)))
		if ok || err != nil {
			t.Fatalf("%s with nil secret = ok %v err %v, want false nil", v.Name(), ok, err)
		}
		ok, err = v.Verify([]byte(webhookUnitSecret), nil, webhookUnitHeaders(HeaderWebhookSignature, webhookUnitHex(t, body)))
		if ok || err != nil {
			t.Fatalf("%s with empty body = ok %v err %v, want false nil", v.Name(), ok, err)
		}
	}
}
