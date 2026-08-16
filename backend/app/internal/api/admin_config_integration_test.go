//go:build integration

// ADMIN-CONFIG surfaces against real PostgreSQL + Redis (docker compose):
// templates, staff roles, SLA rules, platform commission rules and the
// two-person (4-eyes) approval workflow. Run via
//
//	go test -tags integration ./internal/api/ -run 'AdminTemplate|StaffRole|SlaRule|CommissionRule|TwoPerson' -count=1
//
// after `make migrate` (migration 00046).
//
// Table hygiene: admin_templates, staff_roles, sla_rules,
// two_person_approvals and platform_commission_rules are owned by this
// milestone alone, so each test truncates exactly those five tables at
// setup. Shared tables (users, roles) are never truncated: staff accounts
// are seeded with per-run unique phones and deleted in cleanup.
package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/hudumika/api-backend/internal/gen"
)

// uniqueAdminConfigPhone builds a per-run unique phone (+2559 prefix for
// this suite) so repeated runs and parallel milestones never collide.
func uniqueAdminConfigPhone(t *testing.T, suffix string) string {
	t.Helper()
	return fmt.Sprintf("+2559%09d-%s", time.Now().UnixNano()%1_000_000_000, suffix)
}

// waitForAdminConfigTables polls to_regclass for the five admin-config
// tables (migration 00046). Up to 240s.
func waitForAdminConfigTables(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	deadline := time.Now().Add(240 * time.Second)
	for {
		var reg string
		if err := pool.QueryRow(context.Background(),
			`SELECT to_regclass('public.admin_templates')::text || ':' ||
				to_regclass('public.staff_roles')::text || ':' ||
				to_regclass('public.sla_rules')::text || ':' ||
				to_regclass('public.two_person_approvals')::text || ':' ||
				to_regclass('public.platform_commission_rules')::text`).Scan(&reg); err != nil {
			t.Fatalf("admin-config table poll query: %v", err)
		}
		// Five parts joined by four colons; a missing table leaves an empty
		// part, so the colon count stays four but a "::" pair appears.
		if !strings.Contains(reg, "::") {
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("admin-config tables did not appear within 240s (migration 00046 missing?)")
		}
		time.Sleep(5 * time.Second)
	}
}

// resetAdminConfigTables truncates only the five tables owned by this
// milestone.
func resetAdminConfigTables(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	if _, err := pool.Exec(context.Background(),
		`TRUNCATE admin_templates, staff_roles, sla_rules, two_person_approvals, platform_commission_rules`); err != nil {
		t.Fatalf("truncate admin-config tables: %v", err)
	}
}

