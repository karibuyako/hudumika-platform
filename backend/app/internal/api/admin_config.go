package api

// ADMIN-CONFIG bounded context (API-CONTRACT.yaml /admin/templates,
// /admin/staff-roles, /admin/sla-rules, /admin/commission-rules,
// /admin/two-person-approvals): the platform configuration registry —
// notification templates, staff role definitions, SLA rules, platform-level
// commission rules — and the 4-eyes (two-person) approval workflow that
// gates dangerous staff actions.
//
// Gating: /admin/* route policy restricts every route to MFA-verified staff
// before the handler runs; the handlers still fail hard (500 INTERNAL_ERROR)
// when no database is wired (dev, unit-test server). The audit middleware
// records every /admin/* mutation, so no handler writes audit rows itself.
//
// Honest mapping notes:
//   - templates: the contract AdminTemplate carries subject and variables;
//     both are stored (subject text, variables jsonb). The title column of
//     the milestone sketch has no contract field and stays at its default.
//   - TEMPLATE_KEY_EXISTS is defined for a create path that would collide
//     on a live key; PUT /admin/templates is a pure upsert (no create path
//     exists on the route), so the code is never raised — same reasoning as
//     FEATURE_KEY_EXISTS in admin_extra.go.
//   - staff roles: name conflicts on create answer 409 CONFLICT (the unique
//     constraint decides). ROLE_IN_USE (ERROR-CODES.md: "role assigned to
//     staff") guards a role-delete path the contract does not declare, so it
//     is never raised here.
//   - SLA rules: scope maps onto ticket_type; alertBeforeMinutes is stored
//     (default 15 per the contract); priority is the milestone-sketch
//     column with no contract field.
//   - commission rules: platform_commission_rules stores category defaults
//     (applies_to='category' + category_id) and entity overrides
//     (applies_to='delivery' — the platform default channel — plus
//     entity_type/entity_id). The contract has no channel dimension on
//     AdminCommissionRule, so the stored channel on overrides is a pin, not
//     a round-trip loss. COMMISSION_RULE_NOT_FOUND guards an update-by-id
//     path the contract does not declare; never raised here.
//   - two-person approvals: action/targetType/targetId/reason/payload map
//     onto action/entity_type/entity_id/reason/payload. Create requires the
//     requesting staff's account to resolve (422 VALIDATION_FAILED
//     otherwise). The 4-eyes property is enforced at decision time: only a
//     DIFFERENT staff member may decide (staff are JWT identities — the
//     roles table only admits customer/merchant/provider/rider, so there is
//     no DB registry of staff to count), so deciding one's own request
//     answers 409 APPROVAL_SAME_ACTOR and an already-decided request 409
//     APPROVAL_ALREADY_DECIDED. TWO_PERSON_REQUIRED is defined in
//     ERROR-CODES.md for a system-side 4-eyes gate this surface does not
//     declare; it is never raised here.

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/hudumika/api-backend/internal/gen"
	openapi_types "github.com/oapi-codegen/runtime/types"
)

// List bounds for the admin-config surfaces. Templates, staff roles, SLA
// rules and commission rules declare no pagination params (like the
// admin-extra lists); the two-person approval list declares only a status
// filter, so it is a bounded newest-first snapshot too.
const (
	adminConfigMaxListLimit = 100
	// adminTwoPersonListCap bounds /admin/two-person-approvals.
	adminTwoPersonListCap = 25
)

// ---------------------------------------------------------------------------
// Notification templates
// ---------------------------------------------------------------------------

// adminTemplateRow is one admin_templates row.
type adminTemplateRow struct {
	key       string
	title     string
	subject   *string
	body      string
	variables []byte
	channel   string
	active    bool
	updatedAt time.Time
}

const adminTemplateColumns = `key, title, subject, body, variables, channel, active, updated_at`

func scanAdminTemplate(sc pgx.Row) (adminTemplateRow, error) {
	var row adminTemplateRow
	err := sc.Scan(&row.key, &row.title, &row.subject, &row.body, &row.variables,
		&row.channel, &row.active, &row.updatedAt)
	return row, err
}

