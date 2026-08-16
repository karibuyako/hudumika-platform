package payments

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"strings"
)

// Signature header names understood by the HMAC family of verifiers.
const (
	HeaderWebhookSignature = "X-Webhook-Signature"
	HeaderHubSignature256  = "X-Hub-Signature-256"
)

// Signature-scheme sentinel errors. Verify reports them so callers can tell a
// protocol problem (the request carried no usable signature) apart from a
// mismatch (ok=false, err=nil). Verification always fails closed.
var (
	// ErrSignatureMissing reports a request with neither
	// X-Webhook-Signature nor X-Hub-Signature-256.
	ErrSignatureMissing = errors.New("payments: webhook signature header missing")
	// ErrMalformedSignature reports a signature value that cannot be decoded
	// (non-hex text, invalid base64). The payload is rejected.
	ErrMalformedSignature = errors.New("payments: malformed webhook signature")
)

// Verifier validates a provider webhook's signature. Providers sign with
// their own key under their own scheme; DefaultVerifiers maps the contract
// provider enum to the matching verifier.
//
// Adapter seam: to add a provider scheme, implement Verifier and register it
// in DefaultVerifiers (or install a custom registry at startup). The api
// handler selects purely through this interface, so a new Verifier is a
// drop-in — no handler changes required.
type Verifier interface {
	// Name is the scheme name used in logs and diagnostics.
	Name() string
	// Verify reports whether body is authentic under secret. ok=false with
	// err=nil means the signature decoded but did not match; a non-nil err
	// means the request carried no usable signature. Never panics, even on
	// malformed input.
	Verify(secret []byte, body []byte, headers http.Header) (ok bool, err error)
}

// HMACVerifier is the platform default scheme: hex HMAC-SHA256 of the raw
// body keyed by the provider secret, sent in X-Webhook-Signature. The
// GitHub-style X-Hub-Signature-256 form ("sha256=<hex>") is also accepted.
// The comparison is constant-time; a missing secret, empty body or empty
// signature never verifies.
type HMACVerifier struct{}

// Name reports the default scheme name.
func (HMACVerifier) Name() string { return "hmac-sha256" }

// Verify implements Verifier for the hex HMAC-SHA256 scheme.
func (HMACVerifier) Verify(secret []byte, body []byte, headers http.Header) (bool, error) {
	if len(secret) == 0 || len(body) == 0 {
		return false, nil
	}
	signature, err := signatureFromHeaders(headers)
	if err != nil {
		return false, err
	}
	return verifyHexHMAC(secret, body, signature)
}

// MPesaVerifier is the Daraja-style M-Pesa scheme: the same HMAC-SHA256
// construction as HMACVerifier (hex in X-Webhook-Signature, or
// "sha256=<hex>" in X-Hub-Signature-256), extended with the base64 variant:
//
//	base64:<base64 of the raw HMAC-SHA256 bytes>
//
// Safaricom's Daraja gateways expose the digest as base64 rather than hex.
// The "base64:" prefix is the per-signature opt-in flag: when it is present
// the suffix decodes to raw MAC bytes and is compared to the raw MAC in
// constant time; without it the value is always treated as hex, so a provider
// can never silently flip schemes. Both decodings are constant-time, and a
// malformed base64 suffix fails closed instead of panicking.
type MPesaVerifier struct{}

// Name reports the M-Pesa scheme name.
func (MPesaVerifier) Name() string { return "mpesa-hmac-sha256" }

// Verify implements Verifier for the Daraja HMAC-SHA256 scheme (hex plus the
// base64: variant).
func (MPesaVerifier) Verify(secret []byte, body []byte, headers http.Header) (bool, error) {
	if len(secret) == 0 || len(body) == 0 {
		return false, nil
	}
	signature, err := signatureFromHeaders(headers)
	if err != nil {
		return false, err
	}
	if strings.HasPrefix(signature, "base64:") {
		return verifyBase64HMAC(secret, body, strings.TrimPrefix(signature, "base64:"))
	}
	return verifyHexHMAC(secret, body, signature)
}

// DefaultVerifiers maps the contract webhook provider enum (mpesa, tigo,
// airtel, card, cardtonic) to the verifier for that provider's signature
// scheme. Every provider signs with its own key; the default scheme is
// HMACVerifier. M-Pesa (Daraja) additionally accepts the base64: variant.
// An unknown provider yields nil — callers fall back to HMACVerifier, the
// platform default.
func DefaultVerifiers() map[string]Verifier {
	return map[string]Verifier{
		"mpesa":     MPesaVerifier{},
		"tigo":      HMACVerifier{},
		"airtel":    HMACVerifier{},
		"card":      HMACVerifier{},
		"cardtonic": HMACVerifier{},
	}
}

// VerifySignature is the default-path convenience: it verifies the hex
// HMAC-SHA256 of body keyed by secret against signature (X-Webhook-Signature
// plain hex, or X-Hub-Signature-256 "sha256=<hex>" form), exactly like
// HMACVerifier. Kept for callers that already hold the raw signature string.
func VerifySignature(secret []byte, body []byte, signature string) bool {
	headers := make(http.Header)
	if signature != "" {
		headers.Set(HeaderWebhookSignature, signature)
	}
	ok, _ := HMACVerifier{}.Verify(secret, body, headers)
	return ok
}

// signatureFromHeaders extracts the signature value: X-Webhook-Signature
// first, falling back to X-Hub-Signature-256, with the "sha256=" prefix
// stripped and surrounding whitespace trimmed.
func signatureFromHeaders(headers http.Header) (string, error) {
	signature := strings.TrimSpace(headers.Get(HeaderWebhookSignature))
	if signature == "" {
		signature = strings.TrimSpace(headers.Get(HeaderHubSignature256))
	}
	if strings.HasPrefix(signature, "sha256=") {
		signature = strings.TrimPrefix(signature, "sha256=")
	}
	if signature == "" {
		return "", ErrSignatureMissing
	}
	return signature, nil
}

// verifyHexHMAC compares the lowercase hex HMAC-SHA256 of body keyed by
// secret against got. Non-hex text never matches; the comparison is
// constant-time over equal-length values.
func verifyHexHMAC(secret []byte, body []byte, got string) (bool, error) {
	if got == "" {
		return false, ErrSignatureMissing
	}
	mac := hmac.New(sha256.New, secret)
	mac.Write(body)
	want := hex.EncodeToString(mac.Sum(nil))
	got = strings.ToLower(got)
	if len(got) != len(want) {
		return false, nil
	}
	return subtle.ConstantTimeCompare([]byte(got), []byte(want)) == 1, nil
}

// verifyBase64HMAC compares raw HMAC-SHA256 bytes against the base64-decoded
// digest. A suffix that is not valid base64 is ErrMalformedSignature (never a
// panic); the comparison is constant-time over equal-length values.
func verifyBase64HMAC(secret []byte, body []byte, encoded string) (bool, error) {
	got, err := base64.StdEncoding.DecodeString(strings.TrimSpace(encoded))
	if err != nil {
		return false, fmt.Errorf("%w: %v", ErrMalformedSignature, err)
	}
	mac := hmac.New(sha256.New, secret)
	mac.Write(body)
	want := mac.Sum(nil)
	if len(got) != len(want) {
		return false, nil
	}
	return subtle.ConstantTimeCompare(got, want) == 1, nil
}
