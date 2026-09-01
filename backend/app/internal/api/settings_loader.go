package api

import (
	"context"
	"log/slog"
	"sync"
	"time"
)

type PlatformSettings struct {
	// Financial
	TwoPersonThresholdTZS     int64
	WithdrawalMinimumTZS      int64
	WithdrawalDailyLimit      int
	WithdrawalRateWindowHours int
	WalletTopupMinimumTZS     int64

	// Operational
	AdminRestEnforceHours int
	DefaultCountry        string
	ExportBaseURL         string
	StoreQrPrefix         string
	CSPConnectSrc         string

	// Timeouts
	IdempotencyTTLHours      int
	ExportTTLHours           int
	PairCodeTTLMinutes       int
	AccountDeletionGraceDays int

	// Limits
	MaxImportRows        int
	MaxBodyBytes         int64
	ChatMaxMessageLength int
	DefaultChatListLimit int
	MaxChatListLimit     int
	DefaultHomeFeedLimit int
	MaxReceiptTemplates  int
	MaxPaymentAccounts   int

	// Rate limits
	ChatMessageRateLimit  int
	RiderLocationRateLimit int
	AuthRateLimit          int
	GlobalRateLimit        int
	VerificationRateLimit  int
	ExportRateLimit        int

	// Health/monitoring
	HealthCheckTimeoutSeconds    int
	HealthMonitorIntervalSeconds int
	EventPollIntervalMs          int
	TraceSampleRatio             float64

	// Degradation
	DegradationThresholdSlowMs     int
	DegradationThresholdDegradedMs int
	DegradationThresholdCriticalMs int

	// Estimates
	DefaultEstimateDurationMinutes int
	ComplianceEstimatedMinutes     int

	// Shares
	TrackingShareExpiryHours int
	RiderShareExpiryHours    int

	// Self-pickup
	MinSelfPickupMinutes int
	MaxSelfPickupMinutes int

	LoadedAt time.Time
}

var (
	globalSettings     *PlatformSettings
	globalSettingsMu   sync.RWMutex
)

// LoadSettings reads all platform_settings from the database.
func (s *Server) LoadSettings(ctx context.Context) (*PlatformSettings, error) {
	if s.db == nil {
		return defaultSettings(), nil
	}

	settings := defaultSettings()
	row := s.db.Pool().QueryRow(ctx, `SELECT
		two_person_threshold_tzs, withdrawal_minimum_tzs, withdrawal_daily_limit,
		withdrawal_rate_window_hours, wallet_topup_minimum_tzs, admin_rest_enforce_hours,
		default_country, export_base_url, store_qr_prefix, csp_connect_src,
		idempotency_ttl_hours, export_ttl_hours, max_import_rows, max_body_bytes,
		trace_sample_ratio, health_check_timeout_seconds, health_monitor_interval_seconds,
		event_poll_interval_ms, chat_message_rate_limit, rider_location_rate_limit,
		auth_rate_limit, global_rate_limit, verification_rate_limit, pair_code_ttl_minutes,
		account_deletion_grace_days, default_estimate_duration_minutes, compliance_estimated_minutes,
		max_receipt_templates, max_payment_accounts, min_self_pickup_minutes, max_self_pickup_minutes,
		chat_max_message_length, default_chat_list_limit, max_chat_list_limit, default_home_feed_limit,
		tracking_share_expiry_hours, rider_share_expiry_hours, export_rate_limit,
		degradation_threshold_slow_ms, degradation_threshold_degraded_ms, degradation_threshold_critical_ms
	FROM platform_settings LIMIT 1`)

	err := row.Scan(
		&settings.TwoPersonThresholdTZS, &settings.WithdrawalMinimumTZS, &settings.WithdrawalDailyLimit,
		&settings.WithdrawalRateWindowHours, &settings.WalletTopupMinimumTZS, &settings.AdminRestEnforceHours,
		&settings.DefaultCountry, &settings.ExportBaseURL, &settings.StoreQrPrefix, &settings.CSPConnectSrc,
		&settings.IdempotencyTTLHours, &settings.ExportTTLHours, &settings.MaxImportRows, &settings.MaxBodyBytes,
		&settings.TraceSampleRatio, &settings.HealthCheckTimeoutSeconds, &settings.HealthMonitorIntervalSeconds,
		&settings.EventPollIntervalMs, &settings.ChatMessageRateLimit, &settings.RiderLocationRateLimit,
		&settings.AuthRateLimit, &settings.GlobalRateLimit, &settings.VerificationRateLimit, &settings.PairCodeTTLMinutes,
		&settings.AccountDeletionGraceDays, &settings.DefaultEstimateDurationMinutes, &settings.ComplianceEstimatedMinutes,
		&settings.MaxReceiptTemplates, &settings.MaxPaymentAccounts, &settings.MinSelfPickupMinutes, &settings.MaxSelfPickupMinutes,
		&settings.ChatMaxMessageLength, &settings.DefaultChatListLimit, &settings.MaxChatListLimit, &settings.DefaultHomeFeedLimit,
		&settings.TrackingShareExpiryHours, &settings.RiderShareExpiryHours, &settings.ExportRateLimit,
		&settings.DegradationThresholdSlowMs, &settings.DegradationThresholdDegradedMs, &settings.DegradationThresholdCriticalMs,
	)
	if err != nil {
		slog.Warn("failed to load platform settings, using defaults", "error", err)
		return settings, nil
	}

	settings.LoadedAt = time.Now()

	globalSettingsMu.Lock()
	globalSettings = settings
	globalSettingsMu.Unlock()

	return settings, nil
}

