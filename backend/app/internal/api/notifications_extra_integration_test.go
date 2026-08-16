//go:build integration

// NOTIFICATIONS-EXTRA integration tests against real PostgreSQL + Redis
// (migration 00038_notifications_extra.sql).
//
//	cd app && DATABASE_URL=... REDIS_URL=... go test -tags integration ./internal/api/ -run 'OrderSetting|Announcement' -count=1
//
// Validation ordering: UpdateOrderAlertSettings validates the request body
// before resolving the caller, so an invalid event key answers 422
// PREFERENCE_INVALID_EVENT here (and in the unit suite, even with no
// database). This suite owns only the rows it inserts: its own
// announcements, its own notification_preferences rows and its own users
// (phone prefix +255947). It never truncates; the notifications package
// truncates notification_preferences/notifications in its own process, so
// this suite is robust to that only within a single test body.
package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/hudumika/api-backend/internal/gen"
)

// notificationsExtraPhonePrefix identifies every users row this suite inserts.
const notificationsExtraPhonePrefix = "+255947"

var notificationsExtraSeq atomic.Int64

// notificationsExtraPhone builds a per-run unique phone.
func notificationsExtraPhone() string {
	n := notificationsExtraSeq.Add(1)
	return fmt.Sprintf("%s%05d%04d", notificationsExtraPhonePrefix, time.Now().UnixNano()%100000, n%10000)
}

// notificationsExtraFixture wires the persistent server and owns cleanup of
// every row it creates.
type notificationsExtraFixture struct {
	s               *Server
	pool            *pgxpool.Pool
	h               http.Handler
	userIDs         []uuid.UUID
	announcementIDs []uuid.UUID
}

func newNotificationsExtraFixture(t *testing.T) *notificationsExtraFixture {
	t.Helper()
	s, pool := newPersistentServer(t)
	f := &notificationsExtraFixture{s: s, pool: pool, h: s.Router()}
	t.Cleanup(func() { f.cleanup(context.Background()) })
	return f
}

// cleanup deletes only this suite's rows: own announcements, own
// notification_preferences rows (by user id; the row cascades with the user
// anyway) and own users. Shared tables are untouched.
func (f *notificationsExtraFixture) cleanup(ctx context.Context) {
	if len(f.announcementIDs) > 0 {
		_, _ = f.pool.Exec(ctx, `DELETE FROM announcements WHERE id = ANY($1)`, f.announcementIDs)
	}
	if len(f.userIDs) > 0 {
		_, _ = f.pool.Exec(ctx, `DELETE FROM notification_preferences WHERE user_id = ANY($1)`, f.userIDs)
		_, _ = f.pool.Exec(ctx, `DELETE FROM users WHERE id = ANY($1)`, f.userIDs)
	}
}

// user inserts a users row and returns its id and phone.
func (f *notificationsExtraFixture) user(t *testing.T) (uuid.UUID, string) {
	t.Helper()
	phone := notificationsExtraPhone()
	id := uuid.New()
	if _, err := f.pool.Exec(context.Background(),
		`INSERT INTO users (id, phone) VALUES ($1, $2)`, id, phone); err != nil {
		t.Fatalf("insert user: %v", err)
	}
	f.userIDs = append(f.userIDs, id)
	return id, phone
}

