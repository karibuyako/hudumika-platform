package api

// CUSTOMER WITHDRAWALS surface (API-CONTRACT.yaml /wallet/withdrawals/me,
// consumer docs/CONTRACT-ADDITIONS.md "Wallet withdrawals"): the session
// user's cash-out request ledger. Merchant/provider/rider withdrawals live on
// payout_entries (wallet.go); CUSTOMER requests have their own table
// (migrations/00068_withdrawals.sql customer_withdrawals — the wallet is a
// projection of ledger_entries and has no wallet_transactions table), read
// here newest first. The contract defines no query parameters for this
// route, so the optional knobs are read from the raw query string following
// ListWithdrawals (wallet.go): limit caps the page (default 20, clamped to
// 50) and cursor continues from a previous X-Next-Cursor (the same
// id-only keyset cursor as the wallet lists). An empty array (never null)
// when the user has none. The stored 'completed' status projects as the
// contract's 'paid' (completed_at → paidAt).

import (
	"fmt"
	"net/http"
	"strconv"
	"time"

	"github.com/google/uuid"

	"github.com/hudumika/api-backend/internal/gen"
)

// customerWithdrawalRow is one customer_withdrawals row in list order.
type customerWithdrawalRow struct {
	ID          uuid.UUID
	AmountTZS   int64
	Method      string
	Status      string
	CreatedAt   time.Time
	CompletedAt *time.Time
}

// customerWithdrawalStatus maps the stored status onto the contract enum:
// 'completed' projects as 'paid' (the contract has no completed value),
// pending/processing/failed map verbatim.
func customerWithdrawalStatus(status string) gen.WithdrawalStatus {
	if status == "completed" {
		return gen.WithdrawalStatusPaid
	}
	return gen.WithdrawalStatus(status)
}

// customerWithdrawalToContract maps a row onto the contract Withdrawal. fee,
// estimatedArrivalDays and reason are omitted: the customer request ledger
// carries no fee or ETA and there is no rejection-reason flow yet.
func customerWithdrawalToContract(wd customerWithdrawalRow) gen.Withdrawal {
	method := wd.Method
	return gen.Withdrawal{
		Id:        newUUID(wd.ID.String()),
		AmountTZS: int(wd.AmountTZS),
		Method:    &method,
		Status:    customerWithdrawalStatus(wd.Status),
		PaidAt:    wd.CompletedAt,
		CreatedAt: wd.CreatedAt,
	}
}

// ListMyWithdrawals returns the session user's customer withdrawal requests
// (GET /wallet/withdrawals/me), newest first, as an array of Withdrawal — []
// when the user has none. limit (default 20, max 50) and cursor come from
// the query string; the next page, when one exists, is advertised in
// X-Next-Cursor (same keyset convention as ListWithdrawals in wallet.go,
// reusing its id-only cursor codecs).
func (s *Server) ListMyWithdrawals(w http.ResponseWriter, r *http.Request) {
	user, _, ok := s.customerUser(w, r)
	if !ok {
		return
	}

	limit := defaultWithdrawalListLimit
	if raw := r.URL.Query().Get("limit"); raw != "" {
		if n, err := strconv.Atoi(raw); err == nil && n > 0 {
			limit = n
			if limit > maxWithdrawalListLimit {
				limit = maxWithdrawalListLimit
			}
		}
	}
	cursor := r.URL.Query().Get("cursor")

	query := `SELECT id, amount_tzs, method, status, created_at, completed_at
	          FROM customer_withdrawals WHERE user_id = $1`
	args := []any{user.ID}
	if cursor != "" {
		id, err := decodeWalletCursor(cursor)
		if err != nil {
			writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "cursor is invalid")
			return
		}
		args = append(args, id)
		query += fmt.Sprintf(` AND (created_at, id) < (SELECT created_at, id FROM customer_withdrawals WHERE id = $%d)`, len(args))
	}
	args = append(args, limit+1)
	query += fmt.Sprintf(" ORDER BY created_at DESC, id DESC LIMIT $%d", len(args))

	rows, err := s.db.Pool().Query(r.Context(), query, args...)
	if err != nil {
		s.logger.Error("customer withdrawals failed", "user", user.ID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer rows.Close()

	out := make([]gen.Withdrawal, 0, limit)
	var (
		last     customerWithdrawalRow
		sentinel bool
	)
	for rows.Next() {
		var e customerWithdrawalRow
		if err := rows.Scan(&e.ID, &e.AmountTZS, &e.Method, &e.Status, &e.CreatedAt, &e.CompletedAt); err != nil {
			s.logger.Error("customer withdrawal scan failed", "user", user.ID, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		if len(out) == limit {
			sentinel = true
			continue
		}
		out = append(out, customerWithdrawalToContract(e))
		last = e
	}
	if err := rows.Err(); err != nil {
		s.logger.Error("customer withdrawals iterate failed", "user", user.ID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if sentinel {
		w.Header().Set("X-Next-Cursor", encodeWalletCursor(last.ID))
	}
	writeJSON(w, http.StatusOK, out)
}