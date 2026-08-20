package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/hudumika/api-backend/internal/auth"
	"github.com/hudumika/api-backend/internal/config"
	"github.com/hudumika/api-backend/internal/db"
	"github.com/hudumika/api-backend/internal/gen"
	"github.com/hudumika/api-backend/internal/notifications"
	"github.com/hudumika/api-backend/internal/store"
)

const maxBodyBytes = 1 << 20

type Server struct {
	gen.Unimplemented
	cfg       config.Config
	db        *db.DB
	stores    *store.Set
	auth      *auth.Service
	outbox    notifications.Outbox
	enc       *notifications.Encryptor
	logger    *slog.Logger
	devOtp    bool
	startedAt time.Time
}

func New(cfg config.Config, logger *slog.Logger) (*Server, error) {
	stores, err := store.NewSet(context.Background(), cfg.RedisURL, cfg.Env)
	if err != nil {
		return nil, err
	}
	return &Server{
		cfg:       cfg,
		stores:    stores,
		logger:    logger,
		devOtp:    cfg.DevOTPEnabled(),
		startedAt: time.Now(),
	}, nil
}

// SetDB wires the PostgreSQL pool (used by /readyz and the auth service).
func (s *Server) SetDB(d *db.DB) {
	s.db = d
	if d != nil {
		s.auth = auth.NewService(s.stores.Otp, s.stores.Sessions, auth.NewRepo(d.Pool()), s.logger)
	}
}

// SetOutbox wires the notification outbox used for best-effort OTP delivery.
func (s *Server) SetOutbox(o notifications.Outbox) {
	s.outbox = o
}

// SetEncryptor wires the payload encryptor that protects OTP codes before
// they are enqueued. A nil encryptor disables enqueueing (best-effort).
func (s *Server) SetEncryptor(e *notifications.Encryptor) {
	s.enc = e
}

