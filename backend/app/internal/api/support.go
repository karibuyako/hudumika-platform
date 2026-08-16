package api

import (
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	openapi_types "github.com/oapi-codegen/runtime/types"

	"github.com/hudumika/api-backend/internal/auth"
	"github.com/hudumika/api-backend/internal/gen"
	"github.com/hudumika/api-backend/internal/support"
)

// supportUser resolves the caller's users row from the authenticated claims.
// A missing database is a server fault (500) here, mirroring the reviews
// handlers: a ticket cannot be opened without durable identity.
func (s *Server) supportUser(r *http.Request) (*auth.UserRow, error) {
	claims, ok := ClaimsFromContext(r.Context())
	if !ok {
		return nil, errNoBearerToken
	}
	if s.db == nil {
		return nil, errNoDatabase
	}
	user, err := auth.NewRepo(s.db.Pool()).GetUserByPhone(r.Context(), claims.Subject)
	if err != nil {
		return nil, err
	}
	if user == nil {
		return nil, errUserNotFound
	}
	return user, nil
}

// writeSupportUserError maps supportUser failures to envelopes; a missing
// database surfaces as INTERNAL_ERROR (500), never NOT_FOUND.
func (s *Server) writeSupportUserError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, errNoBearerToken), errors.Is(err, errBadToken):
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing or invalid bearer token")
	case errors.Is(err, errNoDatabase):
		s.logger.Error("support handler skipped: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
	case errors.Is(err, errUserNotFound):
		writeError(w, http.StatusNotFound, "NOT_FOUND", "User not found")
	default:
		s.logger.Error("support user lookup failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
	}
}

// supportStore returns the support Store bound to the server pool. Callers
// must guard s.db nil before reaching this point.
func (s *Server) supportStore() *support.Store {
	return support.NewStore(s.db.Pool())
}

// isStaffRole reports whether the session role is a support-staff role.
// /support/ is open to every authenticated role; staff may read and reply to
// any ticket, everyone else only their own (SUPPORT.md admin surface).
func isStaffRole(role string) bool {
	switch role {
	case RoleAdmin, RoleOps, RoleFinance, RoleCompliance:
		return true
	default:
		return false
	}
}

// ticketRequesterRole maps the session role onto the requester enum of
// support_tickets. Staff sessions have no requester variant, so they are
// recorded as customers when opening a ticket.
func ticketRequesterRole(role string) string {
	switch role {
	case RoleCustomer, RoleMerchant, RoleProvider, RoleRider:
		return role
	default:
		return RoleCustomer
	}
}

// ticketAuthorRole maps the session role onto the author_role enum of
// ticket_messages; every non-requester role writes as 'agent'.
func ticketAuthorRole(role string) string {
	switch role {
	case RoleCustomer, RoleMerchant, RoleProvider, RoleRider:
		return role
	default:
		return "agent"
	}
}

// CreateTicket opens a support ticket from any role (POST /support/tickets).
// The requester is the session user; the ticket is created open with normal
// priority and the opening body becomes the first message (SUPPORT.md).
func (s *Server) CreateTicket(w http.ResponseWriter, r *http.Request) {
	user, err := s.supportUser(r)
	if err != nil {
		s.writeSupportUserError(w, err)
		return
	}
	claims, _ := ClaimsFromContext(r.Context())

	var body gen.CreateTicketJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if strings.TrimSpace(body.Subject) == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "subject is required")
		return
	}
	if len(body.Subject) > 160 {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "subject must be at most 160 characters")
		return
	}
	if strings.TrimSpace(body.Body) == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "body is required")
		return
	}
	if len(body.Body) > 4000 {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "body must be at most 4000 characters")
		return
	}

	role := ticketRequesterRole(claims.Role)
	ticket, err := s.supportStore().Create(r.Context(), support.TicketInput{
		RequesterUserID: user.ID,
		Role:            role,
		Subject:         body.Subject,
		Body:            body.Body,
		OrderID:         body.OrderId,
		BookingID:       body.BookingId,
	})
	if err != nil {
		s.logger.Error("support ticket create failed", "user", user.ID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusCreated, toGenTicket(ticket))
}

