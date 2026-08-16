// Package support is the bounded context for customer support tickets
// (backend/SUPPORT.md). It talks directly to PostgreSQL via a pgxpool.Pool.
// Tickets carry the requester's role for routing and the opening message is
// persisted as the first ticket_messages row; messages are append-only.
package support

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Sentinel errors returned by Store methods and mapped to HTTP envelopes by
// the support API handlers.
var (
	// ErrNotFound is returned when a ticket does not exist.
	ErrNotFound = errors.New("support ticket not found")
	// ErrTicketClosed is returned when a mutation requires a non-closed
	// ticket (message on a closed ticket, closing an already-closed one).
	ErrTicketClosed = errors.New("support ticket is closed")
	// ErrTicketNotAssignable is returned when a closed ticket cannot be
	// assigned to an agent.
	ErrTicketNotAssignable = errors.New("support ticket is not assignable")
)

// TicketRow is the persisted projection of one support_tickets row.
type TicketRow struct {
	ID              uuid.UUID
	RequesterUserID uuid.UUID
	Role            string
	Subject         string
	Status          string
	Priority        string
	AssignedAgentID *uuid.UUID
	OrderID         *uuid.UUID
	BookingID       *uuid.UUID
	CreatedAt       time.Time
	UpdatedAt       time.Time
}

// MessageRow is the persisted projection of one ticket_messages row.
type MessageRow struct {
	ID           uuid.UUID
	TicketID     uuid.UUID
	AuthorUserID uuid.UUID
	AuthorRole   string
	Body         string
	CreatedAt    time.Time
}

// TicketInput is the input shape for creating a ticket.
type TicketInput struct {
	RequesterUserID uuid.UUID
	Role            string
	Subject         string
	Body            string
	OrderID         *uuid.UUID
	BookingID       *uuid.UUID
}

// Store wraps the connection pool for all support persistence.
type Store struct {
	pool *pgxpool.Pool
}

// NewStore returns a Store bound to the given pool.
func NewStore(pool *pgxpool.Pool) *Store {
	return &Store{pool: pool}
}

const ticketColumns = `id, requester_user_id, role, subject, status, priority,
	assigned_agent_id, order_id, booking_id, created_at, updated_at`

const messageColumns = `id, ticket_id, author_user_id, author_role, body, created_at`

