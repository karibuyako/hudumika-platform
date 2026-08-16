//go:build integration

// Masked-call sessions against real PostgreSQL + Redis (docker compose). Run
// via DATABASE_URL=postgres://hudumika:hudumika@localhost:5432/hudumika
// REDIS_URL=redis://localhost:6379/0 go test -tags integration ./internal/api/ -run 'MaskedCall' -count=1
// Every test seeds only its own rows (unique +2559* phones) and deletes
// exactly those rows plus its own Redis call:* keys in cleanup; the shared
// tables are never truncated.
package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/hudumika/api-backend/internal/gen"
)

// maskedPersistentServer is newPersistentServer with an explicit skip when
// Redis is not configured: masked sessions live in Redis, so without it the
// suite cannot run.
func maskedPersistentServer(t *testing.T) (*Server, *pgxpool.Pool) {
	t.Helper()
	if os.Getenv("REDIS_URL") == "" {
		t.Skip("integration: REDIS_URL required")
	}
	return newPersistentServer(t)
}

// seedMaskedRider creates the rider's owner user, city and riders rows and
// registers cleanup that deletes exactly those rows.
func seedMaskedRider(t *testing.T, pool *pgxpool.Pool, prefix string) (ownerUserID, riderID uuid.UUID, riderPhone string) {
	t.Helper()
	riderPhone = uniqueAdminPhone(t, prefix)
	ownerUserID = seedAdminUser(t, pool, riderPhone, "MaskedCall Rider "+riderPhone, "rider", time.Now())
	var cityID uuid.UUID
	if err := pool.QueryRow(context.Background(),
		`INSERT INTO cities (name, country) VALUES ($1, 'TZ') RETURNING id`,
		"MaskedCall City "+riderPhone).Scan(&cityID); err != nil {
		t.Fatalf("seed city: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM cities WHERE id = $1`, cityID)
	})
	var id uuid.UUID
	if err := pool.QueryRow(context.Background(),
		`INSERT INTO riders (owner_user_id, name, city_id, vehicle, verification, online)
		 VALUES ($1, $2, $3, 'motorcycle', 'approved', false) RETURNING id`,
		ownerUserID, "MaskedCall Rider "+riderPhone, cityID).Scan(&id); err != nil {
		t.Fatalf("seed rider: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM riders WHERE id = $1`, id)
	})
	return ownerUserID, id, riderPhone
}

// seedMaskedOrder inserts a paid order for the customer+merchant, optionally
// bound to the given rider, and registers cleanup that deletes exactly this
// order's rows and its masked-call Redis keys (never truncating shared
// tables).
func seedMaskedOrder(t *testing.T, s *Server, pool *pgxpool.Pool, customerID, merchantID uuid.UUID, riderID *uuid.UUID) uuid.UUID {
	t.Helper()
	ctx := context.Background()
	var id uuid.UUID
	if err := pool.QueryRow(ctx,
		`INSERT INTO orders (customer_user_id, merchant_id, status, subtotal_tzs, delivery_fee_tzs, platform_fee_tzs, total_tzs)
		 VALUES ($1, $2, 'paid', 12000, 2000, 1000, 15000) RETURNING id`,
		customerID, merchantID).Scan(&id); err != nil {
		t.Fatalf("seed order: %v", err)
	}
	if riderID != nil {
		if _, err := pool.Exec(ctx,
			`UPDATE orders SET rider_id = $1 WHERE id = $2`, *riderID, id); err != nil {
			t.Fatalf("bind rider: %v", err)
		}
	}
	t.Cleanup(func() {
		client := s.stores.Redis.Client()
		for _, role := range []string{"customer", "rider"} {
			_ = client.Del(context.Background(), maskedCallKey(id, role)).Err()
		}
		_, _ = pool.Exec(context.Background(), `DELETE FROM order_assignments WHERE order_id = $1`, id)
		_, _ = pool.Exec(context.Background(), `DELETE FROM order_events WHERE order_id = $1`, id)
		_, _ = pool.Exec(context.Background(), `DELETE FROM orders WHERE id = $1`, id)
	})
	return id
}

// seedMaskedCustomer creates a customer user and returns its phone, id and
// token.
func seedMaskedCustomer(t *testing.T, s *Server, pool *pgxpool.Pool, prefix string) (phone string, id uuid.UUID, token string) {
	t.Helper()
	phone = uniqueAdminPhone(t, prefix)
	id = seedAdminUser(t, pool, phone, "MaskedCall Customer "+phone, "customer", time.Now())
	return phone, id, tokenFor(t, s, phone, RoleCustomer, false)
}

