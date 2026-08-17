package api

// REFERRALS bounded context (API-CONTRACT.yaml /referrals/me,
// /referrals/claim, consumer docs/CONTRACT-ADDITIONS.md "Referral"): every
// customer owns one referral row, minted lazily on first GET /referrals/me
// (no seed mechanism exists in this backend — the mock's HUDU-DEMO-25 is
// mock-side; the server derives the code deterministically from the user id,
// which is unique). referral_claims records each redeemed code; a code is
// usable exactly once. Rewards are always 'pending' in this milestone: no
// crediting flow exists (PAYOUTS-LEDGER.md), matching the consumer mock's
// ReferralReward.status = pending with creditedAt null.
//
// Error codes follow ERROR-CODES.md generic codes — there is no referral
// section: VALIDATION_FAILED (422) for malformed codes, NOT_FOUND (404) for
// unknown codes, CONFLICT (409) for self-claims and already-claimed codes.
// Idempotency-Key replay is provided by the global middleware
// (idempotency.go); the claim itself is additionally guarded by the
// active->claimed row flip inside one transaction, so a concurrent double
// claim cannot succeed.

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/hudumika/api-backend/internal/auth"
	"github.com/hudumika/api-backend/internal/gen"
)

// referralCodeRE is the contract shape of ClaimReferralBody.code: 6-20 chars
// of A-Z, 0-9 and dashes, starting with a letter or digit (contract
// maxLength 20). The check runs on the RAW input: lowercase or stray
// characters are 422 — a strict server rejects malformed codes (the UI
// normalizes case), mirroring the consumer mock.
var referralCodeRE = regexp.MustCompile(`^[A-Z0-9][A-Z0-9-]{5,19}$`)

// customerUser resolves the authenticated subject (JWT subject = phone) to
// the users row. A missing database is a 500: money-adjacent lookups must
// never degrade into a 404 (same convention as walletUser in wallet.go and
// financeUser in finance.go).
func (s *Server) customerUser(w http.ResponseWriter, r *http.Request) (*auth.UserRow, *Claims, bool) {
	claims, ok := ClaimsFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing or invalid bearer token")
		return nil, nil, false
	}
	if s.db == nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return nil, nil, false
	}
	user, err := auth.NewRepo(s.db.Pool()).GetUserByPhone(r.Context(), claims.Subject)
	if err != nil {
		s.logger.Error("customer user lookup failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return nil, nil, false
	}
	if user == nil {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "User not found")
		return nil, nil, false
	}
	return user, claims, true
}

// referralCodeFor derives the deterministic referral code for a user from
// their unique id: "HUDU-" + the first 8 hex chars of the uuid, uppercased
// (13 chars, inside the contract's 6-20 window and matching
// referralCodeRE). The code is unique per user because the id is; the
// referrals.code UNIQUE constraint stays as the backstop.
func referralCodeFor(userID uuid.UUID) string {
	return "HUDU-" + strings.ToUpper(userID.String())[:8]
}

// mintReferral ensures the user owns a referrals row, creating it lazily
// with the deterministic code (reward_tzs 5000, the platform's per-claim
// bounty). A concurrent mint for the same user is absorbed by ON CONFLICT on
// owner_user_id and the existing row is returned; a code collision with a
// different user (1 in 2^32 for the derived code) surfaces the insert error.
func (s *Server) mintReferral(ctx context.Context, userID uuid.UUID) (uuid.UUID, string, error) {
	code := referralCodeFor(userID)
	var (
		id  uuid.UUID
		row string
	)
	err := s.db.Pool().QueryRow(ctx,
		`INSERT INTO referrals (code, owner_user_id, reward_tzs)
		 VALUES ($1, $2, 5000)
		 ON CONFLICT (owner_user_id) DO NOTHING
		 RETURNING id, code`, code, userID).Scan(&id, &row)
	if err == nil {
		return id, row, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, "", fmt.Errorf("referrals: mint %s: %w", userID, err)
	}
	// A concurrent mint won the race: reuse the existing row.
	if err := s.db.Pool().QueryRow(ctx,
		`SELECT id, code FROM referrals WHERE owner_user_id = $1`, userID).Scan(&id, &row); err != nil {
		return uuid.Nil, "", fmt.Errorf("referrals: resolve mint %s: %w", userID, err)
	}
	return id, row, nil
}