// announcement inserts an announcements row and returns its id.
func (f *notificationsExtraFixture) announcement(t *testing.T, title, audience string, active bool, startsAt, endsAt *time.Time) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	if err := f.pool.QueryRow(context.Background(),
		`INSERT INTO announcements (title, body, audience, active, starts_at, ends_at)
		 VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
		title, "body of "+title, audience, active, startsAt, endsAt).Scan(&id); err != nil {
		t.Fatalf("insert announcement: %v", err)
	}
	f.announcementIDs = append(f.announcementIDs, id)
	return id
}

// TestOrderSettingRoundtrip: GET on a fresh user answers the honest
// default shape; PUT replaces it and both the PUT response and the next GET
// echo the stored settings verbatim.
func TestOrderSettingRoundtrip(t *testing.T) {
	f := newNotificationsExtraFixture(t)
	_, phone := f.user(t)
	token := tokenFor(t, f.s, phone, RoleCustomer, false)

	rec := authedGET(t, f.h, "/notifications/me/order-settings", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("get default = %d (%s)", rec.Code, rec.Body)
	}
	var settings gen.OrderAlertSettings
	if err := json.NewDecoder(rec.Body).Decode(&settings); err != nil {
		t.Fatalf("decode default: %v", err)
	}
	if settings.AcceptanceMethod == nil || *settings.AcceptanceMethod != gen.OrderAlertSettingsAcceptanceMethodManual {
		t.Fatalf("default acceptanceMethod = %v, want manual", settings.AcceptanceMethod)
	}
	if settings.VoiceAlerts == nil || !*settings.VoiceAlerts {
		t.Fatalf("default voiceAlerts = %v, want true", settings.VoiceAlerts)
	}
	if settings.Channels == nil || len(*settings.Channels) != 3 {
		t.Fatalf("default channels = %v, want push/sms/in_app", settings.Channels)
	}
	if settings.QuietHours == nil || settings.QuietHours.Enabled == nil || *settings.QuietHours.Enabled {
		t.Fatalf("default quietHours = %+v, want disabled", settings.QuietHours)
	}

	body := `{"acceptanceMethod":"auto","voiceAlerts":false,"channels":["push"],"quietHours":{"enabled":true,"from":"22:00","to":"08:00"},"autoAcceptWithinSeconds":60}`
	rec = authedDo(t, f.h, http.MethodPut, "/notifications/me/order-settings", body, token)
	if rec.Code != http.StatusOK {
		t.Fatalf("put = %d (%s)", rec.Code, rec.Body)
	}
	settings = gen.OrderAlertSettings{}
	if err := json.NewDecoder(rec.Body).Decode(&settings); err != nil {
		t.Fatalf("decode put response: %v", err)
	}
	if settings.AcceptanceMethod == nil || *settings.AcceptanceMethod != gen.OrderAlertSettingsAcceptanceMethodAuto {
		t.Fatalf("put acceptanceMethod = %v, want auto", settings.AcceptanceMethod)
	}
	if settings.VoiceAlerts == nil || *settings.VoiceAlerts {
		t.Fatalf("put voiceAlerts = %v, want false", settings.VoiceAlerts)
	}
	if settings.Channels == nil || len(*settings.Channels) != 1 || (*settings.Channels)[0] != gen.OrderAlertSettingsChannelsPush {
		t.Fatalf("put channels = %v, want [push]", settings.Channels)
	}
	if settings.AutoAcceptWithinSeconds == nil || *settings.AutoAcceptWithinSeconds != 60 {
		t.Fatalf("put autoAcceptWithinSeconds = %v, want 60", settings.AutoAcceptWithinSeconds)
	}
	if settings.QuietHours == nil || settings.QuietHours.Enabled == nil || !*settings.QuietHours.Enabled ||
		settings.QuietHours.From == nil || *settings.QuietHours.From != "22:00" ||
		settings.QuietHours.To == nil || *settings.QuietHours.To != "08:00" {
		t.Fatalf("put quietHours = %+v, want enabled 22:00..08:00", settings.QuietHours)
	}

	rec = authedGET(t, f.h, "/notifications/me/order-settings", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("get after put = %d (%s)", rec.Code, rec.Body)
	}
	settings = gen.OrderAlertSettings{}
	if err := json.NewDecoder(rec.Body).Decode(&settings); err != nil {
		t.Fatalf("decode get after put: %v", err)
	}
	if settings.AcceptanceMethod == nil || *settings.AcceptanceMethod != gen.OrderAlertSettingsAcceptanceMethodAuto {
		t.Fatalf("roundtrip acceptanceMethod = %v, want auto", settings.AcceptanceMethod)
	}
	if settings.VoiceAlerts == nil || *settings.VoiceAlerts {
		t.Fatalf("roundtrip voiceAlerts = %v, want false", settings.VoiceAlerts)
	}
	if settings.AutoAcceptWithinSeconds == nil || *settings.AutoAcceptWithinSeconds != 60 {
		t.Fatalf("roundtrip autoAcceptWithinSeconds = %v, want 60", settings.AutoAcceptWithinSeconds)
	}

	// The 00009 per-channel toggle columns are untouched by this surface.
	var push []byte
	if err := f.pool.QueryRow(context.Background(),
		`SELECT push FROM notification_preferences WHERE user_id = $1`, f.userIDs[0]).Scan(&push); err != nil {
		t.Fatalf("read push column: %v", err)
	}
	if string(push) != "{}" {
		t.Fatalf("push column = %s, want untouched {}", push)
	}
}

// TestOrderSettingInvalidEventKey: a body key outside the
// OrderAlertSettings schema is rejected with PREFERENCE_INVALID_EVENT before
// any database write.
func TestOrderSettingInvalidEventKey(t *testing.T) {
	f := newNotificationsExtraFixture(t)
	_, phone := f.user(t)
	token := tokenFor(t, f.s, phone, RoleCustomer, false)

	for _, body := range []string{
		`{"orderCreated":true}`,
		`{"orderStatusChanged":true,"voiceAlerts":true}`,
		`{"acceptanceMethod":"auto","rushReplied":true}`,
	} {
		rec := authedDo(t, f.h, http.MethodPut, "/notifications/me/order-settings", body, token)
		if rec.Code != http.StatusUnprocessableEntity {
			t.Fatalf("put %s = %d, want 422", body, rec.Code)
		}
		var errBody gen.ErrorResponse
		if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
			t.Fatalf("decode error body: %v", err)
		}
		if errBody.Code != "PREFERENCE_INVALID_EVENT" {
			t.Fatalf("put %s code = %q, want PREFERENCE_INVALID_EVENT", body, errBody.Code)
		}
	}

	// Nothing was persisted: GET still answers the default.
	rec := authedGET(t, f.h, "/notifications/me/order-settings", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("get after rejected puts = %d (%s)", rec.Code, rec.Body)
	}
	var settings gen.OrderAlertSettings
	if err := json.NewDecoder(rec.Body).Decode(&settings); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if settings.AcceptanceMethod == nil || *settings.AcceptanceMethod != gen.OrderAlertSettingsAcceptanceMethodManual {
		t.Fatalf("acceptanceMethod after rejected puts = %v, want default manual", settings.AcceptanceMethod)
	}
}

// TestAnnouncementsActiveOnly: only active announcements inside their
// publish window are listed, newest first; `[]` when none.
func TestAnnouncementsActiveOnly(t *testing.T) {
	f := newNotificationsExtraFixture(t)
	_, phone := f.user(t)
	token := tokenFor(t, f.s, phone, RoleCustomer, false)
	now := time.Now().UTC()

	rec := authedGET(t, f.h, "/announcements", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("empty list = %d (%s)", rec.Code, rec.Body)
	}
	var none []announcementItem
	if err := json.NewDecoder(rec.Body).Decode(&none); err != nil {
		t.Fatalf("decode empty list: %v", err)
	}
	if len(none) != 0 {
		t.Fatalf("empty list = %d items, want 0", len(none))
	}

	in1h := now.Add(time.Hour)
	out1h := now.Add(-time.Hour)
	out2h := now.Add(-2 * time.Hour)
	visibleNewer := f.announcement(t, "Visible newer", "all", true, &out1h, &in1h)
	visibleOlder := f.announcement(t, "Visible older", "all", true, &out2h, nil)
	f.announcement(t, "Inactive", "all", false, &out1h, &in1h)
	f.announcement(t, "Ended", "all", true, &out2h, &out1h)
	f.announcement(t, "Not started", "all", true, &in1h, nil)

	rec = authedGET(t, f.h, "/announcements", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("list = %d (%s)", rec.Code, rec.Body)
	}
	var items []announcementItem
	if err := json.NewDecoder(rec.Body).Decode(&items); err != nil {
		t.Fatalf("decode list: %v", err)
	}
	present := map[string]bool{}
	order := map[string]int{}
	for i, it := range items {
		present[it.ID.String()] = true
		order[it.ID.String()] = i
	}
	if !present[visibleNewer.String()] || !present[visibleOlder.String()] {
		t.Fatalf("list = %+v, want %s and %s visible", items, visibleNewer, visibleOlder)
	}
	for _, excluded := range []string{"Inactive", "Ended", "Not started"} {
		for _, it := range items {
			if it.Title == excluded {
				t.Fatalf("list contains excluded %q", excluded)
			}
		}
	}
	if order[visibleNewer.String()] > order[visibleOlder.String()] {
		t.Fatalf("visible order = %v, want newer first", items)
	}
	for _, it := range items {
		if it.Title == "" || it.Body == "" || it.PublishedAt.IsZero() {
			t.Fatalf("item missing contract fields: %+v", it)
		}
	}
}

// TestAnnouncementsAudienceIncluded: audience is stored per announcement but
// the list is role-agnostic — the contract response carries no audience
// field, so announcements of every audience are served to any session.
func TestAnnouncementsAudienceIncluded(t *testing.T) {
	f := newNotificationsExtraFixture(t)
	_, phone := f.user(t)
	token := tokenFor(t, f.s, phone, RoleCustomer, false)
	now := time.Now().UTC()

	customers := f.announcement(t, "Customers only", "customers", true, &now, nil)
	merchants := f.announcement(t, "Merchants only", "merchants", true, &now, nil)
	everyone := f.announcement(t, "Everyone", "all", true, &now, nil)

	rec := authedGET(t, f.h, "/announcements", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("list = %d (%s)", rec.Code, rec.Body)
	}
	var items []announcementItem
	if err := json.NewDecoder(rec.Body).Decode(&items); err != nil {
		t.Fatalf("decode list: %v", err)
	}
	found := map[string]bool{}
	for _, it := range items {
		found[it.ID.String()] = true
	}
	for _, want := range []uuid.UUID{customers, merchants, everyone} {
		if !found[want.String()] {
			t.Fatalf("list missing announcement %s", want)
		}
	}
}

// TestAnnouncementsPagination: 25 active announcements page as 20 + 5 via
// the default limit and X-Next-Cursor, with no overlap and newest first.
// limit caps a page; an invalid cursor is a 422.
func TestAnnouncementsPagination(t *testing.T) {
	f := newNotificationsExtraFixture(t)
	_, phone := f.user(t)
	token := tokenFor(t, f.s, phone, RoleCustomer, false)
	now := time.Now().UTC()
	for i := 0; i < 25; i++ {
		at := now.Add(-time.Duration(24-i) * time.Second)
		f.announcement(t, fmt.Sprintf("Page %d", i), "all", true, &at, nil)
	}

	rec := authedGET(t, f.h, "/announcements", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("page 1 = %d (%s)", rec.Code, rec.Body)
	}
	var page1 []announcementItem
	if err := json.NewDecoder(rec.Body).Decode(&page1); err != nil {
		t.Fatalf("decode page 1: %v", err)
	}
	if len(page1) != 20 {
		t.Fatalf("page 1 length = %d, want 20", len(page1))
	}
	cursor := rec.Header().Get("X-Next-Cursor")
	if cursor == "" {
		t.Fatal("page 1 missing X-Next-Cursor")
	}
	if page1[0].Title != "Page 24" {
		t.Fatalf("page 1 newest = %q, want Page 24", page1[0].Title)
	}

	rec = authedGET(t, f.h, "/announcements?cursor="+url.QueryEscape(cursor), token)
	if rec.Code != http.StatusOK {
		t.Fatalf("page 2 = %d (%s)", rec.Code, rec.Body)
	}
	var page2 []announcementItem
	if err := json.NewDecoder(rec.Body).Decode(&page2); err != nil {
		t.Fatalf("decode page 2: %v", err)
	}
	if len(page2) != 5 {
		t.Fatalf("page 2 length = %d, want 5", len(page2))
	}
	if rec.Header().Get("X-Next-Cursor") != "" {
		t.Fatal("page 2 should not carry a next cursor")
	}
	seen := map[string]bool{}
	for _, it := range append(page1, page2...) {
		if seen[it.ID.String()] {
			t.Fatalf("announcement %s returned on both pages", it.ID)
		}
		seen[it.ID.String()] = true
	}
	if len(seen) != 25 {
		t.Fatalf("union has %d unique ids, want 25", len(seen))
	}
	if page2[len(page2)-1].Title != "Page 0" {
		t.Fatalf("page 2 oldest = %q, want Page 0", page2[len(page2)-1].Title)
	}

	// An explicit limit caps the page.
	rec = authedGET(t, f.h, "/announcements?limit=7", token)
	_ = json.NewDecoder(rec.Body).Decode(&page1)
	if len(page1) != 7 || rec.Header().Get("X-Next-Cursor") == "" {
		t.Fatalf("limit=7 returned %d items, cursor %q", len(page1), rec.Header().Get("X-Next-Cursor"))
	}

	// A garbage cursor is a client error, not a 500.
	rec = authedGET(t, f.h, "/announcements?cursor=not-a-cursor", token)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("garbage cursor = %d, want 422", rec.Code)
	}
}
