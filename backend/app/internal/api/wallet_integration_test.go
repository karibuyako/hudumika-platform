//go:build integration

// Wallet bounded context integration tests against real PostgreSQL + Redis.
//
//	cd app && go test -tags integration ./internal/api/ -run 'Wallet' -count=1
//
// The wallet is a projection of the immutable ledger, so this suite NEVER
// truncates ledger_entries, payout_batches or payout_entries (those tables
// are owned by the payouts context, which truncates them in its own suite).
// Every row this suite inserts uses a unique owner id / phone and is deleted
// at cleanup: payout_entries and ledger_entries by owner, users by phone
// prefix. The ledger tables may not exist yet when this suite starts (they
// arrive with the payouts context's migration 00010): the setup polls for
// ledger_entries every 5s for up to 240s before any test runs.
package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/hudumika/api-backend/internal/gen"
)

// walletTestSetup wires a persistent server and waits for the payouts
// ledger tables to exist.
func walletTestSetup(t *testing.T) (*Server, *pgxpool.Pool) {
	t.Helper()
	s, pool := newPersistentServer(t)
	waitForLedgerTables(t, pool)
	return s, pool
}

// waitForLedgerTables polls to_regclass('public.ledger_entries') every 5s
// for up to 240s. The ledger arrives with migration 00010 from the payouts
// context; this suite runs against it and must not start early.
func waitForLedgerTables(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	deadline := time.Now().Add(240 * time.Second)
	for {
		var reg *string
		if err := pool.QueryRow(context.Background(),
			`SELECT to_regclass('public.ledger_entries')::text`).Scan(&reg); err != nil {
			t.Fatalf("ledger poll query: %v", err)
		}
		if reg != nil {
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("ledger_entries table did not appear within 240s (payouts migration 00010 missing?)")
		}
		time.Sleep(5 * time.Second)
	}
}

// walletUser inserts a users row with a per-run unique phone and registers
// cleanup that deletes ONLY this suite's rows (never a truncate).
func walletUser(t *testing.T, pool *pgxpool.Pool) (uuid.UUID, string) {
	t.Helper()
	ctx := context.Background()
	userID := uuid.New()
	phone := fmt.Sprintf("+2559%09d", time.Now().UnixNano()%1_000_000_000)
	if _, err := pool.Exec(ctx, `INSERT INTO users (id, phone) VALUES ($1, $2)`, userID, phone); err != nil {
		t.Fatalf("insert wallet user: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(ctx, `DELETE FROM payout_entries WHERE owner_id = $1`, userID)
		_, _ = pool.Exec(ctx, `DELETE FROM ledger_entries WHERE account_owner_id = $1`, userID)
		_, _ = pool.Exec(ctx, `DELETE FROM users WHERE id = $1`, userID)
	})
	return userID, phone
}

// ledgerSeed is one ledger_entries row to insert directly. created_at is
// explicit so ordering in tests is deterministic; zero yields now().
type ledgerSeed struct {
	entryType  string
	amountTZS  int64
	balanceTZS int64
	createdAt  time.Time
}

// seedLedger inserts ledger entries directly: this suite seeds the ledger
// because only withdrawals write it in production, and the wallet must be
// tested against a populated projection. The running balance is supplied per
// row — the ledger stores it, the wallet only reads it.
func seedLedger(t *testing.T, pool *pgxpool.Pool, ownerID uuid.UUID, accountType string, seeds []ledgerSeed) {
	t.Helper()
	for i, e := range seeds {
		createdAt := e.createdAt
		if createdAt.IsZero() {
			createdAt = time.Now().Add(time.Duration(i) * time.Millisecond)
		}
		if _, err := pool.Exec(context.Background(),
			`INSERT INTO ledger_entries (account_owner_id, account_type, type, amount_tzs, balance_tzs, reference_type, idempotency_key, created_at)
			 VALUES ($1, $2, $3, $4, $5, 'seed', $6, $7)`,
			ownerID, accountType, e.entryType, e.amountTZS, e.balanceTZS,
			"seed:"+uuid.NewString(), createdAt); err != nil {
			t.Fatalf("seed ledger entry %d: %v", i, err)
		}
	}
}

