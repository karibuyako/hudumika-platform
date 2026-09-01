package config

import (
	"strings"
	"testing"
)

func setEnv(t *testing.T, vars map[string]string) {
	t.Helper()
	cleanup := make([]string, 0, len(vars))
	for k, v := range vars {
		cleanup = append(cleanup, k)
		t.Setenv(k, v)
	}
	for _, k := range []string{"ENV", "PORT", "DATABASE_URL", "REDIS_URL", "JWT_SECRET", "JWT_SIGNING_KEY", "OTP_DEV_CODE", "ACCESS_TOKEN_TTL", "REFRESH_TOKEN_TTL", "CORS_ORIGINS", "ADMIN_ALLOWED_IPS"} {
		found := false
		for k2 := range vars {
			if k2 == k {
				found = true
			}
		}
		if !found {
			t.Setenv(k, "")
		}
	}
}

func TestValidateUnknownEnvFails(t *testing.T) {
	setEnv(t, map[string]string{"ENV": "dev", "JWT_SECRET": strings.Repeat("x", 48)})
	_, err := Load()
	if err == nil {
		t.Fatal("expected boot failure for invalid ENV")
	}
	if !strings.Contains(err.Error(), "ENV") {
		t.Fatalf("error should mention ENV: %v", err)
	}
}

func TestValidateEmptyEnvFails(t *testing.T) {
	setEnv(t, map[string]string{"ENV": "", "JWT_SECRET": strings.Repeat("x", 48)})
	if _, err := Load(); err == nil {
		t.Fatal("expected boot failure for empty ENV")
	}
}

func TestValidateProductionWeakSecretFails(t *testing.T) {
	setEnv(t, map[string]string{
		"ENV":               "production",
		"JWT_SECRET":        "dev-secret-change-me",
		"DATABASE_URL":      "postgres://u:p@h:5432/db",
		"REDIS_URL":         "redis://h:6379/0",
		"CORS_ORIGINS":      "https://app.hudumika.co.tz",
		"ADMIN_ALLOWED_IPS": "10.0.0.1/32",
	})
	_, err := Load()
	if err == nil || !strings.Contains(err.Error(), "JWT_SECRET") {
		t.Fatalf("expected weak-secret failure, got %v", err)
	}
}

func TestValidateProductionShortSecretFails(t *testing.T) {
	setEnv(t, map[string]string{
		"ENV":               "production",
		"JWT_SECRET":        "short",
		"DATABASE_URL":      "postgres://u:p@h:5432/db",
		"REDIS_URL":         "redis://h:6379/0",
		"CORS_ORIGINS":      "https://app.hudumika.co.tz",
		"ADMIN_ALLOWED_IPS": "10.0.0.1/32",
	})
	if _, err := Load(); err == nil {
		t.Fatal("expected failure for short production secret")
	}
}

func TestValidateProductionRequiresDependencies(t *testing.T) {
	setEnv(t, map[string]string{"ENV": "production", "JWT_SECRET": strings.Repeat("x", 48)})
	_, err := Load()
	if err == nil {
		t.Fatal("expected failure when DATABASE_URL/REDIS_URL missing in production")
	}
	if !strings.Contains(err.Error(), "DATABASE_URL") || !strings.Contains(err.Error(), "REDIS_URL") {
		t.Fatalf("error should list missing dependencies: %v", err)
	}
}

func TestValidateProductionCorsWildcardFails(t *testing.T) {
	setEnv(t, map[string]string{
		"ENV":               "production",
		"JWT_SECRET":        strings.Repeat("x", 48),
		"DATABASE_URL":      "postgres://u:p@h:5432/db",
		"REDIS_URL":         "redis://h:6379/0",
		"CORS_ORIGINS":      "*",
		"ADMIN_ALLOWED_IPS": "10.0.0.1/32",
	})
	_, err := Load()
	if err == nil || !strings.Contains(err.Error(), "CORS_ORIGINS") {
		t.Fatalf("expected CORS wildcard failure, got %v", err)
	}
}

