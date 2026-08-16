//go:build integration

// End-to-end tests for the merchants Store against real PostgreSQL
// (docker compose / local dev). Run via
// `go test -tags integration ./internal/merchants/ -count=1` with
// DATABASE_URL set (e.g. postgres://hudumika:hudumika@localhost:5432/
// hudumika) after `go run ./cmd/migrate -up`. Setup truncates ONLY the
// merchants and providers tables and deletes the users/cities it creates,
// so other contexts' data is untouched.
package merchants

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"sync"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// env bundles the store and its pool for a test.
type env struct {
	store  *Store
	pool   *pgxpool.Pool
	cityID string
}

// setup connects to the real database (skipping when DATABASE_URL is
// unset), truncates ONLY merchants + providers, and creates a cities row
// the FK can reference (scheduled for deletion).
func setup(t *testing.T) *env {
	t.Helper()
	databaseURL := os.Getenv("DATABASE_URL")
	if databaseURL == "" {
		t.Skip("DATABASE_URL not set")
	}

	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatalf("pgxpool.New: %v", err)
	}
	t.Cleanup(pool.Close)
	if _, err := pool.Exec(ctx, "TRUNCATE merchants, providers CASCADE"); err != nil {
		t.Fatalf("truncate merchants, providers: %v", err)
	}

	var cityID uuid.UUID
	if err := pool.QueryRow(ctx,
		`INSERT INTO cities (name) VALUES ($1) RETURNING id`,
		"Dar es Salaam "+uuid.NewString()[:8]).Scan(&cityID); err != nil {
		t.Fatalf("insert city: %v", err)
	}
	t.Cleanup(func() {
		if _, err := pool.Exec(ctx, `DELETE FROM cities WHERE id = $1`, cityID); err != nil {
			t.Errorf("cleanup city %s: %v", cityID, err)
		}
	})

	return &env{store: NewStore(pool), pool: pool, cityID: cityID.String()}
}

// insertUser creates a users row (the FK target) and schedules its
// deletion; the merchant/provider rows cascade away with it.
func insertUser(t *testing.T, env *env, phone string) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	if err := env.pool.QueryRow(context.Background(),
		`INSERT INTO users (phone) VALUES ($1) RETURNING id`, phone).Scan(&id); err != nil {
		t.Fatalf("insert user %s: %v", phone, err)
	}
	t.Cleanup(func() {
		if _, err := env.pool.Exec(context.Background(),
			`DELETE FROM users WHERE id = $1`, id); err != nil {
			t.Errorf("cleanup user %s: %v", id, err)
		}
	})
	return id
}

// applyMerchant is a convenience wrapper around ApplyMerchant with a city.
func applyMerchant(t *testing.T, env *env, userID uuid.UUID, name string) uuid.UUID {
	t.Helper()
	id, err := env.store.ApplyMerchant(context.Background(), userID, MerchantInput{
		BusinessName: name,
		CityID:       &env.cityID,
	})
	if err != nil {
		t.Fatalf("apply merchant %s: %v", name, err)
	}
	return id
}

