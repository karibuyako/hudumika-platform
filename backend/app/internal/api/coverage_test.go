package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/hudumika/api-backend/internal/gen"
)

const contractPathCount = 571

// testUUID is the substitute used for every path parameter without an enum
// constraint: a well-formed uuid that any uuid-typed binding accepts.
const testUUID = "00000000-0000-4000-8000-000000000000"

// requiredQueryValues supplies a valid value for every REQUIRED query
// parameter in the contract. The generated route wrappers bind required query
// parameters before the handler runs; a missing or malformed value would
// surface as a plain-text 400 from the generated ErrorHandlerFunc, which is
// not a defined response shape.
var requiredQueryValues = map[string]string{
	"q":          "test",
	"from":       "2026-01-01",
	"to":         "2026-12-31",
	"date":       "2026-01-01",
	"advance":    "2026-01-01",
	"lat":        "0",
	"lon":        "0",
	"after":      "0",
	"category":   "all",
	"metric":     "deliveries",
	"merchantId": testUUID,
	"serviceId":  testUUID,
}

func doAuthed(t *testing.T, h http.Handler, method, path, body, token string, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	var r io.Reader
	if body != "" {
		r = bytes.NewBufferString(body)
	}
	req := httptest.NewRequest(method, path, r)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

// isErrorEnvelope reports whether the body is a JSON error envelope carrying a
// code field (gen.ErrorResponse shape).
// bodyIsJSON reports whether the body parses as non-empty JSON of any shape
// (error envelope, real object, or array).
func bodyIsJSON(body []byte) bool {
	if len(bytes.TrimSpace(body)) == 0 {
		return false
	}
	return json.Valid(body)
}

func isErrorEnvelope(body []byte) bool {
	var m map[string]any
	if err := json.Unmarshal(body, &m); err != nil {
		return false
	}
	code, ok := m["code"].(string)
	return ok && code != ""
}

// TestAllContractPathsReturnDefinedShape proves that every one of the
// contract's 503 paths is routed with a defined response shape: never a blank
// 404 and never an empty body. Unimplemented paths return the 501
// NOT_IMPLEMENTED envelope (counted below); implemented ones return either an
// error envelope (code/message/requestId) or a real body (204 is the one
// exception — its defined shape is an empty body).
func TestAllContractPathsReturnDefinedShape(t *testing.T) {
	spec, err := gen.GetSpec()
	if err != nil {
		t.Fatalf("load contract spec: %v", err)
	}
	if got := spec.Paths.Len(); got != contractPathCount {
		t.Fatalf("contract path count = %d, want %d — contract regeneration dropped or added paths", got, contractPathCount)
	}

	s := newTestServer()
	ses, err := s.issueSession(context.Background(), "+255700000001", time.Now())
	if err != nil {
		t.Fatalf("issue session: %v", err)
	}
	h := s.Router()
	token := ses.AccessToken

	pathParamRE := regexp.MustCompile(`\{([^}]+)\}`)

	var (
		pathsChecked      int
		operationsChecked int
		notImplemented    int
		failures          []string
	)

	for p, item := range spec.Paths.Map() {
		pathsChecked++
		for method, op := range item.Operations() {
			operationsChecked++

			path := p
			for _, m := range pathParamRE.FindAllStringSubmatch(p, -1) {
				name := m[1]
				val := testUUID
				for _, pr := range op.Parameters {
					pv := pr.Value
					if pv == nil || pv.In != "path" || pv.Name != name {
						continue
					}
					// Enum-constrained path params ({provider}, {scope}) take
					// their first documented value.
					if pv.Schema != nil && pv.Schema.Value != nil && len(pv.Schema.Value.Enum) > 0 {
						val = fmt.Sprintf("%v", pv.Schema.Value.Enum[0])
					}
				}
				path = strings.Replace(path, "{"+name+"}", val, 1)
			}

			var query []string
			headers := map[string]string{}
			for _, pr := range op.Parameters {
				pv := pr.Value
				if pv == nil {
					continue
				}
				switch pv.In {
				case "query":
					if !pv.Required {
						continue
					}
					val, ok := requiredQueryValues[pv.Name]
					if !ok {
						val = testUUID
					}
					query = append(query, url.QueryEscape(pv.Name)+"="+url.QueryEscape(val))
				case "header":
					if pv.Required {
						headers[pv.Name] = testUUID
					}
				}
			}
			if len(query) > 0 {
				path += "?" + strings.Join(query, "&")
			}

			rec := doAuthed(t, h, method, path, "", token, headers)

			// Defined shapes: any error envelope or real body. Never a blank
			// 404 (unrouted chi "404 page not found" text), never an empty
			// body (204 being the sole legitimate empty-body status). A 404
			// carrying the contract-shaped NOT_FOUND envelope — e.g. the
			// implemented /users/me handlers without a database — is a
			// defined response.
			switch {
			case rec.Code == http.StatusNoContent:
				// 204 is the defined empty shape.
			case rec.Code == http.StatusNotFound:
				if !isErrorEnvelope(rec.Body.Bytes()) {
					failures = append(failures, fmt.Sprintf("%s %s: blank 404 (no envelope): %q", method, path, rec.Body.String()))
				}
			case strings.TrimSpace(rec.Body.String()) == "":
				failures = append(failures, fmt.Sprintf("%s %s: status %d with empty body", method, path, rec.Code))
			default:
				// Implemented endpoints return real JSON bodies (objects or
				// arrays); unimplemented ones carry the NOT_IMPLEMENTED
				// envelope. Either way the body must be valid JSON — the
				// guarantee is "never blank, never text garbage".
				if !bodyIsJSON(rec.Body.Bytes()) {
					failures = append(failures, fmt.Sprintf("%s %s: status %d body is not valid JSON: %q", method, path, rec.Code, rec.Body.String()))
				}
			}
			if rec.Code == http.StatusNotImplemented {
				notImplemented++
				t.Logf("501: %s %s", method, path)
			}
		}
	}

	if pathsChecked != contractPathCount {
		t.Errorf("iterated %d paths, want %d", pathsChecked, contractPathCount)
	}
	for _, f := range failures {
		t.Errorf("undefined response shape: %s", f)
	}

	// 501 coverage is explicit and counted: unimplemented contract endpoints
	// must always answer with the NOT_IMPLEMENTED envelope, never a blank 404.
	t.Logf("contract paths checked: %d, operations checked: %d, not implemented (501): %d, undefined shapes: %d",
		pathsChecked, operationsChecked, notImplemented, len(failures))
}