// ledgerBalance reads the running balance of the owner's last entry.
func ledgerBalance(t *testing.T, pool *pgxpool.Pool, ownerID uuid.UUID) int64 {
	t.Helper()
	var b int64
	if err := pool.QueryRow(context.Background(),
		`SELECT balance_tzs FROM ledger_entries WHERE account_owner_id = $1
		 ORDER BY created_at DESC, id DESC LIMIT 1`, ownerID).Scan(&b); err != nil {
		t.Fatalf("read ledger balance: %v", err)
	}
	return b
}

// decodeWallet parses the response body as the contract Wallet.
func decodeWallet(t *testing.T, rec *httptest.ResponseRecorder) gen.Wallet {
	t.Helper()
	var w gen.Wallet
	if err := json.NewDecoder(rec.Body).Decode(&w); err != nil {
		t.Fatalf("decode wallet body: %v (%s)", err, rec.Body)
	}
	return w
}

// TestWalletProjectionAndWithdrawals is the wallet end-to-end flow: the
// projection mirrors seeded ledger entries; a withdrawal lands the ledger
// debit and a pending payout entry atomically and moves the withdrawable
// balance; then insufficient, below-minimum and rate-limit rules fire.
func TestWalletProjectionAndWithdrawals(t *testing.T) {
	s, pool := walletTestSetup(t)
	userID, phone := walletUser(t, pool)
	token := tokenFor(t, s, phone, RoleMerchant, false)
	h := s.Router()

	// Ledger: order_earning +15000 then delivery_fee +2000 → balance 17000.
	seedLedger(t, pool, userID, "merchant", []ledgerSeed{
		{entryType: "order_earning", amountTZS: 15000, balanceTZS: 15000},
		{entryType: "delivery_fee", amountTZS: 2000, balanceTZS: 17000},
	})

	// Customer projection (GET /wallet/me) reflects the ledger exactly.
	rec := authedGET(t, h, "/wallet/me", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /wallet/me status = %d (%s)", rec.Code, rec.Body)
	}
	w := decodeWallet(t, rec)
	if w.TotalTZS != 17000 || w.WithdrawableTZS != 17000 {
		t.Fatalf("wallet = %+v, want total=17000 withdrawable=17000", w)
	}
	if w.PendingTZS != nil {
		t.Fatalf("pendingTZS = %d, want absent", *w.PendingTZS)
	}

	// Withdrawal of 5000 → 201, status pending.
	rec = authedRequest(t, h, http.MethodPost, "/wallet/withdrawals", token, `{"amountTZS":5000}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("withdrawal status = %d (%s)", rec.Code, rec.Body)
	}
	var wd gen.Withdrawal
	if err := json.NewDecoder(rec.Body).Decode(&wd); err != nil {
		t.Fatalf("decode withdrawal: %v", err)
	}
	if wd.Status != gen.WithdrawalStatusPending || wd.AmountTZS != 5000 || wd.Id.String() == "" {
		t.Fatalf("withdrawal = %+v, want pending 5000 with id", wd)
	}

	// The ledger balance fell to 12000 and a pending payout entry exists.
	if got := ledgerBalance(t, pool, userID); got != 12000 {
		t.Fatalf("ledger balance = %d, want 12000", got)
	}
	var payoutCount int
	if err := pool.QueryRow(context.Background(),
		`SELECT count(*) FROM payout_entries WHERE owner_id = $1 AND status = 'pending' AND amount_tzs = 5000`,
		userID).Scan(&payoutCount); err != nil {
		t.Fatalf("payout entry query: %v", err)
	}
	if payoutCount != 1 {
		t.Fatalf("pending payout entries = %d, want 1", payoutCount)
	}

	// Merchant projection: total 12000, 5000 pending → withdrawable 7000.
	rec = authedGET(t, h, "/wallet", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /wallet status = %d (%s)", rec.Code, rec.Body)
	}
	w = decodeWallet(t, rec)
	if w.TotalTZS != 12000 || w.WithdrawableTZS != 7000 {
		t.Fatalf("wallet = %+v, want total=12000 withdrawable=7000", w)
	}
	if w.PendingTZS == nil || *w.PendingTZS != 5000 {
		t.Fatalf("pendingTZS = %v, want 5000", w.PendingTZS)
	}

	// Amount above the withdrawable balance → 409 WALLET_INSUFFICIENT_BALANCE.
	rec = authedRequest(t, h, http.MethodPost, "/wallet/withdrawals", token, `{"amountTZS":12001}`)
	if rec.Code != http.StatusConflict {
		t.Fatalf("insufficient status = %d (%s)", rec.Code, rec.Body)
	}
	assertErrorCode(t, rec, "WALLET_INSUFFICIENT_BALANCE")

	// Below the 5000 minimum → 422 WITHDRAWAL_BELOW_MINIMUM.
	rec = authedRequest(t, h, http.MethodPost, "/wallet/withdrawals", token, `{"amountTZS":4000}`)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("below-minimum status = %d (%s)", rec.Code, rec.Body)
	}
	assertErrorCode(t, rec, "WITHDRAWAL_BELOW_MINIMUM")

	// The daily budget of 3 is consumed by every attempt, so the 4th request
	// of the day is rate limited no matter what it asks for.
	rec = authedRequest(t, h, http.MethodPost, "/wallet/withdrawals", token, `{"amountTZS":5000}`)
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("rate-limited status = %d (%s)", rec.Code, rec.Body)
	}
	assertErrorCode(t, rec, "WITHDRAWAL_RATE_LIMITED")
	if rec.Header().Get("Retry-After") == "" {
		t.Fatal("missing Retry-After header on rate limit")
	}

	// Nothing extra landed: still exactly one payout entry, balance 12000.
	if got := ledgerBalance(t, pool, userID); got != 12000 {
		t.Fatalf("ledger balance after rejected attempts = %d, want 12000", got)
	}
	if err := pool.QueryRow(context.Background(),
		`SELECT count(*) FROM payout_entries WHERE owner_id = $1`,
		userID).Scan(&payoutCount); err != nil {
		t.Fatalf("payout recount: %v", err)
	}
	if payoutCount != 1 {
		t.Fatalf("payout entries after rejected attempts = %d, want 1", payoutCount)
	}
}

// TestWalletTransactionsPagination: 25 ledger entries page as 20 + 5 with a
// keyset cursor, newest first; an empty wallet yields [] (never null).
func TestWalletTransactionsPagination(t *testing.T) {
	s, pool := walletTestSetup(t)
	userID, phone := walletUser(t, pool)
	token := tokenFor(t, s, phone, RoleMerchant, false)
	h := s.Router()

	base := time.Now().Add(-time.Hour)
	seeds := make([]ledgerSeed, 0, 25)
	for i := 1; i <= 25; i++ {
		seeds = append(seeds, ledgerSeed{
			entryType:  "order_earning",
			amountTZS:  int64(i * 1000),
			balanceTZS: int64(i * 1000),
			createdAt:  base.Add(time.Duration(i) * time.Second),
		})
	}
	seedLedger(t, pool, userID, "merchant", seeds)

	// First page: 20 of 25, newest first (entry 25 first), cursor present.
	rec := authedGET(t, h, "/wallet/me/transactions?limit=20", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("first page status = %d (%s)", rec.Code, rec.Body)
	}
	var page1 []gen.WalletTransaction
	if err := json.NewDecoder(rec.Body).Decode(&page1); err != nil {
		t.Fatalf("decode page 1: %v", err)
	}
	if len(page1) != 20 {
		t.Fatalf("page 1 length = %d, want 20", len(page1))
	}
	if page1[0].AmountTZS != 25000 || page1[0].BalanceTZS != 25000 {
		t.Fatalf("page 1 first entry = %+v, want amount=25000 balance=25000", page1[0])
	}
	if page1[0].Type != gen.WalletTransactionTypeSettlement {
		t.Fatalf("order_earning type = %q, want settlement", page1[0].Type)
	}
	cursor := rec.Header().Get("X-Next-Cursor")
	if cursor == "" {
		t.Fatal("missing X-Next-Cursor on first page")
	}

	// Second page: remaining 5, no next cursor.
	rec = authedGET(t, h, "/wallet/me/transactions?limit=20&cursor="+cursor, token)
	if rec.Code != http.StatusOK {
		t.Fatalf("second page status = %d (%s)", rec.Code, rec.Body)
	}
	var page2 []gen.WalletTransaction
	if err := json.NewDecoder(rec.Body).Decode(&page2); err != nil {
		t.Fatalf("decode page 2: %v", err)
	}
	if len(page2) != 5 {
		t.Fatalf("page 2 length = %d, want 5", len(page2))
	}
	if page2[4].AmountTZS != 1000 {
		t.Fatalf("page 2 last entry = %+v, want amount=1000", page2[4])
	}
	if rec.Header().Get("X-Next-Cursor") != "" {
		t.Fatal("unexpected X-Next-Cursor on last page")
	}

	// An empty wallet is [] — never null.
	_, emptyPhone := walletUser(t, pool)
	emptyToken := tokenFor(t, s, emptyPhone, RoleMerchant, false)
	rec = authedGET(t, h, "/wallet/transactions", emptyToken)
	if rec.Code != http.StatusOK {
		t.Fatalf("empty list status = %d (%s)", rec.Code, rec.Body)
	}
	if rec.Body.String() != "[]" {
		t.Fatalf("empty wallet body = %q, want []", rec.Body.String())
	}
}

// TestWalletProjectionAfterPayoutPaid: once the pending payout flips to
// 'paid' (the payout context's job does this), the pending sum drops to zero
// and the withdrawable balance returns to the ledger balance.
func TestWalletProjectionAfterPayoutPaid(t *testing.T) {
	s, pool := walletTestSetup(t)
	userID, phone := walletUser(t, pool)
	token := tokenFor(t, s, phone, RoleMerchant, false)
	h := s.Router()

	seedLedger(t, pool, userID, "merchant", []ledgerSeed{
		{entryType: "order_earning", amountTZS: 15000, balanceTZS: 15000},
		{entryType: "delivery_fee", amountTZS: 2000, balanceTZS: 17000},
	})

	rec := authedRequest(t, h, http.MethodPost, "/wallet/withdrawals", token, `{"amountTZS":5000}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("withdrawal status = %d (%s)", rec.Code, rec.Body)
	}
	var wd gen.Withdrawal
	if err := json.NewDecoder(rec.Body).Decode(&wd); err != nil {
		t.Fatalf("decode withdrawal: %v", err)
	}

	// Flip ONLY this suite's payout row to paid (the payouts context owns
	// the status machine; here we simulate its outcome).
	if _, err := pool.Exec(context.Background(),
		`UPDATE payout_entries SET status = 'paid', paid_at = now() WHERE id = $1 AND owner_id = $2`,
		wd.Id, userID); err != nil {
		t.Fatalf("flip payout to paid: %v", err)
	}

	rec = authedGET(t, h, "/wallet", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /wallet status = %d (%s)", rec.Code, rec.Body)
	}
	w := decodeWallet(t, rec)
	if w.TotalTZS != 12000 || w.WithdrawableTZS != 12000 {
		t.Fatalf("wallet after paid = %+v, want total=12000 withdrawable=12000", w)
	}
	if w.PendingTZS != nil {
		t.Fatalf("pendingTZS = %d, want absent after payout paid", *w.PendingTZS)
	}
}

