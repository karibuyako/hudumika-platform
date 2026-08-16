//go:build integration

// Store-level integration tests for the reviews bounded context against real
// PostgreSQL (backend/TESTING.md). Run with DATABASE_URL set, e.g.
// DATABASE_URL=postgres://hudumika:hudumika@localhost:5432/hudumika go test
// -tags integration ./internal/reviews/ -count=1
package reviews

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

	// The reviews context owns only these two tables; nothing else in the
	// schema references them.
	if _, err := pool.Exec(context.Background(),
		`TRUNCATE reviews, review_reports RESTART IDENTITY CASCADE`); err != nil {
		t.Fatalf("truncate: %v", err)
	}
	return pool
}

// insertUser creates a users row (reviews.author_user_id and
// review_reports.reporter_user_id reference users.id) and returns its id.
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

func testReview(authorID, targetID uuid.UUID, body string, rating int) Review {
	return Review{
		TargetType:   "merchant",
		TargetID:     targetID,
		AuthorUserID: authorID,
		Rating:       rating,
		Body:         body,
		State:        "pending",
	}
}

// TestCreateThenGet: a created review is persisted in the pending state and
// read back with every field intact.
func TestCreateThenGet(t *testing.T) {
	pool := newTestPool(t)
	store := NewStore(pool)
	ctx := context.Background()

	author := insertUser(t, pool, uniquePhone("+255701000001"))
	target := uuid.New()

	id, err := store.Create(ctx, testReview(author, target, "Excellent work", 5))
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if id == uuid.Nil {
		t.Fatal("create returned nil id")
	}

	got, err := store.Get(ctx, id)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if got == nil {
		t.Fatal("get returned nil for created review")
	}
	if got.State != "pending" {
		t.Fatalf("state = %q, want pending", got.State)
	}
	if got.AuthorUserID != author || got.TargetID != target || got.TargetType != "merchant" {
		t.Fatalf("identity mismatch: %+v", got)
	}
	if got.Rating != 5 || got.Body != "Excellent work" {
		t.Fatalf("content mismatch: %+v", got)
	}
	if got.HelpfulCount != 0 {
		t.Fatalf("helpful count = %d, want 0", got.HelpfulCount)
	}
}

// TestCreateDuplicateRejected: a second review by the same author for the
// same target (no completion link) violates the unique constraint.
func TestCreateDuplicateRejected(t *testing.T) {
	pool := newTestPool(t)
	store := NewStore(pool)
	ctx := context.Background()

	author := insertUser(t, pool, uniquePhone("+255701000002"))
	target := uuid.New()

	if _, err := store.Create(ctx, testReview(author, target, "First", 4)); err != nil {
		t.Fatalf("first create: %v", err)
	}
	_, err := store.Create(ctx, testReview(author, target, "Second", 1))
	if !errors.Is(err, ErrAlreadyExists) {
		t.Fatalf("second create error = %v, want ErrAlreadyExists", err)
	}
}

// TestReplyLifecycle: one reply attaches; a second reply on the same review
// is rejected with ErrReplyExists.
func TestReplyLifecycle(t *testing.T) {
	pool := newTestPool(t)
	store := NewStore(pool)
	ctx := context.Background()

	author := insertUser(t, pool, uniquePhone("+255701000003"))
	reviewID, err := store.Create(ctx, testReview(author, uuid.New(), "Nice", 5))
	if err != nil {
		t.Fatalf("create: %v", err)
	}

	replyAuthor := insertUser(t, pool, uniquePhone("+255701000004"))
	if err := store.AddReply(ctx, reviewID, replyAuthor, "Thank you!"); err != nil {
		t.Fatalf("first reply: %v", err)
	}

	got, err := store.Get(ctx, reviewID)
	if err != nil || got == nil {
		t.Fatalf("get: %v", err)
	}
	if got.ReplyBody == nil || *got.ReplyBody != "Thank you!" {
		t.Fatalf("reply body = %v, want Thank you!", got.ReplyBody)
	}
	if got.ReplyAuthorUserID == nil || *got.ReplyAuthorUserID != replyAuthor {
		t.Fatalf("reply author = %v, want %s", got.ReplyAuthorUserID, replyAuthor)
	}
	if got.ReplyCreatedAt == nil {
		t.Fatal("reply created_at not set")
	}

	err = store.AddReply(ctx, reviewID, replyAuthor, "Second reply")
	if !errors.Is(err, ErrReplyExists) {
		t.Fatalf("second reply error = %v, want ErrReplyExists", err)
	}
}

// TestBumpHelpfulIncrements: a helpful vote only lands on published reviews
// and increments the counter; pending reviews are rejected.
func TestBumpHelpfulIncrements(t *testing.T) {
	pool := newTestPool(t)
	store := NewStore(pool)
	ctx := context.Background()

	author := insertUser(t, pool, uniquePhone("+255701000005"))
	reviewID, err := store.Create(ctx, testReview(author, uuid.New(), "Great", 5))
	if err != nil {
		t.Fatalf("create: %v", err)
	}

	// Pending reviews do not accept votes.
	if err := store.BumpHelpful(ctx, reviewID); !errors.Is(err, ErrNotEligible) {
		t.Fatalf("bump on pending error = %v, want ErrNotEligible", err)
	}

	if _, err := pool.Exec(ctx, `UPDATE reviews SET state = 'published' WHERE id = $1`, reviewID); err != nil {
		t.Fatalf("publish: %v", err)
	}
	if err := store.BumpHelpful(ctx, reviewID); err != nil {
		t.Fatalf("bump: %v", err)
	}

	got, err := store.Get(ctx, reviewID)
	if err != nil || got == nil {
		t.Fatalf("get: %v", err)
	}
	if got.HelpfulCount != 1 {
		t.Fatalf("helpful count = %d, want 1", got.HelpfulCount)
	}
}

