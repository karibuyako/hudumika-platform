package api

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	openapi_types "github.com/oapi-codegen/runtime/types"

	"github.com/hudumika/api-backend/internal/auth"
	"github.com/hudumika/api-backend/internal/gen"
)

// CHAT bounded context (backend/SUPPORT.md): one conversation pairs a
// customer with one merchant account; merchant_id is the merchant's users
// row id (the JWT subject of their sessions), so participant checks resolve
// without extra lookups. Unread counters are per side; messages are
// append-only rows backed by the (conversation_id, created_at) index.
//
// Authn: every /conversations route sits behind RequireAuth. The caller's
// identity is their users row id resolved from the JWT subject (phone), and
// their side of a conversation is derived from the session role: customers
// act as customer_user_id and read unread_customer, merchants as merchant_id
// and read unread_merchant. A missing database is a server fault (500) here
// — chat state is meaningless without durable identity — unlike users.go's
// currentUser which degrades a missing database to 404.

const (
	chatDefaultListLimit  = 20
	chatMaxListLimit      = 50
	chatDefaultMsgLimit   = 30
	chatMaxMsgLimit       = 100
	chatMaxMessageLength  = 2000
	chatMessageRateLimit  = 20
	chatMessageRateWindow = time.Minute

	chatConversationSelect = `SELECT c.id, c.customer_user_id, c.merchant_id, c.subject, c.status,
	       c.unread_customer, c.unread_merchant,
	       c.last_message_at, c.created_at, c.updated_at,
	       (SELECT m.body FROM conversation_messages m
	         WHERE m.conversation_id = c.id
	         ORDER BY m.created_at DESC, m.id DESC LIMIT 1)
	FROM conversations c`
)

// chatCaller resolves the authenticated caller's users row id and session
// role from the JWT claims. It returns the shared sentinels from users.go
// (errNoBearerToken, errNoDatabase, errUserNotFound) plus the raw lookup
// error. The check ordering — claims, then database, then user row — is
// observable in the unit tests: a missing database answers 500, never 404.
func (s *Server) chatCaller(r *http.Request) (uuid.UUID, string, error) {
	claims, ok := ClaimsFromContext(r.Context())
	if !ok {
		return uuid.Nil, "", errNoBearerToken
	}
	if s.db == nil {
		return uuid.Nil, "", errNoDatabase
	}
	user, err := auth.NewRepo(s.db.Pool()).GetUserByPhone(r.Context(), claims.Subject)
	if err != nil {
		return uuid.Nil, "", err
	}
	if user == nil {
		return uuid.Nil, "", errUserNotFound
	}
	return user.ID, claims.Role, nil
}

// writeChatCallerError maps chatCaller failures to envelopes; a missing
// database surfaces as INTERNAL_ERROR (500), never NOT_FOUND.
func (s *Server) writeChatCallerError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, errNoBearerToken), errors.Is(err, errBadToken):
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing or invalid bearer token")
	case errors.Is(err, errNoDatabase):
		s.logger.Error("chat handler skipped: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
	case errors.Is(err, errUserNotFound):
		writeError(w, http.StatusNotFound, "NOT_FOUND", "User not found")
	default:
		s.logger.Error("chat caller lookup failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
	}
}

// chatConversationRow is one conversations row plus the last-message preview
// used by the list and detail responses.
type chatConversationRow struct {
	id              uuid.UUID
	customerUserID  uuid.UUID
	merchantID      uuid.UUID
	subject         string
	status          string
	unreadCustomer  int
	unreadMerchant  int
	lastMessageAt   *time.Time
	lastMessageBody string
	createdAt       time.Time
	updatedAt       time.Time
}

func scanChatConversation(sc pgx.Row) (chatConversationRow, error) {
	var (
		c       chatConversationRow
		preview *string
	)
	err := sc.Scan(&c.id, &c.customerUserID, &c.merchantID, &c.subject, &c.status,
		&c.unreadCustomer, &c.unreadMerchant,
		&c.lastMessageAt, &c.createdAt, &c.updatedAt, &preview)
	if preview != nil {
		c.lastMessageBody = *preview
	}
	return c, err
}

