//go:build integration

// Finance integration tests against real PostgreSQL + Redis.
//
//	cd app && go test -tags integration ./internal/api/ -run 'BankCard|Invoice|Settlement|Reconciliation|Finance' -count=1
//
// This suite owns the finance tables (migration 00030): it truncates
// bank_cards, invoices, daily_settlements and reconciliation_runs at setup
// and clears its own users (phone prefix +255876...) — it never truncates
// shared tables. Settlements also write payout_batches/payout_entries rows
// (shared with the payouts/wallet suites): assertions there are scoped to
// the rows this suite created.
package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/hudumika/api-backend/internal/gen"
)

// financePhonePrefix identifies every users row this suite inserts.
const financePhonePrefix = "+255876"

// financeTables are the tables owned by this suite (migration 00030).
var financeTables = []string{
	"reconciliation_runs",
	"daily_settlements",
	"invoices",
	"bank_cards",
}

// financeSetup wires a persistent server and truncates only this suite's
// tables plus its own users, in one statement. Orders seeded by this suite
// reference the suite's users rows (orders.customer_user_id FK), so they are
// deleted first.
func financeSetup(t *testing.T) (*Server, *pgxpool.Pool) {
	t.Helper()
	s, pool := newPersistentServer(t)
	ctx := context.Background()
	if _, err := pool.Exec(ctx, "TRUNCATE "+strings.Join(financeTables, ", ")); err != nil {
		t.Fatalf("truncate finance tables: %v", err)
	}
	if _, err := pool.Exec(ctx,
		`DELETE FROM orders WHERE customer_user_id IN (SELECT id FROM users WHERE phone LIKE '`+financePhonePrefix+`%')`); err != nil {
		t.Fatalf("clear finance orders: %v", err)
	}
	if _, err := pool.Exec(ctx, `DELETE FROM users WHERE phone LIKE '`+financePhonePrefix+`%'`); err != nil {
		t.Fatalf("clear finance users: %v", err)
	}
	return s, pool
}

// financeUser inserts a users row with a per-run unique phone and returns
// the user id and the phone (the session subject).
func financeUser(t *testing.T, pool *pgxpool.Pool) (uuid.UUID, string) {
	t.Helper()
	ctx := context.Background()
	phone := fmt.Sprintf("%s%08d", financePhonePrefix, time.Now().UnixNano()%100_000_000)
	userID := uuid.New()
	if _, err := pool.Exec(ctx, `INSERT INTO users (id, phone) VALUES ($1, $2)`, userID, phone); err != nil {
		t.Fatalf("insert finance user: %v", err)
	}
	return userID, phone
}

// financeDBDate returns today's date in the database's timezone — the cycle
// date comparisons (created_at::date = $1) are evaluated by PostgreSQL, so
// the test date must come from the database, not the test process.
func financeDBDate(t *testing.T, pool *pgxpool.Pool) string {
	t.Helper()
	var d string
	if err := pool.QueryRow(context.Background(),
		`SELECT to_char(CURRENT_DATE, 'YYYY-MM-DD')`).Scan(&d); err != nil {
		t.Fatalf("read db date: %v", err)
	}
	return d
}

// financeErr decodes an error envelope and asserts its code.
func financeErr(t *testing.T, rec *httptest.ResponseRecorder) gen.ErrorResponse {
	t.Helper()
	var errBody gen.ErrorResponse
	if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
		t.Fatalf("decode error body: %v", err)
	}
	return errBody
}