// TestMaskedCallCustomerWithoutRiderCreatesSession: the owning customer is
// always a party — even on an order with no rider bound — and receives 201
// with the session id, the 5-minute expiry, the deterministic placeholder
// masked number and the customer_to_rider direction; the Redis session row
// carries sessionId/orderId/callerRole/expiresAt with a 5-minute TTL.
func TestMaskedCallCustomerWithoutRiderCreatesSession(t *testing.T) {
	s, pool := maskedPersistentServer(t)
	ctx := context.Background()
	_, customerID, customerToken := seedMaskedCustomer(t, s, pool, "mcc1")
	merchantID := seedAdminUser(t, pool, uniqueAdminPhone(t, "mcm1"), "MaskedCall Merchant", "merchant", time.Now())
	orderID := seedMaskedOrder(t, s, pool, customerID, merchantID, nil)

	rec := authedPOSTJSON(t, s.Router(), "/orders/"+orderID.String()+"/masked-call", "", customerToken)
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 201 (%s)", rec.Code, rec.Body)
	}
	var session gen.MaskedCallSession
	if err := json.NewDecoder(rec.Body).Decode(&session); err != nil {
		t.Fatalf("decode session: %v", err)
	}
	if session.SessionId == uuid.Nil {
		t.Fatal("missing session id")
	}
	if got := len(normalizeSessionID(session.SessionId.String())); got != 32 {
		t.Fatalf("session id hex length = %d, want 32", got)
	}
	if d := session.ExpiresAt.Sub(time.Now()); d < 250*time.Second || d > 310*time.Second {
		t.Fatalf("expiresAt delta = %v, want ~300s", d)
	}
	if session.Direction == nil || *session.Direction != gen.CustomerToRider {
		t.Fatalf("direction = %v, want customer_to_rider", session.Direction)
	}
	if session.OrderId == nil || *session.OrderId != orderID {
		t.Fatalf("orderId = %v, want %s", session.OrderId, orderID)
	}
	// Deterministic placeholder derived from the session id.
	if want := maskedPhoneFromSession(normalizeSessionID(session.SessionId.String())); session.MaskedNumber != want {
		t.Fatalf("maskedNumber = %q, want derived %q", session.MaskedNumber, want)
	}
	if !strings.HasPrefix(session.MaskedNumber, "07") || len(session.MaskedNumber) != 12 {
		t.Fatalf("maskedNumber = %q, want 07XX XXX XXX stub", session.MaskedNumber)
	}

	// Redis row: exactly the handler's fields plus the 5-minute TTL.
	fields, err := s.stores.Redis.Client().HGetAll(ctx, maskedCallKey(orderID, "customer")).Result()
	if err != nil {
		t.Fatalf("hgetall: %v", err)
	}
	if got := fields["sessionId"]; got != normalizeSessionID(session.SessionId.String()) {
		t.Fatalf("stored sessionId = %q, want %q", got, normalizeSessionID(session.SessionId.String()))
	}
	if got := fields["orderId"]; got != orderID.String() {
		t.Fatalf("stored orderId = %q, want %q", got, orderID.String())
	}
	if got := fields["callerRole"]; got != "customer" {
		t.Fatalf("stored callerRole = %q, want customer", got)
	}
	if got := fields["expiresAt"]; got == "" {
		t.Fatal("stored expiresAt missing")
	}
	ttl, err := s.stores.Redis.Client().TTL(ctx, maskedCallKey(orderID, "customer")).Result()
	if err != nil {
		t.Fatalf("ttl: %v", err)
	}
	if ttl < 250*time.Second || ttl > 310*time.Second {
		t.Fatalf("ttl = %v, want ~300s", ttl)
	}

	// VerifyMaskedCall accepts the presented id and rejects a wrong one.
	verified, err := s.VerifyMaskedCall(ctx, orderID, "customer", session.SessionId.String())
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if verified.SessionID != normalizeSessionID(session.SessionId.String()) || verified.OrderID != orderID.String() || verified.CallerRole != "customer" {
		t.Fatalf("verified session = %+v", verified)
	}
	if _, err := s.VerifyMaskedCall(ctx, orderID, "customer", "deadbeefdeadbeefdeadbeefdeadbeef"); err != errMaskedCallExpired {
		t.Fatalf("verify wrong id err = %v, want errMaskedCallExpired", err)
	}
}

