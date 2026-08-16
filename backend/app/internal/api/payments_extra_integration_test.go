//go:build integration

// PAYMENTS-EXTRA + WALLET TOP-UP integration tests against real PostgreSQL +
// Redis (docker compose / local dev).
//
//	cd app && go test -tags integration ./internal/api/ -run 'PaymentMethods|PaymentHistory|Reverse|RequestPayment|PaymentQr|TopUp' -count=1
//
// Only payment_intents and payment_transactions are truncated (this suite
// owns them); every user and order row inserted here is deleted at cleanup.
package api

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/hudumika/api-backend/internal/gen"
	"github.com/hudumika/api-backend/internal/payments"
)

// paymentsExtraSetup wires a persistent server, waits for the orders table
// (migration 00005, written by a sibling agent), and truncates only the
// payments tables.
func paymentsExtraSetup(t *testing.T) (*Server, *pgxpool.Pool) {
	t.Helper()
	s, pool := newPersistentServer(t)
	waitForOrdersTable(t, pool)
	if _, err := pool.Exec(context.Background(), `TRUNCATE payment_transactions, payment_intents CASCADE`); err != nil {
		t.Fatalf("truncate payments tables: %v", err)
	}
	return s, pool
}

// waitForOrdersTable polls for the orders table, which arrives with
// migration 00005 written by a sibling agent (max 180 s).
func waitForOrdersTable(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	ctx := context.Background()
	deadline := time.Now().Add(180 * time.Second)
	for {
		var reg *string
		err := pool.QueryRow(ctx, `SELECT to_regclass('public.orders')`).Scan(&reg)
		if err == nil && reg != nil {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("orders table never appeared — run `go run ./cmd/migrate -up` (migration 00005): %v", err)
		}
		time.Sleep(5 * time.Second)
	}
}

