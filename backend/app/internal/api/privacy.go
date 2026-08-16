package api

import (
	"context"
	"net/http"
	"time"

	"github.com/google/uuid"

	"github.com/hudumika/api-backend/internal/auth"
	"github.com/hudumika/api-backend/internal/gen"
)

const (
	// privacyExportTTL is how long an assembled export artifact stays valid;
	// it is reported as expiresAt on the 202 response.
	privacyExportTTL = 24 * time.Hour
	// accountDeletionEstimatedDays is the contract's grace-period example for
	// /privacy/delete; the sweeper job is the authority on the real window.
	accountDeletionEstimatedDays = 30
)

// privacyExportPayload is the assembled personal-data export: the user's own
// profile plus every dataset the platform holds about them. Assembles inline
// until a download-artifact job exists; the sweeper can reuse the same
// assembly query set.
type privacyExportPayload struct {
	User          exportUser           `json:"user"`
	Roles         []gen.RoleSummary    `json:"roles"`
	Notifications []exportNotification `json:"notifications"`
	Orders        []exportOrder        `json:"orders"`
	Favorites     []exportFavorite     `json:"favorites"`
}

type exportUser struct {
	ID        uuid.UUID `json:"id"`
	Phone     string    `json:"phone"`
	Email     *string   `json:"email"`
	FullName  string    `json:"fullName"`
	Locale    string    `json:"locale"`
	CreatedAt time.Time `json:"createdAt"`
}

type exportNotification struct {
	ID        uuid.UUID `json:"id"`
	Type      string    `json:"type"`
	Title     string    `json:"title"`
	Body      string    `json:"body"`
	Read      bool      `json:"read"`
	CreatedAt time.Time `json:"createdAt"`
}

type exportOrder struct {
	ID             uuid.UUID `json:"id"`
	No             string    `json:"no"`
	Status         string    `json:"status"`
	SubtotalTZS    int64     `json:"subtotalTzs"`
	DeliveryFeeTZS int64     `json:"deliveryFeeTzs"`
	PlatformFeeTZS int64     `json:"platformFeeTzs"`
	TaxTZS         int64     `json:"taxTzs"`
	DiscountTZS    int64     `json:"discountTzs"`
	TotalTZS       int64     `json:"totalTzs"`
	CreatedAt      time.Time `json:"createdAt"`
}

type exportFavorite struct {
	MerchantID uuid.UUID `json:"merchantId"`
	CreatedAt  time.Time `json:"createdAt"`
}

// beginPrivacyRequest records the durable privacy_requests row for the
// user/kind pair. When an open request (pending/processing) already exists it
// returns open=true and the caller maps that to the contract 409. A finished
// request (completed/failed) is re-opened by resetting it to pending, since
// the unique (user_id, kind) constraint allows exactly one row per pair.
func (s *Server) beginPrivacyRequest(ctx context.Context, userID uuid.UUID, kind string, expiresAt *time.Time) (uuid.UUID, bool, error) {
	pool := s.db.Pool()
	tag, err := pool.Exec(ctx,
		`INSERT INTO privacy_requests (user_id, kind, expires_at) VALUES ($1, $2, $3)
		 ON CONFLICT (user_id, kind) DO NOTHING`,
		userID, kind, expiresAt)
	if err != nil {
		return uuid.Nil, false, err
	}
	if tag.RowsAffected() == 1 {
		var id uuid.UUID
		if err := pool.QueryRow(ctx,
			`SELECT id FROM privacy_requests WHERE user_id = $1 AND kind = $2`,
			userID, kind).Scan(&id); err != nil {
			return uuid.Nil, false, err
		}
		return id, false, nil
	}

	var (
		id     uuid.UUID
		status string
	)
	if err := pool.QueryRow(ctx,
		`SELECT id, status FROM privacy_requests WHERE user_id = $1 AND kind = $2`,
		userID, kind).Scan(&id, &status); err != nil {
		return uuid.Nil, false, err
	}
	if status == "pending" || status == "processing" {
		return id, true, nil
	}
	if _, err := pool.Exec(ctx,
		`UPDATE privacy_requests SET status = 'pending', expires_at = $3, updated_at = now() WHERE id = $1 AND user_id = $2`,
		id, userID, expiresAt); err != nil {
		return uuid.Nil, false, err
	}
	return id, false, nil
}

