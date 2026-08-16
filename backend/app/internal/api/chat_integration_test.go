//go:build integration

// CHAT bounded context integration tests against real PostgreSQL + Redis.
//
//	cd app && go test -tags integration ./internal/api/ -run 'Chat|Conversation|Unread' -count=1
//
// This suite owns the chat tables (migration 00025): it truncates
// conversation_messages and conversations at setup, and clears its own users
// (phone prefix +25578...) — it never truncates shared tables.
package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/hudumika/api-backend/internal/gen"
)

// chatPhonePrefix identifies every users row this suite inserts.
const chatPhonePrefix = "+25577"

// chatTables are the tables owned by this suite (migration 00025), in
// foreign-key order.
var chatTables = []string{"conversation_messages", "conversations"}

// chatSetup wires a persistent server and truncates only this suite's
// tables plus its own users.
func chatSetup(t *testing.T) (*Server, *pgxpool.Pool) {
	t.Helper()
	s, pool := newPersistentServer(t)
	ctx := context.Background()
	if _, err := pool.Exec(ctx, "TRUNCATE "+strings.Join(chatTables, ", ")); err != nil {
		t.Fatalf("truncate chat tables: %v", err)
	}
	if _, err := pool.Exec(ctx, `DELETE FROM users WHERE phone LIKE '`+chatPhonePrefix+`%'`); err != nil {
		t.Fatalf("clear chat users: %v", err)
	}
	return s, pool
}

// chatUser inserts a users row with a per-run unique phone and returns the
// id and phone. merchant_id in conversations is the merchant's users row id,
// so the same helper seeds both sides of a conversation.
func chatUser(t *testing.T, pool *pgxpool.Pool) (uuid.UUID, string) {
	t.Helper()
	ctx := context.Background()
	phone := fmt.Sprintf("%s%08d", chatPhonePrefix, time.Now().UnixNano()%100_000_000)
	userID := uuid.New()
	if _, err := pool.Exec(ctx, `INSERT INTO users (id, phone) VALUES ($1, $2)`, userID, phone); err != nil {
		t.Fatalf("insert chat user: %v", err)
	}
	return userID, phone
}

// chatCreate opens a conversation through the API and returns the recorder
// and the decoded conversation.
func chatCreate(t *testing.T, h http.Handler, token, merchantID string) (*httptest.ResponseRecorder, gen.Conversation) {
	t.Helper()
	rec := authedDo(t, h, http.MethodPost, "/conversations",
		fmt.Sprintf(`{"merchantId":"%s","subject":"Order help","initialMessage":"hello"}`, merchantID), token)
	var conv gen.Conversation
	if err := json.NewDecoder(rec.Body).Decode(&conv); err != nil {
		t.Fatalf("decode conversation: %v (%s)", err, rec.Body)
	}
	return rec, conv
}

