package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	// Embed the IANA timezone database so zone lookups (e.g.
	// Africa/Dar_es_Salaam) resolve in slim containers without system tzdata.
	_ "time/tzdata"

	"github.com/hudumika/api-backend/internal/api"
	"github.com/hudumika/api-backend/internal/config"
	"github.com/hudumika/api-backend/internal/db"
	"github.com/hudumika/api-backend/internal/notifications"
	"github.com/hudumika/api-backend/internal/payments"
	"github.com/hudumika/api-backend/internal/store"
	"github.com/hudumika/api-backend/internal/sweeper"
	"github.com/hudumika/api-backend/internal/webhooks"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	slog.SetDefault(logger)

	cfg, err := config.Load()
	if err != nil {
		logger.Error("invalid configuration — refusing to boot", "error", err)
		os.Exit(1)
	}

	server, err := api.New(cfg, logger)
	if err != nil {
		logger.Error("failed to initialise server", "error", err)
		os.Exit(1)
	}

	var notifWorker *notifications.Worker
	var sweep *sweeper.Sweeper
	var webhookWorker *webhooks.Worker
	if cfg.DatabaseURL != "" {
		conn, err := db.New(context.Background(), cfg.DatabaseURL)
		if err != nil {
			logger.Error("database connection failed", "error", err)
			os.Exit(1)
		}
		server.SetDB(conn)
		defer conn.Close()

		outbox := notifications.NewPgOutbox(conn.Pool())
		enc, ok := loadOtpPayloadKey(cfg, logger)
		if !ok {
			os.Exit(1)
		}
		encryptor, err := notifications.NewEncryptor(enc)
		if err != nil {
			logger.Error("invalid OTP_PAYLOAD_KEY", "error", err)
			os.Exit(1)
		}
		server.SetOutbox(outbox)
		server.SetEncryptor(encryptor)

		url := os.Getenv("OTP_SMS_GATEWAY_URL")
		apiKey := os.Getenv("OTP_SMS_GATEWAY_API_KEY")
		sender := os.Getenv("OTP_SMS_GATEWAY_SENDER")
		var smsGateway notifications.Provider
		if strings.Contains(url, "textbee") {
			if gw, err := notifications.NewTextBeeGateway(url, apiKey); err == nil {
				smsGateway = gw
				logger.Info("notification gateway configured", "channel", "sms", "provider", "textbee")
			} else {
				logger.Warn("textbee gateway disabled", "error", err)
			}
		} else {
			smsGateway = gatewayFromEnv("sms", url, apiKey, sender, logger)
		}
		emailGateway := gatewayFromEnv("email", os.Getenv("EMAIL_GATEWAY_URL"), os.Getenv("EMAIL_GATEWAY_API_KEY"), os.Getenv("EMAIL_GATEWAY_SENDER"), logger)
		primary := notifications.Provider(&notifications.SMSProvider{})
		fallback := notifications.Provider(&notifications.EmailProvider{})
		primaryName, fallbackName := "sms stub", "email stub"
		if smsGateway != nil {
			primary, primaryName = smsGateway, "sms gateway"
			// Dual-provider failover: with a backup gateway configured the
			// primary SMS gateway is wrapped in a FailoverSMS whose
			// Redis-backed circuit opens after repeated primary failures and
			// routes SMS to the backup. Without Redis (dev) the breaker
			// degrades to allow-always.
			if os.Getenv("OTP_SMS_GATEWAY_BACKUP_URL") != "" {
				var breakerRedis *store.Redis
				if cfg.RedisURL != "" {
					if r, err := store.NewRedis(context.Background(), cfg.RedisURL); err != nil {
						logger.Warn("SMS failover circuit breaker runs allow-always: redis unavailable", "error", err)
					} else {
						breakerRedis = r
						defer r.Close()
					}
				}
				if failover := failoverSMSFromEnv(smsGateway, breakerRedis, logger); failover != nil {
					primary, primaryName = failover, "sms gateway (backup failover)"
				}
			}
		}
		if emailGateway != nil {
			fallback, fallbackName = emailGateway, "email gateway"
		}
		chain := notifications.NewChain(primary, fallback, logger)
		logger.Info("notification providers active", "primary", primaryName, "fallback", fallbackName)
		// The Expo push provider joins the chain as a third tier when
		// EXPO_PUSH_ACCESS_TOKEN is configured (dev/staging E2E, real pushes).
		if expo, err := notifications.ExpoProviderFromEnv(logger); err != nil {
			logger.Warn("expo push provider skipped", "error", err)
		} else if expo != nil {
			chain.Add(expo)
			logger.Info("notification provider added", "provider", "expo-push")
		}
		// The SMTP email provider joins the chain when EMAIL_SMTP_HOST is
		// configured: real transactional email via stdlib net/smtp, no HTTP
		// vendor. Configuration problems are warnings, never fatal — the
		// chain fails open in development.
		if smtpProvider, err := notifications.SMTPProviderFromEnv(logger); err != nil {
			logger.Warn("smtp email provider skipped", "error", err)
		} else if smtpProvider != nil {
			chain.Add(smtpProvider)
			logger.Info("notification provider added", "provider", "smtp-email")
		}
		// M-Pesa (Daraja) STK push: when MPESA_CONSUMER_KEY is configured the
		// delivery worker routes stk_push outbox messages to the real Daraja
		// client (OAuth token + STK invoke), recording the returned
		// CheckoutRequestID on the intent so the webhook can reconcile it.
		// Without credentials the explicit fallback is the generic HTTP
		// gateway chain (mock-gateway in dev/staging) — a logged decision so
		// staging keeps working with the simulator.
		provider := notifications.Provider(chain)
		if mpesaCfg, ok := payments.DarajaConfigFromEnv(); ok {
			darajaClient, err := payments.NewDarajaClient(mpesaCfg)
			if err != nil {
				logger.Warn("daraja mpesa client disabled — stk push falls back to the generic HTTP gateway (mock-gateway)", "error", err)
			} else {
				provider = notifications.NewSTKPushRouter(
					notifications.NewSTKPushProvider(darajaClient, payments.NewStore(conn.Pool()), logger),
					chain,
				)
				logger.Info("stk push provider active", "provider", "daraja-mpesa", "env", mpesaCfg.Env)
			}
		} else {
			logger.Warn("MPESA_CONSUMER_KEY unset — stk push falls back to the generic HTTP gateway (mock-gateway)")
		}
		notifWorker = notifications.NewWorker(outbox, provider, logger, 5*time.Second)
		sweep = sweeper.New(conn.Pool(), logger, 30*time.Second)
		webhookWorker = webhooks.New(conn.Pool(), logger, 5*time.Second)
	} else if cfg.IsProd() {
		logger.Error("DATABASE_URL is required in production")
		os.Exit(1)
	}

	srv := &http.Server{
		Addr:         ":" + cfg.Port,
		Handler:      server.RateLimitedRouter(),
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 30 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	workerCtx, stopWorker := context.WithCancel(context.Background())
	defer stopWorker()
	if notifWorker != nil {
		go notifWorker.Start(workerCtx)
	}
	// The sweeper shares workerCtx with the notifications worker: stopping
	// the workers (stopWorker) cancels both loops; no separate Stop is
	// needed.
	if sweep != nil {
		go sweep.Run(workerCtx)
	}
	if webhookWorker != nil {
		go webhookWorker.Run(workerCtx)
	}

	errCh := make(chan error, 1)
	go func() {
		logger.Info("api listening", "port", cfg.Port, "env", cfg.Env)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	select {
	case err := <-errCh:
		logger.Error("server failed", "error", err)
		os.Exit(1)
	case <-stop:
	}

	logger.Info("shutting down")
	stopWorker()
	if notifWorker != nil {
		notifWorker.Stop()
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := srv.Shutdown(ctx); err != nil {
		logger.Error("graceful shutdown failed", "error", err)
		os.Exit(1)
	}
	logger.Info("shutdown complete")
}

// loadOtpPayloadKey returns the hex AES-256 key for outbox payloads. In
// production a missing key refuses to boot; elsewhere a random per-boot key
// is generated (payloads become undecryptable after restart).
func loadOtpPayloadKey(cfg config.Config, logger *slog.Logger) (string, bool) {
	if key := os.Getenv("OTP_PAYLOAD_KEY"); key != "" {
		return key, true
	}
	if cfg.IsProd() {
		logger.Error("OTP_PAYLOAD_KEY is required in production (hex-encoded 32-byte key)")
		return "", false
	}
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		logger.Error("failed to generate ephemeral OTP_PAYLOAD_KEY", "error", err)
		return "", false
	}
	logger.Warn("OTP_PAYLOAD_KEY unset — generated a random per-boot key; enqueued payloads cannot be decrypted after restart")
	return hex.EncodeToString(b), true
}

// gatewayFromEnv builds an HTTP notification gateway for channel from its
// environment variables. An unset URL (the dev default) disables the gateway
// and keeps the provider stub active with a warning; configuration problems
// are logged, never fatal, so the chain fails open in development.
func gatewayFromEnv(channel, url, apiKey, sender string, logger *slog.Logger) notifications.Provider {
	if url == "" {
		logger.Warn("notification gateway URL unset — provider stub remains active", "channel", channel)
		return nil
	}
	gw, err := notifications.NewHTTPGateway(notifications.HTTPGatewayConfig{
		URL:    url,
		APIKey: apiKey,
		Sender: sender,
	}, channel)
	if err != nil {
		logger.Warn("notification gateway disabled", "channel", channel, "error", err)
		return nil
	}
	logger.Info("notification gateway configured", "channel", channel)
	return gw
}

// failoverSMSFromEnv wraps the primary SMS gateway in a FailoverSMS using the
// backup gateway from OTP_SMS_GATEWAY_BACKUP_URL. The backup's API key and
// sender default to the primary's when unset. breakerRedis backs the circuit
// (nil degrades to allow-always). Configuration problems are logged, never
// fatal: the plain primary gateway stays active.
func failoverSMSFromEnv(primary notifications.Provider, breakerRedis *store.Redis, logger *slog.Logger) *notifications.FailoverSMS {
	primaryGw, ok := primary.(*notifications.HTTPGateway)
	if !ok {
		logger.Warn("SMS failover disabled: primary gateway is not an HTTP gateway")
		return nil
	}
	backupAPIKey := os.Getenv("OTP_SMS_GATEWAY_BACKUP_API_KEY")
	if backupAPIKey == "" {
		backupAPIKey = os.Getenv("OTP_SMS_GATEWAY_API_KEY")
	}
	backupSender := os.Getenv("OTP_SMS_GATEWAY_BACKUP_SENDER")
	if backupSender == "" {
		backupSender = os.Getenv("OTP_SMS_GATEWAY_SENDER")
	}
	backup, err := notifications.NewHTTPGateway(notifications.HTTPGatewayConfig{
		URL:    os.Getenv("OTP_SMS_GATEWAY_BACKUP_URL"),
		APIKey: backupAPIKey,
		Sender: backupSender,
	}, "sms")
	if err != nil {
		logger.Warn("SMS failover disabled: backup gateway misconfigured", "error", err)
		return nil
	}
	logger.Info("SMS failover configured", "backupURL", os.Getenv("OTP_SMS_GATEWAY_BACKUP_URL"))
	return notifications.NewFailoverSMS(primaryGw, backup, notifications.NewCircuitBreaker(breakerRedis, "sms"), logger)
}
