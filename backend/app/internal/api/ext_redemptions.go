package api

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

var (
	errRedeemMemberNotFound = errors.New("api: loyalty member not found")
	errRedeemMemberNotOwned = errors.New("api: loyalty member not owned by merchant")
	errRedeemMemberNoUser   = errors.New("api: loyalty member has no linked user")
)

// requireMerchant resolves the authenticated merchant and writes an error if
// the session is not a merchant session. It returns the merchants row id.
func (s *Server) requireMerchant(w http.ResponseWriter, r *http.Request) (uuid.UUID, bool) {
	merchantID, err := s.merchantIDForSession(r)
	if err != nil {
		if errors.Is(err, errNoBearerToken) || errors.Is(err, errNoMerchant) || errors.Is(err, errUserNotFound) {
			writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Merchant session required")
		} else {
			s.logger.Error("merchant session resolution failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		}
		return uuid.Nil, false
	}
	if merchantID == uuid.Nil {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Merchant session required")
		return uuid.Nil, false
	}
	return merchantID, true
}

func redemptionJSON(id, userID uuid.UUID, memberID *uuid.UUID, points int, reason *string, createdAt time.Time, idem string) map[string]any {
	m := map[string]any{
		"id":        id.String(),
		"points":    points,
		"createdAt": createdAt,
	}
	if userID != uuid.Nil {
		m["userId"] = userID.String()
	}
	if memberID != nil {
		m["memberId"] = memberID.String()
	}
	if reason != nil {
		m["reason"] = *reason
	}
	if idem != "" {
		m["idempotencyKey"] = idem
	}
	return m
}

// MthListRedemptionsReal lists loyalty redemptions for the merchant.
func (s *Server) MthListRedemptionsReal(w http.ResponseWriter, r *http.Request) {
	if s.db == nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	merchantID, ok := s.requireMerchant(w, r)
	if !ok {
		return
	}
	rows, err := s.db.Pool().Query(r.Context(),
		`SELECT id, user_id, member_id, points, reason, created_at
		 FROM loyalty_redemptions WHERE merchant_id = $1
		 ORDER BY created_at DESC, id DESC LIMIT 200`, merchantID)
	if err != nil {
		s.logger.Error("list redemptions failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer rows.Close()
	out := make([]map[string]any, 0)
	for rows.Next() {
		var (
			id       uuid.UUID
			userID  uuid.UUID
			memberID *uuid.UUID
			points  int
			reason  *string
			created time.Time
		)
		if err := rows.Scan(&id, &userID, &memberID, &points, &reason, &created); err != nil {
			s.logger.Error("scan redemption failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		out = append(out, redemptionJSON(id, userID, memberID, points, reason, created, ""))
	}
	if err := rows.Err(); err != nil {
		s.logger.Error("iterate redemptions failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// MthCreateRedemptionReal creates a loyalty redemption row for the merchant.
func (s *Server) MthCreateRedemptionReal(w http.ResponseWriter, r *http.Request) {
	s.createMerchantRedemption(w, r)
}

// MthCreateLoyaltyRedemptionReal creates a loyalty redemption row (mirrors the
// consumer /loyalty/redemptions flow but merchant/group scoped).
func (s *Server) MthCreateLoyaltyRedemptionReal(w http.ResponseWriter, r *http.Request) {
	s.createMerchantRedemption(w, r)
}

func (s *Server) createMerchantRedemption(w http.ResponseWriter, r *http.Request) {
	if s.db == nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	merchantID, ok := s.requireMerchant(w, r)
	if !ok {
		return
	}
	var body struct {
		MemberID       string `json:"memberId"`
		Points         int    `json:"points"`
		Reason         string `json:"reason"`
		IdempotencyKey string `json:"idempotencyKey"`
	}
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	memberID, err := uuid.Parse(strings.TrimSpace(body.MemberID))
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "memberId must be a valid UUID")
		return
	}
	if body.Points <= 0 {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "points must be greater than 0")
		return
	}
	idem := mthIdemKey(r, &body.IdempotencyKey)

	id, userID, createdAt, existed, err := s.redeemInsert(r.Context(), merchantID, memberID, body.Points, body.Reason, idem)
	if err != nil {
		switch {
		case errors.Is(err, errRedeemMemberNotFound), errors.Is(err, errRedeemMemberNotOwned):
			writeError(w, http.StatusNotFound, "NOT_FOUND", "Loyalty member not found")
		case errors.Is(err, errRedeemMemberNoUser):
			writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Loyalty member has no linked user account")
		default:
			s.logger.Error("create redemption failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		}
		return
	}
	mid := memberID
	status := http.StatusCreated
	if existed {
		status = http.StatusOK
	}
	writeJSON(w, status, redemptionJSON(id, userID, &mid, body.Points, &body.Reason, createdAt, idem))
}

// redeemInsert performs the idempotent insertion of a loyalty_redemptions row
// scoped to the given merchant and member. It returns existed=true when the
// idempotency key had already been consumed (the caller should respond 200).
func (s *Server) redeemInsert(ctx context.Context, merchantID, memberID uuid.UUID, points int, reason, idem string) (id, userID uuid.UUID, createdAt time.Time, existed bool, err error) {
	pool := s.db.Pool()

	if idem != "" {
		var eid, euid uuid.UUID
		var eca time.Time
		eerr := pool.QueryRow(ctx, `SELECT id, user_id, created_at FROM loyalty_redemptions WHERE idempotency_key=$1`, idem).Scan(&eid, &euid, &eca)
		if eerr == nil {
			return eid, euid, eca, true, nil
		}
		if !errors.Is(eerr, pgx.ErrNoRows) {
			return uuid.Nil, uuid.Nil, time.Time{}, false, eerr
		}
	}

	var mMerchant, mUser uuid.UUID
	lerr := pool.QueryRow(ctx, `SELECT merchant_id, customer_user_id FROM loyalty_members WHERE id=$1`, memberID).Scan(&mMerchant, &mUser)
	if errors.Is(lerr, pgx.ErrNoRows) {
		return uuid.Nil, uuid.Nil, time.Time{}, false, errRedeemMemberNotFound
	}
	if lerr != nil {
		return uuid.Nil, uuid.Nil, time.Time{}, false, lerr
	}
	if mMerchant != merchantID {
		return uuid.Nil, uuid.Nil, time.Time{}, false, errRedeemMemberNotOwned
	}
	if mUser == uuid.Nil {
		return uuid.Nil, uuid.Nil, time.Time{}, false, errRedeemMemberNoUser
	}

	var nid, nuid uuid.UUID
	var nca time.Time
	ierr := pool.QueryRow(ctx,
		`INSERT INTO loyalty_redemptions (user_id, reward, points, merchant_id, member_id, reason, idempotency_key)
		 VALUES ($1,'points_redemption',$2,$3,$4,$5,NULLIF($6,'')) RETURNING id, user_id, created_at`,
		mUser, points, merchantID, memberID, reason, idem).Scan(&nid, &nuid, &nca)
	if ierr != nil {
		var pgErr *pgconn.PgError
		if errors.As(ierr, &pgErr) && pgErr.Code == "23505" {
			var rid, ruid uuid.UUID
			var rca time.Time
			_ = pool.QueryRow(ctx, `SELECT id, user_id, created_at FROM loyalty_redemptions WHERE idempotency_key=$1`, idem).Scan(&rid, &ruid, &rca)
			return rid, ruid, rca, true, nil
		}
		return uuid.Nil, uuid.Nil, time.Time{}, false, ierr
	}
	return nid, nuid, nca, false, nil
}

// MthRedeemLoyaltyMemberReal deducts points from a loyalty member and records
// the redemption in a single transaction.
func (s *Server) MthRedeemLoyaltyMemberReal(w http.ResponseWriter, r *http.Request) {
	if s.db == nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	merchantID, ok := s.requireMerchant(w, r)
	if !ok {
		return
	}
	memberID, ok := mthParamUUID(r, "id")
	if !ok {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "id is required")
		return
	}
	var body struct {
		Points         int    `json:"points"`
		Reason         string `json:"reason"`
		IdempotencyKey string `json:"idempotencyKey"`
	}
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if body.Points <= 0 {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "points must be greater than 0")
		return
	}
	idem := mthIdemKey(r, &body.IdempotencyKey)
	ctx := r.Context()
	pool := s.db.Pool()

	if idem != "" {
		var eid uuid.UUID
		var epts int
		var ereas *string
		var eca time.Time
		eerr := pool.QueryRow(ctx, `SELECT id, points, reason, created_at FROM loyalty_redemptions WHERE idempotency_key=$1`, idem).Scan(&eid, &epts, &ereas, &eca)
		if eerr == nil {
			writeJSON(w, http.StatusOK, map[string]any{
				"id":             eid.String(),
				"memberId":       memberID.String(),
				"points":         epts,
				"reason":         ereas,
				"createdAt":      eca,
				"idempotencyKey": idem,
			})
			return
		}
		if !errors.Is(eerr, pgx.ErrNoRows) {
			s.logger.Error("redeem idempotency lookup failed", "error", eerr)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
	}

	tx, err := pool.Begin(ctx)
	if err != nil {
		s.logger.Error("redeem begin tx failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer tx.Rollback(ctx)

	var mUser uuid.UUID
	var newBal int64
	derr := tx.QueryRow(ctx,
		`UPDATE loyalty_members
		 SET balance_tzs = balance_tzs - $1
		 WHERE id = $2 AND merchant_id = $3 AND balance_tzs >= $1 AND customer_user_id IS NOT NULL
		 RETURNING customer_user_id, balance_tzs`,
		int64(body.Points), memberID, merchantID).Scan(&mUser, &newBal)
	if derr != nil {
		if errors.Is(derr, pgx.ErrNoRows) {
			var exists, hasUser bool
			var bal int64
			_ = tx.QueryRow(ctx,
				`SELECT EXISTS(SELECT 1 FROM loyalty_members WHERE id=$1 AND merchant_id=$2),
				        COALESCE(balance_tzs,0),
				        (customer_user_id IS NOT NULL)
				 FROM loyalty_members WHERE id=$1 AND merchant_id=$2`,
				memberID, merchantID).Scan(&exists, &bal, &hasUser)
			if !exists {
				writeError(w, http.StatusNotFound, "NOT_FOUND", "Loyalty member not found")
				return
			}
			if !hasUser {
				writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Loyalty member has no linked user account")
				return
			}
			writeError(w, http.StatusConflict, "CONFLICT", "Insufficient points balance")
			return
		}
		s.logger.Error("redeem update member failed", "error", derr)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	var nid uuid.UUID
	var nca time.Time
	ierr := tx.QueryRow(ctx,
		`INSERT INTO loyalty_redemptions (user_id, reward, points, merchant_id, member_id, reason, idempotency_key)
		 VALUES ($1,'points_redemption',$2,$3,$4,$5,NULLIF($6,'')) RETURNING id, created_at`,
		mUser, body.Points, merchantID, memberID, body.Reason, idem).Scan(&nid, &nca)
	if ierr != nil {
		var pgErr *pgconn.PgError
		if errors.As(ierr, &pgErr) && pgErr.Code == "23505" {
			_ = tx.QueryRow(ctx, `SELECT id, created_at FROM loyalty_redemptions WHERE idempotency_key=$1`, idem).Scan(&nid, &nca)
			if cerr := tx.Commit(ctx); cerr != nil {
				s.logger.Error("redeem commit failed", "error", cerr)
				writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
				return
			}
			writeJSON(w, http.StatusOK, map[string]any{
				"id":             nid.String(),
				"memberId":       memberID.String(),
				"points":         body.Points,
				"reason":         &body.Reason,
				"balanceTzs":     newBal,
				"createdAt":      nca,
				"idempotencyKey": idem,
			})
			return
		}
		s.logger.Error("redeem insert failed", "error", ierr)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	if err := tx.Commit(ctx); err != nil {
		s.logger.Error("redeem commit failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"id":             nid.String(),
		"memberId":       memberID.String(),
		"points":         body.Points,
		"reason":         &body.Reason,
		"balanceTzs":     newBal,
		"createdAt":      nca,
		"idempotencyKey": idem,
	})
}
