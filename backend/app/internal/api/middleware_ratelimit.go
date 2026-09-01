package api

import (
	"net/http"
	"strings"
	"sync"
	"time"
)

type rateLimit struct {
	rate  int // requests per minute
	burst int
}

type bucket struct {
	tokens   float64
	lastTime time.Time
	mu       sync.Mutex
}

type RateLimiter struct {
	buckets      sync.Map // key -> *bucket
	defaultRate  int
	defaultBurst int
	routeLimits  map[string]rateLimit // path prefix -> limit
}

func NewRateLimiter(defaultRate, defaultBurst int, routeLimits map[string]rateLimit) *RateLimiter {
	if routeLimits == nil {
		routeLimits = make(map[string]rateLimit)
	}
	return &RateLimiter{
		defaultRate:  defaultRate,
		defaultBurst: defaultBurst,
		routeLimits:  routeLimits,
	}
}

func (rl *RateLimiter) getRouteLimit(path string) rateLimit {
	for prefix, limit := range rl.routeLimits {
		if strings.HasPrefix(path, prefix) {
			return limit
		}
	}
	return rateLimit{rate: rl.defaultRate, burst: rl.defaultBurst}
}

func (rl *RateLimiter) allow(key string, limit rateLimit) bool {
	now := time.Now()
	b, _ := rl.buckets.LoadOrStore(key, &bucket{
		tokens:   float64(limit.burst),
		lastTime: now,
	})

	bkt := b.(*bucket)
	bkt.mu.Lock()
	defer bkt.mu.Unlock()

	elapsed := now.Sub(bkt.lastTime).Seconds()
	refill := elapsed * float64(limit.rate) / 60.0
	bkt.tokens += refill
	if bkt.tokens > float64(limit.burst) {
		bkt.tokens = float64(limit.burst)
	}
	bkt.lastTime = now

	if bkt.tokens < 1 {
		return false
	}
	bkt.tokens--
	return true
}

func (rl *RateLimiter) retryAfter(key string, limit rateLimit) time.Duration {
	b, ok := rl.buckets.Load(key)
	if !ok {
		return time.Second
	}
	bkt := b.(*bucket)
	bkt.mu.Lock()
	defer bkt.mu.Unlock()

	tokensNeeded := 1 - bkt.tokens
	if tokensNeeded <= 0 {
		return 0
	}
	seconds := tokensNeeded * 60 / float64(limit.rate)
	return time.Duration(seconds * float64(time.Second))
}

func RateLimit(limiter *RateLimiter) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ip := clientIP(r)
			rl := limiter.getRouteLimit(r.URL.Path)
			key := ip + ":" + r.URL.Path

			if !limiter.allow(key, rl) {
				retry := limiter.retryAfter(key, rl)
				w.Header().Set("Retry-After", formatRetryAfter(retry))
				writeErrorWithRetry(w, http.StatusTooManyRequests, "RATE_LIMITED", "Too many requests", int(retry.Seconds()))
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

func formatRetryAfter(d time.Duration) string {
	seconds := int(d.Seconds())
	if seconds < 1 {
		seconds = 1
	}
	return (time.Duration(seconds) * time.Second).String()
}

func IPAllowlist(allowedIPs []string) func(http.Handler) http.Handler {
	if len(allowedIPs) == 0 {
		return func(next http.Handler) http.Handler {
			return next
		}
	}
	allowed := make(map[string]bool, len(allowedIPs))
	for _, ip := range allowedIPs {
		allowed[strings.TrimSpace(ip)] = true
	}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ip := clientIP(r)
			if !allowed[ip] {
				writeError(w, http.StatusForbidden, "IP_NOT_ALLOWED", "Your IP is not allowed to access this resource")
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

func SecurityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("X-XSS-Protection", "1; mode=block")
		w.Header().Set("Referrer-Policy", "strict-origin-when-cross-origin")
		settings := GetSettings()
		csp := "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; " + settings.CSPConnectSrc
		w.Header().Set("Content-Security-Policy", csp)
		w.Header().Set("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
		next.ServeHTTP(w, r)
	})
}
