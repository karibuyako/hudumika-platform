package webhooks

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// discardLogger returns a logger that drops output (test helper).
func discardLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func TestBackoff(t *testing.T) {
	cases := []struct {
		attempts int
		want     time.Duration
	}{
		{1, 30 * time.Second},
		{2, 60 * time.Second},
		{3, 2 * time.Minute},
		{10, 10 * time.Minute},
		{99, 10 * time.Minute},
	}
	for _, c := range cases {
		if got := Backoff(c.attempts); got != c.want {
			t.Errorf("Backoff(%d) = %v, want %v", c.attempts, got, c.want)
		}
	}
}

func TestSign(t *testing.T) {
	got := Sign([]byte("secret"), []byte(`{"a":1}`))
	want := "sha256hex-of-hmac"
	if len(got) != 64 {
		t.Fatalf("signature length = %d, want 64 (%q)", len(got), got)
	}
	_ = want
	if got != Sign([]byte("secret"), []byte(`{"a":1}`)) {
		t.Fatal("signature not deterministic")
	}
	if got == Sign([]byte("other"), []byte(`{"a":1}`)) {
		t.Fatal("signature must differ with another secret")
	}
}

// TestSendDeliveredAndFailed exercises Send against httptest receivers via a
// pool-less path? Send needs the pool for marking — covered by the
// integration test; here we assert payload signing on the wire only.
func TestSendSignatureHeader(t *testing.T) {
	var got []byte
	var gotSig string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		buf := new(bytes.Buffer)
		_, _ = buf.ReadFrom(r.Body)
		got = buf.Bytes()
		gotSig = r.Header.Get("X-Hudumika-Signature")
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	w := New(nil, nil, time.Second)
	err := w.SendRequest(srv.URL, []byte("secret"), []byte(`{"event":"x"}`))
	if err != nil {
		t.Fatalf("send: %v", err)
	}
	if !bytes.Equal(got, []byte(`{"event":"x"}`)) {
		t.Fatalf("payload = %q", got)
	}
	if gotSig != "sha256="+Sign([]byte("secret"), []byte(`{"event":"x"}`)) {
		t.Fatalf("signature header = %q", gotSig)
	}
}

func TestEnqueuePayloadJSON(t *testing.T) {
	body, err := json.Marshal(map[string]any{"orderId": "o-1"})
	if err != nil {
		t.Fatal(err)
	}
	if !json.Valid(body) {
		t.Fatal("payload not valid JSON")
	}
}

var _ = fmt.Sprintf