// TestApplyThenAdminApprovalFlow walks the full lifecycle: apply creates a
// pending row the owner can read, the staff list shows it with the owner
// phone, the approve decision flips it to approved, and then both the
// public list and the public get expose it.
func TestApplyThenAdminApprovalFlow(t *testing.T) {
	env := setup(t)
	ctx := context.Background()
	userID := insertUser(t, env, "+255709100001")
	businessType := "restaurant"

	id, err := env.store.ApplyMerchant(ctx, userID, MerchantInput{
		BusinessName: "Spice Corner",
		BusinessType: &businessType,
		CityID:       &env.cityID,
	})
	if err != nil {
		t.Fatalf("apply: %v", err)
	}
	if id == uuid.Nil {
		t.Fatal("apply returned nil id")
	}

	m, err := env.store.GetMerchantByOwner(ctx, userID)
	if err != nil {
		t.Fatalf("get by owner: %v", err)
	}
	if m == nil || m.ID != id {
		t.Fatalf("merchant by owner = %+v, want id %s", m, id)
	}
	if m.Verification != "pending" || m.BusinessName != "Spice Corner" {
		t.Fatalf("merchant = %+v, want pending + Spice Corner", m)
	}
	if !m.IsOpen {
		t.Fatal("new merchant should be open")
	}

	pending := "pending"
	list, next, err := env.store.ListMerchantsForAdmin(ctx, &pending, 20, "")
	if err != nil {
		t.Fatalf("admin list: %v", err)
	}
	if len(list) != 1 || list[0].ID != id {
		t.Fatalf("admin pending list = %+v, want exactly %s", list, id)
	}
	if list[0].OwnerPhone != "+255709100001" {
		t.Fatalf("owner phone = %q, want +255709100001", list[0].OwnerPhone)
	}
	if next != "" {
		t.Fatalf("next cursor = %q, want empty", next)
	}

	if err := env.store.DecideMerchant(ctx, id, "approved", "welcome aboard"); err != nil {
		t.Fatalf("decide approve: %v", err)
	}

	m, err = env.store.GetMerchantByOwner(ctx, userID)
	if err != nil {
		t.Fatalf("get by owner after approval: %v", err)
	}
	if m.Verification != "approved" {
		t.Fatalf("verification after approval = %q, want approved", m.Verification)
	}

	approved, next, err := env.store.ListApprovedMerchants(ctx, nil, 20, "")
	if err != nil {
		t.Fatalf("approved list: %v", err)
	}
	if len(approved) != 1 || approved[0].ID != id {
		t.Fatalf("approved list = %+v, want exactly %s", approved, id)
	}
	if approved[0].CityName != m.CityName {
		t.Fatalf("public city = %q, want %q", approved[0].CityName, m.CityName)
	}
	if next != "" {
		t.Fatalf("next cursor = %q, want empty", next)
	}

	pub, err := env.store.GetMerchant(ctx, id)
	if err != nil {
		t.Fatalf("get approved: %v", err)
	}
	if pub == nil || pub.Verification != "approved" || pub.BusinessName != "Spice Corner" {
		t.Fatalf("public merchant = %+v", pub)
	}
}

// TestRejectWithReasonKeepsRowOffPublicList: a rejection with a reason is
// stored (visible to the owner) and the merchant leaves the public list.
func TestRejectWithReasonKeepsRowOffPublicList(t *testing.T) {
	env := setup(t)
	ctx := context.Background()
	userID := insertUser(t, env, "+255709100002")

	id := applyMerchant(t, env, userID, "Beach Bar")
	if err := env.store.DecideMerchant(ctx, id, "rejected", "no business license"); err != nil {
		t.Fatalf("decide reject: %v", err)
	}

	m, err := env.store.GetMerchantByOwner(ctx, userID)
	if err != nil {
		t.Fatalf("get by owner: %v", err)
	}
	if m.Verification != "rejected" {
		t.Fatalf("verification = %q, want rejected", m.Verification)
	}
	if m.VerificationReason == nil || *m.VerificationReason != "no business license" {
		t.Fatalf("reason = %v, want no business license", m.VerificationReason)
	}

	approved, _, err := env.store.ListApprovedMerchants(ctx, nil, 20, "")
	if err != nil {
		t.Fatalf("approved list: %v", err)
	}
	if len(approved) != 0 {
		t.Fatalf("approved list = %+v, want empty", approved)
	}
}