func (s *Server) RequestOtp(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Channel     string `json:"channel"`
		Destination string `json:"destination"`
		Purpose     string `json:"purpose"`
	}
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if strings.TrimSpace(body.Destination) == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "destination is required")
		return
	}
	switch body.Channel {
	case "phone", "email":
	default:
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "channel must be phone or email")
		return
	}
	if body.Purpose == "" {
		body.Purpose = "login"
	}
	switch body.Purpose {
	case "login", "signup", "password_reset", "verify_role":
	default:
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "purpose is invalid")
		return
	}

	now := time.Now()
	decision, err := s.stores.Otp.RateLimit(r.Context(), body.Destination, now)
	if err != nil {
		s.logger.Error("otp rate limit check failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	// The X-RateLimit-* trio rides both the 429 and the success response:
	// the per-destination window budget, what this window has left, and the
	// unix second the window resets (RetryAfter on denial, its end on
	// success).
	if !decision.Allowed {
		s.logger.Warn("otp rate limited", "destination", body.Destination)
		s.RecordOtpOutcome(body.Channel, "rate_limited")
		writeRateLimitHeaders(w, store.OtpRequestBudget, 0, decision.RetryAfter)
		writeErrorWithRetry(w, http.StatusTooManyRequests, "OTP_RATE_LIMITED", "Too many OTP requests", int(decision.RetryAfter.Seconds()))
		return
	}
	writeRateLimitHeaders(w, store.OtpRequestBudget, rateLimitRemaining(decision, store.OtpRequestBudget), store.OtpRateWindow)

	var created store.OtpCreated
	if s.auth != nil {
		created, err = s.auth.CreateOtp(r.Context(), store.OtpCreateInput{
			Destination: body.Destination,
			Channel:     body.Channel,
			Purpose:     body.Purpose,
			DevCode:     s.devOtp,
			Now:         now,
		})
	} else {
		created, err = s.stores.Otp.Create(r.Context(), store.OtpCreateInput{
			Destination: body.Destination,
			Channel:     body.Channel,
			Purpose:     body.Purpose,
			DevCode:     s.devOtp,
			Now:         now,
		})
	}
	if err != nil {
		s.logger.Error("otp create failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	// The code itself is never logged. Delivery via SMS/email gateway lands
	// with the outbox pattern in M6.
	s.logger.Info("otp issued", "requestId", created.RequestID, "channel", body.Channel, "purpose", body.Purpose)
	s.RecordOtpOutcome(body.Channel, "issued")
	s.enqueueOtpDelivery(r.Context(), created, body.Channel, body.Destination)

	writeJSON(w, http.StatusOK, gen.OtpDelivery{
		RequestId:        newUUID(created.RequestID),
		ExpiresInSeconds: int(created.ExpiresAt.Sub(now).Seconds()),
	})
}

// enqueueOtpDelivery pushes the OTP code to the outbox for SMS delivery. The
// code is encrypted before it leaves this process and is never logged.
// Delivery is best-effort at this milestone: enqueue failures are logged, not
// fatal, and a missing outbox/encryptor silently degrades to no delivery.
// Notification preferences are enforced before anything is enqueued: when
// the destination resolves to a users row, the recipient's sms/otp toggle is
// consulted and a disabled channel skips delivery (logged, never an error);
// a destination with no users row (fresh signup) is always delivered.
func (s *Server) enqueueOtpDelivery(ctx context.Context, created store.OtpCreated, channel, destination string) {
	if channel == "phone" {
		channel = "sms"
	}
	if s.otpSMSDisabledByPreference(ctx, channel, destination, created.RequestID) {
		return
	}
	if s.outbox == nil {
		s.logger.Warn("otp delivery skipped: no outbox configured", "requestId", created.RequestID)
		return
	}
	if s.enc == nil {
		s.logger.Warn("otp delivery skipped: no payload encryptor configured", "requestId", created.RequestID)
		return
	}
	plain, err := json.Marshal(struct {
		Code      string `json:"code"`
		RequestID string `json:"requestId"`
	}{Code: created.Code, RequestID: created.RequestID})
	if err != nil {
		s.logger.Error("otp payload marshal failed", "requestId", created.RequestID, "error", err)
		return
	}
	payload, err := s.enc.Encrypt(plain)
	if err != nil {
		s.logger.Error("otp payload encrypt failed", "requestId", created.RequestID, "error", err)
		return
	}
	if err := s.outbox.Enqueue(ctx, notifications.Message{
		Channel:   channel,
		Recipient: destination,
		Template:  "otp",
		Payload:   payload,
	}); err != nil {
		s.logger.Warn("otp delivery enqueue failed", "requestId", created.RequestID, "error", err)
	}
}

// otpSMSDisabledByPreference reports whether the recipient has disabled SMS
// OTP via notification_preferences (sms.otp = false). Only phone
// destinations of known users are consulted; a missing database, a lookup
// error, a destination that maps to no users row (fresh signup) or an
// unreadable preference row all yield false — preference enforcement must
// never break OTP issuance, it only skips delivery for a deliberate toggle.
func (s *Server) otpSMSDisabledByPreference(ctx context.Context, channel, destination, requestID string) bool {
	if channel != "sms" || s.db == nil {
		return false
	}
	user, err := auth.NewRepo(s.db.Pool()).GetUserByPhone(ctx, destination)
	if err != nil {
		s.logger.Warn("otp preference lookup skipped: user lookup failed", "requestId", requestID, "error", err)
		return false
	}
	if user == nil {
		return false
	}
	enabled, err := s.prefsStore().ChannelEnabled(ctx, user.ID, "sms", "otp")
	if err != nil {
		s.logger.Warn("otp preference lookup skipped: preference read failed", "requestId", requestID, "error", err)
		return false
	}
	if !enabled {
		s.logger.Info("otp delivery skipped: sms disabled by preference",
			"requestId", requestID, "userId", user.ID.String())
		return true
	}
	return false
}

func (s *Server) VerifyOtp(w http.ResponseWriter, r *http.Request) {
	var body struct {
		RequestId string `json:"requestId"`
		Code      string `json:"code"`
		Role      string `json:"role"`
	}
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}

	var (
		result store.OtpVerifyResult
		userID uuid.UUID
		err    error
	)
	if s.auth != nil {
		result, userID, err = s.auth.VerifyOtp(r.Context(), body.RequestId, body.Code, time.Now())
	} else {
		result, err = s.stores.Otp.Verify(r.Context(), body.RequestId, body.Code, time.Now())
	}
	switch {
	case errors.Is(err, store.ErrOtpLocked):
		s.RecordOtpOutcome("unknown", "failed")
		writeError(w, http.StatusUnauthorized, "OTP_MAX_ATTEMPTS", "Too many attempts — request a new code")
		return
	case errors.Is(err, store.ErrOtpUnknown):
		s.RecordOtpOutcome("unknown", "failed")
		writeError(w, http.StatusUnauthorized, "OTP_INVALID", "Invalid or expired code")
		return
	case err != nil:
		s.RecordOtpOutcome("unknown", "failed")
		s.logger.Error("otp verify failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if !result.Verified {
		s.logger.Warn("otp verify wrong code", "requestId", body.RequestId)
		s.RecordOtpOutcome("unknown", "failed")
		writeError(w, http.StatusUnauthorized, "OTP_INVALID", "Invalid or expired code")
		return
	}
	s.RecordOtpOutcome("unknown", "verified")

	// Role-aware session minting: if client explicitly requests a role, honor
	// it — validate via requestedRole then check active assignment (roles
	// table). A missing assignment answers 422 ROLE_NOT_ACTIVE per contract.
	// Without an explicit role, fall back to the historical "customer" mint.
	var role string
	if strings.TrimSpace(body.Role) != "" {
		trimmed := strings.TrimSpace(body.Role)
		canonical, ok := requestedRole(trimmed)
		if !ok {
			writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "role is invalid")
			return
		}
		if canonical != RoleCustomer && !s.hasActiveRole(r.Context(), userID, result.Destination, canonical) {
			writeRoleNotActive(w, canonical)
			return
		}
		role = canonical
	} else {
		role = RoleCustomer
	}

	now := time.Now()
	session, err := s.buildSession(r.Context(), result.Destination, role, now)
	if err != nil {
		s.logger.Error("session issue failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if err := s.stores.Sessions.Create(r.Context(), session.record); err != nil {
		s.logger.Error("session store failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if s.auth != nil {
		if err := s.auth.PersistSession(r.Context(), auth.SessionRow{
			UserID:           userID,
			Role:             role,
			AccessTokenHash:  session.record.AccessTokenHash,
			RefreshTokenHash: session.record.RefreshTokenHash,
			ExpiresAt:        session.record.ExpiresAt,
		}); err != nil {
			s.logger.Error("session persistence failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
	}
	writeJSON(w, http.StatusOK, session.session)
}

// hasActiveRole reports whether the verified identity holds the requested
// active role. Customer is always active (every identity is at least a
// customer via EnsureRole). All other checks query the roles table for an
// active row; without a DB or userID the check fails closed.
func (s *Server) hasActiveRole(ctx context.Context, userID uuid.UUID, phone, role string) bool {
	if role == RoleCustomer {
		return true
	}
	if s.db == nil || userID == uuid.Nil {
		return false
	}
	var exists bool
	if err := s.db.Pool().QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM roles WHERE user_id = $1 AND role = $2 AND active)`, userID, role).Scan(&exists); err != nil {
		s.logger.Warn("role check failed", "error", err)
		return false
	}
	if exists {
		return true
	}
	if role == RoleAdmin {
		if err := s.db.Pool().QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM roles WHERE user_id = $1 AND role = $2 AND active)`, userID, RoleStaff).Scan(&exists); err == nil && exists {
			return true
		}
	}
	if role == RoleStaff {
		if err := s.db.Pool().QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM roles WHERE user_id = $1 AND role = $2 AND active)`, userID, RoleAdmin).Scan(&exists); err == nil && exists {
			return true
		}
	}
	return false
}

func (s *Server) RefreshToken(w http.ResponseWriter, r *http.Request) {
	var body struct {
		RefreshToken string `json:"refreshToken"`
	}
	if err := decodeJSON(r, &body); err != nil || body.RefreshToken == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}

	hash := sha256Hex(body.RefreshToken)
	sess, err := s.stores.Sessions.Get(r.Context(), hash)
	if err != nil {
		s.logger.Error("session get failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if sess == nil {
		writeError(w, http.StatusUnauthorized, "REFRESH_TOKEN_REVOKED", "Refresh token is invalid or revoked")
		return
	}

	next, err := s.buildSession(r.Context(), sess.Subject, sess.Role, time.Now())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if err := s.stores.Sessions.Rotate(r.Context(), hash, next.record); err != nil {
		s.logger.Warn("refresh token reuse rejected", "error", err)
		writeError(w, http.StatusUnauthorized, "REFRESH_TOKEN_REVOKED", "Refresh token is invalid or revoked")
		return
	}
	if s.auth != nil {
		// The Redis store is authoritative for hot-path rotation; the durable
		// row is a mirror, so a missing/divergent row degrades to a warning.
		if err := s.auth.RotateSession(r.Context(), hash, auth.SessionRow{
			Role:             sess.Role,
			AccessTokenHash:  next.record.AccessTokenHash,
			RefreshTokenHash: next.record.RefreshTokenHash,
			ExpiresAt:        next.record.ExpiresAt,
		}); err != nil {
			s.logger.Warn("session row rotation failed", "error", err)
		}
	}
	writeJSON(w, http.StatusOK, next.session)
}

func (s *Server) Logout(w http.ResponseWriter, r *http.Request) {
	var body struct {
		RefreshToken string `json:"refreshToken"`
	}
	_ = decodeJSON(r, &body)
	if body.RefreshToken != "" {
		hash := sha256Hex(body.RefreshToken)
		if err := s.stores.Sessions.Revoke(r.Context(), hash); err != nil {
			s.logger.Error("session revoke failed", "error", err)
		}
		if s.auth != nil {
			if err := s.auth.RevokeSession(r.Context(), hash); err != nil {
				s.logger.Warn("session row revoke failed", "error", err)
			}
		}
	}
	w.WriteHeader(http.StatusNoContent)
}

func decodeJSON(r *http.Request, dst any) error {
	r.Body = http.MaxBytesReader(nil, r.Body, maxBodyBytes)
	dec := json.NewDecoder(r.Body)
	if err := dec.Decode(dst); err != nil {
		return err
	}
	if _, err := dec.Token(); err != io.EOF {
		return errNotNil
	}
	return nil
}