func TestValidateProductionDevOtpCodeFails(t *testing.T) {
	setEnv(t, map[string]string{
		"ENV":               "production",
		"JWT_SECRET":        strings.Repeat("x", 48),
		"DATABASE_URL":      "postgres://u:p@h:5432/db",
		"REDIS_URL":         "redis://h:6379/0",
		"CORS_ORIGINS":      "https://app.hudumika.co.tz",
		"OTP_DEV_CODE":      "123456",
		"ADMIN_ALLOWED_IPS": "10.0.0.1/32",
	})
	_, err := Load()
	if err == nil || !strings.Contains(err.Error(), "OTP_DEV_CODE") {
		t.Fatalf("expected OTP_DEV_CODE failure, got %v", err)
	}
}

func TestValidateProductionAdminAllowedIPsRequired(t *testing.T) {
	setEnv(t, map[string]string{
		"ENV":          "production",
		"JWT_SECRET":   strings.Repeat("x", 48),
		"DATABASE_URL": "postgres://u:p@h:5432/db",
		"REDIS_URL":    "redis://h:6379/0",
		"CORS_ORIGINS": "https://app.hudumika.co.tz",
	})
	_, err := Load()
	if err == nil || !strings.Contains(err.Error(), "ADMIN_ALLOWED_IPS") {
		t.Fatalf("expected ADMIN_ALLOWED_IPS failure in production, got %v", err)
	}
}

func TestValidateProductionAdminAllowedIPsPresent(t *testing.T) {
	setEnv(t, map[string]string{
		"ENV":               "production",
		"JWT_SECRET":        strings.Repeat("x", 48),
		"DATABASE_URL":      "postgres://u:p@h:5432/db",
		"REDIS_URL":         "redis://h:6379/0",
		"CORS_ORIGINS":      "https://app.hudumika.co.tz",
		"ADMIN_ALLOWED_IPS": "10.0.0.1/32, 10.0.0.2/32",
		"OTP_DEV_CODE":      "999999",
	})
	if _, err := Load(); err != nil {
		t.Fatalf("production config with ADMIN_ALLOWED_IPS should load: %v", err)
	}
}

func TestValidateDevelopmentDefaults(t *testing.T) {
	setEnv(t, map[string]string{"ENV": "development", "JWT_SECRET": "compose-dev-secret"})
	cfg, err := Load()
	if err != nil {
		t.Fatalf("development config should load: %v", err)
	}
	if !cfg.DevOTPEnabled() {
		t.Fatal("dev OTP should be enabled in development")
	}
	if cfg.IsProd() {
		t.Fatal("development is not production")
	}
}

func TestValidateJwtSigningKeyAlias(t *testing.T) {
	setEnv(t, map[string]string{"ENV": "development", "JWT_SIGNING_KEY": "alias-secret"})
	cfg, err := Load()
	if err != nil {
		t.Fatalf("config should load: %v", err)
	}
	if string(cfg.JWTSecret) != "alias-secret" {
		t.Fatalf("JWT_SIGNING_KEY alias not honored: %q", cfg.JWTSecret)
	}
}

func TestDevOTPDisabledInProduction(t *testing.T) {
	setEnv(t, map[string]string{
		"ENV":               "production",
		"JWT_SECRET":        strings.Repeat("x", 48),
		"DATABASE_URL":      "postgres://u:p@h:5432/db",
		"REDIS_URL":         "redis://h:6379/0",
		"CORS_ORIGINS":      "https://app.hudumika.co.tz",
		"OTP_DEV_CODE":      "111111",
		"ADMIN_ALLOWED_IPS": "10.0.0.1/32",
	})
	cfg, err := Load()
	if err != nil {
		t.Fatalf("config should load: %v", err)
	}
	if cfg.DevOTPEnabled() {
		t.Fatal("dev OTP must never be enabled in production")
	}
}