// TestRequestChangesStateVisibleToOwner: request_changes leaves the row in
// a terminal state visible to the owner; the owner resubmits by updating
// the profile (the row returns to 'pending', reason cleared), after which
// the resubmission can be approved. A decision on the un-resubmitted
// changes_requested row is a status conflict.
func TestRequestChangesStateVisibleToOwner(t *testing.T) {
	env := setup(t)
	ctx := context.Background()
	userID := insertUser(t, env, "+255709100003")

	id := applyMerchant(t, env, userID, "City Grill")
	if err := env.store.DecideMerchant(ctx, id, "changes_requested", "upload your tax id"); err != nil {
		t.Fatalf("decide changes: %v", err)
	}

	m, err := env.store.GetMerchantByOwner(ctx, userID)
	if err != nil {
		t.Fatalf("get by owner: %v", err)
	}
	if m.Verification != "changes_requested" {
		t.Fatalf("verification = %q, want changes_requested", m.Verification)
	}
	if m.VerificationReason == nil || *m.VerificationReason != "upload your tax id" {
		t.Fatalf("reason = %v, want upload your tax id", m.VerificationReason)
	}

	// Not decidable until the owner resubmits.
	if err := env.store.DecideMerchant(ctx, id, "approved", ""); !errors.Is(err, ErrStatusConflict) {
		t.Fatalf("decide on changes_requested err = %v, want ErrStatusConflict", err)
	}

	// Resubmission: the owner edits the profile; the row returns to
	// pending with the reason cleared.
	description := "tax id attached"
	if err := env.store.UpdateMerchantProfile(ctx, id, MerchantProfileUpdate{Description: &description}); err != nil {
		t.Fatalf("resubmit via profile update: %v", err)
	}
	m, err = env.store.GetMerchantByOwner(ctx, userID)
	if err != nil {
		t.Fatalf("get by owner after resubmission: %v", err)
	}
	if m.Verification != "pending" {
		t.Fatalf("verification after resubmission = %q, want pending", m.Verification)
	}
	if m.VerificationReason != nil {
		t.Fatalf("reason after resubmission = %v, want nil", *m.VerificationReason)
	}

	// The resubmitted application is decidable again.
	if err := env.store.DecideMerchant(ctx, id, "approved", ""); err != nil {
		t.Fatalf("decide after resubmission: %v", err)
	}
}

// TestDuplicateApplyIsAlreadyApplied: the unique owner_user_id constraint
// makes a second application fail with ErrAlreadyApplied.
func TestDuplicateApplyIsAlreadyApplied(t *testing.T) {
	env := setup(t)
	ctx := context.Background()
	userID := insertUser(t, env, "+255709100004")

	applyMerchant(t, env, userID, "Mama's Kitchen")
	_, err := env.store.ApplyMerchant(ctx, userID, MerchantInput{BusinessName: "Mama's Kitchen 2"})
	if !errors.Is(err, ErrAlreadyApplied) {
		t.Fatalf("second apply err = %v, want ErrAlreadyApplied", err)
	}
}

// TestProviderApplyAndProfileRoundtrip: provider applications land pending,
// the mutable profile fields persist, and the row round-trips via both
// lookups.
func TestProviderApplyAndProfileRoundtrip(t *testing.T) {
	env := setup(t)
	ctx := context.Background()
	userID := insertUser(t, env, "+255709100005")

	id, err := env.store.ApplyProvider(ctx, userID, ProviderInput{
		Name:        "Juma's Plumbing",
		Trade:       "plumbing",
		CityID:      &env.cityID,
		Bio:         stringPtr("24/7 emergency plumbing"),
		ServiceArea: stringPtr("Kinondoni"),
	})
	if err != nil {
		t.Fatalf("provider apply: %v", err)
	}
	p, err := env.store.GetProviderByOwner(ctx, userID)
	if err != nil {
		t.Fatalf("get provider by owner: %v", err)
	}
	if p == nil || p.ID != id || p.Verification != "pending" || p.Name != "Juma's Plumbing" {
		t.Fatalf("provider = %+v", p)
	}
	if len(p.ServiceAreas) == 0 {
		t.Fatal("service areas not stored")
	}
	var areas []string
	if err := json.Unmarshal(p.ServiceAreas, &areas); err != nil {
		t.Fatalf("unmarshal service areas: %v", err)
	}
	if len(areas) != 1 || areas[0] != "Kinondoni" {
		t.Fatalf("service areas = %v, want [Kinondoni]", areas)
	}

	rate := int64(150000)
	update := ProviderProfileUpdate{
		Bio:          stringPtr("Best rated plumber in Dar"),
		BaseRateTZS:  &rate,
		AvatarURL:    stringPtr("https://cdn.example.com/juma.png"),
		ServiceAreas: mustJSON(t, []string{"Kinondoni", "Ubungo"}),
	}
	if err := env.store.UpdateProviderProfile(ctx, id, update); err != nil {
		t.Fatalf("update provider profile: %v", err)
	}

	p, err = env.store.GetProvider(ctx, id)
	if err != nil {
		t.Fatalf("get provider: %v", err)
	}
	if p == nil {
		t.Fatal("provider missing after update")
	}
	if p.Bio == nil || *p.Bio != "Best rated plumber in Dar" {
		t.Fatalf("bio = %v", p.Bio)
	}
	if p.BaseRateTZS == nil || *p.BaseRateTZS != 150000 {
		t.Fatalf("base rate = %v, want 150000", p.BaseRateTZS)
	}
	if p.AvatarURL == nil || *p.AvatarURL != "https://cdn.example.com/juma.png" {
		t.Fatalf("avatar = %v", p.AvatarURL)
	}
	var areas2 []string
	if err := json.Unmarshal(p.ServiceAreas, &areas2); err != nil {
		t.Fatalf("unmarshal updated areas: %v", err)
	}
	if len(areas2) != 2 || areas2[1] != "Ubungo" {
		t.Fatalf("updated service areas = %v", areas2)
	}
}