// GetMyReferral returns the session user's referral code and claim stats
// (GET /referrals/me). The referral row is minted on first read; invitedCount
// is the number of redeemed claims and totalRewardTZS their sum (both 0 on a
// fresh code — honest counts, unlike the mock's seeded demo numbers).
// rewardStatus is always 'pending': no crediting flow exists yet.
func (s *Server) GetMyReferral(w http.ResponseWriter, r *http.Request) {
	user, _, ok := s.customerUser(w, r)
	if !ok {
		return
	}
	ctx := r.Context()
	referralID, code, err := s.mintReferral(ctx, user.ID)
	if err != nil {
		s.logger.Error("referral mint failed", "user", user.ID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	var (
		invited int64
		earned  int64
	)
	if err := s.db.Pool().QueryRow(ctx,
		`SELECT count(*), COALESCE(SUM(reward_tzs), 0) FROM referral_claims WHERE referral_id = $1`,
		referralID).Scan(&invited, &earned); err != nil {
		s.logger.Error("referral stats failed", "user", user.ID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	total := int(earned)
	writeJSON(w, http.StatusOK, gen.ReferralSummary{
		Code:           code,
		InvitedCount:   int(invited),
		RewardStatus:   gen.ReferralSummaryRewardStatusPending,
		TotalRewardTZS: &total,
	})
}

// ClaimReferral redeems another user's code (POST /referrals/claim, body
// {code}, 201 ReferralReward). Evaluation order: the code format is
// validated first (client errors never touch the database), the caller is
// then resolved DB-gated, self-claims and already-claimed codes are 409, and
// the active->claimed flip inside one transaction is the concurrency guard.
// A replaying client with the same Idempotency-Key is answered by the global
// middleware before this handler runs.
func (s *Server) ClaimReferral(w http.ResponseWriter, r *http.Request) {
	var body gen.ClaimReferralJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	raw := strings.TrimSpace(body.Code)
	if !referralCodeRE.MatchString(raw) {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED",
			"Referral codes are 6-20 letters, digits and dashes")
		return
	}

	user, _, ok := s.customerUser(w, r)
	if !ok {
		return
	}
	ctx := r.Context()
	code := strings.ToUpper(raw)

	var (
		rowID   uuid.UUID
		reward  int64
		status  string
		ownerID uuid.UUID
	)
	err := s.db.Pool().QueryRow(ctx,
		`SELECT id, reward_tzs, status, owner_user_id FROM referrals WHERE code = $1`,
		code).Scan(&rowID, &reward, &status, &ownerID)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "Referral code not found")
		return
	}
	if err != nil {
		s.logger.Error("referral claim lookup failed", "user", user.ID, "code", code, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if ownerID == user.ID {
		writeError(w, http.StatusConflict, "CONFLICT", "You cannot use your own referral code")
		return
	}
	if status != "active" {
		writeError(w, http.StatusConflict, "CONFLICT", "This referral code was already claimed")
		return
	}

	// The flip is the write: WHERE status = 'active' makes a concurrent
	// double-claim impossible — the loser sees 0 rows and surfaces 409.
	tx, err := s.db.Pool().Begin(ctx)
	if err != nil {
		s.logger.Error("referral claim begin failed", "user", user.ID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer func() { _ = tx.Rollback(ctx) }()

	tag, err := tx.Exec(ctx,
		`UPDATE referrals SET status = 'claimed', claimed_by_user_id = $2, claimed_at = now()
		 WHERE id = $1 AND status = 'active'`, rowID, user.ID)
	if err != nil {
		s.logger.Error("referral claim flip failed", "user", user.ID, "referral", rowID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if tag.RowsAffected() == 0 {
		writeError(w, http.StatusConflict, "CONFLICT", "This referral code was already claimed")
		return
	}
	var claimID uuid.UUID
	if err := tx.QueryRow(ctx,
		`INSERT INTO referral_claims (referral_id, claimant_user_id, reward_tzs)
		 VALUES ($1, $2, $3) RETURNING id`,
		rowID, user.ID, reward).Scan(&claimID); err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			// The flip guard already lost the race for this claimant; keep
			// the constraint handling symmetric.
			writeError(w, http.StatusConflict, "CONFLICT", "This referral code was already claimed")
			return
		}
		s.logger.Error("referral claim insert failed", "user", user.ID, "referral", rowID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if err := tx.Commit(ctx); err != nil {
		s.logger.Error("referral claim commit failed", "user", user.ID, "referral", rowID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusCreated, gen.ReferralReward{
		Id:        newUUID(claimID.String()),
		AmountTZS: int(reward),
		Status:    gen.ReferralRewardStatusPending,
	})
}