// TestTopUpWalletCreatesIntent: with a live database the top-up endpoint
// creates an order-less payment intent (202 + PaymentIntent); the client
// then drives the provider flow via /payments/{intentId}/confirm. (Replaces
// the pre-PAYMENTS-EXTRA TestTopUpWalletNotImplemented, which asserted the
// 501 stub removed by the payments-extra milestone.)
func TestTopUpWalletCreatesIntent(t *testing.T) {
	s, pool := walletTestSetup(t)
	_, phone := walletUser(t, s.db.Pool())
	token := tokenFor(t, s, phone, RoleMerchant, false)
	h := s.Router()

	rec := payAuthedJSON(t, h, http.MethodPost, "/wallet/me/top-up", token,
		`{"amountTZS":10000,"method":"mpesa"}`, map[string]string{"Idempotency-Key": "wallet-itest-1"})
	if rec.Code != http.StatusAccepted {
		t.Fatalf("top-up status = %d, want 202 (%s)", rec.Code, rec.Body)
	}
	var pi gen.PaymentIntent
	if err := json.NewDecoder(rec.Body).Decode(&pi); err != nil {
		t.Fatalf("decode payment intent: %v (%s)", err, rec.Body)
	}
	if pi.Status != gen.PaymentIntentStatus("created") || pi.AmountTZS != 10000 {
		t.Fatalf("unexpected payment intent: %+v", pi)
	}
	intentID := uuid.UUID(pi.Id)
	t.Cleanup(func() {
		ctx := context.Background()
		_, _ = pool.Exec(ctx, `DELETE FROM payment_transactions WHERE intent_id = $1`, intentID)
		_, _ = pool.Exec(ctx, `DELETE FROM payment_intents WHERE id = $1`, intentID)
	})
	var orderID *uuid.UUID
	if err := pool.QueryRow(context.Background(),
		`SELECT order_id FROM payment_intents WHERE id = $1`, intentID).Scan(&orderID); err != nil {
		t.Fatalf("intent row: %v", err)
	}
	if orderID != nil {
		t.Fatalf("top-up intent has order_id %v, want NULL", orderID)
	}
}