// TestListApprovedMerchantsPagination: 25 approved merchants page as
// 20 + 5 (default limit 20) with a working keyset cursor; the last page
// returns an empty next cursor.
func TestListApprovedMerchantsPagination(t *testing.T) {
	env := setup(t)
	ctx := context.Background()

	const total = 25
	for i := 0; i < total; i++ {
		userID := insertUser(t, env, fmt.Sprintf("+2557091000%02d", 20+i))
		id := applyMerchant(t, env, userID, fmt.Sprintf("Shop %02d", i))
		if err := env.store.DecideMerchant(ctx, id, "approved", ""); err != nil {
			t.Fatalf("approve %d: %v", i, err)
		}
	}

	page1, next, err := env.store.ListApprovedMerchants(ctx, nil, 20, "")
	if err != nil {
		t.Fatalf("page 1: %v", err)
	}
	if len(page1) != 20 || next == "" {
		t.Fatalf("page 1 = %d rows, next = %q; want 20 and a cursor", len(page1), next)
	}
	page2, next2, err := env.store.ListApprovedMerchants(ctx, nil, 20, next)
	if err != nil {
		t.Fatalf("page 2: %v", err)
	}
	if len(page2) != 5 || next2 != "" {
		t.Fatalf("page 2 = %d rows, next = %q; want 5 and empty", len(page2), next2)
	}

	// No overlaps across pages and every approved merchant appears exactly
	// once, newest first.
	seen := make(map[uuid.UUID]bool, total)
	all := append(append([]Merchant{}, page1...), page2...)
	for _, m := range all {
		if seen[m.ID] {
			t.Fatalf("merchant %s seen twice", m.ID)
		}
		seen[m.ID] = true
	}
	if len(seen) != total {
		t.Fatalf("distinct merchants = %d, want %d", len(seen), total)
	}
	for i := 1; i < len(all); i++ {
		if all[i-1].CreatedAt.Before(all[i].CreatedAt) {
			t.Fatalf("page order not newest-first at %d", i)
		}
	}
}

// TestListApprovedMerchantsCityFilter: the cityId scope keeps only the
// merchants of that city in the public list.
func TestListApprovedMerchantsCityFilter(t *testing.T) {
	env := setup(t)
	ctx := context.Background()

	var otherCity string
	if err := env.pool.QueryRow(ctx,
		`INSERT INTO cities (name) VALUES ($1) RETURNING id`,
		"Arusha "+uuid.NewString()[:8]).Scan(&otherCity); err != nil {
		t.Fatalf("insert other city: %v", err)
	}
	t.Cleanup(func() {
		if _, err := env.pool.Exec(ctx, `DELETE FROM cities WHERE id = $1`, otherCity); err != nil {
			t.Errorf("cleanup city: %v", err)
		}
	})

	u1 := insertUser(t, env, "+255709100030")
	u2 := insertUser(t, env, "+255709100031")
	id1 := applyMerchant(t, env, u1, "Dar Deli")
	if _, err := env.store.ApplyMerchant(ctx, u2, MerchantInput{BusinessName: "Arusha Chai", CityID: &otherCity}); err != nil {
		t.Fatalf("apply other city: %v", err)
	}
	if err := env.store.DecideMerchant(ctx, id1, "approved", ""); err != nil {
		t.Fatalf("approve: %v", err)
	}

	list, _, err := env.store.ListApprovedMerchants(ctx, &env.cityID, 20, "")
	if err != nil {
		t.Fatalf("city filtered list: %v", err)
	}
	if len(list) != 1 || list[0].ID != id1 {
		t.Fatalf("city filtered list = %+v, want %s", list, id1)
	}
}