// chatUnreadCount GETs the caller's unread badge.
func chatUnreadCount(t *testing.T, h http.Handler, token string) int {
	t.Helper()
	rec := authedDo(t, h, http.MethodGet, "/conversations/unread-count", "", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("unread-count = %d (%s)", rec.Code, rec.Body)
	}
	var body struct {
		Count int `json:"count"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("decode unread count: %v", err)
	}
	return body.Count
}

// TestChatCreateGetLifecycle covers create → detail → lists → badge counts
// for both sides of a fresh conversation.
func TestChatCreateGetLifecycle(t *testing.T) {
	s, pool := chatSetup(t)
	_, customerPhone := chatUser(t, pool)
	merchantID, merchantPhone := chatUser(t, pool)
	customerToken := tokenFor(t, s, customerPhone, RoleCustomer, false)
	merchantToken := tokenFor(t, s, merchantPhone, RoleMerchant, false)
	h := s.Router()

	rec, conv := chatCreate(t, h, customerToken, merchantID.String())
	if rec.Code != http.StatusCreated {
		t.Fatalf("create = %d, want 201 (%s)", rec.Code, rec.Body)
	}
	if conv.Status != gen.ConversationStatusOpen {
		t.Fatalf("status = %q, want open", conv.Status)
	}
	if conv.MerchantId.String() != merchantID.String() {
		t.Fatalf("merchantId = %s, want %s", conv.MerchantId, merchantID)
	}
	if conv.UnreadCount != 0 {
		t.Fatalf("customer unread = %d, want 0", conv.UnreadCount)
	}
	if conv.LastMessagePreview != "hello" {
		t.Fatalf("preview = %q, want hello", conv.LastMessagePreview)
	}

	// The initial message bumped the merchant side, not the customer side.
	if got := chatUnreadCount(t, h, merchantToken); got != 1 {
		t.Fatalf("merchant unread count = %d, want 1", got)
	}
	if got := chatUnreadCount(t, h, customerToken); got != 0 {
		t.Fatalf("customer unread count = %d, want 0", got)
	}

	// Detail from the merchant side exposes the merchant unread counter.
	rec = authedDo(t, h, http.MethodGet, "/conversations/"+conv.Id.String(), "", merchantToken)
	if rec.Code != http.StatusOK {
		t.Fatalf("get as merchant = %d (%s)", rec.Code, rec.Body)
	}
	var detail gen.ConversationDetail
	if err := json.NewDecoder(rec.Body).Decode(&detail); err != nil {
		t.Fatalf("decode detail: %v", err)
	}
	if detail.UnreadCount != 1 {
		t.Fatalf("merchant detail unread = %d, want 1", detail.UnreadCount)
	}
	if len(detail.Participants) != 2 {
		t.Fatalf("participants = %d, want 2", len(detail.Participants))
	}
	if detail.Participants[0].Role != gen.ConversationDetailParticipantsRoleCustomer ||
		detail.Participants[1].Role != gen.ConversationDetailParticipantsRoleMerchantStaff {
		t.Fatalf("participant roles = %q, %q; want customer, merchant_staff",
			detail.Participants[0].Role, detail.Participants[1].Role)
	}

	// Both sides list the conversation, newest activity first.
	rec = authedDo(t, h, http.MethodGet, "/conversations", "", customerToken)
	if rec.Code != http.StatusOK {
		t.Fatalf("list as customer = %d (%s)", rec.Code, rec.Body)
	}
	var list []gen.Conversation
	if err := json.NewDecoder(rec.Body).Decode(&list); err != nil {
		t.Fatalf("decode list: %v", err)
	}
	if len(list) != 1 || list[0].Id != conv.Id {
		t.Fatalf("customer list = %d conversations, want [%s]", len(list), conv.Id)
	}
	if list[0].LastMessagePreview != "hello" {
		t.Fatalf("list preview = %q, want hello", list[0].LastMessagePreview)
	}
	if list[0].UnreadCount != 0 {
		t.Fatalf("customer list unread = %d, want 0", list[0].UnreadCount)
	}

	rec = authedDo(t, h, http.MethodGet, "/conversations", "", merchantToken)
	if err := json.NewDecoder(rec.Body).Decode(&list); err != nil {
		t.Fatalf("decode merchant list: %v", err)
	}
	if len(list) != 1 || list[0].UnreadCount != 1 {
		t.Fatalf("merchant list = %d with unread %d, want 1 with 1", len(list), list[0].UnreadCount)
	}
	if rec.Header().Get("X-Next-Cursor") != "" {
		t.Fatalf("single-page list advertised a next cursor: %q", rec.Header().Get("X-Next-Cursor"))
	}
}

// TestChatDuplicateCreateReturnsExisting: the (customer, merchant) pair is
// unique, so a second create returns the same conversation with 200.
func TestChatDuplicateCreateReturnsExisting(t *testing.T) {
	s, pool := chatSetup(t)
	customerPhone := chatUserPhone(t, pool)
	merchantID, merchantPhone := chatUser(t, pool)
	customerToken := tokenFor(t, s, customerPhone, RoleCustomer, false)
	merchantToken := tokenFor(t, s, merchantPhone, RoleMerchant, false)
	h := s.Router()

	first, conv := chatCreate(t, h, customerToken, merchantID.String())
	if first.Code != http.StatusCreated {
		t.Fatalf("first create = %d, want 201 (%s)", first.Code, first.Body)
	}

	second, again := chatCreate(t, h, customerToken, merchantID.String())
	if second.Code != http.StatusOK {
		t.Fatalf("duplicate create = %d, want 200 (%s)", second.Code, second.Body)
	}
	if again.Id != conv.Id {
		t.Fatalf("duplicate id = %s, want %s", again.Id, conv.Id)
	}
	if got := chatUnreadCount(t, h, merchantToken); got != 1 {
		t.Fatalf("merchant unread after duplicate create = %d, want 1 (no extra message)", got)
	}
}

// TestChatSendListAndValidation covers two-way sending, ascending history,
// the MESSAGE_EMPTY / MESSAGE_TOO_LONG envelopes and counter flips.
func TestChatSendListAndValidation(t *testing.T) {
	s, pool := chatSetup(t)
	_, customerPhone := chatUser(t, pool)
	merchantID, merchantPhone := chatUser(t, pool)
	customerToken := tokenFor(t, s, customerPhone, RoleCustomer, false)
	merchantToken := tokenFor(t, s, merchantPhone, RoleMerchant, false)
	h := s.Router()

	_, conv := chatCreate(t, h, customerToken, merchantID.String())

	// Empty body and over-long body are rejected before any write.
	rec := authedDo(t, h, http.MethodPost, "/conversations/"+conv.Id.String()+"/messages", `{"body":"   "}`, customerToken)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("empty send = %d, want 422 (%s)", rec.Code, rec.Body)
	}
	assertErrorCode(t, rec, "MESSAGE_EMPTY")
	tooLong := `{"body":"` + strings.Repeat("x", chatMaxMessageLength+1) + `"}`
	rec = authedDo(t, h, http.MethodPost, "/conversations/"+conv.Id.String()+"/messages", tooLong, customerToken)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("long send = %d, want 422", rec.Code)
	}
	assertErrorCode(t, rec, "MESSAGE_TOO_LONG")

	rec = authedDo(t, h, http.MethodPost, "/conversations/"+conv.Id.String()+"/messages", `{"body":"hello from customer"}`, customerToken)
	if rec.Code != http.StatusCreated {
		t.Fatalf("customer send = %d (%s)", rec.Code, rec.Body)
	}
	rec = authedDo(t, h, http.MethodPost, "/conversations/"+conv.Id.String()+"/messages", `{"body":"hello from merchant"}`, merchantToken)
	if rec.Code != http.StatusCreated {
		t.Fatalf("merchant send = %d (%s)", rec.Code, rec.Body)
	}

	// Counters flip: each side sees the other's messages as unread.
	if got := chatUnreadCount(t, h, merchantToken); got != 2 {
		t.Fatalf("merchant unread = %d, want 2 (initial + customer)", got)
	}
	if got := chatUnreadCount(t, h, customerToken); got != 1 {
		t.Fatalf("customer unread = %d, want 1 (merchant reply)", got)
	}

	rec = authedDo(t, h, http.MethodGet, "/conversations/"+conv.Id.String()+"/messages", "", customerToken)
	if rec.Code != http.StatusOK {
		t.Fatalf("list messages = %d (%s)", rec.Code, rec.Body)
	}
	var msgs []gen.ChatMessage
	if err := json.NewDecoder(rec.Body).Decode(&msgs); err != nil {
		t.Fatalf("decode messages: %v", err)
	}
	if len(msgs) != 3 {
		t.Fatalf("messages = %d, want 3 (%s)", len(msgs), rec.Body)
	}
	want := []struct {
		body string
		role gen.ChatMessageAuthorRole
	}{
		{"hello", gen.ChatMessageAuthorRoleCustomer},
		{"hello from customer", gen.ChatMessageAuthorRoleCustomer},
		{"hello from merchant", gen.ChatMessageAuthorRole("merchant")},
	}
	for i, w := range want {
		if msgs[i].Body != w.body || msgs[i].AuthorRole != w.role {
			t.Fatalf("message %d = %q (%s), want %q (%s)", i, msgs[i].Body, msgs[i].AuthorRole, w.body, w.role)
		}
	}
}

// TestChatMarkReadZeroes: each side zeroes only its own counter.
func TestChatMarkReadZeroes(t *testing.T) {
	s, pool := chatSetup(t)
	_, customerPhone := chatUser(t, pool)
	merchantID, merchantPhone := chatUser(t, pool)
	customerToken := tokenFor(t, s, customerPhone, RoleCustomer, false)
	merchantToken := tokenFor(t, s, merchantPhone, RoleMerchant, false)
	h := s.Router()

	_, conv := chatCreate(t, h, customerToken, merchantID.String())
	if got := chatUnreadCount(t, h, merchantToken); got != 1 {
		t.Fatalf("merchant unread = %d, want 1", got)
	}

	// Merchant reads; only the merchant counter zeroes.
	rec := authedDo(t, h, http.MethodPost, "/conversations/"+conv.Id.String()+"/read", "", merchantToken)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("mark read = %d, want 204", rec.Code)
	}
	if got := chatUnreadCount(t, h, merchantToken); got != 0 {
		t.Fatalf("merchant unread after read = %d, want 0", got)
	}
	if got := chatUnreadCount(t, h, customerToken); got != 0 {
		t.Fatalf("customer unread after merchant read = %d, want 0", got)
	}

	// Merchant sends; the customer counter flips to 1 and the merchant's
	// own counter stays at 0.
	rec = authedDo(t, h, http.MethodPost, "/conversations/"+conv.Id.String()+"/messages", `{"body":"are you there?"}`, merchantToken)
	if rec.Code != http.StatusCreated {
		t.Fatalf("merchant send = %d (%s)", rec.Code, rec.Body)
	}
	if got := chatUnreadCount(t, h, merchantToken); got != 0 {
		t.Fatalf("merchant unread after own send = %d, want 0", got)
	}
	if got := chatUnreadCount(t, h, customerToken); got != 1 {
		t.Fatalf("customer unread after merchant send = %d, want 1", got)
	}
}

// TestChatBlockRefusesMessages: a blocked conversation rejects sends and
// duplicate creates with 409 CONVERSATION_BLOCKED.
func TestChatBlockRefusesMessages(t *testing.T) {
	s, pool := chatSetup(t)
	customerPhone := chatUserPhone(t, pool)
	merchantID, merchantPhone := chatUser(t, pool)
	customerToken := tokenFor(t, s, customerPhone, RoleCustomer, false)
	merchantToken := tokenFor(t, s, merchantPhone, RoleMerchant, false)
	h := s.Router()

	_, conv := chatCreate(t, h, customerToken, merchantID.String())

	rec := authedDo(t, h, http.MethodPost, "/conversations/"+conv.Id.String()+"/block", `{"reason":"spam"}`, merchantToken)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("block = %d, want 204 (%s)", rec.Code, rec.Body)
	}

	rec = authedDo(t, h, http.MethodPost, "/conversations/"+conv.Id.String()+"/messages", `{"body":"still here?"}`, customerToken)
	if rec.Code != http.StatusConflict {
		t.Fatalf("send to blocked = %d, want 409 (%s)", rec.Code, rec.Body)
	}
	assertErrorCode(t, rec, "CONVERSATION_BLOCKED")

	rec = authedDo(t, h, http.MethodPost, "/conversations",
		fmt.Sprintf(`{"merchantId":"%s","subject":"again"}`, merchantID), customerToken)
	if rec.Code != http.StatusConflict {
		t.Fatalf("duplicate create on blocked = %d, want 409 (%s)", rec.Code, rec.Body)
	}
	assertErrorCode(t, rec, "CONVERSATION_BLOCKED")
}

// TestChatArchiveRefusesMessages: an archived conversation rejects sends
// with 409 CONVERSATION_ARCHIVED and appears under the status filter.
func TestChatArchiveRefusesMessages(t *testing.T) {
	s, pool := chatSetup(t)
	_, customerPhone := chatUser(t, pool)
	merchantID, merchantPhone := chatUser(t, pool)
	customerToken := tokenFor(t, s, customerPhone, RoleCustomer, false)
	merchantToken := tokenFor(t, s, merchantPhone, RoleMerchant, false)
	h := s.Router()

	_, conv := chatCreate(t, h, customerToken, merchantID.String())

	rec := authedDo(t, h, http.MethodPost, "/conversations/"+conv.Id.String()+"/archive", "", customerToken)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("archive = %d, want 204 (%s)", rec.Code, rec.Body)
	}

	rec = authedDo(t, h, http.MethodPost, "/conversations/"+conv.Id.String()+"/messages", `{"body":"still open?"}`, merchantToken)
	if rec.Code != http.StatusConflict {
		t.Fatalf("send to archived = %d, want 409 (%s)", rec.Code, rec.Body)
	}
	assertErrorCode(t, rec, "CONVERSATION_ARCHIVED")

	// The archived conversation is listed only under the archived filter.
	rec = authedDo(t, h, http.MethodGet, "/conversations?status=archived", "", merchantToken)
	var list []gen.Conversation
	if err := json.NewDecoder(rec.Body).Decode(&list); err != nil {
		t.Fatalf("decode archived list: %v", err)
	}
	if len(list) != 1 || list[0].Id != conv.Id || list[0].Status != gen.ConversationStatusArchived {
		t.Fatalf("archived list = %v, want [%s archived]", list, conv.Id)
	}
	rec = authedDo(t, h, http.MethodGet, "/conversations?status=open", "", merchantToken)
	if err := json.NewDecoder(rec.Body).Decode(&list); err != nil {
		t.Fatalf("decode open list: %v", err)
	}
	if len(list) != 0 {
		t.Fatalf("open list = %d conversations, want 0", len(list))
	}
}

// TestChatNonParticipantNotFound: a user outside the pair sees 404
// CONVERSATION_NOT_FOUND on every endpoint — existence never leaks.
func TestChatNonParticipantNotFound(t *testing.T) {
	s, pool := chatSetup(t)
	_, customerPhone := chatUser(t, pool)
	merchantID, _ := chatUser(t, pool)
	_, outsiderPhone := chatUser(t, pool)
	customerToken := tokenFor(t, s, customerPhone, RoleCustomer, false)
	outsiderToken := tokenFor(t, s, outsiderPhone, RoleCustomer, false)
	h := s.Router()

	_, conv := chatCreate(t, h, customerToken, merchantID.String())

	cases := []struct {
		name   string
		method string
		path   string
		body   string
	}{
		{"get", http.MethodGet, "/conversations/" + conv.Id.String(), ""},
		{"messages", http.MethodGet, "/conversations/" + conv.Id.String() + "/messages", ""},
		{"send", http.MethodPost, "/conversations/" + conv.Id.String() + "/messages", `{"body":"intrude"}`},
		{"read", http.MethodPost, "/conversations/" + conv.Id.String() + "/read", ""},
		{"archive", http.MethodPost, "/conversations/" + conv.Id.String() + "/archive", ""},
		{"block", http.MethodPost, "/conversations/" + conv.Id.String() + "/block", `{"reason":"spam"}`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := authedDo(t, h, tc.method, tc.path, tc.body, outsiderToken)
			if rec.Code != http.StatusNotFound {
				t.Fatalf("%s as outsider = %d, want 404 (%s)", tc.name, rec.Code, rec.Body)
			}
			assertErrorCode(t, rec, "CONVERSATION_NOT_FOUND")
		})
	}
	// A missing conversation answers the same envelope, so existence never
	// leaks.
	missing := uuid.New()
	rec := authedDo(t, h, http.MethodGet, "/conversations/"+missing.String(), "", customerToken)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("get missing = %d, want 404 (%s)", rec.Code, rec.Body)
	}
	assertErrorCode(t, rec, "CONVERSATION_NOT_FOUND")
}

// TestChatMessagePagination: 25 total messages (create's initial message
// plus 24 seeded) page as 20 + 5 with the keyset cursor riding the
// X-Next-Cursor header.
func TestChatMessagePagination(t *testing.T) {
	s, pool := chatSetup(t)
	customerID, customerPhone := chatUser(t, pool)
	merchantID, _ := chatUser(t, pool)
	customerToken := tokenFor(t, s, customerPhone, RoleCustomer, false)
	h := s.Router()

	_, conv := chatCreate(t, h, customerToken, merchantID.String())

	// Seed 24 messages directly (the create already produced one; the rate
	// limiter is per user and the paginator is what is under test). Distinct
	// timestamps make the (created_at, id) keyset deterministic.
	ctx := context.Background()
	base := time.Now().Add(-time.Hour)
	for i := 0; i < 24; i++ {
		author, role := customerID, "customer"
		if i%2 == 1 {
			author, role = merchantID, "merchant"
		}
		if _, err := pool.Exec(ctx,
			`INSERT INTO conversation_messages (conversation_id, author_user_id, author_role, body, created_at)
			 VALUES ($1, $2, $3, $4, $5)`,
			conv.Id.String(), author, role, fmt.Sprintf("seeded %d", i), base.Add(time.Duration(i)*time.Second)); err != nil {
			t.Fatalf("seed message %d: %v", i, err)
		}
	}

	rec := authedDo(t, h, http.MethodGet, "/conversations/"+conv.Id.String()+"/messages?limit=20", "", customerToken)
	if rec.Code != http.StatusOK {
		t.Fatalf("first page = %d (%s)", rec.Code, rec.Body)
	}
	var page1 []gen.ChatMessage
	if err := json.NewDecoder(rec.Body).Decode(&page1); err != nil {
		t.Fatalf("decode page 1: %v", err)
	}
	if len(page1) != 20 {
		t.Fatalf("page 1 = %d messages, want 20", len(page1))
	}
	if page1[0].Body != "seeded 0" || page1[19].Body != "seeded 19" {
		t.Fatalf("page 1 order broken: first %q, last %q", page1[0].Body, page1[19].Body)
	}
	next := rec.Header().Get("X-Next-Cursor")
	if next == "" {
		t.Fatal("first page advertised no next cursor")
	}

	rec = authedDo(t, h, http.MethodGet, "/conversations/"+conv.Id.String()+"/messages?limit=20&cursor="+next, "", customerToken)
	if rec.Code != http.StatusOK {
		t.Fatalf("second page = %d (%s)", rec.Code, rec.Body)
	}
	var page2 []gen.ChatMessage
	if err := json.NewDecoder(rec.Body).Decode(&page2); err != nil {
		t.Fatalf("decode page 2: %v", err)
	}
	// The create's initial message is the newest row, so the tail page is
	// seeded 20..23 plus hello.
	if len(page2) != 5 {
		t.Fatalf("page 2 = %d messages, want 5 (%s)", len(page2), rec.Body)
	}
	if page2[0].Body != "seeded 20" || page2[4].Body != "hello" {
		t.Fatalf("page 2 order broken: first %q, last %q", page2[0].Body, page2[4].Body)
	}
	if rec.Header().Get("X-Next-Cursor") != "" {
		t.Fatalf("final page advertised a next cursor: %q", rec.Header().Get("X-Next-Cursor"))
	}

	// A malformed cursor answers 422 before touching the store.
	rec = authedDo(t, h, http.MethodGet, "/conversations/"+conv.Id.String()+"/messages?cursor=%21%21%21", "", customerToken)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("bad cursor = %d, want 422 (%s)", rec.Code, rec.Body)
	}
	assertErrorCode(t, rec, "VALIDATION_FAILED")
}

// TestChatConcurrentSends: 10 goroutines sending from the same side all land
// as rows and the other side's unread counter reaches exactly 10.
func TestChatConcurrentSends(t *testing.T) {
	s, pool := chatSetup(t)
	_, customerPhone := chatUser(t, pool)
	merchantID, merchantPhone := chatUser(t, pool)
	customerToken := tokenFor(t, s, customerPhone, RoleCustomer, false)
	merchantToken := tokenFor(t, s, merchantPhone, RoleMerchant, false)
	h := s.Router()

	_, conv := chatCreate(t, h, customerToken, merchantID.String())

	const sends = 10
	var wg sync.WaitGroup
	errs := make(chan string, sends)
	for i := 0; i < sends; i++ {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			rec := authedDo(t, h, http.MethodPost, "/conversations/"+conv.Id.String()+"/messages",
				fmt.Sprintf(`{"body":"concurrent %d"}`, n), customerToken)
			if rec.Code != http.StatusCreated {
				errs <- fmt.Sprintf("send %d = %d (%s)", n, rec.Code, rec.Body)
			}
		}(i)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatal(err)
	}

	rec := authedDo(t, h, http.MethodGet, "/conversations/"+conv.Id.String()+"/messages", "", merchantToken)
	var msgs []gen.ChatMessage
	if err := json.NewDecoder(rec.Body).Decode(&msgs); err != nil {
		t.Fatalf("decode messages: %v", err)
	}
	if len(msgs) != sends+1 {
		t.Fatalf("messages = %d, want %d", len(msgs), sends+1)
	}
	seen := map[string]bool{}
	for _, m := range msgs {
		if m.Body == "hello" || strings.HasPrefix(m.Body, "concurrent ") {
			if seen[m.Body] {
				t.Fatalf("duplicate message body %q", m.Body)
			}
			seen[m.Body] = true
		}
	}
	if len(seen) != sends+1 {
		t.Fatalf("distinct messages = %d, want %d", len(seen), sends+1)
	}

	// The other side's counter reflects every send exactly once.
	if got := chatUnreadCount(t, h, merchantToken); got != sends+1 {
		t.Fatalf("merchant unread = %d, want %d", got, sends+1)
	}
	var rowCount int
	if err := pool.QueryRow(context.Background(),
		`SELECT unread_merchant FROM conversations WHERE id = $1`, conv.Id.String()).Scan(&rowCount); err != nil {
		t.Fatalf("read unread_merchant: %v", err)
	}
	if rowCount != sends+1 {
		t.Fatalf("unread_merchant column = %d, want %d", rowCount, sends+1)
	}
}

// chatUserPhone is chatUser discarding the id (helper for callers that only
// need a phone to mint a token).
func chatUserPhone(t *testing.T, pool *pgxpool.Pool) string {
	t.Helper()
	_, phone := chatUser(t, pool)
	return phone
}
