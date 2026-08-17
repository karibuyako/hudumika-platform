package api

// BIRTHDAY REWARDS bounded context (API-CONTRACT.yaml /rewards/birthday and
// /rewards/birthday/claim, consumer docs/CONTRACT-ADDITIONS.md "Birthday
// reward"): one birthday_rewards row per user, granted lazily on first read
// — the contract User DTO carries no birthday field (verified in the
// generated model), so the platform treats every registered customer as
// in-window for this milestone, exactly like the consumer mock
// (mock/rewards.ts). The row's status is pending -> claimed (claimed_at
// set); available stays true while claimed, mirroring the contract
// BirthdayReward shape (available + claimed are independent flags).
// Idempotency-Key replay is provided by the global middleware; the
// pending->claimed flip is the write, so a concurrent double claim cannot
// succeed.

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/hudumika/api-backend/internal/gen"
)

// birthdayRewardWindow is how long a freshly granted reward stays valid
// (valid_from = now, valid_to = now + 30 days — the mock's expiresAt
// horizon).
const birthdayRewardWindow = 30 * 24 * time.Hour

// birthdayRewardRow is one birthday_rewards row.
type birthdayRewardRow struct {
	ID        uuid.UUID
	Title     string
	RewardTZS int64
	Status    string
	ValidFrom time.Time
	ValidTo   time.Time
}

// ensureBirthdayReward returns the user's birthday_rewards row, creating a
// fresh pending reward on first read (lazy grant). A concurrent first-read
// grant can insert twice; the latest-row read below then surfaces the newest
// row and the claim flip (WHERE status = 'pending') makes only one of the
// two claimable, so the race cannot double-claim.
func (s *Server) ensureBirthdayReward(ctx context.Context, userID uuid.UUID) (birthdayRewardRow, error) {
	row, found, err := s.latestBirthdayReward(ctx, userID)
	if err != nil {
		return birthdayRewardRow{}, err
	}
	if found {
		return row, nil
	}
	now := time.Now().UTC()
	var id uuid.UUID
	if err := s.db.Pool().QueryRow(ctx,
		`INSERT INTO birthday_rewards (user_id, title, valid_from, valid_to)
		 VALUES ($1, 'Birthday treat', $2, $3) RETURNING id`,
		userID, now, now.Add(birthdayRewardWindow)).Scan(&id); err != nil {
		return birthdayRewardRow{}, err
	}
	return birthdayRewardRow{
		ID:        id,
		Title:     "Birthday treat",
		RewardTZS: 10000,
		Status:    "pending",
		ValidFrom: now,
		ValidTo:   now.Add(birthdayRewardWindow),
	}, nil
}

// latestBirthdayReward reads the user's most recently granted reward row.
func (s *Server) latestBirthdayReward(ctx context.Context, userID uuid.UUID) (birthdayRewardRow, bool, error) {
	var row birthdayRewardRow
	err := s.db.Pool().QueryRow(ctx,
		`SELECT id, title, reward_tzs, status, valid_from, valid_to
		 FROM birthday_rewards WHERE user_id = $1
		 ORDER BY created_at DESC, id DESC LIMIT 1`, userID).
		Scan(&row.ID, &row.Title, &row.RewardTZS, &row.Status, &row.ValidFrom, &row.ValidTo)
	if errors.Is(err, pgx.ErrNoRows) {
		return birthdayRewardRow{}, false, nil
	}
	if err != nil {
		return birthdayRewardRow{}, false, err
	}
	return row, true, nil
}

// birthdayToContract maps a birthday_rewards row onto the contract
// BirthdayReward. available = pending and still inside valid_to; claimed is
// the stored claim flag (available and claimed stay independent, mirroring
// the mock).
func birthdayToContract(row birthdayRewardRow, now time.Time) gen.BirthdayReward {
	out := gen.BirthdayReward{
		Available:   row.Status == "pending" && !now.After(row.ValidTo),
		Claimed:     row.Status == "claimed",
		RewardTitle: &row.Title,
	}
	tzs := int(row.RewardTZS)
	out.RewardTZS = &tzs
	expires := row.ValidTo
	out.ExpiresAt = &expires
	return out
}

// GetBirthdayReward returns the session user's birthday reward availability
// (GET /rewards/birthday, 200 BirthdayReward). A first read lazily grants a
// pending reward (30-day window) — every registered customer is in-window
// until the platform carries birthdays (contract User DTO has none).
func (s *Server) GetBirthdayReward(w http.ResponseWriter, r *http.Request) {
	user, _, ok := s.customerUser(w, r)
	if !ok {
		return
	}
	row, err := s.ensureBirthdayReward(r.Context(), user.ID)
	if err != nil {
		s.logger.Error("birthday reward grant failed", "user", user.ID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, birthdayToContract(row, time.Now()))
}

// ClaimBirthdayReward claims the session user's birthday reward (POST
// /rewards/birthday/claim, no body, 201 BirthdayReward). A user with no row
// yet is granted one lazily and claims it in the same call; an already-
// claimed reward surfaces 409 CONFLICT (a replaying client with the same
// Idempotency-Key is answered by the global middleware first).
func (s *Server) ClaimBirthdayReward(w http.ResponseWriter, r *http.Request) {
	user, _, ok := s.customerUser(w, r)
	if !ok {
		return
	}
	ctx := r.Context()
	row, err := s.ensureBirthdayReward(ctx, user.ID)
	if err != nil {
		s.logger.Error("birthday reward grant failed", "user", user.ID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if row.Status == "claimed" {
		writeError(w, http.StatusConflict, "CONFLICT", "You already claimed your birthday reward")
		return
	}
	tag, err := s.db.Pool().Exec(ctx,
		`UPDATE birthday_rewards SET status = 'claimed', claimed_at = now()
		 WHERE id = $1 AND status = 'pending'`, row.ID)
	if err != nil {
		s.logger.Error("birthday reward claim failed", "user", user.ID, "reward", row.ID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if tag.RowsAffected() == 0 {
		writeError(w, http.StatusConflict, "CONFLICT", "You already claimed your birthday reward")
		return
	}
	row.Status = "claimed"
	writeJSON(w, http.StatusCreated, birthdayToContract(row, time.Now()))
}