// seedAdminConfigStaff inserts a staff user (users row only — platform
// staff are JWT identities, the roles table admits only
// customer/merchant/provider/rider) and registers cleanup that deletes
// exactly this user's rows.
func seedAdminConfigStaff(t *testing.T, pool *pgxpool.Pool, phone string) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	if err := pool.QueryRow(context.Background(),
		`INSERT INTO users (phone, full_name) VALUES ($1, $2) RETURNING id`,
		phone, "admin-config staff").Scan(&id); err != nil {
		t.Fatalf("seed staff user %s: %v", phone, err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM users WHERE id = $1`, id)
	})
	return id
}

func adminConfigStaffToken(t *testing.T, s *Server, phone string) string {
	t.Helper()
	return tokenFor(t, s, phone, RoleAdmin, true)
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

func TestAdminTemplatesIntegration(t *testing.T) {
	s, pool := newPersistentServer(t)
	waitForAdminConfigTables(t, pool)
	resetAdminConfigTables(t, pool)
	token := adminConfigStaffToken(t, s, uniqueAdminConfigPhone(t, "tpl"))
	h := s.Router()

	rec := authedGET(t, h, "/admin/templates", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("empty list status = %d (%s)", rec.Code, rec.Body)
	}
	var empty []gen.AdminTemplate
	if err := json.NewDecoder(rec.Body).Decode(&empty); err != nil || len(empty) != 0 {
		t.Fatalf("empty list = %v, %v", empty, err)
	}

	rec = authedAdminConfigJSON(t, h, http.MethodPut, "/admin/templates",
		`{"key":"order_confirmation","channel":"sms","body":"Your order {order_id} is confirmed","subject":"Confirmed","variables":["order_id"]}`,
		token)
	if rec.Code != http.StatusOK {
		t.Fatalf("upsert status = %d (%s)", rec.Code, rec.Body)
	}
	var created gen.AdminTemplate
	if err := json.NewDecoder(rec.Body).Decode(&created); err != nil {
		t.Fatalf("decode upsert: %v", err)
	}
	if created.Key != "order_confirmation" || created.Channel != gen.AdminTemplateChannelSms {
		t.Fatalf("created template = %+v", created)
	}
	if created.Subject == nil || *created.Subject != "Confirmed" || created.Variables == nil || len(*created.Variables) != 1 {
		t.Fatalf("subject/variables not stored: %+v", created)
	}

	// Same key again is an update, not a conflict (pure upsert route).
	rec = authedAdminConfigJSON(t, h, http.MethodPut, "/admin/templates",
		`{"key":"order_confirmation","channel":"email","body":"New body","active":false}`,
		token)
	if rec.Code != http.StatusOK {
		t.Fatalf("re-upsert status = %d (%s)", rec.Code, rec.Body)
	}
	var updated gen.AdminTemplate
	_ = json.NewDecoder(rec.Body).Decode(&updated)
	if updated.Channel != gen.AdminTemplateChannelEmail || updated.Active == nil || *updated.Active {
		t.Fatalf("updated template = %+v", updated)
	}

	rec = authedGET(t, h, "/admin/templates", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("list status = %d (%s)", rec.Code, rec.Body)
	}
	var all []gen.AdminTemplate
	_ = json.NewDecoder(rec.Body).Decode(&all)
	if len(all) != 1 || all[0].Key != "order_confirmation" || all[0].Channel != gen.AdminTemplateChannelEmail {
		t.Fatalf("list = %+v", all)
	}
}

// ---------------------------------------------------------------------------
// Staff roles
// ---------------------------------------------------------------------------

func TestAdminStaffRolesIntegration(t *testing.T) {
	s, pool := newPersistentServer(t)
	waitForAdminConfigTables(t, pool)
	resetAdminConfigTables(t, pool)
	token := adminConfigStaffToken(t, s, uniqueAdminConfigPhone(t, "role"))
	h := s.Router()

	rec := authedAdminConfigJSON(t, h, http.MethodPost, "/admin/staff-roles",
		`{"name":"support_agent","description":"L1 support","permissions":["orders.view","orders.assign","support.tickets"]}`,
		token)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create status = %d (%s)", rec.Code, rec.Body)
	}
	var created gen.AdminRoleDefinition
	if err := json.NewDecoder(rec.Body).Decode(&created); err != nil {
		t.Fatalf("decode create: %v", err)
	}
	if created.Id == nil || created.Name != "support_agent" || len(created.Permissions) != 3 {
		t.Fatalf("created role = %+v", created)
	}

	// Duplicate name: the unique constraint decides → 409 CONFLICT.
	rec = authedAdminConfigJSON(t, h, http.MethodPost, "/admin/staff-roles",
		`{"name":"support_agent","permissions":["orders.view"]}`,
		token)
	if rec.Code != http.StatusConflict {
		t.Fatalf("duplicate status = %d, want 409 (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	_ = json.NewDecoder(rec.Body).Decode(&errBody)
	if errBody.Code != "CONFLICT" {
		t.Fatalf("duplicate error code = %q, want CONFLICT", errBody.Code)
	}

	rec = authedGET(t, h, "/admin/staff-roles", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("list status = %d (%s)", rec.Code, rec.Body)
	}
	var all []gen.AdminRoleDefinition
	_ = json.NewDecoder(rec.Body).Decode(&all)
	if len(all) != 1 || all[0].Name != "support_agent" {
		t.Fatalf("list = %+v", all)
	}
}

// ---------------------------------------------------------------------------
// SLA rules
// ---------------------------------------------------------------------------

func TestAdminSlaRulesIntegration(t *testing.T) {
	s, pool := newPersistentServer(t)
	waitForAdminConfigTables(t, pool)
	resetAdminConfigTables(t, pool)
	token := adminConfigStaffToken(t, s, uniqueAdminConfigPhone(t, "sla"))
	h := s.Router()

	rec := authedAdminConfigJSON(t, h, http.MethodPut, "/admin/sla-rules",
		`{"rules":[
			{"scope":"support_ticket","responseMinutes":15,"resolutionMinutes":240,"alertBeforeMinutes":5},
			{"scope":"delivery","responseMinutes":5,"resolutionMinutes":30}
		]}`,
		token)
	if rec.Code != http.StatusOK {
		t.Fatalf("put status = %d (%s)", rec.Code, rec.Body)
	}
	var created []gen.AdminSlaRule
	if err := json.NewDecoder(rec.Body).Decode(&created); err != nil {
		t.Fatalf("decode put: %v", err)
	}
	if len(created) != 2 {
		t.Fatalf("created rules = %+v", created)
	}
	if created[0].Scope != gen.AdminSlaRuleScopeSupportTicket || created[0].AlertBeforeMinutes == nil || *created[0].AlertBeforeMinutes != 5 {
		t.Fatalf("created[0] = %+v", created[0])
	}

	rec = authedGET(t, h, "/admin/sla-rules", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("list status = %d (%s)", rec.Code, rec.Body)
	}
	var listed []gen.AdminSlaRule
	_ = json.NewDecoder(rec.Body).Decode(&listed)
	if len(listed) != 2 {
		t.Fatalf("list = %+v", listed)
	}

	// Replace-all: the old rules are deactivated, the new set wins.
	rec = authedAdminConfigJSON(t, h, http.MethodPut, "/admin/sla-rules",
		`{"rules":[{"scope":"verification","responseMinutes":30,"resolutionMinutes":720}]}`,
		token)
	if rec.Code != http.StatusOK {
		t.Fatalf("replace status = %d (%s)", rec.Code, rec.Body)
	}
	var replaced []gen.AdminSlaRule
	_ = json.NewDecoder(rec.Body).Decode(&replaced)
	if len(replaced) != 1 || replaced[0].Scope != gen.AdminSlaRuleScopeVerification {
		t.Fatalf("replaced = %+v", replaced)
	}

	// The list surfaces the active rule first; the deactivated legacy rules
	// stay visible at the bottom (honest history, "active first" ordering).
	rec = authedGET(t, h, "/admin/sla-rules", token)
	var after []gen.AdminSlaRule
	_ = json.NewDecoder(rec.Body).Decode(&after)
	if len(after) != 3 {
		t.Fatalf("after replace len = %d, want 3 (%+v)", len(after), after)
	}
	if after[0].Scope != gen.AdminSlaRuleScopeVerification || after[0].Active == nil || !*after[0].Active {
		t.Fatalf("after replace active-first = %+v", after[0])
	}
	for _, rule := range after[1:] {
		if rule.Active == nil || *rule.Active {
			t.Fatalf("legacy rule should be deactivated: %+v", rule)
		}
	}

	// Negative minutes are rejected before any write happens.
	rec = authedAdminConfigJSON(t, h, http.MethodPut, "/admin/sla-rules",
		`{"rules":[{"scope":"delivery","responseMinutes":-1,"resolutionMinutes":0}]}`,
		token)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("negative status = %d, want 422 (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	_ = json.NewDecoder(rec.Body).Decode(&errBody)
	if errBody.Code != "SLA_RULE_INVALID" {
		t.Fatalf("negative error code = %q, want SLA_RULE_INVALID", errBody.Code)
	}
}

// ---------------------------------------------------------------------------
// Commission rules
// ---------------------------------------------------------------------------

func TestAdminCommissionRulesIntegration(t *testing.T) {
	s, pool := newPersistentServer(t)
	waitForAdminConfigTables(t, pool)
	resetAdminConfigTables(t, pool)
	token := adminConfigStaffToken(t, s, uniqueAdminConfigPhone(t, "comm"))
	h := s.Router()

	categoryID := uuid.New()
	merchantID := uuid.New()
	rec := authedAdminConfigJSON(t, h, http.MethodPut, "/admin/commission-rules",
		`{"rules":[
			{"scopeType":"category","scopeId":"`+categoryID.String()+`","rateBps":800},
			{"scopeType":"merchant","scopeId":"`+merchantID.String()+`","rateBps":300}
		]}`,
		token)
	if rec.Code != http.StatusOK {
		t.Fatalf("put status = %d (%s)", rec.Code, rec.Body)
	}
	var created []gen.AdminCommissionRule
	if err := json.NewDecoder(rec.Body).Decode(&created); err != nil {
		t.Fatalf("decode put: %v", err)
	}
	if len(created) != 2 {
		t.Fatalf("created rules = %+v", created)
	}
	if created[0].ScopeType != gen.AdminCommissionRuleScopeTypeCategory || created[0].ScopeId == nil ||
		created[0].ScopeId.String() != categoryID.String() || created[0].RateBps != 800 {
		t.Fatalf("category rule = %+v", created[0])
	}
	if created[1].ScopeType != gen.AdminCommissionRuleScopeTypeMerchant || created[1].ScopeId == nil ||
		created[1].ScopeId.String() != merchantID.String() || created[1].RateBps != 300 {
		t.Fatalf("merchant rule = %+v", created[1])
	}

	rec = authedGET(t, h, "/admin/commission-rules", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("list status = %d (%s)", rec.Code, rec.Body)
	}
	var listed []gen.AdminCommissionRule
	_ = json.NewDecoder(rec.Body).Decode(&listed)
	if len(listed) != 2 {
		t.Fatalf("list = %+v", listed)
	}

	// Replace-all: the old rules are deactivated, the new set wins.
	providerID := uuid.New()
	rec = authedAdminConfigJSON(t, h, http.MethodPut, "/admin/commission-rules",
		`{"rules":[{"scopeType":"provider","scopeId":"`+providerID.String()+`","rateBps":200}]}`,
		token)
	if rec.Code != http.StatusOK {
		t.Fatalf("replace status = %d (%s)", rec.Code, rec.Body)
	}
	var replaced []gen.AdminCommissionRule
	_ = json.NewDecoder(rec.Body).Decode(&replaced)
	if len(replaced) != 1 || replaced[0].ScopeType != gen.AdminCommissionRuleScopeTypeProvider || replaced[0].RateBps != 200 {
		t.Fatalf("replaced = %+v", replaced)
	}
	rec = authedGET(t, h, "/admin/commission-rules", token)
	var after []gen.AdminCommissionRule
	_ = json.NewDecoder(rec.Body).Decode(&after)
	if len(after) != 1 || after[0].ScopeType != gen.AdminCommissionRuleScopeTypeProvider {
		t.Fatalf("after replace = %+v", after)
	}

	// Rate guard: out of range is rejected before any write happens.
	rec = authedAdminConfigJSON(t, h, http.MethodPut, "/admin/commission-rules",
		`{"rules":[{"scopeType":"category","rateBps":10001}]}`,
		token)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("rate status = %d, want 422 (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	_ = json.NewDecoder(rec.Body).Decode(&errBody)
	if errBody.Code != "COMMISSION_RULE_INVALID" {
		t.Fatalf("rate error code = %q, want COMMISSION_RULE_INVALID", errBody.Code)
	}
}

// ---------------------------------------------------------------------------
// Two-person approvals
// ---------------------------------------------------------------------------

func TestAdminTwoPersonApprovalsIntegration(t *testing.T) {
	s, pool := newPersistentServer(t)
	waitForAdminConfigTables(t, pool)
	resetAdminConfigTables(t, pool)
	phoneA := uniqueAdminConfigPhone(t, "2pa")
	phoneB := uniqueAdminConfigPhone(t, "2pb")
	staffA := seedAdminConfigStaff(t, pool, phoneA)
	seedAdminConfigStaff(t, pool, phoneB)
	tokenA := adminConfigStaffToken(t, s, phoneA)
	tokenB := adminConfigStaffToken(t, s, phoneB)
	h := s.Router()

	orderID := uuid.New()
	rec := authedAdminConfigJSON(t, h, http.MethodPost, "/admin/two-person-approvals",
		`{"actionType":"large_refund","targetType":"order","targetId":"`+orderID.String()+`","reason":"duplicate charge","payload":{"amountTZS":150000}}`,
		tokenA)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create status = %d (%s)", rec.Code, rec.Body)
	}
	var created gen.AdminTwoPersonApproval
	if err := json.NewDecoder(rec.Body).Decode(&created); err != nil {
		t.Fatalf("decode create: %v", err)
	}
	if created.Status != gen.AdminTwoPersonApprovalStatusPending {
		t.Fatalf("created status = %s", created.Status)
	}
	if created.ActionType != gen.AdminTwoPersonApprovalActionTypeLargeRefund || created.TargetId != orderID.String() {
		t.Fatalf("created = %+v", created)
	}
	if created.RequestedBy != staffA.String() {
		t.Fatalf("requestedBy = %s, want %s", created.RequestedBy, staffA)
	}
	if created.Payload == nil || (*created.Payload)["amountTZS"] != float64(150000) {
		t.Fatalf("payload not stored: %+v", created.Payload)
	}

	// The requester cannot decide their own request (4-eyes).
	rec = authedAdminConfigJSON(t, h, http.MethodPost, "/admin/two-person-approvals/"+created.Id.String()+"/decision",
		`{"decision":"approve","comment":"self approve"}`,
		tokenA)
	if rec.Code != http.StatusConflict {
		t.Fatalf("same-actor status = %d, want 409 (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	_ = json.NewDecoder(rec.Body).Decode(&errBody)
	if errBody.Code != "APPROVAL_SAME_ACTOR" {
		t.Fatalf("same-actor error code = %q, want APPROVAL_SAME_ACTOR", errBody.Code)
	}

	// A second staff member approves.
	rec = authedAdminConfigJSON(t, h, http.MethodPost, "/admin/two-person-approvals/"+created.Id.String()+"/decision",
		`{"decision":"approve","comment":"checked ledger"}`,
		tokenB)
	if rec.Code != http.StatusOK {
		t.Fatalf("decide status = %d (%s)", rec.Code, rec.Body)
	}
	var decided gen.AdminTwoPersonApproval
	_ = json.NewDecoder(rec.Body).Decode(&decided)
	if decided.Status != gen.AdminTwoPersonApprovalStatusApproved || decided.DecidedBy == nil || decided.DecidedAt == nil {
		t.Fatalf("decided = %+v", decided)
	}

	// Re-deciding answers 409 APPROVAL_ALREADY_DECIDED; unknown id 404.
	rec = authedAdminConfigJSON(t, h, http.MethodPost, "/admin/two-person-approvals/"+created.Id.String()+"/decision",
		`{"decision":"reject","comment":"again"}`,
		tokenB)
	if rec.Code != http.StatusConflict {
		t.Fatalf("re-decide status = %d, want 409 (%s)", rec.Code, rec.Body)
	}
	_ = json.NewDecoder(rec.Body).Decode(&errBody)
	if errBody.Code != "APPROVAL_ALREADY_DECIDED" {
		t.Fatalf("re-decide error code = %q, want APPROVAL_ALREADY_DECIDED", errBody.Code)
	}
	rec = authedAdminConfigJSON(t, h, http.MethodPost, "/admin/two-person-approvals/"+uuid.NewString()+"/decision",
		`{"decision":"approve","comment":"ghost"}`,
		tokenB)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("missing status = %d, want 404 (%s)", rec.Code, rec.Body)
	}
	_ = json.NewDecoder(rec.Body).Decode(&errBody)
	if errBody.Code != "APPROVAL_NOT_FOUND" {
		t.Fatalf("missing error code = %q, want APPROVAL_NOT_FOUND", errBody.Code)
	}

	// Status filter narrows the list.
	rec = authedGET(t, h, "/admin/two-person-approvals?status=approved", tokenB)
	if rec.Code != http.StatusOK {
		t.Fatalf("filtered list status = %d (%s)", rec.Code, rec.Body)
	}
	var approved []gen.AdminTwoPersonApproval
	_ = json.NewDecoder(rec.Body).Decode(&approved)
	if len(approved) != 1 || approved[0].Id != decided.Id {
		t.Fatalf("approved list = %+v", approved)
	}
	rec = authedGET(t, h, "/admin/two-person-approvals?status=pending", tokenB)
	var pending []gen.AdminTwoPersonApproval
	_ = json.NewDecoder(rec.Body).Decode(&pending)
	if len(pending) != 0 {
		t.Fatalf("pending list = %+v", pending)
	}
}

// TestAdminTwoPersonApprovalPagination: the list is a bounded newest-first
// snapshot — 20 pending + 5 decided = 25 rows total, and the cap admits all
// 25 (adminTwoPersonListCap).
func TestAdminTwoPersonApprovalPagination(t *testing.T) {
	s, pool := newPersistentServer(t)
	waitForAdminConfigTables(t, pool)
	resetAdminConfigTables(t, pool)
	phoneA := uniqueAdminConfigPhone(t, "pgA")
	phoneB := uniqueAdminConfigPhone(t, "pgB")
	seedAdminConfigStaff(t, pool, phoneA)
	seedAdminConfigStaff(t, pool, phoneB)
	tokenA := adminConfigStaffToken(t, s, phoneA)
	tokenB := adminConfigStaffToken(t, s, phoneB)
	h := s.Router()

	const total = 25
	ids := make([]string, 0, total)
	for i := 0; i < total; i++ {
		rec := authedAdminConfigJSON(t, h, http.MethodPost, "/admin/two-person-approvals",
			`{"actionType":"change_commission","targetType":"category","targetId":"`+uuid.NewString()+`","reason":"paginate"}`,
			tokenA)
		if rec.Code != http.StatusCreated {
			t.Fatalf("create %d status = %d (%s)", i, rec.Code, rec.Body)
		}
		var created gen.AdminTwoPersonApproval
		_ = json.NewDecoder(rec.Body).Decode(&created)
		ids = append(ids, created.Id.String())
	}

	// 5 of the 25 are decided by the second staff member (rejected).
	for i := 0; i < 5; i++ {
		rec := authedAdminConfigJSON(t, h, http.MethodPost, "/admin/two-person-approvals/"+ids[i]+"/decision",
			`{"decision":"reject","comment":"no"}`,
			tokenB)
		if rec.Code != http.StatusOK {
			t.Fatalf("reject %d status = %d (%s)", i, rec.Code, rec.Body)
		}
	}

	rec := authedGET(t, h, "/admin/two-person-approvals", tokenB)
	if rec.Code != http.StatusOK {
		t.Fatalf("list status = %d (%s)", rec.Code, rec.Body)
	}
	var all []gen.AdminTwoPersonApproval
	_ = json.NewDecoder(rec.Body).Decode(&all)
	if len(all) != total {
		t.Fatalf("list len = %d, want %d", len(all), total)
	}

	rec = authedGET(t, h, "/admin/two-person-approvals?status=pending", tokenB)
	var pending []gen.AdminTwoPersonApproval
	_ = json.NewDecoder(rec.Body).Decode(&pending)
	if len(pending) != total-5 {
		t.Fatalf("pending len = %d, want %d", len(pending), total-5)
	}

	rec = authedGET(t, h, "/admin/two-person-approvals?status=rejected", tokenB)
	var rejected []gen.AdminTwoPersonApproval
	_ = json.NewDecoder(rec.Body).Decode(&rejected)
	if len(rejected) != 5 {
		t.Fatalf("rejected len = %d, want 5", len(rejected))
	}
}