// payoutSeed is one payout_entries row to insert directly, bypassing the
// withdrawal flow so statuses and ordering are deterministic. paid_at is set
// only for 'paid' rows; a zero createdAt yields now().
type payoutSeed struct {
	amountTZS int64
	status    string
	createdAt time.Time
}

// seedPayouts inserts payout entries directly, each under its own batch row
// (payout_batches.cycle is a UNIQUE date, so every batch gets its own
// far-future day; the random offset keeps parallel runs from colliding on
// the shared database). This suite's entries and batches are deleted at
// cleanup.
func seedPayouts(t *testing.T, pool *pgxpool.Pool, ownerID uuid.UUID, seeds []payoutSeed) {
	t.Helper()
	ctx := context.Background()
	var batchIDs []uuid.UUID
	// Cleanup is registered before seeding so a mid-loop failure still
	// removes the batches created so far.
	t.Cleanup(func() {
		_, _ = pool.Exec(ctx, `DELETE FROM payout_entries WHERE owner_id = $1`, ownerID)
		for _, b := range batchIDs {
			_, _ = pool.Exec(ctx, `DELETE FROM payout_batches WHERE id = $1`, b)
		}
	})
	for i, p := range seeds {
		createdAt := p.createdAt
		if createdAt.IsZero() {
			createdAt = time.Now().Add(time.Duration(i) * time.Millisecond)
		}
		cycle := time.Date(2100, time.January, 1, 0, 0, 0, 0, time.UTC).
			AddDate(0, 0, int(uuid.New().ID())%36525)
		var batchID uuid.UUID
		if err := pool.QueryRow(ctx,
			`INSERT INTO payout_batches (cycle) VALUES ($1) RETURNING id`, cycle).Scan(&batchID); err != nil {
			t.Fatalf("seed payout batch %d: %v", i, err)
		}
		batchIDs = append(batchIDs, batchID)
		var paidAt any
		if p.status == "paid" {
			paidAt = createdAt
		}
		if _, err := pool.Exec(ctx,
			`INSERT INTO payout_entries (batch_id, owner_id, amount_tzs, method, status, created_at, paid_at)
			 VALUES ($1, $2, $3, 'bank', $4, $5, $6)`,
			batchID, ownerID, p.amountTZS, p.status, createdAt, paidAt); err != nil {
			t.Fatalf("seed payout entry %d: %v", i, err)
		}
	}
}