// TestMaskedCallAssignedRiderCreatesSession: the owner of the riders row the
// order is bound to may open the rider-side session (201, direction
// rider_to_customer); the session lands under call:{orderId}:rider.
func TestMaskedCallAssignedRiderCreatesSession(t *testing.T) {
	s, pool := maskedPersistentServer(t)
	ctx := context.Background()
	customerID := seedAdminUser(t, pool, uniqueAdminPhone(t, "mcc2"), "MaskedCall Customer", "customer", time.Now())
	merchantID := seedAdminUser(t, pool, uniqueAdminPhone(t, "mcm2"), "MaskedCall Merchant", "merchant", time.Now())
	_, riderID, riderPhone := seedMaskedRider(t, pool, "mcr2")
	orderID := seedMaskedOrder(t, s, pool, customerID, merchantID, &riderID)
	riderToken := tokenFor(t, s, riderPhone, RoleRider, false)

	rec := authedPOSTJSON(t, s.Router(), "/orders/"+orderID.String()+"/masked-call", "", riderToken)
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 201 (%s)", rec.Code, rec.Body)
	}
	var session gen.MaskedCallSession
	if err := json.NewDecoder(rec.Body).Decode(&session); err != nil {
		t.Fatalf("decode session: %v", err)
	}
	if session.SessionId == uuid.Nil {
		t.Fatal("missing session id")
	}
	if session.Direction == nil || *session.Direction != gen.RiderToCustomer {
		t.Fatalf("direction = %v, want rider_to_customer", session.Direction)
	}

	fields, err := s.stores.Redis.Client().HGetAll(ctx, maskedCallKey(orderID, "rider")).Result()
	if err != nil {
		t.Fatalf("hgetall: %v", err)
	}
	if got := fields["sessionId"]; got != normalizeSessionID(session.SessionId.String()) {
		t.Fatalf("stored sessionId = %q, want %q", got, normalizeSessionID(session.SessionId.String()))
	}
	if got := fields["callerRole"]; got != "rider" {
		t.Fatalf("stored callerRole = %q, want rider", got)
	}
	if _, err := s.VerifyMaskedCall(ctx, orderID, "rider", session.SessionId.String()); err != nil {
		t.Fatalf("verify rider session: %v", err)
	}
}

// TestMaskedCallRiderNotAssignedForbidden: a rider whose riders row is not
// bound to the order gets the documented 403 MASKED_CALL_NOT_ALLOWED (the
// dispatch-context denial), never ORDER_NOT_FOUND.
func TestMaskedCallRiderNotAssignedForbidden(t *testing.T) {
	s, pool := maskedPersistentServer(t)
	customerID := seedAdminUser(t, pool, uniqueAdminPhone(t, "mcc3"), "MaskedCall Customer", "customer", time.Now())
	merchantID := seedAdminUser(t, pool, uniqueAdminPhone(t, "mcm3"), "MaskedCall Merchant", "merchant", time.Now())
	_, _, riderPhone := seedMaskedRider(t, pool, "mcr3")
	orderID := seedMaskedOrder(t, s, pool, customerID, merchantID, nil)
	riderToken := tokenFor(t, s, riderPhone, RoleRider, false)

	rec := authedPOSTJSON(t, s.Router(), "/orders/"+orderID.String()+"/masked-call", "", riderToken)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403 (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
		t.Fatalf("decode error body: %v", err)
	}
	if errBody.Code != "MASKED_CALL_NOT_ALLOWED" {
		t.Fatalf("error code = %q, want MASKED_CALL_NOT_ALLOWED", errBody.Code)
	}
}

// TestMaskedCallNonPartyOrderNotFound: a user with no relation to the order
// sees the same 404 ORDER_NOT_FOUND as a missing order — existence never
// leaks.
func TestMaskedCallNonPartyOrderNotFound(t *testing.T) {
	s, pool := maskedPersistentServer(t)
	customerID := seedAdminUser(t, pool, uniqueAdminPhone(t, "mcc4"), "MaskedCall Customer", "customer", time.Now())
	merchantID := seedAdminUser(t, pool, uniqueAdminPhone(t, "mcm4"), "MaskedCall Merchant", "merchant", time.Now())
	orderID := seedMaskedOrder(t, s, pool, customerID, merchantID, nil)
	_, _, outsiderToken := seedMaskedCustomer(t, s, pool, "mco4")

	rec := authedPOSTJSON(t, s.Router(), "/orders/"+orderID.String()+"/masked-call", "", outsiderToken)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404 (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
		t.Fatalf("decode error body: %v", err)
	}
	if errBody.Code != "ORDER_NOT_FOUND" {
		t.Fatalf("error code = %q, want ORDER_NOT_FOUND", errBody.Code)
	}
}