// TestFinanceBankCardLifecycle covers create (token stored, never returned),
// first-card-is-default, the 5-card limit, set-default and promotion on
// deletion of the default, plus ownership isolation between users.
func TestFinanceBankCardLifecycle(t *testing.T) {
	s, pool := financeSetup(t)
	_, phoneA := financeUser(t, pool)
	_, phoneB := financeUser(t, pool)
	tokenA := tokenFor(t, s, phoneA, RoleCustomer, false)
	tokenB := tokenFor(t, s, phoneB, RoleCustomer, false)
	h := s.Router()

	rec := authedDo(t, h, http.MethodPost, "/finance/bank-cards",
		`{"token":"tok_fin_a1","last4":"1234","brand":"Visa","expiryMonth":12,"expiryYear":2028}`, tokenA)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create first card = %d (%s)", rec.Code, rec.Body)
	}
	var first gen.BankCard
	if err := json.NewDecoder(rec.Body).Decode(&first); err != nil {
		t.Fatalf("decode first card: %v", err)
	}
	if !first.IsDefault {
		t.Fatalf("first card not default: %+v", first)
	}
	if strings.Contains(rec.Body.String(), "tok_fin_a1") {
		t.Fatalf("token leaked in create response: %s", rec.Body)
	}
	var storedToken string
	if err := pool.QueryRow(context.Background(),
		`SELECT token FROM bank_cards WHERE id = $1`, first.Id).Scan(&storedToken); err != nil {
		t.Fatalf("load stored card token: %v", err)
	}
	if storedToken != "tok_fin_a1" {
		t.Fatalf("stored token = %q, want tok_fin_a1", storedToken)
	}

	rec = authedDo(t, h, http.MethodPost, "/finance/bank-cards",
		`{"token":"tok_fin_a2","last4":"5678","brand":"Mastercard"}`, tokenA)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create second card = %d (%s)", rec.Code, rec.Body)
	}
	var second gen.BankCard
	if err := json.NewDecoder(rec.Body).Decode(&second); err != nil {
		t.Fatalf("decode second card: %v", err)
	}
	if second.IsDefault {
		t.Fatalf("second card unexpectedly default: %+v", second)
	}

	// 5-card limit: cards 3..5 succeed, the 6th is rejected.
	for i := 0; i < 3; i++ {
		rec = authedDo(t, h, http.MethodPost, "/finance/bank-cards",
			fmt.Sprintf(`{"token":"tok_fin_a3_%d","last4":"%d","brand":"Visa"}`, i, 9000+i), tokenA)
		if rec.Code != http.StatusCreated {
			t.Fatalf("create card %d = %d (%s)", i+3, rec.Code, rec.Body)
		}
	}
	rec = authedDo(t, h, http.MethodPost, "/finance/bank-cards",
		`{"token":"tok_fin_a6","last4":"9999","brand":"Visa"}`, tokenA)
	if rec.Code != http.StatusConflict {
		t.Fatalf("6th card = %d, want 409 (%s)", rec.Code, rec.Body)
	}
	if errBody := financeErr(t, rec); errBody.Code != "BANK_CARD_LIMIT_REACHED" {
		t.Fatalf("error code = %q, want BANK_CARD_LIMIT_REACHED", errBody.Code)
	}

	// List: two visible cards (max 5) with masked data, no token anywhere.
	rec = authedGET(t, h, "/finance/bank-cards", tokenA)
	if rec.Code != http.StatusOK {
		t.Fatalf("list cards = %d (%s)", rec.Code, rec.Body)
	}
	var list []gen.BankCard
	if err := json.NewDecoder(rec.Body).Decode(&list); err != nil {
		t.Fatalf("decode card list: %v", err)
	}
	if len(list) != 5 {
		t.Fatalf("card count = %d, want 5", len(list))
	}
	if strings.Contains(rec.Body.String(), "tok_") {
		t.Fatalf("token leaked in list response: %s", rec.Body)
	}
	for _, c := range list {
		if c.Last4 == "" {
			t.Fatalf("card without last4: %+v", c)
		}
	}

	// Ownership isolation: user B sees no cards and cannot touch A's.
	rec = authedGET(t, h, "/finance/bank-cards", tokenB)
	if err := json.NewDecoder(rec.Body).Decode(&list); err != nil {
		t.Fatalf("decode B card list: %v", err)
	}
	if len(list) != 0 {
		t.Fatalf("user B card count = %d, want 0", len(list))
	}
	rec = authedDo(t, h, http.MethodDelete, "/finance/bank-cards/"+first.Id.String(), "", tokenB)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("B deletes A card = %d, want 404 (%s)", rec.Code, rec.Body)
	}
	if errBody := financeErr(t, rec); errBody.Code != "BANK_CARD_NOT_FOUND" {
		t.Fatalf("error code = %q, want BANK_CARD_NOT_FOUND", errBody.Code)
	}
	rec = authedDo(t, h, http.MethodPut, "/finance/bank-cards/"+first.Id.String()+"/default", "", tokenB)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("B sets A default = %d, want 404", rec.Code)
	}

	// Set default to the second card, then delete it: the first is promoted
	// in the same transaction.
	rec = authedDo(t, h, http.MethodPut, "/finance/bank-cards/"+second.Id.String()+"/default", "", tokenA)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("set default = %d (%s)", rec.Code, rec.Body)
	}
	rec = authedDo(t, h, http.MethodDelete, "/finance/bank-cards/"+second.Id.String(), "", tokenA)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("delete default = %d (%s)", rec.Code, rec.Body)
	}
	var promoted bool
	if err := pool.QueryRow(context.Background(),
		`SELECT is_default FROM bank_cards WHERE id = $1`, first.Id).Scan(&promoted); err != nil {
		t.Fatalf("load promoted card: %v", err)
	}
	if !promoted {
		t.Fatalf("sibling not promoted to default after default deletion")
	}

	// Deleting a card that no longer exists (A's last card then the same id
	// again) → BANK_CARD_NOT_FOUND.
	rec = authedDo(t, h, http.MethodDelete, "/finance/bank-cards/"+first.Id.String(), "", tokenA)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("delete last card = %d (%s)", rec.Code, rec.Body)
	}
	rec = authedDo(t, h, http.MethodDelete, "/finance/bank-cards/"+first.Id.String(), "", tokenA)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("delete missing card = %d, want 404", rec.Code)
	}
	if errBody := financeErr(t, rec); errBody.Code != "BANK_CARD_NOT_FOUND" {
		t.Fatalf("error code = %q, want BANK_CARD_NOT_FOUND", errBody.Code)
	}
}