// toGenTemplate maps a template row onto the contract AdminTemplate; the
// stored variables jsonb round-trips onto []string, corrupt rows read as
// nil (variables omitted).
func toGenTemplate(row adminTemplateRow) gen.AdminTemplate {
	out := gen.AdminTemplate{
		Key:       row.key,
		Subject:   row.subject,
		Body:      &row.body,
		Channel:   gen.AdminTemplateChannel(row.channel),
		Active:    &row.active,
		UpdatedAt: &row.updatedAt,
	}
	if len(row.variables) > 0 {
		var variables []string
		if err := json.Unmarshal(row.variables, &variables); err == nil {
			out.Variables = &variables
		}
	}
	return out
}

// AdminListTemplates returns every notification template, key-sorted,
// capped at adminConfigMaxListLimit (GET /admin/templates).
func (s *Server) AdminListTemplates(w http.ResponseWriter, r *http.Request) {
	if s.db == nil {
		s.logger.Error("list templates failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	rows, err := s.db.Pool().Query(r.Context(),
		`SELECT `+adminTemplateColumns+` FROM admin_templates ORDER BY key LIMIT $1`,
		adminConfigMaxListLimit)
	if err != nil {
		s.logger.Error("list templates query failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer rows.Close()

	out := make([]gen.AdminTemplate, 0, adminConfigMaxListLimit)
	for rows.Next() {
		row, err := scanAdminTemplate(rows)
		if err != nil {
			s.logger.Error("scan template row failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		out = append(out, toGenTemplate(row))
	}
	if err := rows.Err(); err != nil {
		s.logger.Error("iterate template rows failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// AdminUpsertTemplate upserts a template by key (PUT /admin/templates,
// 200). The route is a pure upsert — there is no create path to collide on
// — so TEMPLATE_KEY_EXISTS is never raised (see the file header). A missing
// key or unknown channel answers 422 VALIDATION_FAILED.
func (s *Server) AdminUpsertTemplate(w http.ResponseWriter, r *http.Request) {
	var body gen.AdminUpsertTemplateJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if strings.TrimSpace(body.Key) == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "key is required")
		return
	}
	if !body.Channel.Valid() {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "channel must be one of sms, email, push, in_app")
		return
	}
	if s.db == nil {
		s.logger.Error("upsert template failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	active := true
	if body.Active != nil {
		active = *body.Active
	}
	bodyText := ""
	if body.Body != nil {
		bodyText = *body.Body
	}
	var variables []byte
	if body.Variables != nil {
		variables, _ = json.Marshal(body.Variables)
	} else {
		// The column is NOT NULL; an absent variables list stores [].
		variables = []byte("[]")
	}
	row, err := scanAdminTemplate(s.db.Pool().QueryRow(r.Context(),
		`INSERT INTO admin_templates (key, title, subject, body, variables, channel, active, updated_at)
		 VALUES ($1, '', $2, $3, $4, $5, $6, now())
		 ON CONFLICT (key) DO UPDATE
		 SET subject = EXCLUDED.subject, body = EXCLUDED.body, variables = EXCLUDED.variables,
		     channel = EXCLUDED.channel, active = EXCLUDED.active, updated_at = now()
		 RETURNING `+adminTemplateColumns,
		body.Key, body.Subject, bodyText, variables, string(body.Channel), active))
	if err != nil {
		s.logger.Error("upsert template failed", "key", body.Key, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	newJSON, _ := json.Marshal(map[string]any{"key": body.Key, "channel": string(body.Channel)})
	_ = s.AuditLog(r.Context(), r, "template.upserted", "admin_template", nil, nil, newJSON)
	writeJSON(w, http.StatusOK, toGenTemplate(row))
}

// ---------------------------------------------------------------------------
// Staff roles
// ---------------------------------------------------------------------------

// adminStaffRoleRow is one staff_roles row.
type adminStaffRoleRow struct {
	id          uuid.UUID
	name        string
	description string
	permissions []byte
	system      bool
	createdAt   time.Time
}

const adminStaffRoleColumns = `id, name, description, permissions, system, created_at`

// toGenStaffRole maps a role row onto the contract AdminRoleDefinition; the
// stored permissions jsonb round-trips onto []string, corrupt rows read as
// [] (the contract requires the array).
func toGenStaffRole(row adminStaffRoleRow) gen.AdminRoleDefinition {
	permissions := []string{}
	if len(row.permissions) > 0 {
		_ = json.Unmarshal(row.permissions, &permissions)
	}
	return gen.AdminRoleDefinition{
		Id:          newUUIDPtr(row.id),
		Name:        row.name,
		Description: &row.description,
		Permissions: permissions,
		System:      &row.system,
		CreatedAt:   &row.createdAt,
	}
}

// AdminListStaffRoles returns every staff role definition, name-sorted,
// capped at adminConfigMaxListLimit (GET /admin/staff-roles).
func (s *Server) AdminListStaffRoles(w http.ResponseWriter, r *http.Request) {
	if s.db == nil {
		s.logger.Error("list staff roles failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	rows, err := s.db.Pool().Query(r.Context(),
		`SELECT `+adminStaffRoleColumns+` FROM staff_roles ORDER BY name LIMIT $1`,
		adminConfigMaxListLimit)
	if err != nil {
		s.logger.Error("list staff roles query failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer rows.Close()

	out := make([]gen.AdminRoleDefinition, 0, adminConfigMaxListLimit)
	for rows.Next() {
		var row adminStaffRoleRow
		if err := rows.Scan(&row.id, &row.name, &row.description, &row.permissions, &row.system, &row.createdAt); err != nil {
			s.logger.Error("scan staff role row failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		out = append(out, toGenStaffRole(row))
	}
	if err := rows.Err(); err != nil {
		s.logger.Error("iterate staff role rows failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// AdminCreateStaffRole inserts a custom staff role (POST /admin/staff-roles,
// 201). A blank name or empty permissions array answers 422 VALIDATION_FAILED
// before the database gate; a duplicate name answers 409 CONFLICT (the
// unique constraint decides — ROLE_IN_USE guards a delete path this contract
// does not declare, see the file header).
func (s *Server) AdminCreateStaffRole(w http.ResponseWriter, r *http.Request) {
	var body gen.AdminCreateStaffRoleJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if strings.TrimSpace(body.Name) == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "name is required")
		return
	}
	if len(body.Permissions) == 0 {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "permissions must not be empty")
		return
	}
	if s.db == nil {
		s.logger.Error("create staff role failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	description := ""
	if body.Description != nil {
		description = *body.Description
	}
	permissions, _ := json.Marshal(body.Permissions)
	system := false
	if body.System != nil {
		system = *body.System
	}
	var row adminStaffRoleRow
	err := s.db.Pool().QueryRow(r.Context(),
		`INSERT INTO staff_roles (name, description, permissions, system)
		 VALUES ($1, $2, $3, $4)
		 RETURNING `+adminStaffRoleColumns,
		body.Name, description, permissions, system).Scan(&row.id, &row.name, &row.description, &row.permissions, &row.system, &row.createdAt)
	if isUniqueViolation(err) {
		writeError(w, http.StatusConflict, "CONFLICT", "A staff role with this name already exists")
		return
	}
	if err != nil {
		s.logger.Error("create staff role failed", "name", body.Name, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	newJSON, _ := json.Marshal(map[string]any{"name": body.Name, "permissions": body.Permissions})
	_ = s.AuditLog(r.Context(), r, "staff_role.created", "staff_role", &row.id, nil, newJSON)
	writeJSON(w, http.StatusCreated, toGenStaffRole(row))
}

// ---------------------------------------------------------------------------
// SLA rules
// ---------------------------------------------------------------------------

// adminSlaRuleRow is one sla_rules row.
type adminSlaRuleRow struct {
	id                 uuid.UUID
	ticketType         string
	responseMinutes    int
	resolutionMinutes  int
	alertBeforeMinutes int
	priority           string
	active             bool
	createdAt          time.Time
}

const adminSlaRuleColumns = `id, ticket_type, response_minutes, resolution_minutes, alert_before_minutes, priority, active, created_at`

func scanAdminSlaRule(sc pgx.Row) (adminSlaRuleRow, error) {
	var row adminSlaRuleRow
	err := sc.Scan(&row.id, &row.ticketType, &row.responseMinutes, &row.resolutionMinutes,
		&row.alertBeforeMinutes, &row.priority, &row.active, &row.createdAt)
	return row, err
}

// toGenSlaRule maps a sla_rules row onto the contract AdminSlaRule; the
// stored ticket_type is the contract scope.
func toGenSlaRule(row adminSlaRuleRow) gen.AdminSlaRule {
	alertBefore := row.alertBeforeMinutes
	return gen.AdminSlaRule{
		Id:                 newUUIDPtr(row.id),
		Scope:              gen.AdminSlaRuleScope(row.ticketType),
		ResponseMinutes:    row.responseMinutes,
		ResolutionMinutes:  row.resolutionMinutes,
		AlertBeforeMinutes: &alertBefore,
		Active:             &row.active,
	}
}

// AdminListSlaRules returns the SLA rules, active first (then newest first),
// capped at adminConfigMaxListLimit (GET /admin/sla-rules). The active-first
// ordering keeps deactivated legacy rules visible but at the bottom after a
// replace-all.
func (s *Server) AdminListSlaRules(w http.ResponseWriter, r *http.Request) {
	if s.db == nil {
		s.logger.Error("list sla rules failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	rows, err := s.db.Pool().Query(r.Context(),
		`SELECT `+adminSlaRuleColumns+` FROM sla_rules
		 ORDER BY active DESC, created_at DESC, id DESC LIMIT $1`,
		adminConfigMaxListLimit)
	if err != nil {
		s.logger.Error("list sla rules query failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer rows.Close()

	out := make([]gen.AdminSlaRule, 0, adminConfigMaxListLimit)
	for rows.Next() {
		row, err := scanAdminSlaRule(rows)
		if err != nil {
			s.logger.Error("scan sla rule row failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		out = append(out, toGenSlaRule(row))
	}
	if err := rows.Err(); err != nil {
		s.logger.Error("iterate sla rule rows failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// AdminPutSlaRules configures the SLA rule set (PUT /admin/sla-rules, 200):
// replace-all semantics — every existing rule is deactivated and the body
// rules are inserted active (unless the body says otherwise), all in one
// transaction. A negative response/resolution minutes answers 422
// SLA_RULE_INVALID, an unknown scope 422 VALIDATION_FAILED, both before the
// database gate.
func (s *Server) AdminPutSlaRules(w http.ResponseWriter, r *http.Request) {
	var body gen.AdminPutSlaRulesJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	for _, rule := range body.Rules {
		if !rule.Scope.Valid() {
			writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "scope must be one of support_ticket, delivery, service_booking, refund, verification")
			return
		}
		if rule.ResponseMinutes < 0 || rule.ResolutionMinutes < 0 {
			writeError(w, http.StatusUnprocessableEntity, "SLA_RULE_INVALID", "responseMinutes and resolutionMinutes must not be negative")
			return
		}
	}
	if s.db == nil {
		s.logger.Error("put sla rules failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	tx, err := s.db.Pool().Begin(r.Context())
	if err != nil {
		s.logger.Error("put sla rules begin failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer tx.Rollback(r.Context())

	if _, err := tx.Exec(r.Context(), `UPDATE sla_rules SET active = false`); err != nil {
		s.logger.Error("deactivate sla rules failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	out := make([]gen.AdminSlaRule, 0, len(body.Rules))
	for _, rule := range body.Rules {
		alertBefore := 15
		if rule.AlertBeforeMinutes != nil {
			alertBefore = *rule.AlertBeforeMinutes
		}
		active := true
		if rule.Active != nil {
			active = *rule.Active
		}
		row, err := scanAdminSlaRule(tx.QueryRow(r.Context(),
			`INSERT INTO sla_rules (ticket_type, response_minutes, resolution_minutes, alert_before_minutes, priority, active)
			 VALUES ($1, $2, $3, $4, 'normal', $5)
			 RETURNING `+adminSlaRuleColumns,
			string(rule.Scope), rule.ResponseMinutes, rule.ResolutionMinutes, alertBefore, active))
		if err != nil {
			s.logger.Error("insert sla rule failed", "scope", rule.Scope, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		out = append(out, toGenSlaRule(row))
	}
	if err := tx.Commit(r.Context()); err != nil {
		s.logger.Error("put sla rules commit failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	newJSON, _ := json.Marshal(map[string]any{"ruleCount": len(body.Rules)})
	_ = s.AuditLog(r.Context(), r, "sla_rules.replaced", "sla_rule", nil, nil, newJSON)
	writeJSON(w, http.StatusOK, out)
}

// ---------------------------------------------------------------------------
// Platform commission rules
// ---------------------------------------------------------------------------

// adminCommissionRow is one platform_commission_rules row.
type adminCommissionRow struct {
	id         uuid.UUID
	appliesTo  string
	categoryID *uuid.UUID
	entityType *string
	entityID   *uuid.UUID
	rateBps    int
	active     bool
	createdAt  time.Time
	updatedAt  time.Time
}

const adminCommissionColumns = `id, applies_to, category_id, entity_type, entity_id, rate_bps, active, created_at, updated_at`

func scanAdminCommission(sc pgx.Row) (adminCommissionRow, error) {
	var row adminCommissionRow
	err := sc.Scan(&row.id, &row.appliesTo, &row.categoryID, &row.entityType,
		&row.entityID, &row.rateBps, &row.active, &row.createdAt, &row.updatedAt)
	return row, err
}

// toGenCommission maps a platform_commission_rules row onto the contract
// AdminCommissionRule: category defaults surface as scopeType=category with
// the category id; entity overrides surface as scopeType=merchant/provider
// with the entity id. Rows that map to no contract shape (a channel-level
// rule with no entity — never written by this surface) are reported as
// unmappable.
func toGenCommission(row adminCommissionRow) (gen.AdminCommissionRule, bool) {
	switch row.appliesTo {
	case "category":
		if row.categoryID == nil {
			return gen.AdminCommissionRule{}, false
		}
		scopeID := openapi_types.UUID(*row.categoryID)
		return gen.AdminCommissionRule{
			Id:        newUUIDPtr(row.id),
			ScopeType: gen.AdminCommissionRuleScopeTypeCategory,
			ScopeId:   &scopeID,
			RateBps:   row.rateBps,
			Active:    &row.active,
			UpdatedAt: &row.updatedAt,
		}, true
	case "delivery", "dine_in", "takeaway":
		if row.entityID == nil || row.entityType == nil {
			return gen.AdminCommissionRule{}, false
		}
		var scopeType gen.AdminCommissionRuleScopeType
		switch *row.entityType {
		case "merchant":
			scopeType = gen.AdminCommissionRuleScopeTypeMerchant
		case "provider":
			scopeType = gen.AdminCommissionRuleScopeTypeProvider
		default:
			return gen.AdminCommissionRule{}, false
		}
		scopeID := openapi_types.UUID(*row.entityID)
		return gen.AdminCommissionRule{
			Id:        newUUIDPtr(row.id),
			ScopeType: scopeType,
			ScopeId:   &scopeID,
			RateBps:   row.rateBps,
			Active:    &row.active,
			UpdatedAt: &row.updatedAt,
		}, true
	default:
		return gen.AdminCommissionRule{}, false
	}
}

// AdminListCommissionRules returns the active platform commission rules
// (GET /admin/commission-rules), newest first, capped at
// adminConfigMaxListLimit. The contract declares no filter params.
func (s *Server) AdminListCommissionRules(w http.ResponseWriter, r *http.Request) {
	if s.db == nil {
		s.logger.Error("list commission rules failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	rows, err := s.db.Pool().Query(r.Context(),
		`SELECT `+adminCommissionColumns+` FROM platform_commission_rules
		 WHERE active ORDER BY created_at DESC, id DESC LIMIT $1`,
		adminConfigMaxListLimit)
	if err != nil {
		s.logger.Error("list commission rules query failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer rows.Close()

	out := make([]gen.AdminCommissionRule, 0, adminConfigMaxListLimit)
	for rows.Next() {
		row, err := scanAdminCommission(rows)
		if err != nil {
			s.logger.Error("scan commission rule row failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		rule, ok := toGenCommission(row)
		if !ok {
			continue
		}
		out = append(out, rule)
	}
	if err := rows.Err(); err != nil {
		s.logger.Error("iterate commission rule rows failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// AdminPutCommissionRules sets the platform commission rule set (PUT
// /admin/commission-rules, 200): replace-all semantics — every existing rule
// is deactivated and the body rules are inserted active (unless the body
// says otherwise), all in one transaction. A rateBps outside 0..10000
// answers 422 COMMISSION_RULE_INVALID, an unknown scopeType 422
// VALIDATION_FAILED, both before the database gate.
func (s *Server) AdminPutCommissionRules(w http.ResponseWriter, r *http.Request) {
	var body gen.AdminPutCommissionRulesJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	for _, rule := range body.Rules {
		if !rule.ScopeType.Valid() {
			writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "scopeType must be one of category, merchant, provider")
			return
		}
		if rule.RateBps < 0 || rule.RateBps > 10000 {
			writeError(w, http.StatusUnprocessableEntity, "COMMISSION_RULE_INVALID", "rateBps must be between 0 and 10000")
			return
		}
	}
	if s.db == nil {
		s.logger.Error("put commission rules failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	tx, err := s.db.Pool().Begin(r.Context())
	if err != nil {
		s.logger.Error("put commission rules begin failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer tx.Rollback(r.Context())

	if _, err := tx.Exec(r.Context(), `UPDATE platform_commission_rules SET active = false`); err != nil {
		s.logger.Error("deactivate commission rules failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	out := make([]gen.AdminCommissionRule, 0, len(body.Rules))
	for _, rule := range body.Rules {
		var (
			appliesTo  string
			categoryID *uuid.UUID
			entityType *string
			entityID   *uuid.UUID
		)
		if rule.ScopeId != nil {
			id := uuid.UUID(*rule.ScopeId)
			switch rule.ScopeType {
			case gen.AdminCommissionRuleScopeTypeCategory:
				appliesTo = "category"
				categoryID = &id
			case gen.AdminCommissionRuleScopeTypeMerchant:
				appliesTo = "delivery"
				et := "merchant"
				entityType, entityID = &et, &id
			case gen.AdminCommissionRuleScopeTypeProvider:
				appliesTo = "delivery"
				et := "provider"
				entityType, entityID = &et, &id
			}
		} else {
			switch rule.ScopeType {
			case gen.AdminCommissionRuleScopeTypeCategory:
				appliesTo = "category"
			case gen.AdminCommissionRuleScopeTypeMerchant:
				appliesTo = "delivery"
				et := "merchant"
				entityType = &et
			case gen.AdminCommissionRuleScopeTypeProvider:
				appliesTo = "delivery"
				et := "provider"
				entityType = &et
			}
		}
		active := true
		if rule.Active != nil {
			active = *rule.Active
		}
		row, err := scanAdminCommission(tx.QueryRow(r.Context(),
			`INSERT INTO platform_commission_rules (applies_to, category_id, entity_type, entity_id, rate_bps, active)
			 VALUES ($1, $2, $3, $4, $5, $6)
			 RETURNING `+adminCommissionColumns,
			appliesTo, categoryID, entityType, entityID, rule.RateBps, active))
		if err != nil {
			s.logger.Error("insert commission rule failed", "scopeType", rule.ScopeType, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		mapped, ok := toGenCommission(row)
		if !ok {
			s.logger.Error("inserted commission rule does not map onto the contract", "scopeType", rule.ScopeType)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		out = append(out, mapped)
	}
	if err := tx.Commit(r.Context()); err != nil {
		s.logger.Error("put commission rules commit failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	newJSON, _ := json.Marshal(map[string]any{"ruleCount": len(body.Rules)})
	_ = s.AuditLog(r.Context(), r, "commission_rules.replaced", "commission_rule", nil, nil, newJSON)
	writeJSON(w, http.StatusOK, out)
}

// ---------------------------------------------------------------------------
// Two-person (4-eyes) approvals
// ---------------------------------------------------------------------------

// adminApprovalRow is one two_person_approvals row.
type adminApprovalRow struct {
	id              uuid.UUID
	action          string
	entityType      string
	entityID        uuid.UUID
	reason          string
	payload         []byte
	requestedBy     uuid.UUID
	approvedBy      *uuid.UUID
	decisionComment *string
	status          string
	createdAt       time.Time
	decidedAt       *time.Time
}

const adminApprovalColumns = `id, action, entity_type, entity_id, reason, payload, requested_by, approved_by, decision_comment, status, created_at, decided_at`

func scanAdminApproval(sc pgx.Row) (adminApprovalRow, error) {
	var row adminApprovalRow
	err := sc.Scan(&row.id, &row.action, &row.entityType, &row.entityID, &row.reason,
		&row.payload, &row.requestedBy, &row.approvedBy, &row.decisionComment,
		&row.status, &row.createdAt, &row.decidedAt)
	return row, err
}

// toGenApproval maps a two_person_approvals row onto the contract
// AdminTwoPersonApproval; the stored payload jsonb round-trips onto a map,
// corrupt rows read as nil (payload omitted).
func toGenApproval(row adminApprovalRow) gen.AdminTwoPersonApproval {
	out := gen.AdminTwoPersonApproval{
		Id:          newUUID(row.id.String()),
		ActionType:  gen.AdminTwoPersonApprovalActionType(row.action),
		TargetType:  row.entityType,
		TargetId:    row.entityID.String(),
		Reason:      row.reason,
		Status:      gen.AdminTwoPersonApprovalStatus(row.status),
		RequestedBy: row.requestedBy.String(),
		CreatedAt:   row.createdAt,
		DecidedAt:   row.decidedAt,
	}
	if row.approvedBy != nil {
		decidedBy := row.approvedBy.String()
		out.DecidedBy = &decidedBy
	}
	out.DecisionComment = row.decisionComment
	if len(row.payload) > 0 {
		var payload map[string]interface{}
		if err := json.Unmarshal(row.payload, &payload); err == nil {
			out.Payload = &payload
		}
	}
	return out
}

// adminConfigActorID resolves the authenticated staff subject (phone) to its
// users row id. The subject must resolve: the approval row's requested_by /
// approved_by are NOT NULL uuids.
func (s *Server) adminConfigActorID(r *http.Request) (*uuid.UUID, bool) {
	claims, ok := ClaimsFromContext(r.Context())
	if !ok {
		return nil, false
	}
	var id uuid.UUID
	if err := s.db.Pool().QueryRow(r.Context(),
		`SELECT id FROM users WHERE phone = $1`, claims.Subject).Scan(&id); err != nil {
		return nil, false
	}
	return &id, true
}

// AdminCreateTwoPersonApproval initiates a 4-eyes approval for a dangerous
// action (POST /admin/two-person-approvals, 201). The requesting staff is
// recorded as requested_by and the row starts pending. An unknown actionType,
// blank targetType/reason or a non-UUID targetId answers 422
// VALIDATION_FAILED; an unresolvable staff account 422 VALIDATION_FAILED.
func (s *Server) AdminCreateTwoPersonApproval(w http.ResponseWriter, r *http.Request) {
	var body gen.AdminCreateTwoPersonApprovalJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if !body.ActionType.Valid() {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "actionType must be one of large_refund, change_commission, suspend_major_merchant, change_payment_settings, modify_ledger, change_iam_policy, delete_critical_data, release_hold")
		return
	}
	if strings.TrimSpace(body.TargetType) == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "targetType is required")
		return
	}
	targetID, err := uuid.Parse(body.TargetId)
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "targetId must be a UUID")
		return
	}
	if strings.TrimSpace(body.Reason) == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "reason is required")
		return
	}
	claims, ok := requireRBAC(w, r, s, PermApprovalDecide)
	if !ok {
		return
	}
	_ = claims
	if s.db == nil {
		s.logger.Error("create two-person approval failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	actor, ok := s.adminConfigActorID(r)
	if !ok {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Authenticated staff account not found")
		return
	}

	var payload []byte
	if body.Payload != nil {
		payload, _ = json.Marshal(body.Payload)
	}
	row, err := scanAdminApproval(s.db.Pool().QueryRow(r.Context(),
		`INSERT INTO two_person_approvals (action, entity_type, entity_id, reason, payload, requested_by)
		 VALUES ($1, $2, $3, $4, $5, $6)
		 RETURNING `+adminApprovalColumns,
		string(body.ActionType), body.TargetType, targetID, body.Reason, payload, *actor))
	if err != nil {
		s.logger.Error("create two-person approval failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusCreated, toGenApproval(row))
}

// AdminListTwoPersonApprovals returns the two-person approval queue (GET
// /admin/two-person-approvals), newest first, capped at
// adminTwoPersonListCap. The optional status filter narrows the set; an
// unknown status answers 422 VALIDATION_FAILED. The contract defines no
// pagination params, so the list is a bounded snapshot.
func (s *Server) AdminListTwoPersonApprovals(w http.ResponseWriter, r *http.Request, params gen.AdminListTwoPersonApprovalsParams) {
	if params.Status != nil && *params.Status != "" && !params.Status.Valid() {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "status must be one of pending, approved, rejected")
		return
	}
	claims, ok := requireRBAC(w, r, s, PermApprovalDecide)
	if !ok {
		return
	}
	_ = claims
	if s.db == nil {
		s.logger.Error("list two-person approvals failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	query := `SELECT ` + adminApprovalColumns + ` FROM two_person_approvals`
	var args []any
	if params.Status != nil && *params.Status != "" {
		args = append(args, string(*params.Status))
		query += ` WHERE status = $1`
	}
	args = append(args, adminTwoPersonListCap)
	query += fmt.Sprintf(` ORDER BY created_at DESC, id DESC LIMIT $%d`, len(args))

	rows, err := s.db.Pool().Query(r.Context(), query, args...)
	if err != nil {
		s.logger.Error("list two-person approvals query failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer rows.Close()

	out := make([]gen.AdminTwoPersonApproval, 0, adminTwoPersonListCap)
	for rows.Next() {
		row, err := scanAdminApproval(rows)
		if err != nil {
			s.logger.Error("scan two-person approval row failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		out = append(out, toGenApproval(row))
	}
	if err := rows.Err(); err != nil {
		s.logger.Error("iterate two-person approval rows failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// AdminDecideTwoPersonApproval applies the second staff member's decision
// (POST /admin/two-person-approvals/{approvalId}/decision, 200): approve or
// reject ends the pending request, recording the decider, the comment and
// the decision time. Only a DIFFERENT staff member may decide: deciding
// one's own request answers 409 APPROVAL_SAME_ACTOR; an already-decided
// request 409 APPROVAL_ALREADY_DECIDED; a missing request 404
// APPROVAL_NOT_FOUND. A blank comment or unknown decision answers 422
// VALIDATION_FAILED before the database gate.
func (s *Server) AdminDecideTwoPersonApproval(w http.ResponseWriter, r *http.Request, approvalId openapi_types.UUID) {
	id, err := uuid.Parse(approvalId.String())
	if err != nil {
		writeError(w, http.StatusBadRequest, "VALIDATION_FAILED", "approvalId is not a valid UUID")
		return
	}
	var body gen.AdminDecideTwoPersonApprovalJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if !body.Decision.Valid() {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "decision must be one of approve, reject")
		return
	}
	if strings.TrimSpace(body.Comment) == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "comment is required")
		return
	}
	claims, ok := requireRBAC(w, r, s, PermApprovalDecide)
	if !ok {
		return
	}
	_ = claims
	if s.db == nil {
		s.logger.Error("decide two-person approval failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	actor, ok := s.adminConfigActorID(r)
	if !ok {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Authenticated staff account not found")
		return
	}

	tx, err := s.db.Pool().Begin(r.Context())
	if err != nil {
		s.logger.Error("decide two-person approval begin failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer tx.Rollback(r.Context())

	var (
		status      string
		requestedBy uuid.UUID
	)
	err = tx.QueryRow(r.Context(),
		`SELECT status, requested_by FROM two_person_approvals WHERE id = $1 FOR UPDATE`,
		id).Scan(&status, &requestedBy)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "APPROVAL_NOT_FOUND", "Two-person approval not found")
		return
	}
	if err != nil {
		s.logger.Error("lock two-person approval failed", "approval", id, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if status != "pending" {
		writeError(w, http.StatusConflict, "APPROVAL_ALREADY_DECIDED", "This approval has already been decided")
		return
	}
	if *actor == requestedBy {
		writeError(w, http.StatusConflict, "APPROVAL_SAME_ACTOR", "The requesting staff cannot decide their own approval")
		return
	}

	newStatus := "approved"
	if body.Decision == gen.AdminDecideTwoPersonApprovalJSONBodyDecisionReject {
		newStatus = "rejected"
	}
	row, err := scanAdminApproval(tx.QueryRow(r.Context(),
		`UPDATE two_person_approvals
		 SET status = $2, approved_by = $3, decision_comment = $4, decided_at = now()
		 WHERE id = $1
		 RETURNING `+adminApprovalColumns,
		id, newStatus, *actor, body.Comment))
	if err != nil {
		s.logger.Error("decide two-person approval update failed", "approval", id, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		s.logger.Error("decide two-person approval commit failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, toGenApproval(row))
}