// TestDecideGuards: unknown ids surface ErrNotFound, wrong states surface
// ErrStatusConflict, and invalid decisions are rejected up front.
func TestDecideGuards(t *testing.T) {
	env := setup(t)
	ctx := context.Background()
	userID := insertUser(t, env, "+255709100032")

	id := applyMerchant(t, env, userID, "Guarded Grill")
	if err := env.store.DecideMerchant(ctx, uuid.New(), "approved", ""); !errors.Is(err, ErrNotFound) {
		t.Fatalf("decide missing err = %v, want ErrNotFound", err)
	}
	if err := env.store.DecideMerchant(ctx, id, "approved", ""); err != nil {
		t.Fatalf("first decide: %v", err)
	}
	if err := env.store.DecideMerchant(ctx, id, "rejected", "late"); !errors.Is(err, ErrStatusConflict) {
		t.Fatalf("decide on approved err = %v, want ErrStatusConflict", err)
	}
	if err := env.store.DecideMerchant(ctx, id, "approve", ""); !errors.Is(err, ErrInvalidDecision) {
		t.Fatalf("invalid decision err = %v, want ErrInvalidDecision", err)
	}
}

// TestConcurrentApplySameUserSingleWinner: ten parallel applications for the
// same user race on the unique constraint; exactly one wins and the rest get
// ErrAlreadyApplied.
func TestConcurrentApplySameUserSingleWinner(t *testing.T) {
	env := setup(t)
	ctx := context.Background()
	userID := insertUser(t, env, "+255709100040")
	const workers = 10

	var wg sync.WaitGroup
	errs := make(chan error, workers)
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_, err := env.store.ApplyMerchant(ctx, userID, MerchantInput{
				BusinessName: fmt.Sprintf("Racing %d", i),
			})
			errs <- err
		}(i)
	}
	wg.Wait()
	close(errs)

	wins, dupes := 0, 0
	for err := range errs {
		switch {
		case err == nil:
			wins++
		case errors.Is(err, ErrAlreadyApplied):
			dupes++
		default:
			t.Fatalf("unexpected apply error: %v", err)
		}
	}
	if wins != 1 || dupes != workers-1 {
		t.Fatalf("winners = %d, already-applied = %d; want 1 and %d", wins, dupes, workers-1)
	}

	var n int64
	if err := env.pool.QueryRow(ctx,
		`SELECT count(*) FROM merchants WHERE owner_user_id = $1`, userID).Scan(&n); err != nil {
		t.Fatalf("count merchants: %v", err)
	}
	if n != 1 {
		t.Fatalf("merchants rows for user = %d, want 1", n)
	}
}

// TestConcurrentDecideSingleWinner: ten parallel decisions on one pending
// merchant race the guarded UPDATE; exactly one wins and the rest surface
// ErrStatusConflict.
func TestConcurrentDecideSingleWinner(t *testing.T) {
	env := setup(t)
	ctx := context.Background()
	userID := insertUser(t, env, "+255709100041")
	id := applyMerchant(t, env, userID, "Contested Cafe")
	const workers = 10

	decisions := []string{"approved", "rejected", "changes_requested"}
	var wg sync.WaitGroup
	errs := make(chan error, workers)
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			errs <- env.store.DecideMerchant(ctx, id, decisions[i%len(decisions)], "concurrent")
		}(i)
	}
	wg.Wait()
	close(errs)

	wins, conflicts := 0, 0
	for err := range errs {
		switch {
		case err == nil:
			wins++
		case errors.Is(err, ErrStatusConflict):
			conflicts++
		default:
			t.Fatalf("unexpected decide error: %v", err)
		}
	}
	if wins != 1 || conflicts != workers-1 {
		t.Fatalf("winners = %d, conflicts = %d; want 1 and %d", wins, conflicts, workers-1)
	}

	var state string
	if err := env.pool.QueryRow(ctx,
		`SELECT verification FROM merchants WHERE id = $1`, id).Scan(&state); err != nil {
		t.Fatalf("read final state: %v", err)
	}
	final := false
	for _, d := range decisions {
		if state == d {
			final = true
		}
	}
	if !final {
		t.Fatalf("final state = %q, want one of %v", state, decisions)
	}
}

func stringPtr(s string) *string { return &s }

func mustJSON(t *testing.T, v any) []byte {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return b
}
