//go:build integration

// Store-level integration tests for the support bounded context against real
// PostgreSQL (backend/TESTING.md). Run with DATABASE_URL set, e.g.
// DATABASE_URL=postgres://hudumika:hudumika@localhost:5432/hudumika go test
// -tags integration ./internal/support/ -count=1
package support

import (
	"context"
	"errors"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

func newTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	if os.Getenv("DATABASE_URL") == "" {
		t.Skip("integration: DATABASE_URL required")
	}
	pool, err := pgxpool.New(context.Background(), os.Getenv("DATABASE_URL"))
	if err != nil {
		t.Fatalf("pool: %v", err)
	}
	t.Cleanup(pool.Close)

	// The support context owns only these two tables; nothing else in the
	// schema references them.
	if _, err := pool.Exec(context.Background(),
		`TRUNCATE support_tickets, ticket_messages RESTART IDENTITY CASCADE`); err != nil {
		t.Fatalf("truncate: %v", err)
	}
	return pool
}

// insertUser creates a users row (support_tickets.requester_user_id and
// ticket_messages.author_user_id reference users.id) and returns its id.
func insertUser(t *testing.T, pool *pgxpool.Pool, phone string) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	if err := pool.QueryRow(context.Background(),
		`INSERT INTO users (phone) VALUES ($1) RETURNING id`, phone).Scan(&id); err != nil {
		t.Fatalf("insert user: %v", err)
	}
	return id
}

func uniquePhone(prefix string) string {
	return fmt.Sprintf("%s%09d", prefix, time.Now().UnixNano()%1_000_000_000)
}