// TestFinanceInvoiceLifecycle covers create → issue → download, the
// duplicate-number guard, negative totals and the draft download guard, plus
// cross-merchant isolation.
func TestFinanceInvoiceLifecycle(t *testing.T) {
	s, pool := financeSetup(t)
	_, phoneA := financeUser(t, pool)
	_, phoneB := financeUser(t, pool)
	tokenA := tokenFor(t, s, phoneA, RoleMerchant, false)
	tokenB := tokenFor(t, s, phoneB, RoleMerchant, false)
	h := s.Router()

	rec := authedDo(t, h, http.MethodPost, "/finance/invoices",
		`{"number":"FIN-INV-001","amountTZS":10000,"taxAmountTZS":1800}`, tokenA)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create invoice = %d (%s)", rec.Code, rec.Body)
	}
	var invoice gen.Invoice
	if err := json.NewDecoder(rec.Body).Decode(&invoice); err != nil {
		t.Fatalf("decode invoice: %v", err)
	}
	if invoice.Number != "FIN-INV-001" || invoice.Status != gen.InvoiceStatusDraft || invoice.AmountTZS != 10000 {
		t.Fatalf("unexpected created invoice: %+v", invoice)
	}
	if invoice.TaxAmountTZS == nil || *invoice.TaxAmountTZS != 1800 {
		t.Fatalf("created invoice tax = %v, want 1800", invoice.TaxAmountTZS)
	}

	// Duplicate number → 409; negative amounts → 422.
	rec = authedDo(t, h, http.MethodPost, "/finance/invoices",
		`{"number":"FIN-INV-001","amountTZS":5000}`, tokenA)
	if rec.Code != http.StatusConflict {
		t.Fatalf("duplicate number = %d, want 409 (%s)", rec.Code, rec.Body)
	}
	rec = authedDo(t, h, http.MethodPost, "/finance/invoices",
		`{"number":"FIN-INV-NEG","amountTZS":-1}`, tokenA)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("negative amount = %d, want 422 (%s)", rec.Code, rec.Body)
	}
	rec = authedDo(t, h, http.MethodPost, "/finance/invoices",
		`{"number":"FIN-INV-NEG2","amountTZS":100,"taxAmountTZS":-5}`, tokenA)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("negative tax = %d, want 422 (%s)", rec.Code, rec.Body)
	}

	// A draft is not downloadable (409 INVOICE_NOT_ISSUABLE).
	rec = authedGET(t, h, "/finance/invoices/"+invoice.Id.String()+"/download", tokenA)
	if rec.Code != http.StatusConflict {
		t.Fatalf("download draft = %d, want 409 (%s)", rec.Code, rec.Body)
	}
	if errBody := financeErr(t, rec); errBody.Code != "INVOICE_NOT_ISSUABLE" {
		t.Fatalf("error code = %q, want INVOICE_NOT_ISSUABLE", errBody.Code)
	}

	// Issue → 200 with status issued.
	rec = authedDo(t, h, http.MethodPost, "/finance/invoices/"+invoice.Id.String()+"/issue", "", tokenA)
	if rec.Code != http.StatusOK {
		t.Fatalf("issue invoice = %d (%s)", rec.Code, rec.Body)
	}
	var issued gen.Invoice
	if err := json.NewDecoder(rec.Body).Decode(&issued); err != nil {
		t.Fatalf("decode issued invoice: %v", err)
	}
	if issued.Status != gen.InvoiceStatusIssued || issued.IssuedAt == nil {
		t.Fatalf("unexpected issued invoice: %+v", issued)
	}

	// Issuing again → 409 INVOICE_NOT_ISSUABLE.
	rec = authedDo(t, h, http.MethodPost, "/finance/invoices/"+invoice.Id.String()+"/issue", "", tokenA)
	if rec.Code != http.StatusConflict {
		t.Fatalf("re-issue = %d, want 409 (%s)", rec.Code, rec.Body)
	}
	if errBody := financeErr(t, rec); errBody.Code != "INVOICE_NOT_ISSUABLE" {
		t.Fatalf("error code = %q, want INVOICE_NOT_ISSUABLE", errBody.Code)
	}

	// Download the issued invoice: plain text with the row's totals.
	rec = authedGET(t, h, "/finance/invoices/"+invoice.Id.String()+"/download", tokenA)
	if rec.Code != http.StatusOK {
		t.Fatalf("download invoice = %d (%s)", rec.Code, rec.Body)
	}
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/plain") {
		t.Fatalf("download content type = %q, want text/plain", ct)
	}
	if !strings.Contains(rec.Body.String(), "FIN-INV-001") || !strings.Contains(rec.Body.String(), "11800") {
		t.Fatalf("download body missing invoice details: %s", rec.Body)
	}

	// Cross-merchant: merchant B cannot issue or download A's invoice.
	rec = authedDo(t, h, http.MethodPost, "/finance/invoices/"+invoice.Id.String()+"/issue", "", tokenB)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("B issues A invoice = %d, want 404 (%s)", rec.Code, rec.Body)
	}
	if errBody := financeErr(t, rec); errBody.Code != "INVOICE_NOT_FOUND" {
		t.Fatalf("error code = %q, want INVOICE_NOT_FOUND", errBody.Code)
	}
	rec = authedGET(t, h, "/finance/invoices/"+invoice.Id.String()+"/download", tokenB)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("B downloads A invoice = %d, want 404", rec.Code)
	}

	// Unknown invoice → 404.
	rec = authedDo(t, h, http.MethodPost, "/finance/invoices/"+uuid.NewString()+"/issue", "", tokenA)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("issue missing invoice = %d, want 404", rec.Code)
	}
}

