package api

import (
	"encoding/json"
	"net/http"
	"strconv"
	"time"

	"github.com/hudumika/api-backend/internal/gen"
	"github.com/hudumika/api-backend/internal/store"
)

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	if v != nil {
		_ = json.NewEncoder(w).Encode(v)
	}
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, gen.ErrorResponse{
		Code:      code,
		Message:   message,
		RequestId: newUUID(newRequestID()),
	})
}

func writeErrorWithRetry(w http.ResponseWriter, status int, code, message string, retryAfterSeconds int) {
	w.Header().Set("Retry-After", strconv.Itoa(retryAfterSeconds))
	writeJSON(w, status, gen.ErrorResponse{
		Code:              code,
		Message:           message,
		RequestId:         newUUID(newRequestID()),
		RetryAfterSeconds: &retryAfterSeconds,
	})
}

// writeRateLimitHeaders stamps the standard X-RateLimit-* trio on the
// response: the window budget, the budget remaining after this request, and
// the unix second at which the budget resets (now + resetAfter). It must be
// called before the response is written so the headers ride both the 429
// and the success response.
func writeRateLimitHeaders(w http.ResponseWriter, limit int64, remaining int64, resetAfter time.Duration) {
	w.Header().Set("X-RateLimit-Limit", strconv.FormatInt(limit, 10))
	w.Header().Set("X-RateLimit-Remaining", strconv.FormatInt(remaining, 10))
	w.Header().Set("X-RateLimit-Reset", strconv.FormatInt(time.Now().Add(resetAfter).Unix(), 10))
}

// rateLimitRemaining derives the budget left after the decision's
// consumption: max(0, limit-Consumed). A backend that does not report
// consumption (Consumed == 0) is treated as fully consumed, never
// over-advertising capacity.
func rateLimitRemaining(decision store.RateLimitDecision, limit int64) int64 {
	consumed := decision.Consumed
	if consumed <= 0 {
		consumed = limit
	}
	remaining := limit - consumed
	if remaining < 0 {
		return 0
	}
	return remaining
}

// rateLimitReset renders the X-RateLimit-* trio for a limiter decision: the
// budget, the budget left (see rateLimitRemaining), and the unix second the
// budget resets (now + RetryAfter). For allowed decisions RetryAfter is
// unset; callers carry the window in its place so the header reports the
// end of the fixed window.
func rateLimitReset(decision store.RateLimitDecision, limit int64, now time.Time) (limitHdr string, remainingHdr string, resetHdr string) {
	return strconv.FormatInt(limit, 10),
		strconv.FormatInt(rateLimitRemaining(decision, limit), 10),
		strconv.FormatInt(now.Add(decision.RetryAfter).Unix(), 10)
}
