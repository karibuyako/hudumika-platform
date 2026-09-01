package config

import (
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

const (
	EnvDevelopment = "development"
	EnvStaging     = "staging"
	EnvProduction  = "production"
)

var validEnvs = map[string]bool{
	EnvDevelopment: true,
	EnvStaging:     true,
	EnvProduction:  true,
}

// Default JWT secrets that must never be used outside development. The list is
// kept short and explicit; anything not matching the production strength rules
// below is also rejected.
var devJWTSecrets = []string{
	"dev-secret-change-me",
	"change-me-in-production",
	"compose-dev-secret",
	"secret",
	"password",
}

type Config struct {
	Env         string
	Port        string
	DatabaseURL string
	RedisURL    string
	JWTSecret   []byte
	OTPDevCode  string
	AccessTTL   time.Duration
	RefreshTTL  time.Duration
	CORSOrigins []string
	// RateLimitPerMin is the fixed-window per-user request budget (JWT
	// subject) applied to the authenticated tree; <= 0 disables the limiter.
	RateLimitPerMin int
	// MPESA_* configure the real Daraja (M-Pesa) STK push client. Without
	// MPESA_CONSUMER_KEY the outbox worker falls back to the generic HTTP
	// gateway (mock-gateway) — the explicit dev/staging path.
	MPESAEnv            string
	MPESAConsumerKey    string
	MPESAConsumerSecret string
	MPESAShortcode      string
	MPESAPasskey        string
	MPESAStkCallbackURL string
	AdminAllowedIPs     string
}

// Load reads the environment and validates it. Any invalid value is a hard
// boot failure: the caller must not start the process with a bad config.
func Load() (Config, error) {
	cfg := Config{
		Env:         getEnv("ENV", ""),
		Port:        getEnv("PORT", "8080"),
		DatabaseURL: os.Getenv("DATABASE_URL"),
		RedisURL:    os.Getenv("REDIS_URL"),
		JWTSecret:   []byte(getEnv("JWT_SECRET", getEnv("JWT_SIGNING_KEY", ""))),
		OTPDevCode:  getEnv("OTP_DEV_CODE", "123456"),
		AccessTTL:   durationEnv("ACCESS_TOKEN_TTL", 15*time.Minute),
		RefreshTTL:  durationEnv("REFRESH_TOKEN_TTL", 30*24*time.Hour),
		CORSOrigins: splitEnv("CORS_ORIGINS", ""),
		// The per-user rate limit defaults to 300 requests per minute and is
		// deliberately lenient: it bounds runaway clients, never legitimate
		// platform traffic.
		RateLimitPerMin:     intEnv("RATE_LIMIT_PER_MIN", 300),
		MPESAEnv:            getEnv("MPESA_ENV", "sandbox"),
		MPESAConsumerKey:    os.Getenv("MPESA_CONSUMER_KEY"),
		MPESAConsumerSecret: os.Getenv("MPESA_CONSUMER_SECRET"),
		MPESAShortcode:      os.Getenv("MPESA_SHORTCODE"),
		MPESAPasskey:        os.Getenv("MPESA_PASSKEY"),
		MPESAStkCallbackURL: os.Getenv("MPESA_STK_CALLBACK_URL"),
		AdminAllowedIPs:     os.Getenv("ADMIN_ALLOWED_IPS"),
	}
	if err := cfg.Validate(); err != nil {
		return Config{}, err
	}
	return cfg, nil
}

// Validate enforces the platform environment rules. It returns a single error
// listing every problem so operators see all violations at once.
func (c Config) Validate() error {
	var problems []string

	if !validEnvs[c.Env] {
		problems = append(problems,
			fmt.Sprintf("ENV must be one of %q, %q, %q — got %q", EnvDevelopment, EnvStaging, EnvProduction, c.Env))
	}

	if len(c.JWTSecret) == 0 {
		problems = append(problems, "JWT_SECRET (or its alias JWT_SIGNING_KEY) is required")
	} else if c.Env == EnvProduction {
		if len(c.JWTSecret) < 32 {
			problems = append(problems,
				fmt.Sprintf("production JWT_SECRET must be at least 32 bytes, got %d", len(c.JWTSecret)))
		}
		s := string(c.JWTSecret)
		for _, weak := range devJWTSecrets {
			if s == weak {
				problems = append(problems, "refusing to boot in production with a known weak JWT_SECRET")
				break
			}
		}
	}

	if c.Env == EnvProduction {
		if c.DatabaseURL == "" {
			problems = append(problems, "DATABASE_URL is required in production")
		}
		if c.RedisURL == "" {
			problems = append(problems, "REDIS_URL is required in production")
		}
		for _, o := range c.CORSOrigins {
			if o == "*" {
				problems = append(problems, "CORS_ORIGINS must not be '*' in production")
			}
		}
		if c.OTPDevCode != "" && c.OTPDevCode == "123456" {
			problems = append(problems, "OTP_DEV_CODE must not be the default dev code in production")
		}
		if c.MPESAEnv == "production" && c.MPESAConsumerKey == "" {
			problems = append(problems, "MPESA_CONSUMER_KEY is required when MPESA_ENV=production")
		}
		if strings.TrimSpace(c.AdminAllowedIPs) == "" {
			problems = append(problems, "ADMIN_ALLOWED_IPS is required in production (comma-separated IPs/CIDRs for /admin/*)")
		}
	}

	switch c.MPESAEnv {
	case "sandbox", "production":
	default:
		problems = append(problems, fmt.Sprintf("MPESA_ENV must be sandbox or production — got %q", c.MPESAEnv))
	}

	if len(problems) > 0 {
		return errors.New(strings.Join(problems, "; "))
	}
	return nil
}

func (c Config) IsProd() bool { return c.Env == EnvProduction }

// DevOTPEnabled reports whether the fixed development OTP code is usable in
// the current environment. It is never usable in production.
func (c Config) DevOTPEnabled() bool { return !c.IsProd() && c.OTPDevCode != "" }

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func durationEnv(key string, fallback time.Duration) time.Duration {
	if v := os.Getenv(key); v != "" {
		if d, err := time.ParseDuration(v); err == nil {
			return d
		}
	}
	return fallback
}

// intEnv parses a positive integer env var, falling back on unset or invalid
// values so a typo can never silently zero out a limit.
func intEnv(key string, fallback int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return n
		}
	}
	return fallback
}

func splitEnv(key, fallback string) []string {
	if v := os.Getenv(key); v != "" {
		parts := strings.Split(v, ",")
		out := make([]string, 0, len(parts))
		for _, p := range parts {
			if p = strings.TrimSpace(p); p != "" {
				out = append(out, p)
			}
		}
		return out
	}
	if fallback == "" {
		return nil
	}
	return []string{fallback}
}