// TestFinanceInvoicePagination covers the keyset pagination of the invoice
// list: 25 invoices page as 20 + 5 with X-Next-Cursor.
func TestFinanceInvoicePagination(t *testing.T) {
	s, pool := financeSetup(t)
	_, phone := financeUser(t, pool)
	token := tokenFor(t, s, phone, RoleMerchant, false)
	h := s.Router()

	for i := 1; i <= 25; i++ {
		rec := authedDo(t, h, http.MethodPost, "/finance/invoices",
			fmt.Sprintf(`{"number":"FIN-PAG-%03d","amountTZS":%d}`, i, 1000+i), token)
		if rec.Code != http.StatusCreated {
			t.Fatalf("create invoice %d = %d (%s)", i, rec.Code, rec.Body)
		}
	}

	rec := authedGET(t, h, "/finance/invoices?limit=20", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("list invoices = %d (%s)", rec.Code, rec.Body)
	}
	var page []gen.Invoice
	if err := json.NewDecoder(rec.Body).Decode(&page); err != nil {
		t.Fatalf("decode invoice page: %v", err)
	}
	if len(page) != 20 {
		t.Fatalf("first page size = %d, want 20", len(page))
	}
	next := rec.Header().Get("X-Next-Cursor")
	if next == "" {
		t.Fatal("missing X-Next-Cursor on first page")
	}

	rec = authedGET(t, h, "/finance/invoices?limit=20&cursor="+next, token)
	if rec.Code != http.StatusOK {
		t.Fatalf("list invoices page 2 = %d (%s)", rec.Code, rec.Body)
	}
	if err := json.NewDecoder(rec.Body).Decode(&page); err != nil {
		t.Fatalf("decode invoice page 2: %v", err)
	}
	if len(page) != 5 {
		t.Fatalf("second page size = %d, want 5", len(page))
	}
	if rec.Header().Get("X-Next-Cursor") != "" {
		t.Fatal("unexpected X-Next-Cursor on last page")
	}

	// A malformed cursor is a 422, and a customer session cannot list.
	rec = authedGET(t, h, "/finance/invoices?limit=20&cursor=invalid-cursor", token)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("bad cursor = %d, want 422 (%s)", rec.Code, rec.Body)
	}
	_, customerPhone := financeUser(t, pool)
	customerToken := tokenFor(t, s, customerPhone, RoleCustomer, false)
	rec = authedGET(t, h, "/finance/invoices", customerToken)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("customer lists invoices = %d, want 403 (%s)", rec.Code, rec.Body)
	}
}