// RequestPrivacyExport records a durable export request and assembles the
// export payload inline. The contract response is {jobId, status}; data and
// expiresAt are appended so the caller can consume the artifact while no
// download-job infrastructure exists.
func (s *Server) RequestPrivacyExport(w http.ResponseWriter, r *http.Request) {
	user, repo := s.resolveUser(w, r)
	if user == nil {
		return
	}

	now := time.Now()
	expiresAt := now.Add(privacyExportTTL)
	id, open, err := s.beginPrivacyRequest(r.Context(), user.ID, "export", &expiresAt)
	if err != nil {
		s.logger.Error("begin privacy export failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if open {
		writeError(w, http.StatusConflict, "PRIVACY_EXPORT_IN_PROGRESS",
			"A personal data export is already in progress")
		return
	}

	payload, err := s.buildExportPayload(r.Context(), user, repo)
	if err != nil {
		s.logger.Error("build export payload failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	writeJSON(w, http.StatusAccepted, struct {
		JobId     string               `json:"jobId"`
		Status    string               `json:"status"`
		Data      privacyExportPayload `json:"data"`
		ExpiresAt time.Time            `json:"expiresAt"`
	}{
		JobId:     id.String(),
		Status:    "queued",
		Data:      payload,
		ExpiresAt: expiresAt,
	})
}

// buildExportPayload assembles the personal-data export with exactly one
// query per dataset — user (already loaded by currentUser), roles,
// notifications, orders, favorites — never N+1.
func (s *Server) buildExportPayload(ctx context.Context, user *auth.UserRow, repo *auth.Repo) (privacyExportPayload, error) {
	payload := privacyExportPayload{
		User: exportUser{
			ID:        user.ID,
			Phone:     user.Phone,
			Email:     user.Email,
			FullName:  user.FullName,
			Locale:    user.Locale,
			CreatedAt: user.CreatedAt,
		},
	}

	roles, err := repo.ListRolesByUser(ctx, user.ID)
	if err != nil {
		return privacyExportPayload{}, err
	}
	payload.Roles = toRoleSummaries(roles)

	notifRows, err := s.db.Pool().Query(ctx,
		`SELECT id, type, title, body, read, created_at FROM notifications
		 WHERE user_id = $1 ORDER BY created_at DESC`, user.ID)
	if err != nil {
		return privacyExportPayload{}, err
	}
	defer notifRows.Close()
	for notifRows.Next() {
		var n exportNotification
		if err := notifRows.Scan(&n.ID, &n.Type, &n.Title, &n.Body, &n.Read, &n.CreatedAt); err != nil {
			return privacyExportPayload{}, err
		}
		payload.Notifications = append(payload.Notifications, n)
	}
	if err := notifRows.Err(); err != nil {
		return privacyExportPayload{}, err
	}

	orderRows, err := s.db.Pool().Query(ctx,
		`SELECT id, no, status, subtotal_tzs, delivery_fee_tzs, platform_fee_tzs, tax_tzs, discount_tzs, total_tzs, created_at
		 FROM orders WHERE customer_user_id = $1 ORDER BY created_at DESC`, user.ID)
	if err != nil {
		return privacyExportPayload{}, err
	}
	defer orderRows.Close()
	for orderRows.Next() {
		var o exportOrder
		if err := orderRows.Scan(&o.ID, &o.No, &o.Status, &o.SubtotalTZS, &o.DeliveryFeeTZS,
			&o.PlatformFeeTZS, &o.TaxTZS, &o.DiscountTZS, &o.TotalTZS, &o.CreatedAt); err != nil {
			return privacyExportPayload{}, err
		}
		payload.Orders = append(payload.Orders, o)
	}
	if err := orderRows.Err(); err != nil {
		return privacyExportPayload{}, err
	}

	favRows, err := s.db.Pool().Query(ctx,
		`SELECT merchant_id, created_at FROM favorites
		 WHERE user_id = $1 ORDER BY created_at DESC`, user.ID)
	if err != nil {
		return privacyExportPayload{}, err
	}
	defer favRows.Close()
	for favRows.Next() {
		var f exportFavorite
		if err := favRows.Scan(&f.MerchantID, &f.CreatedAt); err != nil {
			return privacyExportPayload{}, err
		}
		payload.Favorites = append(payload.Favorites, f)
	}
	if err := favRows.Err(); err != nil {
		return privacyExportPayload{}, err
	}

	return payload, nil
}

// RequestAccountDeletion records a durable deletion request after the
// confirmation literal is validated. The confirmation is pure input
// validation and is checked before any database work, so malformed requests
// answer 422 without touching the store. Actual deletion — revoking every
// session, soft-flagging the account, purging data after the grace period —
// is executed by the sweeper job; this request row is the durable record it
// acts on.
func (s *Server) RequestAccountDeletion(w http.ResponseWriter, r *http.Request) {
	var body gen.RequestAccountDeletionJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if body.Confirmation != gen.DELETE {
		writeError(w, http.StatusUnprocessableEntity, "ACCOUNT_DELETION_INVALID_CONFIRMATION",
			"Confirmation must be the literal DELETE")
		return
	}
	if body.Reason != nil && len(*body.Reason) > 500 {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED",
			"reason must be at most 500 characters")
		return
	}

	user, _ := s.resolveUser(w, r)
	if user == nil {
		return
	}

	id, open, err := s.beginPrivacyRequest(r.Context(), user.ID, "deletion", nil)
	if err != nil {
		s.logger.Error("begin account deletion failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if open {
		writeError(w, http.StatusConflict, "ACCOUNT_DELETION_PENDING",
			"Account deletion is already pending")
		return
	}

	writeJSON(w, http.StatusAccepted, struct {
		RequestId     string `json:"requestId"`
		EstimatedDays int    `json:"estimatedDays"`
	}{
		RequestId:     id.String(),
		EstimatedDays: accountDeletionEstimatedDays,
	})
}