// ListMyTickets returns the caller's tickets, newest first, with cursor
// pagination (GET /support/tickets/me). The contract response is a bare
// array and the generated wrapper binds no query parameters, so limit and
// cursor are read from the raw query string and the next cursor rides the
// X-Next-Cursor header (the same pattern as ListMyReceivedReviews).
func (s *Server) ListMyTickets(w http.ResponseWriter, r *http.Request) {
	user, err := s.supportUser(r)
	if err != nil {
		s.writeSupportUserError(w, err)
		return
	}

	limit := 20
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			limit = n
		}
	}
	if limit > 100 {
		limit = 100
	}
	cursor := r.URL.Query().Get("cursor")

	tickets, next, err := s.supportStore().ListMine(r.Context(), user.ID, limit, cursor)
	if err != nil {
		s.logger.Error("support ticket list failed", "user", user.ID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	out := make([]gen.Ticket, 0, len(tickets))
	for i := range tickets {
		out = append(out, toGenTicket(tickets[i]))
	}
	if next != "" {
		w.Header().Set("X-Next-Cursor", next)
	}
	writeJSON(w, http.StatusOK, out)
}

// GetTicket returns a ticket with its messages, newest detail for the owner
// and staff only (GET /support/tickets/{ticketId}). A ticket that exists but
// belongs to someone else is indistinguishable from a missing one (404
// TICKET_NOT_FOUND): probing other tickets never leaks existence
// (ERROR-CODES.md conventions).
func (s *Server) GetTicket(w http.ResponseWriter, r *http.Request, ticketId openapi_types.UUID) {
	user, err := s.supportUser(r)
	if err != nil {
		s.writeSupportUserError(w, err)
		return
	}
	claims, _ := ClaimsFromContext(r.Context())

	ticket, err := s.supportStore().Get(r.Context(), ticketId)
	if errors.Is(err, support.ErrNotFound) {
		writeError(w, http.StatusNotFound, "TICKET_NOT_FOUND", "Ticket not found")
		return
	}
	if err != nil {
		s.logger.Error("support ticket get failed", "ticket", ticketId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if !isStaffRole(claims.Role) && ticket.RequesterUserID != user.ID {
		writeError(w, http.StatusNotFound, "TICKET_NOT_FOUND", "Ticket not found")
		return
	}

	messages, err := s.supportStore().Messages(r.Context(), ticketId)
	if err != nil {
		s.logger.Error("support ticket messages failed", "ticket", ticketId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, toGenTicketDetail(*ticket, messages))
}

// ReplyTicket appends a message to a ticket (POST /support/tickets/{ticketId}/messages).
// Owner and staff may reply; replies to a closed ticket are rejected with
// 409 TICKET_CLOSED. The response is the refreshed ticket detail, per the
// contract (201 + TicketDetail).
func (s *Server) ReplyTicket(w http.ResponseWriter, r *http.Request, ticketId openapi_types.UUID) {
	user, err := s.supportUser(r)
	if err != nil {
		s.writeSupportUserError(w, err)
		return
	}
	claims, _ := ClaimsFromContext(r.Context())

	var body gen.ReplyTicketJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if strings.TrimSpace(body.Body) == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "body is required")
		return
	}
	if len(body.Body) > 4000 {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "body must be at most 4000 characters")
		return
	}

	ticket, err := s.supportStore().Get(r.Context(), ticketId)
	if errors.Is(err, support.ErrNotFound) {
		writeError(w, http.StatusNotFound, "TICKET_NOT_FOUND", "Ticket not found")
		return
	}
	if err != nil {
		s.logger.Error("support reply get failed", "ticket", ticketId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if !isStaffRole(claims.Role) && ticket.RequesterUserID != user.ID {
		writeError(w, http.StatusNotFound, "TICKET_NOT_FOUND", "Ticket not found")
		return
	}

	err = s.supportStore().AddMessage(r.Context(), ticketId, user.ID, ticketAuthorRole(claims.Role), body.Body)
	if errors.Is(err, support.ErrTicketClosed) {
		writeError(w, http.StatusConflict, "TICKET_CLOSED", "This ticket is closed and no longer accepts messages")
		return
	}
	if err != nil {
		s.logger.Error("support reply failed", "ticket", ticketId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	messages, err := s.supportStore().Messages(r.Context(), ticketId)
	if err != nil {
		s.logger.Error("support reply reload failed", "ticket", ticketId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusCreated, toGenTicketDetail(*ticket, messages))
}

// toGenTicket maps a support row onto the contract Ticket.
func toGenTicket(t support.TicketRow) gen.Ticket {
	updatedAt := t.UpdatedAt
	out := gen.Ticket{
		Id:        newUUID(t.ID.String()),
		Subject:   t.Subject,
		Status:    gen.TicketStatus(t.Status),
		Priority:  gen.TicketPriority(t.Priority),
		CreatedAt: t.CreatedAt,
		UpdatedAt: &updatedAt,
	}
	out.AssignedAgentId = toGenOptionalUUID(t.AssignedAgentID)
	return out
}

// toGenTicketDetail maps a support row plus its messages onto the contract
// TicketDetail; messages are always a non-nil array. The element type is the
// contract's anonymous inline schema.
func toGenTicketDetail(t support.TicketRow, messages []support.MessageRow) gen.TicketDetail {
	updatedAt := t.UpdatedAt
	out := gen.TicketDetail{
		Id:        newUUID(t.ID.String()),
		Subject:   t.Subject,
		Status:    gen.TicketDetailStatus(t.Status),
		Priority:  gen.TicketDetailPriority(t.Priority),
		CreatedAt: t.CreatedAt,
		UpdatedAt: &updatedAt,
		Messages:  toGenTicketMessages(messages),
	}
	out.AssignedAgentId = toGenOptionalUUID(t.AssignedAgentID)
	return out
}

// ticketMessageElement aliases the contract's anonymous TicketDetail.Messages
// element; its fields and tags must stay identical to the generated schema.
type ticketMessageElement = struct {
	AuthorRole gen.TicketDetailMessagesAuthorRole `json:"authorRole"`
	Body       string                             `json:"body"`
	CreatedAt  time.Time                          `json:"createdAt"`
	Id         openapi_types.UUID                 `json:"id"`
}

// toGenTicketMessages maps message rows onto the contract message elements,
// always returning a non-nil slice.
func toGenTicketMessages(messages []support.MessageRow) []ticketMessageElement {
	out := make([]ticketMessageElement, 0, len(messages))
	for i := range messages {
		out = append(out, ticketMessageElement{
			Id:         newUUID(messages[i].ID.String()),
			AuthorRole: gen.TicketDetailMessagesAuthorRole(messages[i].AuthorRole),
			Body:       messages[i].Body,
			CreatedAt:  messages[i].CreatedAt,
		})
	}
	return out
}

// toGenOptionalUUID converts a nullable uuid to the contract pointer type.
func toGenOptionalUUID(id *uuid.UUID) *openapi_types.UUID {
	if id == nil {
		return nil
	}
	v := newUUID(id.String())
	return &v
}