// TestFinanceSettlementRunPayout seeds a paid order, runs the merchant's
// settlement for the cycle, verifies the totals, then pays it out and
// verifies the payout batch entry and the SETTLEMENT_ALREADY_PAID guard.
func TestFinanceSettlementRunPayout(t *testing.T) {
	s, pool := financeSetup(t)
	merchant, merchantPhone := financeUser(t, pool)
	customer, _ := financeUser(t, pool)
	merchantToken := tokenFor(t, s, merchantPhone, RoleMerchant, false)
	_, staffPhone := financeUser(t, pool)
	staffToken := tokenFor(t, s, staffPhone, RoleFinance, true)
	h := s.Router()
	cycle := financeDBDate(t, pool)

	if _, err := pool.Exec(context.Background(),
		`INSERT INTO orders (merchant_id, customer_user_id, status, subtotal_tzs, tax_tzs, total_tzs)
		 VALUES ($1, $2, 'paid', 10000, 1800, 11800)`, merchant, customer); err != nil {
		t.Fatalf("seed paid order: %v", err)
	}

	// Run the merchant's settlement for the cycle.
	rec := authedDo(t, h, http.MethodPost, "/finance/settlements/run",
		`{"date":"`+cycle+`","reason":"cycle close"}`, merchantToken)
	if rec.Code != http.StatusCreated {
		t.Fatalf("run settlement = %d (%s)", rec.Code, rec.Body)
	}
	var settlement gen.DailySettlement
	if err := json.NewDecoder(rec.Body).Decode(&settlement); err != nil {
		t.Fatalf("decode settlement: %v", err)
	}
	if settlement.Id == nil || settlement.RevenueTZS != 11800 || settlement.OrderCount == nil || *settlement.OrderCount != 1 {
		t.Fatalf("unexpected settlement: %+v", settlement)
	}
	if settlement.Status != gen.DailySettlementStatusOpen {
		t.Fatalf("new settlement status = %q, want open (draft)", settlement.Status)
	}

	// A second run for the same cycle is rejected.
	rec = authedDo(t, h, http.MethodPost, "/finance/settlements/run",
		`{"date":"`+cycle+`","reason":"again"}`, merchantToken)
	if rec.Code != http.StatusConflict {
		t.Fatalf("second run = %d, want 409 (%s)", rec.Code, rec.Body)
	}
	if errBody := financeErr(t, rec); errBody.Code != "VALIDATION_FAILED" {
		t.Fatalf("error code = %q, want VALIDATION_FAILED", errBody.Code)
	}

	// The merchant sees its own settlement in the daily list.
	rec = authedGET(t, h, "/finance/settlements/daily?from="+cycle+"&to="+cycle, merchantToken)
	if rec.Code != http.StatusOK {
		t.Fatalf("merchant list settlements = %d (%s)", rec.Code, rec.Body)
	}
	var daily []gen.DailySettlement
	if err := json.NewDecoder(rec.Body).Decode(&daily); err != nil {
		t.Fatalf("decode daily settlements: %v", err)
	}
	if len(daily) != 1 || daily[0].Id == nil || daily[0].Id.String() != settlement.Id.String() {
		t.Fatalf("merchant daily list = %+v", daily)
	}

	// Finance staff pay the settlement out.
	rec = authedDo(t, h, http.MethodPost, "/finance/settlements/"+settlement.Id.String()+"/payout", "", staffToken)
	if rec.Code != http.StatusOK {
		t.Fatalf("payout settlement = %d (%s)", rec.Code, rec.Body)
	}
	var paid gen.DailySettlement
	if err := json.NewDecoder(rec.Body).Decode(&paid); err != nil {
		t.Fatalf("decode paid settlement: %v", err)
	}
	if paid.Status != gen.DailySettlementStatusPaid || paid.PaidAt == nil {
		t.Fatalf("unexpected paid settlement: %+v", paid)
	}

	// The payout landed as a payout_batches/payout_entries pair for the
	// merchant's cycle.
	var (
		batchCycle  string
		entryOwner  uuid.UUID
		entryAmt    int64
		entryMethod string
	)
	if err := pool.QueryRow(context.Background(),
		`SELECT to_char(pb.cycle, 'YYYY-MM-DD'), pe.owner_id, pe.amount_tzs, pe.method
		 FROM payout_entries pe JOIN payout_batches pb ON pb.id = pe.batch_id
		 WHERE pe.owner_id = $1 AND pe.amount_tzs = 11800
		 ORDER BY pe.created_at DESC LIMIT 1`, merchant).Scan(&batchCycle, &entryOwner, &entryAmt, &entryMethod); err != nil {
		t.Fatalf("load payout entry: %v", err)
	}
	if batchCycle != cycle || entryOwner != merchant || entryAmt != 11800 || entryMethod != "bank" {
		t.Fatalf("unexpected payout entry: cycle=%s owner=%s amt=%d method=%s",
			batchCycle, entryOwner, entryAmt, entryMethod)
	}

	// A second payout is rejected with SETTLEMENT_ALREADY_PAID.
	rec = authedDo(t, h, http.MethodPost, "/finance/settlements/"+settlement.Id.String()+"/payout", "", staffToken)
	if rec.Code != http.StatusConflict {
		t.Fatalf("second payout = %d, want 409 (%s)", rec.Code, rec.Body)
	}
	if errBody := financeErr(t, rec); errBody.Code != "SETTLEMENT_ALREADY_PAID" {
		t.Fatalf("error code = %q, want SETTLEMENT_ALREADY_PAID", errBody.Code)
	}

	// A foreign merchant cannot pay out this settlement.
	_, otherPhone := financeUser(t, pool)
	otherToken := tokenFor(t, s, otherPhone, RoleMerchant, false)
	rec = authedDo(t, h, http.MethodPost, "/finance/settlements/"+settlement.Id.String()+"/payout", "", otherToken)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("foreign payout = %d, want 404 (%s)", rec.Code, rec.Body)
	}
	if errBody := financeErr(t, rec); errBody.Code != "SETTLEMENT_NOT_FOUND" {
		t.Fatalf("error code = %q, want SETTLEMENT_NOT_FOUND", errBody.Code)
	}

	// Unknown settlement id → SETTLEMENT_NOT_FOUND.
	rec = authedDo(t, h, http.MethodPost, "/finance/settlements/"+uuid.NewString()+"/payout", "", staffToken)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("payout missing settlement = %d, want 404", rec.Code)
	}
	if errBody := financeErr(t, rec); errBody.Code != "SETTLEMENT_NOT_FOUND" {
		t.Fatalf("error code = %q, want SETTLEMENT_NOT_FOUND", errBody.Code)
	}
}