// decodeWithdrawals parses the response body as an array of Withdrawal.
func decodeWithdrawals(t *testing.T, rec *httptest.ResponseRecorder) []gen.Withdrawal {
	t.Helper()
	var out []gen.Withdrawal
	if err := json.NewDecoder(rec.Body).Decode(&out); err != nil {
		t.Fatalf("decode withdrawals body: %v (%s)", err, rec.Body)
	}
	return out
}

// TestWithdrawalsListAndFilter: seeded payout entries list newest first with
// their statuses (paid rows carry paidAt); the status filter narrows the
// page; an unknown status is 422; another user's withdrawals never appear;
// an empty history is [] — never null.
func TestWithdrawalsListAndFilter(t *testing.T) {
	s, pool := walletTestSetup(t)
	userID, phone := walletUser(t, pool)
	token := tokenFor(t, s, phone, RoleMerchant, false)
	h := s.Router()

	base := time.Now().Add(-time.Hour)
	seedPayouts(t, pool, userID, []payoutSeed{
		{amountTZS: 5000, status: "pending", createdAt: base.Add(1 * time.Second)},
		{amountTZS: 7000, status: "paid", createdAt: base.Add(2 * time.Second)},
		{amountTZS: 9000, status: "processing", createdAt: base.Add(3 * time.Second)},
	})
	// Another user's withdrawals must stay invisible to the session user.
	otherID, otherPhone := walletUser(t, pool)
	otherToken := tokenFor(t, s, otherPhone, RoleMerchant, false)
	seedPayouts(t, pool, otherID, []payoutSeed{
		{amountTZS: 11111, status: "pending", createdAt: base.Add(1 * time.Minute)},
	})

	rec := authedGET(t, h, "/wallet/withdrawals", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("list status = %d (%s)", rec.Code, rec.Body)
	}
	rows := decodeWithdrawals(t, rec)
	if len(rows) != 3 {
		t.Fatalf("list length = %d, want 3 (%s)", len(rows), rec.Body)
	}
	if rows[0].AmountTZS != 9000 || rows[0].Status != gen.WithdrawalStatusProcessing {
		t.Fatalf("newest row = %+v, want processing 9000", rows[0])
	}
	if rows[2].AmountTZS != 5000 || rows[2].Status != gen.WithdrawalStatusPending {
		t.Fatalf("oldest row = %+v, want pending 5000", rows[2])
	}
	if rows[1].PaidAt == nil {
		t.Fatal("paid row missing paidAt")
	}

	// The status filter narrows the page to the paid row.
	rec = authedGET(t, h, "/wallet/withdrawals?status=paid", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("filtered status = %d (%s)", rec.Code, rec.Body)
	}
	rows = decodeWithdrawals(t, rec)
	if len(rows) != 1 || rows[0].AmountTZS != 7000 {
		t.Fatalf("paid filter = %+v, want the 7000 row (%s)", rows, rec.Body)
	}

	// An unknown status value is rejected with 422 VALIDATION_FAILED.
	rec = authedGET(t, h, "/wallet/withdrawals?status=bogus", token)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("bad status = %d, want 422 (%s)", rec.Code, rec.Body)
	}
	assertErrorCode(t, rec, "VALIDATION_FAILED")

	// The other user sees only their own withdrawal.
	rec = authedGET(t, h, "/wallet/withdrawals", otherToken)
	if rec.Code != http.StatusOK {
		t.Fatalf("other user list status = %d (%s)", rec.Code, rec.Body)
	}
	rows = decodeWithdrawals(t, rec)
	if len(rows) != 1 || rows[0].AmountTZS != 11111 {
		t.Fatalf("other user list = %+v, want only their 11111 row", rows)
	}

	// An empty history is [] — never null.
	_, emptyPhone := walletUser(t, pool)
	emptyToken := tokenFor(t, s, emptyPhone, RoleMerchant, false)
	rec = authedGET(t, h, "/wallet/withdrawals", emptyToken)
	if rec.Code != http.StatusOK {
		t.Fatalf("empty list status = %d (%s)", rec.Code, rec.Body)
	}
	if rec.Body.String() != "[]" {
		t.Fatalf("empty history body = %q, want []", rec.Body.String())
	}
}