// Create opens a ticket in the open state and stores the opening message as
// the first ticket_messages row (the contract's createTicket body becomes
// the ticket's initial message, SUPPORT.md). Priority is always 'normal':
// SUPPORT.md defaults every track to normal priority and the keyword-derived
// escalation (critical for payment/delivery issues) is a queue-routing
// concern, so priority derivation is intentionally left to the admin surface.
// The ticket is created open; the requester role and id come from the
// authenticated session.
func (s *Store) Create(ctx context.Context, in TicketInput) (TicketRow, error) {
	if strings.TrimSpace(in.Subject) == "" || strings.TrimSpace(in.Body) == "" {
		return TicketRow{}, errors.New("support: create: subject and body are required")
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return TicketRow{}, fmt.Errorf("support: create: begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var t TicketRow
	err = tx.QueryRow(ctx,
		`INSERT INTO support_tickets (requester_user_id, role, subject, order_id, booking_id)
		 VALUES ($1, $2, $3, $4, $5)
		 RETURNING `+ticketColumns,
		in.RequesterUserID, in.Role, in.Subject, in.OrderID, in.BookingID).
		Scan(&t.ID, &t.RequesterUserID, &t.Role, &t.Subject, &t.Status, &t.Priority,
			&t.AssignedAgentID, &t.OrderID, &t.BookingID, &t.CreatedAt, &t.UpdatedAt)
	if err != nil {
		return TicketRow{}, fmt.Errorf("support: create ticket for user %s: %w", in.RequesterUserID, err)
	}

	if _, err := tx.Exec(ctx,
		`INSERT INTO ticket_messages (ticket_id, author_user_id, author_role, body)
		 VALUES ($1, $2, $3, $4)`,
		t.ID, in.RequesterUserID, in.Role, in.Body); err != nil {
		return TicketRow{}, fmt.Errorf("support: create opening message for %s: %w", t.ID, err)
	}

	if err := tx.Commit(ctx); err != nil {
		return TicketRow{}, fmt.Errorf("support: create commit for %s: %w", t.ID, err)
	}
	return t, nil
}

// Get returns the ticket for the id, or ErrNotFound when no row matches.
// Ownership and staff gating are the caller's responsibility.
func (s *Store) Get(ctx context.Context, ticketID uuid.UUID) (*TicketRow, error) {
	var t TicketRow
	err := s.pool.QueryRow(ctx,
		`SELECT `+ticketColumns+` FROM support_tickets WHERE id = $1`, ticketID).
		Scan(&t.ID, &t.RequesterUserID, &t.Role, &t.Subject, &t.Status, &t.Priority,
			&t.AssignedAgentID, &t.OrderID, &t.BookingID, &t.CreatedAt, &t.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, fmt.Errorf("support: get %s: %w", ticketID, ErrNotFound)
	}
	if err != nil {
		return nil, fmt.Errorf("support: get %s: %w", ticketID, err)
	}
	return &t, nil
}

// ListMine returns the tickets opened by the user, newest first, with keyset
// pagination over a base64 (created_at, id) cursor. The returned cursor is
// empty when no further page exists.
func (s *Store) ListMine(ctx context.Context, userID uuid.UUID, limit int, cursor string) ([]TicketRow, string, error) {
	if limit <= 0 {
		limit = 20
	}
	if limit > 100 {
		limit = 100
	}

	query := `SELECT ` + ticketColumns + ` FROM support_tickets WHERE requester_user_id = $1`
	args := []any{userID}
	if cursor != "" {
		c, err := parseCursor(cursor)
		if err != nil {
			return nil, "", fmt.Errorf("support: list mine: invalid cursor: %w", err)
		}
		query += ` AND (created_at, id) < ($2, $3)`
		args = append(args, c.createdAt, c.id)
	}
	query += ` ORDER BY created_at DESC, id DESC LIMIT $` + strconv.Itoa(len(args)+1)
	args = append(args, limit+1)

	rows, err := s.pool.Query(ctx, query, args...)
	if err != nil {
		return nil, "", fmt.Errorf("support: list mine for user %s: %w", userID, err)
	}
	defer rows.Close()

	tickets := make([]TicketRow, 0, limit+1)
	for rows.Next() {
		var t TicketRow
		if err := rows.Scan(&t.ID, &t.RequesterUserID, &t.Role, &t.Subject, &t.Status, &t.Priority,
			&t.AssignedAgentID, &t.OrderID, &t.BookingID, &t.CreatedAt, &t.UpdatedAt); err != nil {
			return nil, "", fmt.Errorf("support: list mine for user %s: %w", userID, err)
		}
		tickets = append(tickets, t)
	}
	if err := rows.Err(); err != nil {
		return nil, "", fmt.Errorf("support: list mine for user %s: %w", userID, err)
	}

	if len(tickets) <= limit {
		return tickets, "", nil
	}
	next := encodeCursor(tickets[limit-1].CreatedAt, tickets[limit-1].ID)
	return tickets[:limit], next, nil
}

// Messages returns the ticket's messages in chronological order; an empty
// slice (never nil) when the ticket has none.
func (s *Store) Messages(ctx context.Context, ticketID uuid.UUID) ([]MessageRow, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT `+messageColumns+` FROM ticket_messages WHERE ticket_id = $1
		 ORDER BY created_at ASC, id ASC`, ticketID)
	if err != nil {
		return nil, fmt.Errorf("support: messages for %s: %w", ticketID, err)
	}
	defer rows.Close()

	msgs := make([]MessageRow, 0)
	for rows.Next() {
		var m MessageRow
		if err := rows.Scan(&m.ID, &m.TicketID, &m.AuthorUserID, &m.AuthorRole, &m.Body, &m.CreatedAt); err != nil {
			return nil, fmt.Errorf("support: messages for %s: %w", ticketID, err)
		}
		msgs = append(msgs, m)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("support: messages for %s: %w", ticketID, err)
	}
	return msgs, nil
}

// AddMessage appends a message to a ticket. The status check happens in the
// same statement so the insert and the closed gate cannot race: zero rows
// means the ticket is missing or closed, and both surface as ErrTicketClosed
// (the API resolves ownership before calling this).
func (s *Store) AddMessage(ctx context.Context, ticketID, authorUserID uuid.UUID, authorRole, body string) error {
	tag, err := s.pool.Exec(ctx,
		`INSERT INTO ticket_messages (ticket_id, author_user_id, author_role, body)
		 SELECT $1, $2, $3, $4
		 WHERE EXISTS (SELECT 1 FROM support_tickets WHERE id = $1 AND status <> 'closed')`,
		ticketID, authorUserID, authorRole, body)
	if err != nil {
		return fmt.Errorf("support: add message to %s: %w", ticketID, err)
	}
	if tag.RowsAffected() > 0 {
		return nil
	}
	return fmt.Errorf("support: add message to %s: %w", ticketID, ErrTicketClosed)
}

// Close closes an open ticket; closing an already-closed ticket yields
// ErrTicketClosed and a missing ticket yields ErrNotFound.
func (s *Store) Close(ctx context.Context, ticketID uuid.UUID) error {
	tag, err := s.pool.Exec(ctx,
		`UPDATE support_tickets SET status = 'closed', updated_at = now()
		 WHERE id = $1 AND status <> 'closed'`, ticketID)
	if err != nil {
		return fmt.Errorf("support: close %s: %w", ticketID, err)
	}
	if tag.RowsAffected() > 0 {
		return nil
	}
	if _, err := s.Get(ctx, ticketID); err != nil {
		return err
	}
	return fmt.Errorf("support: close %s: %w", ticketID, ErrTicketClosed)
}

// Assign assigns a ticket to an agent and moves it to the assigned state
// (SUPPORT.md lifecycle: open -> assigned). A closed ticket is not
// assignable (ErrTicketNotAssignable) and a missing ticket yields
// ErrNotFound. Staff authorization is the caller's responsibility.
func (s *Store) Assign(ctx context.Context, ticketID, agentID uuid.UUID) error {
	tag, err := s.pool.Exec(ctx,
		`UPDATE support_tickets SET assigned_agent_id = $2, status = 'assigned', updated_at = now()
		 WHERE id = $1 AND status <> 'closed'`, ticketID, agentID)
	if err != nil {
		return fmt.Errorf("support: assign %s to %s: %w", ticketID, agentID, err)
	}
	if tag.RowsAffected() > 0 {
		return nil
	}
	if _, err := s.Get(ctx, ticketID); err != nil {
		return err
	}
	return fmt.Errorf("support: assign %s to %s: %w", ticketID, agentID, ErrTicketNotAssignable)
}

// cursor is a keyset pagination position: (created_at, id).
type cursor struct {
	createdAt time.Time
	id        uuid.UUID
}

// encodeCursor serializes a pagination position as base64 "createdAt|id".
func encodeCursor(t time.Time, id uuid.UUID) string {
	raw := t.UTC().Format(time.RFC3339Nano) + "|" + id.String()
	return base64.StdEncoding.EncodeToString([]byte(raw))
}

// parseCursor decodes a cursor produced by encodeCursor.
func parseCursor(s string) (cursor, error) {
	raw, err := base64.StdEncoding.DecodeString(s)
	if err != nil {
		return cursor{}, fmt.Errorf("decode: %w", err)
	}
	parts := strings.SplitN(string(raw), "|", 2)
	if len(parts) != 2 {
		return cursor{}, errors.New("malformed cursor")
	}
	t, err := time.Parse(time.RFC3339Nano, parts[0])
	if err != nil {
		return cursor{}, fmt.Errorf("parse time: %w", err)
	}
	id, err := uuid.Parse(parts[1])
	if err != nil {
		return cursor{}, fmt.Errorf("parse id: %w", err)
	}
	return cursor{createdAt: t, id: id}, nil
}