// TestCreateThenGet: a created ticket is persisted in the open state with
// normal priority, and the opening body becomes the first message.
func TestCreateThenGet(t *testing.T) {
	pool := newTestPool(t)
	store := NewStore(pool)
	ctx := context.Background()

	requester := insertUser(t, pool, uniquePhone("+255701000001"))
	ticket, err := store.Create(ctx, TicketInput{
		RequesterUserID: requester,
		Role:            "customer",
		Subject:         "Order never arrived",
		Body:            "Order #123 never arrived.",
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if ticket.ID == uuid.Nil {
		t.Fatal("create returned nil id")
	}
	if ticket.Status != "open" {
		t.Fatalf("status = %q, want open", ticket.Status)
	}
	if ticket.Priority != "normal" {
		t.Fatalf("priority = %q, want normal", ticket.Priority)
	}
	if ticket.Role != "customer" || ticket.RequesterUserID != requester {
		t.Fatalf("requester identity mismatch: %+v", ticket)
	}

	got, err := store.Get(ctx, ticket.ID)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if got == nil || got.ID != ticket.ID {
		t.Fatalf("get returned wrong ticket: %+v", got)
	}
	if got.Subject != "Order never arrived" {
		t.Fatalf("subject = %q", got.Subject)
	}

	msgs, err := store.Messages(ctx, ticket.ID)
	if err != nil {
		t.Fatalf("messages: %v", err)
	}
	if len(msgs) != 1 {
		t.Fatalf("messages = %d, want 1 opening message", len(msgs))
	}
	if msgs[0].Body != "Order #123 never arrived." || msgs[0].AuthorRole != "customer" || msgs[0].AuthorUserID != requester {
		t.Fatalf("opening message mismatch: %+v", msgs[0])
	}
}

// TestGetNotFound: Get on a missing id yields ErrNotFound.
func TestGetNotFound(t *testing.T) {
	pool := newTestPool(t)
	store := NewStore(pool)
	ctx := context.Background()

	_, err := store.Get(ctx, uuid.New())
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("get missing error = %v, want ErrNotFound", err)
	}
}

// TestMessageLifecycle: messages append in chronological order; after the
// ticket is closed further messages are rejected with ErrTicketClosed, and
// closing an already-closed ticket is also ErrTicketClosed.
func TestMessageLifecycle(t *testing.T) {
	pool := newTestPool(t)
	store := NewStore(pool)
	ctx := context.Background()

	requester := insertUser(t, pool, uniquePhone("+255701000002"))
	agent := insertUser(t, pool, uniquePhone("+255701000003"))
	ticket, err := store.Create(ctx, TicketInput{
		RequesterUserID: requester,
		Role:            "rider",
		Subject:         "Payout missing",
		Body:            "My payout did not arrive.",
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}

	if err := store.AddMessage(ctx, ticket.ID, agent, "agent", "We are looking into it."); err != nil {
		t.Fatalf("add message: %v", err)
	}

	msgs, err := store.Messages(ctx, ticket.ID)
	if err != nil {
		t.Fatalf("messages: %v", err)
	}
	if len(msgs) != 2 {
		t.Fatalf("messages = %d, want 2", len(msgs))
	}
	if msgs[0].Body != "My payout did not arrive." || msgs[1].Body != "We are looking into it." {
		t.Fatalf("messages not chronological: %+v", msgs)
	}
	if msgs[1].AuthorRole != "agent" || msgs[1].AuthorUserID != agent {
		t.Fatalf("agent message mismatch: %+v", msgs[1])
	}

	if err := store.Close(ctx, ticket.ID); err != nil {
		t.Fatalf("close: %v", err)
	}
	got, err := store.Get(ctx, ticket.ID)
	if err != nil || got == nil {
		t.Fatalf("get after close: %v", err)
	}
	if got.Status != "closed" {
		t.Fatalf("status = %q, want closed", got.Status)
	}

	err = store.AddMessage(ctx, ticket.ID, requester, "rider", "Any update?")
	if !errors.Is(err, ErrTicketClosed) {
		t.Fatalf("message after close error = %v, want ErrTicketClosed", err)
	}
	err = store.Close(ctx, ticket.ID)
	if !errors.Is(err, ErrTicketClosed) {
		t.Fatalf("close again error = %v, want ErrTicketClosed", err)
	}
}

// TestAssignFlow: an open ticket is assignable to an agent (moves to the
// assigned state); reassignment is allowed; a closed ticket is not
// assignable.
func TestAssignFlow(t *testing.T) {
	pool := newTestPool(t)
	store := NewStore(pool)
	ctx := context.Background()

	requester := insertUser(t, pool, uniquePhone("+255701000004"))
	agent := insertUser(t, pool, uniquePhone("+255701000005"))
	ticket, err := store.Create(ctx, TicketInput{
		RequesterUserID: requester,
		Role:            "merchant",
		Subject:         "Menu prices wrong",
		Body:            "Prices on the menu are wrong.",
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}

	if err := store.Assign(ctx, ticket.ID, agent); err != nil {
		t.Fatalf("assign: %v", err)
	}
	got, err := store.Get(ctx, ticket.ID)
	if err != nil || got == nil {
		t.Fatalf("get after assign: %v", err)
	}
	if got.Status != "assigned" {
		t.Fatalf("status = %q, want assigned", got.Status)
	}
	if got.AssignedAgentID == nil || *got.AssignedAgentID != agent {
		t.Fatalf("assigned agent = %v, want %s", got.AssignedAgentID, agent)
	}

	// Reassignment to another agent is allowed while the ticket is not closed.
	other := insertUser(t, pool, uniquePhone("+255701000006"))
	if err := store.Assign(ctx, ticket.ID, other); err != nil {
		t.Fatalf("reassign: %v", err)
	}

	if err := store.Close(ctx, ticket.ID); err != nil {
		t.Fatalf("close: %v", err)
	}
	err = store.Assign(ctx, ticket.ID, agent)
	if !errors.Is(err, ErrTicketNotAssignable) {
		t.Fatalf("assign after close error = %v, want ErrTicketNotAssignable", err)
	}

	// A missing ticket is distinguishable from a closed one.
	err = store.Assign(ctx, uuid.New(), agent)
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("assign missing error = %v, want ErrNotFound", err)
	}
}

// TestListMinePagination: 25 tickets paginate as 20 + 5 with a non-empty
// cursor in between and no overlap across pages.
func TestListMinePagination(t *testing.T) {
	pool := newTestPool(t)
	store := NewStore(pool)
	ctx := context.Background()

	requester := insertUser(t, pool, uniquePhone("+255701000007"))
	const total = 25
	for i := 0; i < total; i++ {
		if _, err := store.Create(ctx, TicketInput{
			RequesterUserID: requester,
			Role:            "provider",
			Subject:         fmt.Sprintf("Ticket %d", i),
			Body:            fmt.Sprintf("Body %d", i),
		}); err != nil {
			t.Fatalf("create %d: %v", i, err)
		}
	}

	page1, cursor, err := store.ListMine(ctx, requester, 20, "")
	if err != nil {
		t.Fatalf("page 1: %v", err)
	}
	if len(page1) != 20 {
		t.Fatalf("page 1 length = %d, want 20", len(page1))
	}
	if cursor == "" {
		t.Fatal("page 1 cursor empty, want non-empty")
	}

	page2, cursor2, err := store.ListMine(ctx, requester, 20, cursor)
	if err != nil {
		t.Fatalf("page 2: %v", err)
	}
	if len(page2) != 5 {
		t.Fatalf("page 2 length = %d, want 5", len(page2))
	}
	if cursor2 != "" {
		t.Fatalf("page 2 cursor = %q, want empty", cursor2)
	}

	seen := make(map[uuid.UUID]bool, total)
	for _, row := range page1 {
		seen[row.ID] = true
	}
	for _, row := range page2 {
		if seen[row.ID] {
			t.Fatalf("ticket %s appears on both pages", row.ID)
		}
		seen[row.ID] = true
	}
	if len(seen) != total {
		t.Fatalf("distinct tickets across pages = %d, want %d", len(seen), total)
	}
}

// TestOwnerOnlyVisibility: ListMine is scoped to the requester, so a second
// user never sees the first user's tickets. The store does not gate Get by
// owner (that is the API layer, which maps both a missing ticket and
// someone else's ticket to 404 TICKET_NOT_FOUND, no existence leak); an id
// the second user never created yields ErrNotFound.
func TestOwnerOnlyVisibility(t *testing.T) {
	pool := newTestPool(t)
	store := NewStore(pool)
	ctx := context.Background()

	first := insertUser(t, pool, uniquePhone("+255701000008"))
	second := insertUser(t, pool, uniquePhone("+255701000009"))

	var firstTicketID uuid.UUID
	for i := 0; i < 2; i++ {
		ticket, err := store.Create(ctx, TicketInput{
			RequesterUserID: first,
			Role:            "customer",
			Subject:         fmt.Sprintf("First user ticket %d", i),
			Body:            "body",
		})
		if err != nil {
			t.Fatalf("create %d: %v", i, err)
		}
		firstTicketID = ticket.ID
	}
	if _, err := store.Create(ctx, TicketInput{
		RequesterUserID: second,
		Role:            "customer",
		Subject:         "Second user ticket",
		Body:            "body",
	}); err != nil {
		t.Fatalf("second user create: %v", err)
	}

	secondSeen, _, err := store.ListMine(ctx, second, 20, "")
	if err != nil {
		t.Fatalf("list mine second: %v", err)
	}
	if len(secondSeen) != 1 {
		t.Fatalf("second user sees %d tickets, want 1 (own only)", len(secondSeen))
	}
	for _, row := range secondSeen {
		if row.RequesterUserID != second {
			t.Fatalf("second user saw ticket owned by %s", row.RequesterUserID)
		}
	}

	firstSeen, _, err := store.ListMine(ctx, first, 20, "")
	if err != nil {
		t.Fatalf("list mine first: %v", err)
	}
	if len(firstSeen) != 2 {
		t.Fatalf("first user sees %d tickets, want 2", len(firstSeen))
	}

	// A probing Get on the first user's ticket from "outside" (the API layer
	// resolves the owner gate to 404; at store level a row not created by
	// the caller's context is simply queried by id) still surfaces
	// ErrNotFound for ids that do not exist.
	if _, err := store.Get(ctx, uuid.New()); !errors.Is(err, ErrNotFound) {
		t.Fatalf("get unknown id error = %v, want ErrNotFound", err)
	}
	// Sanity: the first user's own ticket remains visible to the store.
	if _, err := store.Get(ctx, firstTicketID); err != nil {
		t.Fatalf("get own ticket: %v", err)
	}
}