// TestWithdrawalsListPagination: 25 payout entries page as 20 + 5 with a
// keyset cursor, newest first, and no overlap between pages; a malformed
// cursor is 422 VALIDATION_FAILED.
func TestWithdrawalsListPagination(t *testing.T) {
	s, pool := walletTestSetup(t)
	userID, phone := walletUser(t, pool)
	token := tokenFor(t, s, phone, RoleMerchant, false)
	h := s.Router()

	base := time.Now().Add(-time.Hour)
	seeds := make([]payoutSeed, 0, 25)
	for i := 1; i <= 25; i++ {
		seeds = append(seeds, payoutSeed{
			amountTZS: int64(i * 1000),
			status:    "pending",
			createdAt: base.Add(time.Duration(i) * time.Second),
		})
	}
	seedPayouts(t, pool, userID, seeds)

	// First page: 20 of 25, newest first (25000 first), cursor present.
	rec := authedGET(t, h, "/wallet/withdrawals?limit=20", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("first page status = %d (%s)", rec.Code, rec.Body)
	}
	page1 := decodeWithdrawals(t, rec)
	if len(page1) != 20 {
		t.Fatalf("page 1 length = %d, want 20 (%s)", len(page1), rec.Body)
	}
	if page1[0].AmountTZS != 25000 {
		t.Fatalf("page 1 first = %+v, want amount 25000", page1[0])
	}
	cursor := rec.Header().Get("X-Next-Cursor")
	if cursor == "" {
		t.Fatal("missing X-Next-Cursor on first page")
	}

	// Second page: the remaining 5, disjoint from page 1, no next cursor.
	rec = authedGET(t, h, "/wallet/withdrawals?limit=20&cursor="+cursor, token)
	if rec.Code != http.StatusOK {
		t.Fatalf("second page status = %d (%s)", rec.Code, rec.Body)
	}
	page2 := decodeWithdrawals(t, rec)
	if len(page2) != 5 {
		t.Fatalf("page 2 length = %d, want 5 (%s)", len(page2), rec.Body)
	}
	seen := make(map[int]bool)
	for _, r := range page1 {
		seen[r.AmountTZS] = true
	}
	for _, r := range page2 {
		if seen[r.AmountTZS] {
			t.Fatalf("page 2 overlaps page 1 at amount %d", r.AmountTZS)
		}
	}
	if page2[4].AmountTZS != 1000 {
		t.Fatalf("page 2 last = %+v, want amount 1000", page2[4])
	}
	if rec.Header().Get("X-Next-Cursor") != "" {
		t.Fatal("unexpected X-Next-Cursor on last page")
	}

	// A malformed cursor is rejected with 422 VALIDATION_FAILED.
	rec = authedGET(t, h, "/wallet/withdrawals?cursor=!!!", token)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("bad cursor status = %d, want 422 (%s)", rec.Code, rec.Body)
	}
	assertErrorCode(t, rec, "VALIDATION_FAILED")
}

// assertErrorCode decodes an error envelope and asserts its code.
func assertErrorCode(t *testing.T, rec *httptest.ResponseRecorder, want string) {
	t.Helper()
	var errBody gen.ErrorResponse
	if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
		t.Fatalf("decode error body: %v (%s)", err, rec.Body)
	}
	if errBody.Code != want {
		t.Fatalf("error code = %q, want %q (%s)", errBody.Code, want, rec.Body)
	}
}