// TestFinanceReconciliation covers the staff-only summary: matched =
// paid settlements, exceptions = exception settlements, and the order and
// payment volume windows.
func TestFinanceReconciliation(t *testing.T) {
	s, pool := financeSetup(t)
	merchantA, _ := financeUser(t, pool)
	merchantB, _ := financeUser(t, pool)
	customer, _ := financeUser(t, pool)
	_, staffPhone := financeUser(t, pool)
	staffToken := tokenFor(t, s, staffPhone, RoleFinance, true)
	_, customerPhone := financeUser(t, pool)
	customerToken := tokenFor(t, s, customerPhone, RoleCustomer, false)
	h := s.Router()
	ctx := context.Background()
	cycle := financeDBDate(t, pool)

	// One paid settlement and one exception settlement on the cycle date.
	if _, err := pool.Exec(ctx,
		`INSERT INTO daily_settlements (merchant_id, cycle_date, total_tzs, count, status)
		 VALUES ($1, CURRENT_DATE, 5000, 1, 'paid')`, merchantA); err != nil {
		t.Fatalf("seed paid settlement: %v", err)
	}
	if _, err := pool.Exec(ctx,
		`INSERT INTO daily_settlements (merchant_id, cycle_date, total_tzs, count, status)
		 VALUES ($1, CURRENT_DATE, 7000, 2, 'exception')`, merchantB); err != nil {
		t.Fatalf("seed exception settlement: %v", err)
	}
	// A paid order for the volume window.
	if _, err := pool.Exec(ctx,
		`INSERT INTO orders (merchant_id, customer_user_id, status, total_tzs)
		 VALUES ($1, $2, 'paid', 4200)`, merchantA, customer); err != nil {
		t.Fatalf("seed paid order: %v", err)
	}
	var wantOrderTotal int64
	if err := pool.QueryRow(ctx,
		`SELECT COALESCE(SUM(total_tzs), 0) FROM orders
		 WHERE status = 'paid' AND created_at::date = CURRENT_DATE`).Scan(&wantOrderTotal); err != nil {
		t.Fatalf("compute expected order total: %v", err)
	}

	// The window is explicit: the test process and the database may be on
	// different calendar days, and the handler defaults to its own clock.
	rec := authedGET(t, h, "/finance/reconciliation?from="+cycle+"&to="+cycle, staffToken)
	if rec.Code != http.StatusOK {
		t.Fatalf("reconciliation = %d (%s)", rec.Code, rec.Body)
	}
	var summary gen.ReconciliationSummary
	if err := json.NewDecoder(rec.Body).Decode(&summary); err != nil {
		t.Fatalf("decode reconciliation: %v", err)
	}
	if summary.Matched != 1 || summary.Exceptions != 1 {
		t.Fatalf("matched/exceptions = %d/%d, want 1/1", summary.Matched, summary.Exceptions)
	}
	if int64(summary.OrderTotalTZS) != wantOrderTotal {
		t.Fatalf("orderTotalTZS = %d, want %d", summary.OrderTotalTZS, wantOrderTotal)
	}
	if summary.From.String() == "" || summary.To.String() == "" {
		t.Fatalf("reconciliation window missing: %+v", summary)
	}

	// from after to → 422; customer sessions are forbidden.
	rec = authedGET(t, h, "/finance/reconciliation?from=2026-01-02&to=2026-01-01", staffToken)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("inverted window = %d, want 422 (%s)", rec.Code, rec.Body)
	}
	rec = authedGET(t, h, "/finance/reconciliation", customerToken)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("customer reconciliation = %d, want 403 (%s)", rec.Code, rec.Body)
	}
}

