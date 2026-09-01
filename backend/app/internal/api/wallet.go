package api

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/hudumika/api-backend/internal/auth"
	"github.com/hudumika/api-backend/internal/gen"
)

// Wallet rules (backend/PAYOUTS-LEDGER.md, backend/ERROR-CODES.md "Wallet
// and withdrawals"). The wallet is a projection of the immutable ledger
// (ledger_entries); it never stores balances and never writes the ledger
// except through withdrawals, which always land the ledger debit and the
// payout entry in one transaction.
const (
	// withdrawalMinimumTZS is the smallest cash-out amount (422
	// WITHDRAWAL_BELOW_MINIMUM below it).
	// Deprecated: use GetSettings().WithdrawalMinimumTZS instead.
	// withdrawalDailyLimit and withdrawalRateWindow bound cash-outs per
	// earner to 3 per rolling 24h (429 WITHDRAWAL_RATE_LIMITED).
	// Deprecated: use GetSettings().WithdrawalDailyLimit and GetSettings().WithdrawalRateWindowHours instead.
	withdrawalDefaultMethod = "bank" // contract sends no method; payout_account resolves it later
	defaultCustomerTxLimit  = 50     // contract default for /wallet/me/transactions
	defaultMerchantTxLimit  = 20     // contract default for /wallet/transactions
	maxWalletTxLimit        = 100
	// defaultWithdrawalListLimit and maxWithdrawalListLimit bound the
	// /wallet/withdrawals page size (same defaults as /payouts/me).
	defaultWithdrawalListLimit = 20
	maxWithdrawalListLimit     = 50
)

// walletEarnerRoles are the roles with an earner ledger account. The RBAC
// middleware already restricts /wallet/* to them (rbac.go); the check is
// repeated defensively so direct-handler callers cannot reach the ledger.
var walletEarnerRoles = map[string]bool{
	RoleMerchant: true, RoleProvider: true, RoleRider: true,
}

// errWithdrawalInsufficient is returned by walletStore.createWithdrawal when
// the requested amount exceeds the withdrawable balance; the handler maps it
// to 409 WALLET_INSUFFICIENT_BALANCE.
var errWithdrawalInsufficient = errors.New("wallet: withdrawal exceeds withdrawable balance")

// errInvalidWalletCursor is returned by walletStore.listEntries when the
// keyset cursor does not decode to a ledger entry id; the handler maps it to
// 422 VALIDATION_FAILED.
var errInvalidWalletCursor = errors.New("wallet: invalid pagination cursor")

// walletUser resolves the authenticated subject (JWT subject = phone) to the
// users row. A missing database is a 500: money lookups must never degrade
// into a 404 (same convention as paymentUser in payments.go).
func (s *Server) walletUser(w http.ResponseWriter, r *http.Request) (*auth.UserRow, *Claims, bool) {
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
		s.logger.Error("wallet user lookup failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return nil, nil, false
	}
	if user == nil {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "User not found")
		return nil, nil, false
	}
	return user, claims, true
}

// walletStore owns the wallet's read-only ledger projections and the single
// write path (createWithdrawal). It only ever READS ledger_entries and
// payout_entries; the withdrawal transaction is the only writer, and it
// appends the ledger debit and the payout entry atomically.
type walletStore struct {
	pool *pgxpool.Pool
}

func (s *Server) walletStore() *walletStore {
	return &walletStore{pool: s.db.Pool()}
}

// projection reads the owner's ledger balance (running balance of the last
// entry, 0 when the owner has none) and the pending payout sum (payout
// entries in pending or processing).
func (w *walletStore) projection(ctx context.Context, ownerID uuid.UUID) (balance, pending int64, err error) {
	err = w.pool.QueryRow(ctx,
		`SELECT balance_tzs FROM ledger_entries
		 WHERE account_owner_id = $1
		 ORDER BY created_at DESC, id DESC LIMIT 1`,
		ownerID).Scan(&balance)
	if errors.Is(err, pgx.ErrNoRows) {
		balance = 0
	} else if err != nil {
		return 0, 0, fmt.Errorf("wallet: read balance for %s: %w", ownerID, err)
	}
	if err := w.pool.QueryRow(ctx,
		`SELECT COALESCE(SUM(amount_tzs), 0) FROM payout_entries
		 WHERE owner_id = $1 AND status IN ('pending', 'processing')`,
		ownerID).Scan(&pending); err != nil {
		return 0, 0, fmt.Errorf("wallet: read pending payouts for %s: %w", ownerID, err)
	}
	return balance, pending, nil
}