// GetSettings returns the cached platform settings, loading them if needed.
func GetSettings() *PlatformSettings {
	globalSettingsMu.RLock()
	s := globalSettings
	globalSettingsMu.RUnlock()
	if s != nil {
		return s
	}
	return defaultSettings()
}

func defaultSettings() *PlatformSettings {
	return &PlatformSettings{
		TwoPersonThresholdTZS:        5_000_000,
		WithdrawalMinimumTZS:         5000,
		WithdrawalDailyLimit:         3,
		WithdrawalRateWindowHours:    24,
		WalletTopupMinimumTZS:        1000,
		AdminRestEnforceHours:        8,
		DefaultCountry:               "TZ",
		ExportBaseURL:                "https://api.hudumika.app",
		StoreQrPrefix:                "https://hudumika.app/qr/",
		CSPConnectSrc:                "connect-src 'self' ws: wss:",
		IdempotencyTTLHours:          24,
		ExportTTLHours:               24,
		MaxImportRows:                500,
		MaxBodyBytes:                 1 << 20,
		PairCodeTTLMinutes:           10,
		AccountDeletionGraceDays:     30,
		DefaultEstimateDurationMinutes: 60,
		ComplianceEstimatedMinutes:     30,
		MaxReceiptTemplates:          10,
		MaxPaymentAccounts:           5,
		MinSelfPickupMinutes:         5,
		MaxSelfPickupMinutes:         120,
		ChatMaxMessageLength:         2000,
		DefaultChatListLimit:         20,
		MaxChatListLimit:             50,
		DefaultHomeFeedLimit:         100,
		TrackingShareExpiryHours:     2,
		RiderShareExpiryHours:        24,
		ChatMessageRateLimit:         20,
		RiderLocationRateLimit:       12,
		AuthRateLimit:                10,
		GlobalRateLimit:              100,
		VerificationRateLimit:        20,
		ExportRateLimit:              3,
		HealthCheckTimeoutSeconds:    5,
		HealthMonitorIntervalSeconds: 30,
		EventPollIntervalMs:          2000,
		TraceSampleRatio:             0.1,
		DegradationThresholdSlowMs:     100,
		DegradationThresholdDegradedMs: 500,
		DegradationThresholdCriticalMs: 2000,
	}
}

// StartSettingsRefresher reloads settings every 5 minutes.
func (s *Server) StartSettingsRefresher(ctx context.Context) {
	ticker := time.NewTicker(5 * time.Minute)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if _, err := s.LoadSettings(ctx); err != nil {
				slog.Warn("settings refresh failed", "error", err)
			}
		}
	}
}