// TestMaskedCallUnknownOrderNotFound: an order id that matches no row is a
// 404 ORDER_NOT_FOUND for a party user.
func TestMaskedCallUnknownOrderNotFound(t *testing.T) {
	s, pool := maskedPersistentServer(t)
	_, _, customerToken := seedMaskedCustomer(t, s, pool, "mcc5")

	rec := authedPOSTJSON(t, s.Router(), "/orders/"+uuid.NewString()+"/masked-call", "", customerToken)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404 (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
		t.Fatalf("decode error body: %v", err)
	}
	if errBody.Code != "ORDER_NOT_FOUND" {
		t.Fatalf("error code = %q, want ORDER_NOT_FOUND", errBody.Code)
	}
}

// TestMaskedCallExpiredSession: a live session created through the handler
// verifies, and VerifyMaskedCall reports MASKED_CALL_EXPIRED semantics once
// the stored session is dead — here the key is replaced directly with a row
// carrying an already-past expiresAt and no TTL, the deterministic stand-in
// for a session whose 5-minute TTL shrank to nothing.
func TestMaskedCallExpiredSession(t *testing.T) {
	s, pool := maskedPersistentServer(t)
	ctx := context.Background()
	_, customerID, customerToken := seedMaskedCustomer(t, s, pool, "mcc6")
	merchantID := seedAdminUser(t, pool, uniqueAdminPhone(t, "mcm6"), "MaskedCall Merchant", "merchant", time.Now())
	orderID := seedMaskedOrder(t, s, pool, customerID, merchantID, nil)

	rec := authedPOSTJSON(t, s.Router(), "/orders/"+orderID.String()+"/masked-call", "", customerToken)
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 201 (%s)", rec.Code, rec.Body)
	}
	var live gen.MaskedCallSession
	if err := json.NewDecoder(rec.Body).Decode(&live); err != nil {
		t.Fatalf("decode session: %v", err)
	}
	if _, err := s.VerifyMaskedCall(ctx, orderID, "customer", live.SessionId.String()); err != nil {
		t.Fatalf("verify live session: %v", err)
	}

	key := maskedCallKey(orderID, "customer")
	client := s.stores.Redis.Client()
	// No TTL and a past expiry: the key still exists but every liveness
	// check (TTL and stored expiresAt) fails.
	if err := client.HSet(ctx, key, map[string]any{
		"sessionId":  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		"orderId":    orderID.String(),
		"callerRole": "customer",
		"expiresAt":  time.Now().Add(-time.Minute).UTC().Format(time.RFC3339),
	}).Err(); err != nil {
		t.Fatalf("insert expired session: %v", err)
	}

	if _, err := s.VerifyMaskedCall(ctx, orderID, "customer", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"); err != errMaskedCallExpired {
		t.Fatalf("verify expired session err = %v, want errMaskedCallExpired", err)
	}
}

// TestMaskedCallGatewayNumberAllocated: with MASKED_CALL_GATEWAY_URL set to a
// real httptest gateway, the session carries the gateway-allocated masked
// number and the gateway receives the {sessionId, orderId} pair. The env var
// is restored by t.Setenv after the test.
func TestMaskedCallGatewayNumberAllocated(t *testing.T) {
	s, pool := maskedPersistentServer(t)
	ctx := context.Background()
	_, customerID, customerToken := seedMaskedCustomer(t, s, pool, "mccg1")
	merchantID := seedAdminUser(t, pool, uniqueAdminPhone(t, "mcmg1"), "MaskedCall Merchant", "merchant", time.Now())
	orderID := seedMaskedOrder(t, s, pool, customerID, merchantID, nil)

	var got struct {
		SessionID string `json:"sessionId"`
		OrderID   string `json:"orderId"`
	}
	gw := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&got)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"maskedPhone":"0712 345 678"}`))
	}))
	defer gw.Close()
	t.Setenv("MASKED_CALL_GATEWAY_URL", gw.URL)

	rec := authedPOSTJSON(t, s.Router(), "/orders/"+orderID.String()+"/masked-call", "", customerToken)
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 201 (%s)", rec.Code, rec.Body)
	}
	var session gen.MaskedCallSession
	if err := json.NewDecoder(rec.Body).Decode(&session); err != nil {
		t.Fatalf("decode session: %v", err)
	}
	if session.MaskedNumber != "0712 345 678" {
		t.Fatalf("maskedNumber = %q, want the gateway value", session.MaskedNumber)
	}
	if got.SessionID == "" || got.OrderID != orderID.String() {
		t.Fatalf("gateway payload = %+v, want a sessionId and orderId %s", got, orderID)
	}
	if _, err := s.VerifyMaskedCall(ctx, orderID, "customer", session.SessionId.String()); err != nil {
		t.Fatalf("verify gateway session: %v", err)
	}
}