// TestReportAndGetReport: a moderation report is persisted and findable by
// (review, reporter); a second report by the same reporter is idempotent.
func TestReportAndGetReport(t *testing.T) {
	pool := newTestPool(t)
	store := NewStore(pool)
	ctx := context.Background()

	author := insertUser(t, pool, uniquePhone("+255701000006"))
	reporter := insertUser(t, pool, uniquePhone("+255701000007"))
	reviewID, err := store.Create(ctx, testReview(author, uuid.New(), "Shady", 2))
	if err != nil {
		t.Fatalf("create: %v", err)
	}

	if err := store.Report(ctx, reviewID, reporter, "suspected fake review"); err != nil {
		t.Fatalf("report: %v", err)
	}
	if err := store.Report(ctx, reviewID, reporter, "suspected fake review"); err != nil {
		t.Fatalf("duplicate report: %v", err)
	}

	report, err := store.GetReport(ctx, reviewID, reporter)
	if err != nil {
		t.Fatalf("get report: %v", err)
	}
	if report == nil {
		t.Fatal("get report returned nil")
	}
	if report.ReviewID != reviewID || report.ReporterUserID != reporter {
		t.Fatalf("report identity mismatch: %+v", report)
	}
	if report.Reason != "suspected fake review" {
		t.Fatalf("reason = %q, want suspected fake review", report.Reason)
	}
	if report.State != "open" {
		t.Fatalf("state = %q, want open", report.State)
	}

	// A different reporter has no report.
	other, err := store.GetReport(ctx, reviewID, author)
	if err != nil {
		t.Fatalf("get other report: %v", err)
	}
	if other != nil {
		t.Fatalf("unexpected report for non-reporter: %+v", other)
	}
}

// TestListMinePagination: 25 reviews paginate as 20 + 5 with a non-empty
// cursor in between and no overlap across pages.
func TestListMinePagination(t *testing.T) {
	pool := newTestPool(t)
	store := NewStore(pool)
	ctx := context.Background()

	author := insertUser(t, pool, uniquePhone("+255701000008"))
	const total = 25
	for i := 0; i < total; i++ {
		// Each review needs its own target: the unique index allows a single
		// order-less review per author+target.
		if _, err := store.Create(ctx, testReview(author, uuid.New(), fmt.Sprintf("review %d", i), 1+(i%5))); err != nil {
			t.Fatalf("create %d: %v", i, err)
		}
	}

	page1, cursor, err := store.ListMine(ctx, author, 20, "")
	if err != nil {
		t.Fatalf("page 1: %v", err)
	}
	if len(page1) != 20 {
		t.Fatalf("page 1 length = %d, want 20", len(page1))
	}
	if cursor == "" {
		t.Fatal("page 1 cursor empty, want non-empty")
	}

	page2, cursor2, err := store.ListMine(ctx, author, 20, cursor)
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
	for _, r := range page1 {
		seen[r.ID] = true
	}
	for _, r := range page2 {
		if seen[r.ID] {
			t.Fatalf("review %s appears on both pages", r.ID)
		}
		seen[r.ID] = true
	}
	if len(seen) != total {
		t.Fatalf("distinct reviews across pages = %d, want %d", len(seen), total)
	}
}

// TestGetStateGatingIsCallerResponsibility: Get returns (nil, nil) only when
// no row matches; hidden/deleted rows still come back so the caller can apply
// state gating (the reviews API does). A deleted row inserted directly is
// returned with its state intact.
func TestGetStateGatingIsCallerResponsibility(t *testing.T) {
	pool := newTestPool(t)
	store := NewStore(pool)
	ctx := context.Background()

	author := insertUser(t, pool, uniquePhone("+255701000009"))

	var id uuid.UUID
	if err := pool.QueryRow(ctx,
		`INSERT INTO reviews (target_type, target_id, author_user_id, rating, body, state)
		 VALUES ('merchant', $1, $2, 5, 'hidden row', 'deleted') RETURNING id`,
		uuid.New(), author).Scan(&id); err != nil {
		t.Fatalf("insert deleted review: %v", err)
	}

	got, err := store.Get(ctx, id)
	if err != nil {
		t.Fatalf("get deleted: %v", err)
	}
	if got == nil {
		t.Fatal("get deleted returned nil, want the row with state gating deferred to the caller")
	}
	if got.State != "deleted" {
		t.Fatalf("state = %q, want deleted", got.State)
	}

	// No row at all is the only nil case.
	missing, err := store.Get(ctx, uuid.New())
	if err != nil {
		t.Fatalf("get missing: %v", err)
	}
	if missing != nil {
		t.Fatalf("get missing returned a row: %+v", missing)
	}
}