// TestFinanceRunSettlementStaff is the finance-staff flavour of the run: it
// closes the cycle for every merchant with paid orders.
func TestFinanceRunSettlementStaff(t *testing.T) {
	s, pool := financeSetup(t)
	merchantA, _ := financeUser(t, pool)
	merchantB, _ := financeUser(t, pool)
	customer, _ := financeUser(t, pool)
	_, staffPhone := financeUser(t, pool)
	staffToken := tokenFor(t, s, staffPhone, RoleFinance, true)
	h := s.Router()
	cycle := financeDBDate(t, pool)

	for _, m := range []uuid.UUID{merchantA, merchantB} {
		if _, err := pool.Exec(context.Background(),
			`INSERT INTO orders (merchant_id, customer_user_id, status, total_tzs)
			 VALUES ($1, $2, 'paid', 2500)`, m, customer); err != nil {
			t.Fatalf("seed paid order for %s: %v", m, err)
		}
	}

	rec := authedDo(t, h, http.MethodPost, "/finance/settlements/run",
		`{"date":"`+cycle+`","reason":"staff run"}`, staffToken)
	if rec.Code != http.StatusCreated {
		t.Fatalf("staff run settlement = %d (%s)", rec.Code, rec.Body)
	}

	var count int
	if err := pool.QueryRow(context.Background(),
		`SELECT count(*) FROM daily_settlements WHERE cycle_date = $1 AND status = 'draft' AND total_tzs = 2500`,
		cycle).Scan(&count); err != nil {
		t.Fatalf("count staff settlements: %v", err)
	}
	if count != 2 {
		t.Fatalf("staff-run settlements = %d, want 2 (one per merchant)", count)
	}
}