// toWallet maps the ledger projection onto the contract Wallet: totalTZS is
// the ledger balance, withdrawableTZS is the balance minus pending payouts,
// and pendingTZS is omitted when nothing is pending.
func toWallet(balance, pending int64) gen.Wallet {
	out := gen.Wallet{
		TotalTZS:        int(balance),
		WithdrawableTZS: int(balance - pending),
	}
	if pending > 0 {
		p := int(pending)
		out.PendingTZS = &p
	}
	return out
}

// GetMyWallet returns the customer wallet projection for the session user
// (GET /wallet/me): totalTZS = ledger balance, withdrawableTZS = balance
// minus pending payouts. The balance is always read from ledger_entries —
// the wallet is a projection, never a stored value.
func (s *Server) GetMyWallet(w http.ResponseWriter, r *http.Request) {
	s.getWallet(w, r)
}

// GetMerchantWallet returns the merchant wallet projection for the session
// user (GET /wallet), with the same ledger semantics as GetMyWallet.
func (s *Server) GetMerchantWallet(w http.ResponseWriter, r *http.Request) {
	s.getWallet(w, r)
}

func (s *Server) getWallet(w http.ResponseWriter, r *http.Request) {
	user, _, ok := s.walletUser(w, r)
	if !ok {
		return
	}
	balance, pending, err := s.walletStore().projection(r.Context(), user.ID)
	if err != nil {
		s.logger.Error("wallet projection failed", "user", user.ID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, toWallet(balance, pending))
}

// walletEntry is one ledger row in wallet projection order (newest first).
type walletEntry struct {
	ID            uuid.UUID
	Type          string
	AmountTZS     int64
	BalanceTZS    int64
	ReferenceType *string
	ReferenceID   *uuid.UUID
	CreatedAt     time.Time
}

// listEntries returns the owner's ledger entries, newest first, keyset-
// paginated on (created_at, id). The cursor is the base64url id of the last
// row of the previous page; next is the cursor of the following page, or ""
// when this is the last page. A malformed cursor yields
// errInvalidWalletCursor.
func (w *walletStore) listEntries(ctx context.Context, ownerID uuid.UUID, limit int, cursor string) ([]walletEntry, string, error) {
	query := `SELECT id, type, amount_tzs, balance_tzs, reference_type, reference_id, created_at
	          FROM ledger_entries WHERE account_owner_id = $1`
	args := []any{ownerID}
	if cursor != "" {
		id, err := decodeWalletCursor(cursor)
		if err != nil {
			return nil, "", err
		}
		args = append(args, id)
		query += ` AND (created_at, id) < (SELECT created_at, id FROM ledger_entries WHERE id = $2)`
	}
	args = append(args, limit+1)
	query += fmt.Sprintf(" ORDER BY created_at DESC, id DESC LIMIT $%d", len(args))

	rows, err := w.pool.Query(ctx, query, args...)
	if err != nil {
		return nil, "", fmt.Errorf("wallet: list entries for %s: %w", ownerID, err)
	}
	defer rows.Close()

	out := make([]walletEntry, 0, limit)
	var (
		last     walletEntry
		sentinel bool
	)
	for rows.Next() {
		var e walletEntry
		if err := rows.Scan(&e.ID, &e.Type, &e.AmountTZS, &e.BalanceTZS,
			&e.ReferenceType, &e.ReferenceID, &e.CreatedAt); err != nil {
			return nil, "", fmt.Errorf("wallet: scan entry: %w", err)
		}
		if len(out) == limit {
			sentinel = true
			continue
		}
		out = append(out, e)
		last = e
	}
	if err := rows.Err(); err != nil {
		return nil, "", fmt.Errorf("wallet: iterate entries: %w", err)
	}
	next := ""
	if sentinel {
		next = encodeWalletCursor(last.ID)
	}
	return out, next, nil
}

// toWalletTransaction maps a ledger row onto the contract WalletTransaction.
func toWalletTransaction(e walletEntry) gen.WalletTransaction {
	var refID *string
	if e.ReferenceID != nil {
		v := e.ReferenceID.String()
		refID = &v
	}
	return gen.WalletTransaction{
		Id:            newUUID(e.ID.String()),
		Type:          toWalletTransactionType(e.Type),
		AmountTZS:     int(e.AmountTZS),
		BalanceTZS:    int(e.BalanceTZS),
		ReferenceType: e.ReferenceType,
		ReferenceId:   refID,
		CreatedAt:     e.CreatedAt,
	}
}

// toWalletTransactionType maps ledger entry types onto the contract enum:
// earnings types (order_earning, booking_earning, delivery_fee, commission,
// bonus) project as "settlement", "payout" as "withdrawal".
func toWalletTransactionType(t string) gen.WalletTransactionType {
	switch t {
	case "payout":
		return gen.WalletTransactionTypeWithdrawal
	case "refund":
		return gen.WalletTransactionTypeRefund
	case "adjustment":
		return gen.WalletTransactionTypeAdjustment
	default:
		return gen.WalletTransactionTypeSettlement
	}
}

// encodeWalletCursor packs a ledger entry id into a URL-safe base64 cursor;
// decodeWalletCursor is its inverse.
func encodeWalletCursor(id uuid.UUID) string {
	return base64.RawURLEncoding.EncodeToString([]byte(id.String()))
}

func decodeWalletCursor(cursor string) (uuid.UUID, error) {
	raw, err := base64.RawURLEncoding.DecodeString(cursor)
	if err != nil {
		return uuid.Nil, fmt.Errorf("wallet: decode cursor: %w", err)
	}
	id, err := uuid.Parse(string(raw))
	if err != nil {
		return uuid.Nil, fmt.Errorf("wallet: parse cursor id: %w", err)
	}
	return id, nil
}

// GetMyWalletTransactions returns the customer's ledger entries (GET
// /wallet/me/transactions), keyset-paginated with the next page in
// X-Next-Cursor; an empty array (never null) when the user has none.
func (s *Server) GetMyWalletTransactions(w http.ResponseWriter, r *http.Request, params gen.GetMyWalletTransactionsParams) {
	s.listWalletTransactions(w, r, defaultCustomerTxLimit, params.Limit, params.Cursor)
}

// ListWalletTransactions returns the merchant's ledger entries (GET
// /wallet/transactions), same shape as GetMyWalletTransactions.
func (s *Server) ListWalletTransactions(w http.ResponseWriter, r *http.Request, params gen.ListWalletTransactionsParams) {
	s.listWalletTransactions(w, r, defaultMerchantTxLimit, params.Limit, params.Cursor)
}

func (s *Server) listWalletTransactions(w http.ResponseWriter, r *http.Request, fallback int, limitPtr *int, cursorPtr *string) {
	user, _, ok := s.walletUser(w, r)
	if !ok {
		return
	}
	limit := fallback
	if limitPtr != nil && *limitPtr > 0 {
		limit = *limitPtr
		if limit > maxWalletTxLimit {
			limit = maxWalletTxLimit
		}
	}
	cursor := ""
	if cursorPtr != nil {
		cursor = *cursorPtr
	}

	entries, next, err := s.walletStore().listEntries(r.Context(), user.ID, limit, cursor)
	if err != nil {
		if errors.Is(err, errInvalidWalletCursor) {
			writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "cursor is invalid")
			return
		}
		s.logger.Error("wallet transactions failed", "user", user.ID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if next != "" {
		w.Header().Set("X-Next-Cursor", next)
	}
	out := make([]gen.WalletTransaction, 0, len(entries))
	for _, e := range entries {
		out = append(out, toWalletTransaction(e))
	}
	writeJSON(w, http.StatusOK, out)
}

// walletTopUpMinimumTZS is the smallest wallet top-up amount (422
// VALIDATION_FAILED below it). The contract only documents minimum 1; the
// 1000 TZS floor matches the QR wallet-intent floor and keeps top-ups
// above the smallest provider tariff.
// Deprecated: use GetSettings().WalletTopupMinimumTZS instead.

// TopUpMyWallet starts a wallet top-up (POST /wallet/me/top-up): it creates
// an order-less payment intent (order_id NULL — payments.Store now supports
// intents without an order) for the session user and responds with the
// PaymentIntent. The client then drives the provider flow: the STK push is
// enqueued best-effort, and /payments/{intentId}/confirm moves the intent
// from created to pending where the provider needs it. Payment intents can
// only be listed through their order, so top-up history is not surfaced by
// /payments/history yet (documented limitation, payments.Store.ListMyIntents).
//
// DEVIATION from the contract: the contract documents a 202 + Wallet body.
// The response is a PaymentIntent instead — the wallet is a projection of
// the immutable ledger and has no top-up entry to project until the intent
// is paid, so a Wallet body would report stale balances. The 202 status
// code is kept.
//
// Client rules, in evaluation order (matching the withdrawal handler's
// documented order in this file):
//
//  1. body validation (amountTZS >= 1 per contract, method in the contract
//     enum) — client errors never touch the database;
//  2. the user is resolved DB-gated, so with no database a well-formed
//     top-up answers the uniform 500/404/401 envelope;
//  3. the Idempotency-Key header is required (422 VALIDATION_FAILED) — the
//     middleware replays duplicates, this check guards direct callers;
//  4. amountTZS must be at least 1000 (422 VALIDATION_FAILED).
func (s *Server) TopUpMyWallet(w http.ResponseWriter, r *http.Request) {
	var body gen.TopUpMyWalletJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if body.AmountTZS < 1 {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "amountTZS must be positive")
		return
	}
	if !body.Method.Valid() {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "method is invalid")
		return
	}

	user, _, ok := s.walletUser(w, r)
	if !ok {
		return
	}

	key := r.Header.Get("Idempotency-Key")
	if key == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Idempotency-Key header is required")
		return
	}
	if int64(body.AmountTZS) < GetSettings().WalletTopupMinimumTZS {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED",
			fmt.Sprintf("Minimum top-up is %d TZS", GetSettings().WalletTopupMinimumTZS))
		return
	}

	intent, err := s.paymentStore().CreateWalletIntent(r.Context(), string(body.Method),
		int64(body.AmountTZS), sha256Hex(user.Phone+"|"+key))
	if err != nil {
		s.logger.Error("wallet top-up intent create failed", "user", user.ID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	s.enqueueStkPush(r.Context(), user.Phone, intent)
	writeJSON(w, http.StatusAccepted, toPaymentIntent(&intent))
}

// walletWithdrawal is one payout_entries row created by RequestWithdrawal.
type walletWithdrawal struct {
	ID        uuid.UUID
	AmountTZS int64
	Method    string
	Status    string
	Reason    *string
	PaidAt    *time.Time
	CreatedAt time.Time
}

// createWithdrawal appends the 'payout' ledger debit and the matching
// payout_entries row (status pending) in ONE transaction, joining today's
// payout batch (created on demand; payout_batches.cycle is UNIQUE per day).
// A per-owner advisory lock serializes concurrent withdrawals so the running
// balance is exact under concurrency. Returns errWithdrawalInsufficient when
// the amount exceeds the withdrawable balance (balance minus pending
// payouts); that check happens inside the transaction so it cannot race a
// concurrent withdrawal.
func (w *walletStore) createWithdrawal(ctx context.Context, ownerID uuid.UUID, accountType string, amountTZS int64, now time.Time) (walletWithdrawal, error) {
	tx, err := w.pool.Begin(ctx)
	if err != nil {
		return walletWithdrawal{}, fmt.Errorf("wallet: begin withdrawal tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Serialize every withdrawal for the owner; the lock lives for the
	// transaction and is released on commit or rollback (same pattern as
	// payouts.Store.AppendEntry).
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext($1))`, ownerID.String()); err != nil {
		return walletWithdrawal{}, fmt.Errorf("wallet: lock owner %s: %w", ownerID, err)
	}

	var balance int64
	err = tx.QueryRow(ctx,
		`SELECT balance_tzs FROM ledger_entries
		 WHERE account_owner_id = $1
		 ORDER BY created_at DESC, id DESC LIMIT 1`,
		ownerID).Scan(&balance)
	if errors.Is(err, pgx.ErrNoRows) {
		balance = 0
	} else if err != nil {
		return walletWithdrawal{}, fmt.Errorf("wallet: read balance for %s: %w", ownerID, err)
	}
	var pending int64
	if err := tx.QueryRow(ctx,
		`SELECT COALESCE(SUM(amount_tzs), 0) FROM payout_entries
		 WHERE owner_id = $1 AND status IN ('pending', 'processing')`,
		ownerID).Scan(&pending); err != nil {
		return walletWithdrawal{}, fmt.Errorf("wallet: read pending payouts for %s: %w", ownerID, err)
	}
	if amountTZS > balance-pending {
		return walletWithdrawal{}, errWithdrawalInsufficient
	}

	// payout_entries.batch_id is NOT NULL and payout_batches.cycle is
	// UNIQUE: withdrawals accumulate into the day's batch, created on first
	// withdrawal of the day (the nightly settlement worker reconciles from
	// pending entries).
	cycle := now.Format("2006-01-02")
	if _, err := tx.Exec(ctx,
		`INSERT INTO payout_batches (cycle) VALUES ($1) ON CONFLICT (cycle) DO NOTHING`, cycle); err != nil {
		return walletWithdrawal{}, fmt.Errorf("wallet: ensure batch %q: %w", cycle, err)
	}
	var batchID uuid.UUID
	if err := tx.QueryRow(ctx, `SELECT id FROM payout_batches WHERE cycle = $1`, cycle).Scan(&batchID); err != nil {
		return walletWithdrawal{}, fmt.Errorf("wallet: resolve batch %q: %w", cycle, err)
	}

	// The ledger entry and the payout entry share the id: the ledger row
	// references the payout row, and the idempotency key derives from the
	// same uuid so a replay is impossible.
	entryID := uuid.New()
	newBalance := balance - amountTZS
	if _, err := tx.Exec(ctx,
		`INSERT INTO ledger_entries (account_owner_id, account_type, type, amount_tzs, balance_tzs, reference_type, reference_id, idempotency_key)
		 VALUES ($1, $2, 'payout', $3, $4, 'payout', $5, $6)`,
		ownerID, accountType, -amountTZS, newBalance, entryID, "withdrawal:"+entryID.String()); err != nil {
		return walletWithdrawal{}, fmt.Errorf("wallet: append payout debit for %s: %w", ownerID, err)
	}
	var createdAt time.Time
	if err := tx.QueryRow(ctx,
		`INSERT INTO payout_entries (id, batch_id, owner_id, amount_tzs, method, status)
		 VALUES ($1, $2, $3, $4, $5, 'pending')
		 RETURNING created_at`,
		entryID, batchID, ownerID, amountTZS, withdrawalDefaultMethod).Scan(&createdAt); err != nil {
		return walletWithdrawal{}, fmt.Errorf("wallet: insert payout entry for %s: %w", ownerID, err)
	}
	if _, err := tx.Exec(ctx,
		`UPDATE payout_batches SET total_tzs = total_tzs + $1, count = count + 1 WHERE id = $2`,
		amountTZS, batchID); err != nil {
		return walletWithdrawal{}, fmt.Errorf("wallet: bump batch %s: %w", batchID, err)
	}

	if err := tx.Commit(ctx); err != nil {
		return walletWithdrawal{}, fmt.Errorf("wallet: commit withdrawal for %s: %w", ownerID, err)
	}
	return walletWithdrawal{
		ID:        entryID,
		AmountTZS: amountTZS,
		Method:    withdrawalDefaultMethod,
		Status:    "pending",
		CreatedAt: createdAt,
	}, nil
}

// toWithdrawal maps a payout row onto the contract Withdrawal.
func toWithdrawal(wd walletWithdrawal) gen.Withdrawal {
	method := wd.Method
	return gen.Withdrawal{
		Id:        newUUID(wd.ID.String()),
		AmountTZS: int(wd.AmountTZS),
		Method:    &method,
		Status:    gen.WithdrawalStatus(wd.Status),
		Reason:    wd.Reason,
		PaidAt:    wd.PaidAt,
		CreatedAt: wd.CreatedAt,
	}
}

// RequestWithdrawal cashes out part of the merchant/provider/rider wallet
// (POST /wallet/withdrawals). Rules, in evaluation order:
//
//  1. The daily budget (3 per rolling 24h, keyed by session subject) is
//     consumed by every attempt — success or rejection — so the 4th request
//     of the day is limited no matter what it asks for (429
//     WITHDRAWAL_RATE_LIMITED). The budget is checked before the amount
//     rules by design.
//  2. amounts below 5000 TZS are rejected (422 WITHDRAWAL_BELOW_MINIMUM).
//  3. amounts above the withdrawable balance (ledger balance minus pending
//     payouts) are rejected inside the write transaction (409
//     WALLET_INSUFFICIENT_BALANCE).
//
// The body is validated first (client errors never touch the database); the
// user is then resolved DB-gated — so with no database a withdrawal answers
// 500 before any amount rule runs. A successful withdrawal appends the
// ledger debit ('payout', negative) and the payout entry (status pending)
// atomically — the wallet never writes the ledger outside this transaction.
func (s *Server) RequestWithdrawal(w http.ResponseWriter, r *http.Request) {
	claims, ok := ClaimsFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing or invalid bearer token")
		return
	}
	if !walletEarnerRoles[claims.Role] {
		writeError(w, http.StatusForbidden, "FORBIDDEN", "This role is not permitted on this route")
		return
	}

	var body gen.RequestWithdrawalJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	amountTZS := int64(body.AmountTZS)

	user, _, ok := s.walletUser(w, r)
	if !ok {
		return
	}

	withdrawalDailyLimit := int64(GetSettings().WithdrawalDailyLimit)
	withdrawalRateWindow := time.Duration(GetSettings().WithdrawalRateWindowHours) * time.Hour
	decision, err := s.stores.Rate.Allow(r.Context(), "withdraw:"+claims.Subject, withdrawalDailyLimit, withdrawalRateWindow, time.Now())
	if err != nil {
		s.logger.Error("withdrawal rate limit check failed", "user", user.ID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if !decision.Allowed {
		s.logger.Warn("withdrawal rate limited", "user", user.ID)
		writeRateLimitHeaders(w, withdrawalDailyLimit, 0, decision.RetryAfter)
		writeErrorWithRetry(w, http.StatusTooManyRequests, "WITHDRAWAL_RATE_LIMITED",
			"Daily withdrawal limit reached", int(decision.RetryAfter.Seconds()))
		return
	}
	writeRateLimitHeaders(w, withdrawalDailyLimit, rateLimitRemaining(decision, withdrawalDailyLimit), withdrawalRateWindow)
	withdrawalMinimum := GetSettings().WithdrawalMinimumTZS
	if amountTZS < withdrawalMinimum {
		writeError(w, http.StatusUnprocessableEntity, "WITHDRAWAL_BELOW_MINIMUM",
			fmt.Sprintf("Minimum withdrawal is %d TZS", withdrawalMinimum))
		return
	}

	wd, err := s.walletStore().createWithdrawal(r.Context(), user.ID, claims.Role, amountTZS, time.Now())
	if errors.Is(err, errWithdrawalInsufficient) {
		writeError(w, http.StatusConflict, "WALLET_INSUFFICIENT_BALANCE", "Withdrawal exceeds the withdrawable balance")
		return
	}
	if err != nil {
		s.logger.Error("withdrawal failed", "user", user.ID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusCreated, toWithdrawal(wd))
}

// listWithdrawals returns the owner's payout entries (all created by
// RequestWithdrawal), newest first, optionally filtered by status, keyset-
// paginated on (created_at, id) with the same id-only cursor as listEntries
// (the subquery resolves the row's (created_at, id) pair). next is the
// cursor of the following page, or "" when this is the last page. A
// malformed cursor yields errInvalidWalletCursor.
func (w *walletStore) listWithdrawals(ctx context.Context, ownerID uuid.UUID, status *string, limit int, cursor string) ([]walletWithdrawal, string, error) {
	query := `SELECT id, amount_tzs, method, status, reason, created_at, paid_at
	          FROM payout_entries WHERE owner_id = $1`
	args := []any{ownerID}
	if status != nil {
		args = append(args, *status)
		query += fmt.Sprintf(" AND status = $%d", len(args))
	}
	if cursor != "" {
		id, err := decodeWalletCursor(cursor)
		if err != nil {
			return nil, "", errInvalidWalletCursor
		}
		args = append(args, id)
		query += fmt.Sprintf(` AND (created_at, id) < (SELECT created_at, id FROM payout_entries WHERE id = $%d)`, len(args))
	}
	args = append(args, limit+1)
	query += fmt.Sprintf(" ORDER BY created_at DESC, id DESC LIMIT $%d", len(args))

	rows, err := w.pool.Query(ctx, query, args...)
	if err != nil {
		return nil, "", fmt.Errorf("wallet: list withdrawals for %s: %w", ownerID, err)
	}
	defer rows.Close()

	out := make([]walletWithdrawal, 0, limit)
	var (
		last     walletWithdrawal
		sentinel bool
	)
	for rows.Next() {
		var e walletWithdrawal
		if err := rows.Scan(&e.ID, &e.AmountTZS, &e.Method, &e.Status, &e.Reason, &e.CreatedAt, &e.PaidAt); err != nil {
			return nil, "", fmt.Errorf("wallet: scan withdrawal: %w", err)
		}
		if len(out) == limit {
			sentinel = true
			continue
		}
		out = append(out, e)
		last = e
	}
	if err := rows.Err(); err != nil {
		return nil, "", fmt.Errorf("wallet: iterate withdrawals: %w", err)
	}
	next := ""
	if sentinel {
		next = encodeWalletCursor(last.ID)
	}
	return out, next, nil
}

// ListWithdrawals returns the session user's withdrawal history (GET
// /wallet/withdrawals), newest first, as an array of Withdrawal — [] when
// the user has none. The contract defines no query parameters for this
// route, so the optional knobs are read from the raw query string: status
// filters to one payout status value (anything else is 422
// VALIDATION_FAILED), limit caps the page (default 20, clamped to 50) and
// cursor continues from a previous X-Next-Cursor. The next page, when one
// exists, is advertised in X-Next-Cursor.
func (s *Server) ListWithdrawals(w http.ResponseWriter, r *http.Request) {
	user, _, ok := s.walletUser(w, r)
	if !ok {
		return
	}

	var status *string
	if raw := r.URL.Query().Get("status"); raw != "" {
		if !gen.WithdrawalStatus(raw).Valid() {
			writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "status is invalid")
			return
		}
		status = &raw
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

	rows, next, err := s.walletStore().listWithdrawals(r.Context(), user.ID, status, limit, cursor)
	if err != nil {
		if errors.Is(err, errInvalidWalletCursor) {
			writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "cursor is invalid")
			return
		}
		s.logger.Error("wallet withdrawals failed", "user", user.ID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if next != "" {
		w.Header().Set("X-Next-Cursor", next)
	}
	out := make([]gen.Withdrawal, 0, len(rows))
	for _, e := range rows {
		out = append(out, toWithdrawal(e))
	}
	writeJSON(w, http.StatusOK, out)
}