// loadConversation fetches one conversation row by id; (nil, nil) when it
// does not exist.
func (s *Server) loadConversation(ctx context.Context, id uuid.UUID) (*chatConversationRow, error) {
	row, err := scanChatConversation(s.db.Pool().QueryRow(ctx, chatConversationSelect+` WHERE c.id = $1`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("load conversation: %w", err)
	}
	return &row, nil
}

// isParticipant reports whether the caller's users row id sits on either
// side of the conversation.
func (c *chatConversationRow) isParticipant(userID uuid.UUID) bool {
	return c.customerUserID == userID || c.merchantID == userID
}

// unreadFor returns the caller-side unread counter (role-aware).
func (c *chatConversationRow) unreadFor(role string) int {
	if role == RoleCustomer {
		return c.unreadCustomer
	}
	return c.unreadMerchant
}

// conversationListKey orders conversations newest-first on the last
// activity; a conversation with no messages sorts by its creation time so
// the keyset predicate stays NULL-free.
func conversationListKey(c *chatConversationRow) time.Time {
	if c.lastMessageAt != nil {
		return *c.lastMessageAt
	}
	return c.createdAt
}

func (c *chatConversationRow) toGen(role string) gen.Conversation {
	subject := c.subject
	return gen.Conversation{
		Id:                 newUUID(c.id.String()),
		CustomerUserId:     chatUUIDPtr(c.customerUserID),
		MerchantId:         newUUID(c.merchantID.String()),
		Subject:            &subject,
		Status:             gen.ConversationStatus(c.status),
		UnreadCount:        c.unreadFor(role),
		LastMessagePreview: c.lastMessageBody,
		CreatedAt:          &c.createdAt,
		UpdatedAt:          c.updatedAt,
	}
}

func chatUUIDPtr(id uuid.UUID) *openapi_types.UUID {
	u := newUUID(id.String())
	return &u
}

// ListConversations returns the caller's conversations: customers see rows
// where they are the customer, merchants rows where they are the merchant.
// Ordered by last activity descending, keyset-paginated on
// (last_message_at, id); the next cursor rides the X-Next-Cursor header.
func (s *Server) ListConversations(w http.ResponseWriter, r *http.Request, params gen.ListConversationsParams) {
	userID, role, err := s.chatCaller(r)
	if err != nil {
		s.writeChatCallerError(w, err)
		return
	}

	limit := chatDefaultListLimit
	if params.Limit != nil && *params.Limit > 0 {
		limit = *params.Limit
		if limit > chatMaxListLimit {
			limit = chatMaxListLimit
		}
	}
	var (
		cursorAt  time.Time
		cursorID  uuid.UUID
		hasCursor bool
	)
	if params.Cursor != nil && *params.Cursor != "" {
		parsedAt, parsedID, err := parseChatCursor(*params.Cursor)
		if err != nil {
			writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "cursor is invalid")
			return
		}
		cursorAt, cursorID, hasCursor = parsedAt, parsedID, true
	}

	query := chatConversationSelect + ` WHERE `
	args := make([]any, 0, 5)
	if role == RoleCustomer {
		args = append(args, userID)
		query += fmt.Sprintf("c.customer_user_id = $%d", len(args))
	} else {
		args = append(args, userID)
		query += fmt.Sprintf("c.merchant_id = $%d", len(args))
	}
	if params.Status != nil && *params.Status != "" {
		args = append(args, string(*params.Status))
		query += fmt.Sprintf(" AND c.status = $%d", len(args))
	}
	if hasCursor {
		args = append(args, cursorAt, cursorID)
		query += fmt.Sprintf(" AND (COALESCE(c.last_message_at, c.created_at), c.id) < ($%d, $%d)",
			len(args)-1, len(args))
	}
	// One extra row acts as a sentinel so a full-but-final page does not
	// advertise a next cursor.
	args = append(args, limit+1)
	query += fmt.Sprintf(" ORDER BY COALESCE(c.last_message_at, c.created_at) DESC, c.id DESC LIMIT $%d", len(args))

	rows, err := s.db.Pool().Query(r.Context(), query, args...)
	if err != nil {
		s.logger.Error("list conversations query failed", "user", userID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer rows.Close()

	convs := make([]gen.Conversation, 0, limit)
	var (
		lastAt   time.Time
		lastID   uuid.UUID
		sentinel bool
	)
	for rows.Next() {
		c, err := scanChatConversation(rows)
		if err != nil {
			s.logger.Error("scan conversation row failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		if len(convs) == limit {
			sentinel = true
			continue
		}
		convs = append(convs, c.toGen(role))
		lastAt, lastID = conversationListKey(&c), c.id
	}
	if err := rows.Err(); err != nil {
		s.logger.Error("iterate conversation rows failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if sentinel {
		w.Header().Set("X-Next-Cursor", encodeChatCursor(lastAt, lastID))
	}
	writeJSON(w, http.StatusOK, convs)
}

// CreateConversation opens a conversation with a merchant. The
// (customer, merchant) pair is unique, so a second create returns the
// existing conversation (200); an existing blocked conversation answers 409
// CONVERSATION_BLOCKED. A non-empty initialMessage becomes the first message
// in the same transaction and bumps the merchant's unread counter.
func (s *Server) CreateConversation(w http.ResponseWriter, r *http.Request) {
	userID, role, err := s.chatCaller(r)
	if err != nil {
		s.writeChatCallerError(w, err)
		return
	}
	if role != RoleCustomer {
		writeError(w, http.StatusForbidden, "CONVERSATION_FORBIDDEN", "Only customer sessions may open a conversation")
		return
	}

	var body gen.CreateConversationJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if len(body.InitialMessage) > chatMaxMessageLength {
		writeError(w, http.StatusUnprocessableEntity, "MESSAGE_TOO_LONG",
			fmt.Sprintf("Message must be at most %d characters", chatMaxMessageLength))
		return
	}

	tx, err := s.db.Pool().Begin(r.Context())
	if err != nil {
		s.logger.Error("create conversation begin failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer tx.Rollback(r.Context())

	var (
		convID    uuid.UUID
		subject   string
		status    string
		createdAt time.Time
		updatedAt time.Time
	)
	err = tx.QueryRow(r.Context(),
		`INSERT INTO conversations (customer_user_id, merchant_id, subject)
		 VALUES ($1, $2, $3)
		 ON CONFLICT (customer_user_id, merchant_id) DO NOTHING
		 RETURNING id, subject, status, created_at, updated_at`,
		userID, body.MerchantId, body.Subject).Scan(&convID, &subject, &status, &createdAt, &updatedAt)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		// The pair already exists: load it and answer 200 unless blocked.
		if err := tx.QueryRow(r.Context(),
			`SELECT id, subject, status, created_at, updated_at FROM conversations
			 WHERE customer_user_id = $1 AND merchant_id = $2`,
			userID, body.MerchantId).Scan(&convID, &subject, &status, &createdAt, &updatedAt); err != nil {
			s.logger.Error("reload existing conversation failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		if err := tx.Commit(r.Context()); err != nil {
			s.logger.Error("create conversation commit failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		if status == "blocked" {
			writeError(w, http.StatusConflict, "CONVERSATION_BLOCKED", "This conversation is blocked")
			return
		}
		existing, err := s.loadConversation(r.Context(), convID)
		if err != nil || existing == nil {
			s.logger.Error("load existing conversation failed", "conversation", convID, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		writeJSON(w, http.StatusOK, existing.toGen(role))
		return
	case err != nil:
		s.logger.Error("create conversation failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	// Fresh conversation: an initial message is inserted with the counter
	// bump and activity stamp in the same transaction.
	if body.InitialMessage != "" {
		now := time.Now()
		if _, err := tx.Exec(r.Context(),
			`INSERT INTO conversation_messages (conversation_id, author_user_id, author_role, body)
			 VALUES ($1, $2, 'customer', $3)`,
			convID, userID, body.InitialMessage); err != nil {
			s.logger.Error("insert initial message failed", "conversation", convID, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		if _, err := tx.Exec(r.Context(),
			`UPDATE conversations
			 SET unread_merchant = unread_merchant + 1, last_message_at = $2, updated_at = $2
			 WHERE id = $1`,
			convID, now); err != nil {
			s.logger.Error("bump conversation activity failed", "conversation", convID, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
	}
	if err := tx.Commit(r.Context()); err != nil {
		s.logger.Error("create conversation commit failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	created, err := s.loadConversation(r.Context(), convID)
	if err != nil || created == nil {
		s.logger.Error("load created conversation failed", "conversation", convID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusCreated, created.toGen(role))
}

// GetConversation returns one conversation to either participant. A missing
// conversation and a non-participant both answer 404 CONVERSATION_NOT_FOUND
// so existence never leaks. Participants are resolved from the users rows so
// the contract's participants array can carry display names.
func (s *Server) GetConversation(w http.ResponseWriter, r *http.Request, conversationId openapi_types.UUID) {
	userID, role, err := s.chatCaller(r)
	if err != nil {
		s.writeChatCallerError(w, err)
		return
	}
	id, err := uuid.Parse(conversationId.String())
	if err != nil {
		writeError(w, http.StatusBadRequest, "VALIDATION_FAILED", "conversationId is not a valid UUID")
		return
	}
	conv, err := s.loadConversation(r.Context(), id)
	if err != nil {
		s.logger.Error("load conversation failed", "conversation", id, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if conv == nil || !conv.isParticipant(userID) {
		writeError(w, http.StatusNotFound, "CONVERSATION_NOT_FOUND", "Conversation not found")
		return
	}

	rows, err := s.db.Pool().Query(r.Context(),
		`SELECT u.id, COALESCE(NULLIF(u.full_name, ''), u.phone)
		 FROM users u WHERE u.id = ANY($1::uuid[])`,
		[]uuid.UUID{conv.customerUserID, conv.merchantID})
	if err != nil {
		s.logger.Error("load conversation participants failed", "conversation", id, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer rows.Close()
	names := map[uuid.UUID]string{}
	for rows.Next() {
		var (
			uid  uuid.UUID
			name string
		)
		if err := rows.Scan(&uid, &name); err != nil {
			s.logger.Error("scan participant row failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		names[uid] = name
	}
	if err := rows.Err(); err != nil {
		s.logger.Error("iterate participant rows failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	subject := conv.subject
	participants := []struct {
		DisplayName string                                 `json:"displayName"`
		MaskedPhone *string                                `json:"maskedPhone,omitempty"`
		Role        gen.ConversationDetailParticipantsRole `json:"role"`
	}{
		{DisplayName: names[conv.customerUserID], Role: gen.ConversationDetailParticipantsRoleCustomer},
		{DisplayName: names[conv.merchantID], Role: gen.ConversationDetailParticipantsRoleMerchantStaff},
	}
	detail := gen.ConversationDetail{
		Id:                 newUUID(conv.id.String()),
		CustomerUserId:     chatUUIDPtr(conv.customerUserID),
		MerchantId:         newUUID(conv.merchantID.String()),
		Subject:            &subject,
		Status:             gen.ConversationStatus(conv.status),
		UnreadCount:        conv.unreadFor(role),
		LastMessagePreview: conv.lastMessageBody,
		CreatedAt:          &conv.createdAt,
		UpdatedAt:          conv.updatedAt,
		Participants:       participants,
	}
	writeJSON(w, http.StatusOK, detail)
}

// ListConversationMessages returns the message history for a participant,
// oldest first, keyset-paginated on (created_at, id). The next cursor rides
// the X-Next-Cursor header.
func (s *Server) ListConversationMessages(w http.ResponseWriter, r *http.Request, conversationId openapi_types.UUID, params gen.ListConversationMessagesParams) {
	userID, _, err := s.chatCaller(r)
	if err != nil {
		s.writeChatCallerError(w, err)
		return
	}
	id, err := uuid.Parse(conversationId.String())
	if err != nil {
		writeError(w, http.StatusBadRequest, "VALIDATION_FAILED", "conversationId is not a valid UUID")
		return
	}
	conv, err := s.loadConversation(r.Context(), id)
	if err != nil {
		s.logger.Error("load conversation failed", "conversation", id, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if conv == nil || !conv.isParticipant(userID) {
		writeError(w, http.StatusNotFound, "CONVERSATION_NOT_FOUND", "Conversation not found")
		return
	}

	limit := chatDefaultMsgLimit
	if params.Limit != nil && *params.Limit > 0 {
		limit = *params.Limit
		if limit > chatMaxMsgLimit {
			limit = chatMaxMsgLimit
		}
	}
	var (
		cursorAt  time.Time
		cursorID  uuid.UUID
		hasCursor bool
	)
	if params.Cursor != nil && *params.Cursor != "" {
		parsedAt, parsedID, err := parseChatCursor(*params.Cursor)
		if err != nil {
			writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "cursor is invalid")
			return
		}
		cursorAt, cursorID, hasCursor = parsedAt, parsedID, true
	}

	query := `SELECT m.id, m.author_user_id, m.author_role, m.body, m.created_at
		FROM conversation_messages m
		WHERE m.conversation_id = $1`
	args := []any{id}
	if hasCursor {
		args = append(args, cursorAt, cursorID)
		query += fmt.Sprintf(" AND (m.created_at, m.id) > ($%d, $%d)", len(args)-1, len(args))
	}
	args = append(args, limit+1)
	query += fmt.Sprintf(" ORDER BY m.created_at, m.id LIMIT $%d", len(args))

	rows, err := s.db.Pool().Query(r.Context(), query, args...)
	if err != nil {
		s.logger.Error("list messages query failed", "conversation", id, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer rows.Close()

	msgs := make([]gen.ChatMessage, 0, limit)
	var (
		lastAt   time.Time
		lastID   uuid.UUID
		sentinel bool
	)
	for rows.Next() {
		var (
			msgID      uuid.UUID
			authorID   uuid.UUID
			authorRole string
			body       string
			createdAt  time.Time
		)
		if err := rows.Scan(&msgID, &authorID, &authorRole, &body, &createdAt); err != nil {
			s.logger.Error("scan message row failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		if len(msgs) == limit {
			sentinel = true
			continue
		}
		msgs = append(msgs, gen.ChatMessage{
			Id:             newUUID(msgID.String()),
			ConversationId: newUUID(id.String()),
			AuthorUserId:   chatUUIDPtr(authorID),
			AuthorRole:     gen.ChatMessageAuthorRole(authorRole),
			Body:           body,
			CreatedAt:      createdAt,
		})
		lastAt, lastID = createdAt, msgID
	}
	if err := rows.Err(); err != nil {
		s.logger.Error("iterate message rows failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if sentinel {
		w.Header().Set("X-Next-Cursor", encodeChatCursor(lastAt, lastID))
	}
	writeJSON(w, http.StatusOK, msgs)
}

// SendConversationMessage appends one message and, in the same transaction,
// bumps the OTHER participant's unread counter and stamps the conversation
// activity. Blocked and archived conversations refuse new messages (409);
// per-user sending is rate-limited to 20/minute (429 MESSAGE_RATE_LIMITED).
func (s *Server) SendConversationMessage(w http.ResponseWriter, r *http.Request, conversationId openapi_types.UUID) {
	userID, role, err := s.chatCaller(r)
	if err != nil {
		s.writeChatCallerError(w, err)
		return
	}
	if role != RoleCustomer && role != RoleMerchant {
		writeError(w, http.StatusForbidden, "CONVERSATION_FORBIDDEN", "Only customer and merchant sessions may send messages")
		return
	}
	id, err := uuid.Parse(conversationId.String())
	if err != nil {
		writeError(w, http.StatusBadRequest, "VALIDATION_FAILED", "conversationId is not a valid UUID")
		return
	}
	conv, err := s.loadConversation(r.Context(), id)
	if err != nil {
		s.logger.Error("load conversation failed", "conversation", id, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if conv == nil || !conv.isParticipant(userID) {
		writeError(w, http.StatusNotFound, "CONVERSATION_NOT_FOUND", "Conversation not found")
		return
	}

	var body gen.SendConversationMessageJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if strings.TrimSpace(body.Body) == "" {
		writeError(w, http.StatusUnprocessableEntity, "MESSAGE_EMPTY", "Message body is required")
		return
	}
	if len(body.Body) > chatMaxMessageLength {
		writeError(w, http.StatusUnprocessableEntity, "MESSAGE_TOO_LONG",
			fmt.Sprintf("Message must be at most %d characters", chatMaxMessageLength))
		return
	}

	decision, err := s.stores.Rate.Allow(r.Context(), "chat:msg:"+userID.String(), chatMessageRateLimit, chatMessageRateWindow, time.Now())
	if err != nil {
		s.logger.Error("message rate limit check failed", "user", userID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if !decision.Allowed {
		s.logger.Warn("message rate limited", "user", userID)
		writeErrorWithRetry(w, http.StatusTooManyRequests, "MESSAGE_RATE_LIMITED",
			"Too many messages — slow down", int(decision.RetryAfter.Seconds()))
		return
	}

	if conv.status == "blocked" {
		writeError(w, http.StatusConflict, "CONVERSATION_BLOCKED", "This conversation is blocked")
		return
	}
	if conv.status == "archived" {
		writeError(w, http.StatusConflict, "CONVERSATION_ARCHIVED", "This conversation is archived")
		return
	}

	tx, err := s.db.Pool().Begin(r.Context())
	if err != nil {
		s.logger.Error("send message begin failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer tx.Rollback(r.Context())

	var (
		msgID     uuid.UUID
		createdAt time.Time
	)
	if err := tx.QueryRow(r.Context(),
		`INSERT INTO conversation_messages (conversation_id, author_user_id, author_role, body)
		 VALUES ($1, $2, $3, $4)
		 RETURNING id, created_at`,
		id, userID, role, body.Body).Scan(&msgID, &createdAt); err != nil {
		s.logger.Error("insert message failed", "conversation", id, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	// Bump the other participant's unread counter and stamp activity in the
	// same transaction so a crash can never leave a message without its
	// badge count.
	otherCounter := "unread_customer"
	if role == RoleCustomer {
		otherCounter = "unread_merchant"
	}
	if _, err := tx.Exec(r.Context(),
		`UPDATE conversations
		 SET `+otherCounter+` = `+otherCounter+` + 1, last_message_at = $2, updated_at = $2
		 WHERE id = $1`,
		id, createdAt); err != nil {
		s.logger.Error("bump conversation activity failed", "conversation", id, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		s.logger.Error("send message commit failed", "conversation", id, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	// Live push: publish a chat.message event so the WS relay delivers it to
	// every client subscribed to the conversation topic (and, through the
	// user field, to the other participant's unsubscribed connections). The
	// relay prefers the topic field, so any open client of either
	// participant that subscribed to conversation:<id> gets the message in
	// real time. Publishing is best-effort by contract: a failure is logged
	// and never fails the send.
	other := conv.customerUserID
	if role == RoleCustomer {
		other = conv.merchantID
	}
	if err := s.PublishEvent(r.Context(), "chat.message", map[string]any{
		"topic":          "conversation:" + id.String(),
		"conversationId": id.String(),
		"message": map[string]any{
			"id":             msgID.String(),
			"conversationId": id.String(),
			"authorUserId":   userID.String(),
			"authorRole":     role,
			"body":           body.Body,
			"createdAt":      createdAt,
		},
		"user": other.String(),
	}); err != nil {
		s.logger.Warn("chat message event not published", "conversation", id, "error", err)
	}

	writeJSON(w, http.StatusCreated, gen.ChatMessage{
		Id:             newUUID(msgID.String()),
		ConversationId: newUUID(id.String()),
		AuthorUserId:   chatUUIDPtr(userID),
		AuthorRole:     gen.ChatMessageAuthorRole(role),
		Body:           body.Body,
		CreatedAt:      createdAt,
	})
}

// MarkConversationRead zeroes the reader's own unread counter.
func (s *Server) MarkConversationRead(w http.ResponseWriter, r *http.Request, conversationId openapi_types.UUID) {
	userID, role, err := s.chatCaller(r)
	if err != nil {
		s.writeChatCallerError(w, err)
		return
	}
	id, err := uuid.Parse(conversationId.String())
	if err != nil {
		writeError(w, http.StatusBadRequest, "VALIDATION_FAILED", "conversationId is not a valid UUID")
		return
	}
	conv, err := s.loadConversation(r.Context(), id)
	if err != nil {
		s.logger.Error("load conversation failed", "conversation", id, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if conv == nil || !conv.isParticipant(userID) {
		writeError(w, http.StatusNotFound, "CONVERSATION_NOT_FOUND", "Conversation not found")
		return
	}

	counter := "unread_merchant"
	if role == RoleCustomer {
		counter = "unread_customer"
	}
	if _, err := s.db.Pool().Exec(r.Context(),
		`UPDATE conversations SET `+counter+` = 0, updated_at = now()
		 WHERE id = $1 AND (customer_user_id = $2 OR merchant_id = $2)`,
		id, userID); err != nil {
		s.logger.Error("mark conversation read failed", "conversation", id, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ArchiveConversation moves a conversation to archived; either participant
// may archive, and an already-archived conversation answers 204 too.
func (s *Server) ArchiveConversation(w http.ResponseWriter, r *http.Request, conversationId openapi_types.UUID) {
	userID, _, err := s.chatCaller(r)
	if err != nil {
		s.writeChatCallerError(w, err)
		return
	}
	id, err := uuid.Parse(conversationId.String())
	if err != nil {
		writeError(w, http.StatusBadRequest, "VALIDATION_FAILED", "conversationId is not a valid UUID")
		return
	}
	conv, err := s.loadConversation(r.Context(), id)
	if err != nil {
		s.logger.Error("load conversation failed", "conversation", id, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if conv == nil || !conv.isParticipant(userID) {
		writeError(w, http.StatusNotFound, "CONVERSATION_NOT_FOUND", "Conversation not found")
		return
	}
	if _, err := s.db.Pool().Exec(r.Context(),
		`UPDATE conversations SET status = 'archived', updated_at = now()
		 WHERE id = $1 AND (customer_user_id = $2 OR merchant_id = $2)`,
		id, userID); err != nil {
		s.logger.Error("archive conversation failed", "conversation", id, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// BlockConversation moves a conversation to blocked; either participant may
// block, and a blocked conversation refuses new messages with 409. The
// reason body is validated but not persisted — the schema reserves it for
// future moderation surfaces.
func (s *Server) BlockConversation(w http.ResponseWriter, r *http.Request, conversationId openapi_types.UUID) {
	userID, _, err := s.chatCaller(r)
	if err != nil {
		s.writeChatCallerError(w, err)
		return
	}
	id, err := uuid.Parse(conversationId.String())
	if err != nil {
		writeError(w, http.StatusBadRequest, "VALIDATION_FAILED", "conversationId is not a valid UUID")
		return
	}
	var body gen.BlockConversationJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	conv, err := s.loadConversation(r.Context(), id)
	if err != nil {
		s.logger.Error("load conversation failed", "conversation", id, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if conv == nil || !conv.isParticipant(userID) {
		writeError(w, http.StatusNotFound, "CONVERSATION_NOT_FOUND", "Conversation not found")
		return
	}
	if _, err := s.db.Pool().Exec(r.Context(),
		`UPDATE conversations SET status = 'blocked', updated_at = now()
		 WHERE id = $1 AND (customer_user_id = $2 OR merchant_id = $2)`,
		id, userID); err != nil {
		s.logger.Error("block conversation failed", "conversation", id, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// GetUnreadConversationCount returns the caller's unread badge: the sum of
// unread_customer over their conversations as a customer, or unread_merchant
// over their conversations as a merchant.
func (s *Server) GetUnreadConversationCount(w http.ResponseWriter, r *http.Request) {
	userID, role, err := s.chatCaller(r)
	if err != nil {
		s.writeChatCallerError(w, err)
		return
	}

	var count int
	if role == RoleCustomer {
		err = s.db.Pool().QueryRow(r.Context(),
			`SELECT COALESCE(SUM(unread_customer), 0) FROM conversations WHERE customer_user_id = $1`,
			userID).Scan(&count)
	} else {
		err = s.db.Pool().QueryRow(r.Context(),
			`SELECT COALESCE(SUM(unread_merchant), 0) FROM conversations WHERE merchant_id = $1`,
			userID).Scan(&count)
	}
	if err != nil {
		s.logger.Error("unread count query failed", "user", userID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, struct {
		Count int `json:"count"`
	}{Count: count})
}

// encodeChatCursor packs a keyset (timestamp, id) into a URL-safe base64
// string; parseChatCursor is its inverse.
func encodeChatCursor(ts time.Time, id uuid.UUID) string {
	raw := ts.UTC().Format(time.RFC3339Nano) + "|" + id.String()
	return base64.RawURLEncoding.EncodeToString([]byte(raw))
}

func parseChatCursor(cursor string) (time.Time, uuid.UUID, error) {
	raw, err := base64.RawURLEncoding.DecodeString(cursor)
	if err != nil {
		return time.Time{}, uuid.Nil, fmt.Errorf("decode cursor: %w", err)
	}
	sep := strings.LastIndexByte(string(raw), '|')
	if sep < 0 {
		return time.Time{}, uuid.Nil, fmt.Errorf("cursor separator missing")
	}
	ts, err := time.Parse(time.RFC3339Nano, string(raw[:sep]))
	if err != nil {
		return time.Time{}, uuid.Nil, fmt.Errorf("parse cursor timestamp: %w", err)
	}
	id, err := uuid.Parse(string(raw[sep+1:]))
	if err != nil {
		return time.Time{}, uuid.Nil, fmt.Errorf("parse cursor id: %w", err)
	}
	return ts, id, nil
}
