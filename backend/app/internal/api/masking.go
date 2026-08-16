package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"strings"
)

// maskedValue replaces sensitive field values in API responses.
const maskedValue = "••••••••"

// sensitiveFieldSuffixes lists PII field names whose values are masked in
// every successful authenticated response. Matching is case-insensitive and
// suffix-based (snake_case and camelCase both included). Money fields are
// never in this list, and phone numbers are the user's identity in this
// product — never masked.
var sensitiveFieldSuffixes = []string{
	"account_number", "accountnumber",
	"id_number", "idnumber",
	"pan",
	"card_number", "cardnumber",
	"cvv",
	"document_url", "documenturl",
	"dob",
	"passport",
	"national_id", "nationalid",
}

// MaskPII masks sensitive JSON fields in successful (status < 400) responses.
// Error envelopes pass through untouched. The response body is buffered so it
// can be rewritten before anything reaches the wire.
func (s *Server) MaskPII(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rec := &maskRecorder{header: w.Header().Clone()}
		next.ServeHTTP(rec, r)

		status := rec.Status()
		body := rec.buf.Bytes()
		if status < http.StatusBadRequest && len(body) > 0 && isJSONBody(rec.header) {
			if masked, err := maskJSON(body); err == nil {
				body = masked
			}
		}

		for k := range w.Header() {
			w.Header().Del(k)
		}
		for k, vs := range rec.header {
			for _, v := range vs {
				w.Header().Add(k, v)
			}
		}
		w.WriteHeader(status)
		if len(body) > 0 {
			_, _ = w.Write(body)
		}
	})
}

func isJSONBody(h http.Header) bool {
	return strings.Contains(strings.ToLower(h.Get("Content-Type")), "json")
}

// maskJSON replaces the values of sensitive fields anywhere in the document.
// Non-JSON bodies are returned untouched by the caller on error.
func maskJSON(data []byte) ([]byte, error) {
	var v any
	if err := json.Unmarshal(data, &v); err != nil {
		return nil, err
	}
	maskValue(v)
	return json.Marshal(v)
}

func maskValue(v any) {
	switch t := v.(type) {
	case map[string]any:
		for k, val := range t {
			if isSensitiveKey(k) {
				t[k] = maskedValue
			} else {
				maskValue(val)
			}
		}
	case []any:
		for _, e := range t {
			maskValue(e)
		}
	}
}

func isSensitiveKey(key string) bool {
	lk := strings.ToLower(key)
	for _, suffix := range sensitiveFieldSuffixes {
		if strings.HasSuffix(lk, suffix) {
			return true
		}
	}
	return false
}

// maskRecorder buffers the handler's response so MaskPII can rewrite the body
// before the status line is sent. It mirrors the recorder pattern in
// idempotency.go, but unlike idemRecorder it does not pass writes through:
// the masked body must replace the original bytes.
type maskRecorder struct {
	header http.Header
	status int
	buf    bytes.Buffer
}

func (r *maskRecorder) Header() http.Header { return r.header }

func (r *maskRecorder) WriteHeader(code int) {
	if r.status == 0 {
		r.status = code
	}
}

func (r *maskRecorder) Write(b []byte) (int, error) { return r.buf.Write(b) }

// Status returns the recorded status, defaulting to 200 when the handler
// never wrote one.
func (r *maskRecorder) Status() int {
	if r.status == 0 {
		return http.StatusOK
	}
	return r.status
}
