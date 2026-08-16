package api

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/hudumika/api-backend/internal/auth"
	"github.com/hudumika/api-backend/internal/gen"
	"github.com/hudumika/api-backend/internal/orders"
)

// CUSTOMER SIMULATOR (ARCHITECTURE.md): a staging-only internal key
// (SIMULATOR_KEY, set only in staging/dev; the gate answers 403 when it is
// unset) emulates the customer platform — orders, chat, rush — end to end so
// E2E suites can drive the real handlers without a mobile client. The whole
// surface lives under /internal/simulate/*, OUTSIDE the auth-wrapped tree:
// every flow mints its own customer/merchant sessions through the server's
// own buildSession path, exactly like a verified OTP login.
//
// The simulator is never exposed in production: SIMULATOR_KEY is not part of
// the production config and the endpoints are unreachable without it.

// simulatorGate guards the /internal/simulate/* surface. A missing
// SIMULATOR_KEY env var (production, or an unconfigured staging box) answers
// 403 FORBIDDEN before anything runs; the x-internal-key header is compared
// to the key in constant time (crypto/subtle) so timing never leaks a
// prefix. On success the request is forwarded with synthetic customer claims
// so downstream handlers see an authenticated customer session.
func (s *Server) simulatorGate(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		key := os.Getenv("SIMULATOR_KEY")
		if key == "" {
			writeError(w, http.StatusForbidden, "FORBIDDEN", "Internal simulator is not configured")
			return
		}
		got := r.Header.Get("x-internal-key")
		if subtle.ConstantTimeCompare([]byte(got), []byte(key)) != 1 {
			writeError(w, http.StatusForbidden, "FORBIDDEN", "Invalid internal key")
			return
		}
		claims := &Claims{Role: RoleCustomer}
		claims.Subject = "simulator"
		ctx := context.WithValue(r.Context(), claimsContextKey, claims)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// simulateOrderRequest is the body of POST /internal/simulate/order.
type simulateOrderRequest struct {
	// Destination is the customer phone; it is the unique identifier of a
	// simulated run (unique destinations make re-runs idempotent-ish).
	Destination string `json:"destination"`
	// ItemID optionally reuses an existing catalogue item; when omitted the
	// simulator seeds a fresh one.
	ItemID *uuid.UUID `json:"itemId"`
	// MerchantID optionally reuses an existing merchant (users row id or
	// merchants row id); when omitted the simulator seeds a fresh merchant.
	MerchantID *uuid.UUID `json:"merchantId"`
}

// simulateOrderTrace is the full trace of one simulated order flow. Status is
// the order status; IntentStatus the payment intent status (paid). The Events
// array is the order_events history — the provider-webhook path flips the
// order row to paid via UpdateOrderToPaid without appending an order event
// (the payment leg's trail lives in payment_transactions), so a webhook-paid
// order's events carry created + merchant_accepted.
type simulateOrderTrace struct {
	OrderID      uuid.UUID        `json:"orderId"`
	IntentID     uuid.UUID        `json:"intentId"`
	IntentStatus string           `json:"intentStatus"`
	Status       string           `json:"status"`
	Events       []gen.OrderEvent `json:"events"`
}

// SimulateOrderFlow is a one-shot end-to-end order run (POST
// /internal/simulate/order): mint a customer session, create the order via
// the orders store (server-computed prices), create a payment intent,
// simulate the signed provider webhook through the real PaymentWebhook
// handler, accept the order as the merchant, and return the full trace.
func (s *Server) SimulateOrderFlow(w http.ResponseWriter, r *http.Request) {
	var body simulateOrderRequest
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if body.Destination == "" {
		writeError(w, http.StatusBadRequest, "VALIDATION_FAILED", "destination (customer phone) is required")
		return
	}
	if s.db == nil {
		s.logger.Error("simulate order failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	ctx := r.Context()

	customerID, err := auth.NewRepo(s.db.Pool()).UpsertUserByPhone(ctx, body.Destination)
	if err != nil {
		s.simulateFail(w, "simulate order: customer upsert", err)
		return
	}
	if err := s.simulateSession(ctx, body.Destination, RoleCustomer); err != nil {
		s.simulateFail(w, "simulate order: customer session", err)
		return
	}
	merchantID, itemID, err := s.simulateMerchant(ctx, body.MerchantID, body.ItemID)
	if err != nil {
		s.simulateFail(w, "simulate order: merchant fixture", err)
		return
	}

	st := orders.NewStore(s.db.Pool())
	row, err := st.CreateOrder(ctx, orders.CreateOrderInput{
		CustomerUserID: customerID,
		MerchantID:     merchantID,
		Items:          []orders.CreateOrderItem{{CatalogueItemID: itemID, Quantity: 1}},
		IdempotencyKey: uuid.NewString(),
		Source:         "simulator",
	})
	if err != nil {
		s.simulateFail(w, "simulate order: create", err)
		return
	}

	pt := s.paymentStore()
	total, found, err := pt.GetOrderTotal(ctx, row.ID, customerID)
	if err != nil || !found {
		s.simulateFail(w, "simulate order: order total", err)
		return
	}
	intent, err := pt.CreateIntent(ctx, row.ID, "mpesa", total, "sim:"+uuid.NewString())
	if err != nil {
		s.simulateFail(w, "simulate order: create intent", err)
		return
	}
	if err := s.simulatePaidWebhook(ctx, row.ID); err != nil {
		s.simulateFail(w, "simulate order: provider webhook", err)
		return
	}

	paid, err := st.GetOrderRow(ctx, row.ID)
	if err != nil {
		s.simulateFail(w, "simulate order: reload paid order", err)
		return
	}
	if _, err := st.AcceptOrder(ctx, row.ID, paid.Version, merchantID); err != nil {
		s.simulateFail(w, "simulate order: accept", err)
		return
	}

	detail, err := st.GetOrderDetail(ctx, row.ID)
	if err != nil {
		s.simulateFail(w, "simulate order: reload detail", err)
		return
	}
	writeJSON(w, http.StatusOK, simulateOrderTrace{
		OrderID:      row.ID,
		IntentID:     intent.ID,
		IntentStatus: "paid",
		Status:       detail.Order.Status,
		Events:       toGenOrderEvents(detail.Events),
	})
}

// simulateChatRequest is the body of POST /internal/simulate/chat.
type simulateChatRequest struct {
	// CustomerPhone is the customer side of the conversation; unique per run.
	CustomerPhone string `json:"customerPhone"`
	// MerchantID optionally reuses an existing merchant (users row id, the
	// conversations.merchant_id convention); when omitted the simulator seeds
	// a fresh merchant.
	MerchantID *uuid.UUID `json:"merchantId"`
}

// simulateChatResult is the outcome of one simulated chat flow.
type simulateChatResult struct {
	ConversationID uuid.UUID   `json:"conversationId"`
	MessageIds     []uuid.UUID `json:"messageIds"`
}

// SimulateChatFlow opens a conversation between a customer and a merchant and
// posts one message per side (POST /internal/simulate/chat): two sessions are
// minted through the server's own session path and the rows are written in
// one transaction with the unread counters bumped, mirroring the real
// handlers. The (customer, merchant) pair is unique, so a re-run for the same
// pair reuses the existing conversation and appends two more messages.
func (s *Server) SimulateChatFlow(w http.ResponseWriter, r *http.Request) {
	var body simulateChatRequest
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if body.CustomerPhone == "" {
		writeError(w, http.StatusBadRequest, "VALIDATION_FAILED", "customerPhone is required")
		return
	}
	if s.db == nil {
		s.logger.Error("simulate chat failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	ctx := r.Context()

	repo := auth.NewRepo(s.db.Pool())
	customerID, err := repo.UpsertUserByPhone(ctx, body.CustomerPhone)
	if err != nil {
		s.simulateFail(w, "simulate chat: customer upsert", err)
		return
	}
	if err := s.simulateSession(ctx, body.CustomerPhone, RoleCustomer); err != nil {
		s.simulateFail(w, "simulate chat: customer session", err)
		return
	}

	merchantID := body.MerchantID
	merchantPhone := ""
	if merchantID != nil {
		if err := s.db.Pool().QueryRow(ctx,
			`SELECT phone FROM users WHERE id = $1`, *merchantID).Scan(&merchantPhone); err != nil {
			writeError(w, http.StatusBadRequest, "VALIDATION_FAILED", "merchantId is not a known user")
			return
		}
	} else {
		merchantPhone = simulatePhone("merc")
		id, err := repo.UpsertUserByPhone(ctx, merchantPhone)
		if err != nil {
			s.simulateFail(w, "simulate chat: merchant upsert", err)
			return
		}
		merchantID = &id
	}
	if err := s.simulateSession(ctx, merchantPhone, RoleMerchant); err != nil {
		s.simulateFail(w, "simulate chat: merchant session", err)
		return
	}

	tx, err := s.db.Pool().Begin(ctx)
	if err != nil {
		s.simulateFail(w, "simulate chat: begin", err)
		return
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var convID uuid.UUID
	err = tx.QueryRow(ctx,
		`INSERT INTO conversations (customer_user_id, merchant_id, subject)
		 VALUES ($1, $2, $3)
		 ON CONFLICT (customer_user_id, merchant_id) DO NOTHING
		 RETURNING id`,
		customerID, *merchantID, "Simulator chat").Scan(&convID)
	if errors.Is(err, pgx.ErrNoRows) {
		// The pair already exists: reuse the conversation (idempotent-ish).
		if err := tx.QueryRow(ctx,
			`SELECT id FROM conversations WHERE customer_user_id = $1 AND merchant_id = $2`,
			customerID, *merchantID).Scan(&convID); err != nil {
			s.simulateFail(w, "simulate chat: reload conversation", err)
			return
		}
	} else if err != nil {
		s.simulateFail(w, "simulate chat: create conversation", err)
		return
	}

	now := time.Now()
	var (
		customerMsg uuid.UUID
		merchantMsg uuid.UUID
	)
	if err := tx.QueryRow(ctx,
		`INSERT INTO conversation_messages (conversation_id, author_user_id, author_role, body)
		 VALUES ($1, $2, 'customer', $3) RETURNING id`,
		convID, customerID, "Hello! I'd like to place an order.").Scan(&customerMsg); err != nil {
		s.simulateFail(w, "simulate chat: customer message", err)
		return
	}
	if _, err := tx.Exec(ctx,
		`UPDATE conversations
		 SET unread_merchant = unread_merchant + 1, last_message_at = $2, updated_at = $2
		 WHERE id = $1`,
		convID, now); err != nil {
		s.simulateFail(w, "simulate chat: bump merchant unread", err)
		return
	}
	if err := tx.QueryRow(ctx,
		`INSERT INTO conversation_messages (conversation_id, author_user_id, author_role, body)
		 VALUES ($1, $2, 'merchant', $3) RETURNING id`,
		convID, *merchantID, "Hi! How can we help you today?").Scan(&merchantMsg); err != nil {
		s.simulateFail(w, "simulate chat: merchant message", err)
		return
	}
	if _, err := tx.Exec(ctx,
		`UPDATE conversations
		 SET unread_customer = unread_customer + 1, last_message_at = $2, updated_at = $2
		 WHERE id = $1`,
		convID, now); err != nil {
		s.simulateFail(w, "simulate chat: bump customer unread", err)
		return
	}
	if err := tx.Commit(ctx); err != nil {
		s.simulateFail(w, "simulate chat: commit", err)
		return
	}

	writeJSON(w, http.StatusOK, simulateChatResult{
		ConversationID: convID,
		MessageIds:     []uuid.UUID{customerMsg, merchantMsg},
	})
}

// simulateRushRequest is the body of POST /internal/simulate/rush.
type simulateRushRequest struct {
	// OrderID optionally reuses an existing paid order; when omitted the
	// simulator builds a fresh paid order (unique run).
	OrderID *uuid.UUID `json:"orderId"`
}

// simulateRushResult is the rush outcome with the store timestamps.
type simulateRushResult struct {
	OrderID     uuid.UUID  `json:"orderId"`
	RequestedAt time.Time  `json:"requestedAt"`
	RepliedAt   *time.Time `json:"repliedAt,omitempty"`
	DeadlineAt  *time.Time `json:"deadlineAt,omitempty"`
}

// SimulateRushFlow drives the hurry-up flow end to end (POST
// /internal/simulate/rush): a paid order (reused from orderId or built
// fresh), a customer rush request and the merchant reply, returning the rush
// timestamps the store recorded.
func (s *Server) SimulateRushFlow(w http.ResponseWriter, r *http.Request) {
	var body simulateRushRequest
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if s.db == nil {
		s.logger.Error("simulate rush failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	ctx := r.Context()
	st := orders.NewStore(s.db.Pool())

	var (
		orderID  uuid.UUID
		customer uuid.UUID
		merchant uuid.UUID
	)
	if body.OrderID != nil {
		row, err := st.GetOrderRow(ctx, *body.OrderID)
		if errors.Is(err, orders.ErrNotFound) {
			writeError(w, http.StatusBadRequest, "VALIDATION_FAILED", "orderId is not a known order")
			return
		}
		if err != nil {
			s.simulateFail(w, "simulate rush: load order", err)
			return
		}
		if row.Status != "paid" {
			writeError(w, http.StatusBadRequest, "VALIDATION_FAILED", "orderId must be a paid order")
			return
		}
		orderID, customer, merchant = row.ID, row.CustomerUserID, row.MerchantID
	} else {
		var err error
		orderID, customer, merchant, err = s.simulateRushOrder(ctx)
		if err != nil {
			s.simulateFail(w, "simulate rush: build paid order", err)
			return
		}
	}

	detail, err := st.RequestRush(ctx, orderID, customer)
	switch {
	case errors.Is(err, orders.ErrNotFound):
		writeError(w, http.StatusBadRequest, "VALIDATION_FAILED", "orderId is not a known order")
		return
	case errors.Is(err, orders.ErrConflict):
		writeError(w, http.StatusConflict, "ORDER_RUSH_NOT_ALLOWED", "Order cannot be rushed in its current state")
		return
	case err != nil:
		s.simulateFail(w, "simulate rush: request", err)
		return
	}

	replied, err := st.ReplyRush(ctx, orderID, merchant, "On it — your order is being expedited")
	switch {
	case errors.Is(err, orders.ErrRushNotOpen):
		writeError(w, http.StatusConflict, "RUSH_NOT_OPEN", "No rush request is open for this order")
		return
	case errors.Is(err, orders.ErrRushReplied):
		writeError(w, http.StatusConflict, "RUSH_ALREADY_REPLIED", "Rush request has already been replied to")
		return
	case err != nil:
		s.simulateFail(w, "simulate rush: reply", err)
		return
	}

	writeJSON(w, http.StatusOK, simulateRushResult{
		OrderID:     orderID,
		RequestedAt: detail.RequestedAt,
		RepliedAt:   replied.RepliedAt,
		DeadlineAt:  replied.DeadlineAt,
	})
}

// simulateSession mints and persists a session for the subject through the
// server's own mint path (buildSession — the same path a verified OTP login
// uses), so the simulated identity is indistinguishable from a real one.
func (s *Server) simulateSession(ctx context.Context, subject, role string) error {
	out, err := s.buildSession(ctx, subject, role, time.Now())
	if err != nil {
		return err
	}
	return s.stores.Sessions.Create(ctx, out.record)
}

// simulateMerchant resolves or builds the merchant fixture of a simulated
// order: an explicit itemId is loaded and its owning merchant is used; an
// explicit merchantId seeds a fresh catalogue item; otherwise a brand-new
// merchant user and item are created. orders.merchant_id and
// catalogue_items.merchant_id carry no FK, so the merchant users row id
// doubles as the entity id exactly like the pre-linkage fixture convention
// used across the integration suites.
func (s *Server) simulateMerchant(ctx context.Context, merchantID, itemID *uuid.UUID) (uuid.UUID, uuid.UUID, error) {
	st := orders.NewStore(s.db.Pool())
	if itemID != nil {
		items, err := st.GetCatalogueItems(ctx, []uuid.UUID{*itemID})
		if err != nil {
			return uuid.Nil, uuid.Nil, fmt.Errorf("simulator: load item: %w", err)
		}
		item, ok := items[*itemID]
		if !ok || !item.Available {
			return uuid.Nil, uuid.Nil, errors.New("simulator: item unavailable")
		}
		return item.MerchantID, *itemID, nil
	}
	if merchantID == nil {
		id, err := auth.NewRepo(s.db.Pool()).UpsertUserByPhone(ctx, simulatePhone("merc"))
		if err != nil {
			return uuid.Nil, uuid.Nil, fmt.Errorf("simulator: create merchant user: %w", err)
		}
		merchantID = &id
	}
	var item uuid.UUID
	if err := s.db.Pool().QueryRow(ctx,
		`INSERT INTO catalogue_items (merchant_id, name, price_tzs)
		 VALUES ($1, $2, $3) RETURNING id`,
		*merchantID, "Simulator item", 5000).Scan(&item); err != nil {
		return uuid.Nil, uuid.Nil, fmt.Errorf("simulator: create catalogue item: %w", err)
	}
	return *merchantID, item, nil
}

// simulateRushOrder builds a paid order from scratch: customer + merchant
// users, a catalogue item, a draft order and the two guarded transitions to
// paid (draft -> pending_payment -> paid). The provider webhook is not part
// of the rush fixture — the transitions are the order state machine's own
// path.
func (s *Server) simulateRushOrder(ctx context.Context) (uuid.UUID, uuid.UUID, uuid.UUID, error) {
	repo := auth.NewRepo(s.db.Pool())
	customerID, err := repo.UpsertUserByPhone(ctx, simulatePhone("cust"))
	if err != nil {
		return uuid.Nil, uuid.Nil, uuid.Nil, fmt.Errorf("simulator: rush customer upsert: %w", err)
	}
	merchantID, err := repo.UpsertUserByPhone(ctx, simulatePhone("merc"))
	if err != nil {
		return uuid.Nil, uuid.Nil, uuid.Nil, fmt.Errorf("simulator: rush merchant upsert: %w", err)
	}
	var itemID uuid.UUID
	if err := s.db.Pool().QueryRow(ctx,
		`INSERT INTO catalogue_items (merchant_id, name, price_tzs)
		 VALUES ($1, $2, $3) RETURNING id`,
		merchantID, "Simulator rush item", 5000).Scan(&itemID); err != nil {
		return uuid.Nil, uuid.Nil, uuid.Nil, fmt.Errorf("simulator: rush item: %w", err)
	}
	st := orders.NewStore(s.db.Pool())
	row, err := st.CreateOrder(ctx, orders.CreateOrderInput{
		CustomerUserID: customerID,
		MerchantID:     merchantID,
		Items:          []orders.CreateOrderItem{{CatalogueItemID: itemID, Quantity: 1}},
		IdempotencyKey: uuid.NewString(),
		Source:         "simulator",
	})
	if err != nil {
		return uuid.Nil, uuid.Nil, uuid.Nil, fmt.Errorf("simulator: rush order create: %w", err)
	}
	if _, err := st.TransitionOrder(ctx, row.ID, 1, []string{"draft"}, "pending_payment", customerID, ""); err != nil {
		return uuid.Nil, uuid.Nil, uuid.Nil, fmt.Errorf("simulator: rush pay step 1: %w", err)
	}
	if _, err := st.TransitionOrder(ctx, row.ID, 2, []string{"pending_payment"}, "paid", customerID, ""); err != nil {
		return uuid.Nil, uuid.Nil, uuid.Nil, fmt.Errorf("simulator: rush pay step 2: %w", err)
	}
	return row.ID, customerID, merchantID, nil
}

// simulatePaidWebhook signs a "paid" provider webhook for the order's intent
// with PAYMENT_WEBHOOK_SECRET and runs it through the same PaymentWebhook
// handler the providers call — the signature is the only trust anchor there,
// so the simulation exercises the real verification and state machine.
func (s *Server) simulatePaidWebhook(ctx context.Context, orderID uuid.UUID) error {
	secret := os.Getenv("PAYMENT_WEBHOOK_SECRET")
	if secret == "" {
		return errors.New("simulator: PAYMENT_WEBHOOK_SECRET is not configured")
	}
	payload, err := json.Marshal(webhookPayload{
		OrderID:   orderID,
		Reference: "sim-" + orderID.String(),
		Status:    "paid",
	})
	if err != nil {
		return fmt.Errorf("simulator: encode webhook payload: %w", err)
	}
	req := httptest.NewRequest(http.MethodPost, "/payments/webhooks/mpesa", bytes.NewReader(payload))
	req = req.WithContext(ctx)
	req.Header.Set("X-Webhook-Signature", simulateHMAC(secret, payload))
	rec := httptest.NewRecorder()
	s.PaymentWebhook(rec, req, gen.PaymentWebhookParamsProvider("mpesa"))
	if rec.Code != http.StatusOK {
		return fmt.Errorf("simulator: webhook handler answered %d: %s", rec.Code, rec.Body.String())
	}
	return nil
}

// simulateHMAC is the hex HMAC-SHA256 of body keyed by secret, the
// X-Webhook-Signature form payments.VerifySignature accepts.
func simulateHMAC(secret string, body []byte) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	return hex.EncodeToString(mac.Sum(nil))
}

// simulatePhone builds a per-run unique phone (the simulator's own +25596
// range; the integration suite deletes users by this prefix at cleanup).
func simulatePhone(role string) string {
	return fmt.Sprintf("+25596%s%09d", role[:1], time.Now().UnixNano()%1_000_000_000)
}

// simulateFail logs and answers the 500 envelope shared by the simulator
// flows. Errors are always wrapped at the call site so the log line carries
// the failing step.
func (s *Server) simulateFail(w http.ResponseWriter, op string, err error) {
	s.logger.Error("simulator flow failed", "op", op, "error", err)
	writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
}