// payAuthedJSON sends an authed request with a JSON body and optional extra
// headers (e.g. Idempotency-Key).
func payAuthedJSON(t *testing.T, h http.Handler, method, path, token, body string, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	var r io.Reader
	if body != "" {
		r = strings.NewReader(body)
	}
	req := httptest.NewRequest(method, path, r)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

// paymentsExtraUser inserts a users row with a per-run unique phone and
// registers cleanup that deletes ONLY this suite's row.
func paymentsExtraUser(t *testing.T, pool *pgxpool.Pool) (uuid.UUID, string) {
	t.Helper()
	ctx := context.Background()
	userID := uuid.New()
	phone := "+2558" + strings.ReplaceAll(uuid.NewString(), "-", "")[:9]
	if _, err := pool.Exec(ctx, `INSERT INTO users (id, phone) VALUES ($1, $2)`, userID, phone); err != nil {
		t.Fatalf("insert payments user: %v", err)
	}
	t.Cleanup(func() { _, _ = pool.Exec(ctx, `DELETE FROM users WHERE id = $1`, userID) })
	return userID, phone
}

// paymentsExtraOrder inserts a pending_payment order owned by the user with
// the given total and registers cleanup for the row.
func paymentsExtraOrder(t *testing.T, pool *pgxpool.Pool, userID uuid.UUID, totalTZS int64) uuid.UUID {
	t.Helper()
	ctx := context.Background()
	orderID := uuid.New()
	if _, err := pool.Exec(ctx,
		`INSERT INTO orders (id, customer_user_id, merchant_id, status, total_tzs)
		 VALUES ($1, $2, $3, 'pending_payment', $4)`,
		orderID, userID, uuid.New(), totalTZS); err != nil {
		t.Fatalf("insert order: %v", err)
	}
	t.Cleanup(func() { _, _ = pool.Exec(ctx, `DELETE FROM orders WHERE id = $1`, orderID) })
	return orderID
}

// decodeIntentID parses a PaymentIntent body and returns its id.
func decodeIntentID(t *testing.T, rec *httptest.ResponseRecorder) uuid.UUID {
	t.Helper()
	var pi gen.PaymentIntent
	if err := json.NewDecoder(rec.Body).Decode(&pi); err != nil {
		t.Fatalf("decode payment intent: %v (%s)", err, rec.Body)
	}
	return uuid.UUID(pi.Id)
}

// intentStatus reads the stored status of an intent.
func intentStatus(t *testing.T, pool *pgxpool.Pool, id uuid.UUID) string {
	t.Helper()
	var status string
	if err := pool.QueryRow(context.Background(), `SELECT status FROM payment_intents WHERE id = $1`, id).Scan(&status); err != nil {
		t.Fatalf("intent status: %v", err)
	}
	return status
}

// TestPaymentMethodsListIntegration: GET /payments/methods returns the
// static eight-method list against a real database.
func TestPaymentMethodsListIntegration(t *testing.T) {
	s, _ := paymentsExtraSetup(t)
	token := tokenFor(t, s, "pay-methods-itest", RoleCustomer, false)

	rec := authedGET(t, s.Router(), "/payments/methods", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	var out []struct {
		Method    string `json:"method"`
		Available bool   `json:"available"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&out); err != nil {
		t.Fatalf("decode methods: %v", err)
	}
	if len(out) != 8 {
		t.Fatalf("method count = %d, want 8", len(out))
	}
	for _, m := range out {
		if !m.Available {
			t.Fatalf("method %q reported unavailable", m.Method)
		}
	}
}

// TestPaymentHistoryListsOwnIntents: after creating an order-linked intent
// through the API, GET /payments/history returns it to the owner.
func TestPaymentHistoryListsOwnIntents(t *testing.T) {
	s, pool := paymentsExtraSetup(t)
	userID, phone := paymentsExtraUser(t, pool)
	orderID := paymentsExtraOrder(t, pool, userID, 16000)
	token := tokenFor(t, s, phone, RoleCustomer, false)
	h := s.Router()

	rec := payAuthedJSON(t, h, http.MethodPost, "/payments/intent", token,
		`{"orderId":"`+orderID.String()+`","method":"mpesa"}`, map[string]string{"Idempotency-Key": "hist-1"})
	if rec.Code != http.StatusCreated {
		t.Fatalf("create intent status = %d, want 201 (%s)", rec.Code, rec.Body)
	}
	intentID := decodeIntentID(t, rec)

	rec = authedGET(t, h, "/payments/history", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("history status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	var items []struct {
		Id        string `json:"id"`
		Method    string `json:"method"`
		AmountTZS int    `json:"amountTZS"`
		Status    string `json:"status"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&items); err != nil {
		t.Fatalf("decode history: %v", err)
	}
	if len(items) != 1 {
		t.Fatalf("history length = %d, want 1 (%s)", len(items), rec.Body)
	}
	if items[0].Id != intentID.String() || items[0].AmountTZS != 16000 ||
		items[0].Method != "mpesa" || items[0].Status != "created" {
		t.Fatalf("unexpected history item: %+v", items[0])
	}
}

// TestPaymentReverseLifecycle: create + confirm an intent, reverse it
// (pending → failed), then reversing again conflicts with 409
// PAYMENT_ALREADY_PAID.
func TestPaymentReverseLifecycle(t *testing.T) {
	s, pool := paymentsExtraSetup(t)
	userID, phone := paymentsExtraUser(t, pool)
	orderID := paymentsExtraOrder(t, pool, userID, 16000)
	token := tokenFor(t, s, phone, RoleCustomer, false)
	h := s.Router()

	rec := payAuthedJSON(t, h, http.MethodPost, "/payments/intent", token,
		`{"orderId":"`+orderID.String()+`","method":"mpesa"}`, map[string]string{"Idempotency-Key": "rev-1"})
	if rec.Code != http.StatusCreated {
		t.Fatalf("create intent status = %d, want 201 (%s)", rec.Code, rec.Body)
	}
	intentID := decodeIntentID(t, rec)

	// created → pending via the confirm endpoint.
	rec = authedRequest(t, h, http.MethodPost, "/payments/"+intentID.String()+"/confirm", token, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("confirm status = %d, want 200 (%s)", rec.Code, rec.Body)
	}

	rec = authedRequest(t, h, http.MethodPost, "/payments/"+intentID.String()+"/reverse", token,
		`{"reason":"duplicate request"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("reverse status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	var reversed gen.PaymentIntent
	if err := json.NewDecoder(rec.Body).Decode(&reversed); err != nil {
		t.Fatalf("decode reversed intent: %v", err)
	}
	if reversed.Status != gen.PaymentIntentStatus("failed") {
		t.Fatalf("reversed status = %q, want failed", reversed.Status)
	}
	if got := intentStatus(t, pool, intentID); got != "failed" {
		t.Fatalf("db status = %q, want failed", got)
	}

	// A second reverse is a state conflict: the guard matched nothing.
	rec = authedRequest(t, h, http.MethodPost, "/payments/"+intentID.String()+"/reverse", token,
		`{"reason":"again"}`)
	if rec.Code != http.StatusConflict {
		t.Fatalf("second reverse status = %d, want 409 (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
		t.Fatalf("decode error body: %v", err)
	}
	if errBody.Code != "PAYMENT_ALREADY_PAID" {
		t.Fatalf("error code = %q, want PAYMENT_ALREADY_PAID", errBody.Code)
	}
}

// TestRequestCustomerPaymentCreatesIntent: POST /payments/request creates an
// order-less intent for the customer phone with the body amount.
func TestRequestCustomerPaymentCreatesIntent(t *testing.T) {
	s, pool := paymentsExtraSetup(t)
	_, merchantPhone := paymentsExtraUser(t, pool)
	_, customerPhone := paymentsExtraUser(t, pool)
	token := tokenFor(t, s, merchantPhone, RoleMerchant, false)
	h := s.Router()

	rec := payAuthedJSON(t, h, http.MethodPost, "/payments/request", token,
		`{"phone":"`+customerPhone+`","amountTZS":5000,"method":"mpesa","note":"thanks"}`, nil)
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 201 (%s)", rec.Code, rec.Body)
	}
	var resp struct {
		RequestId string `json:"requestId"`
		Status    string `json:"status"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if resp.RequestId == "" || resp.Status != "pending_confirmation" {
		t.Fatalf("unexpected response: %+v", resp)
	}

	intent, err := payments.NewStore(pool).GetIntent(context.Background(), uuid.MustParse(resp.RequestId))
	if err != nil {
		t.Fatalf("get intent: %v", err)
	}
	if intent == nil {
		t.Fatal("intent row missing")
	}
	if intent.OrderID != nil || intent.AmountTZS != 5000 || intent.Method != "mpesa" {
		t.Fatalf("unexpected intent row: order_id=%v amount=%d method=%s", intent.OrderID, intent.AmountTZS, intent.Method)
	}
}

// TestWalletTopUpCreatesIntent: POST /wallet/me/top-up with an
// Idempotency-Key creates an order-less intent for the body amount and
// answers 202 with the PaymentIntent; a missing key and a below-minimum
// amount are 422 VALIDATION_FAILED.
func TestWalletTopUpCreatesIntent(t *testing.T) {
	s, pool := paymentsExtraSetup(t)
	_, phone := paymentsExtraUser(t, pool)
	token := tokenFor(t, s, phone, RoleCustomer, false)
	h := s.Router()

	rec := payAuthedJSON(t, h, http.MethodPost, "/wallet/me/top-up", token,
		`{"amountTZS":5000,"method":"mpesa"}`, map[string]string{"Idempotency-Key": "topup-1"})
	if rec.Code != http.StatusAccepted {
		t.Fatalf("top-up status = %d, want 202 (%s)", rec.Code, rec.Body)
	}
	intentID := decodeIntentID(t, rec)

	intent, err := payments.NewStore(pool).GetIntent(context.Background(), intentID)
	if err != nil {
		t.Fatalf("get intent: %v", err)
	}
	if intent == nil {
		t.Fatal("intent row missing")
	}
	if intent.OrderID != nil || intent.AmountTZS != 5000 || intent.Method != "mpesa" || intent.Status != "created" {
		t.Fatalf("unexpected intent row: order_id=%v amount=%d method=%s status=%s",
			intent.OrderID, intent.AmountTZS, intent.Method, intent.Status)
	}

	// Missing Idempotency-Key (with the database present) → 422.
	rec = authedRequest(t, h, http.MethodPost, "/wallet/me/top-up", token, `{"amountTZS":5000,"method":"mpesa"}`)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("no-key status = %d, want 422 (%s)", rec.Code, rec.Body)
	}

	// Below the 1000 TZS floor → 422.
	rec = payAuthedJSON(t, h, http.MethodPost, "/wallet/me/top-up", token,
		`{"amountTZS":500,"method":"mpesa"}`, map[string]string{"Idempotency-Key": "topup-2"})
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("below-minimum status = %d, want 422 (%s)", rec.Code, rec.Body)
	}
}

// TestCreatePaymentQrIntegration: a wallet-style QR (no orderId) backs an
// order-less intent with the body amount; an order-linked QR is charged the
// server-side order total and carries merchantRef. Both payloads are
// hudumika://pay/{intentId} with a 15-minute expiry.
func TestCreatePaymentQrIntegration(t *testing.T) {
	s, pool := paymentsExtraSetup(t)
	userID, phone := paymentsExtraUser(t, pool)
	orderID := paymentsExtraOrder(t, pool, userID, 16000)
	token := tokenFor(t, s, phone, RoleCustomer, false)
	h := s.Router()
	st := payments.NewStore(pool)

	// Wallet-style QR: amount from the body, intent has no order.
	rec := payAuthedJSON(t, h, http.MethodPost, "/payments/qr", token,
		`{"provider":"mpesa","amountTZS":5000,"description":"counter"}`, nil)
	if rec.Code != http.StatusCreated {
		t.Fatalf("qr status = %d, want 201 (%s)", rec.Code, rec.Body)
	}
	var qr gen.PaymentQr
	if err := json.NewDecoder(rec.Body).Decode(&qr); err != nil {
		t.Fatalf("decode qr: %v", err)
	}
	if qr.QrPayload == "" || qr.Provider != "mpesa" || qr.AmountTZS == nil || *qr.AmountTZS != 5000 {
		t.Fatalf("unexpected qr: %+v", qr)
	}
	if !strings.HasPrefix(qr.QrPayload, "hudumika://pay/") {
		t.Fatalf("payload %q does not start with hudumika://pay/", qr.QrPayload)
	}
	if !qr.ExpiresAt.After(time.Now().Add(10 * time.Minute)) {
		t.Fatalf("expiresAt %v not within the 15-minute window", qr.ExpiresAt)
	}
	walletIntent, err := st.GetIntent(context.Background(), uuid.MustParse(strings.TrimPrefix(qr.QrPayload, "hudumika://pay/")))
	if err != nil {
		t.Fatalf("get wallet qr intent: %v", err)
	}
	if walletIntent == nil || walletIntent.OrderID != nil || walletIntent.AmountTZS != 5000 {
		t.Fatalf("unexpected wallet qr intent: %+v", walletIntent)
	}

	// Order-linked QR: amount is the server-side order total, merchantRef is
	// the order id.
	rec = payAuthedJSON(t, h, http.MethodPost, "/payments/qr", token,
		`{"provider":"tigo_pesa","orderId":"`+orderID.String()+`"}`, nil)
	if rec.Code != http.StatusCreated {
		t.Fatalf("order qr status = %d, want 201 (%s)", rec.Code, rec.Body)
	}
	var orderQR gen.PaymentQr
	if err := json.NewDecoder(rec.Body).Decode(&orderQR); err != nil {
		t.Fatalf("decode order qr: %v", err)
	}
	if orderQR.AmountTZS == nil || *orderQR.AmountTZS != 16000 {
		t.Fatalf("order qr amount = %v, want 16000", orderQR.AmountTZS)
	}
	if orderQR.MerchantRef == nil || *orderQR.MerchantRef != orderID.String() {
		t.Fatalf("order qr merchantRef = %v, want %s", orderQR.MerchantRef, orderID)
	}
	orderIntent, err := st.GetIntent(context.Background(), uuid.MustParse(strings.TrimPrefix(orderQR.QrPayload, "hudumika://pay/")))
	if err != nil {
		t.Fatalf("get order qr intent: %v", err)
	}
	if orderIntent == nil || orderIntent.OrderID == nil || *orderIntent.OrderID != orderID || orderIntent.AmountTZS != 16000 {
		t.Fatalf("unexpected order qr intent: %+v", orderIntent)
	}
}

// TestPaymentHistoryPagination: 25 intents paginate as 20 + 5 across two
// pages, with the second page carrying no next cursor.
func TestPaymentHistoryPagination(t *testing.T) {
	s, pool := paymentsExtraSetup(t)
	userID, phone := paymentsExtraUser(t, pool)
	token := tokenFor(t, s, phone, RoleCustomer, false)
	st := payments.NewStore(pool)

	for i := 0; i < 25; i++ {
		orderID := paymentsExtraOrder(t, pool, userID, int64(1000+i))
		if _, err := st.CreateIntent(context.Background(), orderID, "mpesa",
			int64(1000+i), "pg-"+uuid.NewString()); err != nil {
			t.Fatalf("create intent %d: %v", i, err)
		}
	}
	h := s.Router()

	rec := authedGET(t, h, "/payments/history", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("page 1 status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	var page1 []struct {
		Id string `json:"id"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&page1); err != nil {
		t.Fatalf("decode page 1: %v", err)
	}
	if len(page1) != paymentHistoryDefaultLimit {
		t.Fatalf("page 1 length = %d, want %d", len(page1), paymentHistoryDefaultLimit)
	}
	cursor := rec.Header().Get("X-Next-Cursor")
	if cursor == "" {
		t.Fatal("page 1 missing X-Next-Cursor")
	}

	rec = authedGET(t, h, "/payments/history?limit=25&cursor="+cursor, token)
	if rec.Code != http.StatusOK {
		t.Fatalf("page 2 status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	var page2 []struct {
		Id string `json:"id"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&page2); err != nil {
		t.Fatalf("decode page 2: %v", err)
	}
	if len(page2) != 5 {
		t.Fatalf("page 2 length = %d, want 5", len(page2))
	}
	if rec.Header().Get("X-Next-Cursor") != "" {
		t.Fatal("page 2 should carry no next cursor")
	}

	// Pages do not overlap.
	seen := map[string]bool{}
	for _, it := range page1 {
		seen[it.Id] = true
	}
	for _, it := range page2 {
		if seen[it.Id] {
			t.Fatalf("intent %s appears on both pages", it.Id)
		}
		seen[it.Id] = true
	}
}
