package api

// ADMIN-PENDING bounded context (PENDING-ENDPOINTS.md; the 16 methods that
// the regenerated contract routes under /admin/* and previously answered 501
// via the embedded gen.Unimplemented): rider/provider verification
// decisions, dispute resolution, payout-batch reconciliation, rider COD
// shift decisions, chain onboarding/suspension, data-export approval and
// re-run, loyalty config review, crash response, mandatory-rest overrides,
// seal-broken handoff decisions, logistics anomaly decisions, admin order
// cancellation and consignment missing-order resolution.
//
// Gating: the /admin/* route policy restricts every route to MFA-verified
// staff before the handler runs; handlers still fail hard (500
// INTERNAL_ERROR) when no database is wired (dev, unit-test server).
//
// Honest mapping notes:
//   - every handler writes the domain audit entry itself (InsertReturningID)
//     because the Admin*Result contract requires auditEntryId; the generic
//     middleware entry is written on top of it by the /admin/* audit
//     middleware.
//   - TWO_PERSON_REQUIRED endpoints (dispute_resolve above the finance
//     threshold, chain_suspend, order_cancel with an above-threshold refund)
//     route through the two_person_approvals flow (workflow 31): the
//     initiating admin creates the pending approval and the endpoint answers
//     409 TWO_PERSON_REQUIRED; a different admin repeating the action is the
//     second approver — the pending row is approved and the action executes
//     server-side (workflow 31 step 5). An already-approved row for the same
//     action+entity also executes.
//   - disputes/logistics-anomalies tables land with migrations 00070/00071;
//     rider safety events, forced_rest_until, handoff seal-decision columns,
//     consignment missing-decision columns and the admin_config registry land
//     with 00071.

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5/middleware"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/hudumika/api-backend/internal/audit"
	"github.com/hudumika/api-backend/internal/gen"
	"github.com/hudumika/api-backend/internal/orders"
	openapi_types "github.com/oapi-codegen/runtime/types"
)

// adminPendingFinanceThresholdTZS is the finance threshold above which a
// refund/payout decision or an order-cancel refund requires the two-person
// (4-eyes) approval flow (PENDING-ENDPOINTS.md §3/§16, workflow 31).
// Deprecated: use GetSettings().TwoPersonThresholdTZS instead.

// adminRestEnforceWindow is the rest window enforced by AdminRiderRestOverride
// (WORKFLOWS.md #20: a mandated continuous-rest block).
// Deprecated: use time.Duration(GetSettings().AdminRestEnforceHours) * time.Hour instead.

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

// adminPendingAuditDetails is the details payload for the domain audit entry;
// every Admin*Result requires auditEntryId, so the handler writes the entry
// and surfaces the returned id.
type adminPendingAuditDetails struct {
	Before any    `json:"before"`
	After  any    `json:"after"`
	Reason string `json:"reason"`
}

// adminPendingAudit writes the domain audit entry (audit.go convention:
// actorUserId via the session subject, actorRole, action, entityType,
// entityId, details{before,after,reason}, requestId, ipAddress) and returns
// the generated row id as the contract auditEntryId. Best-effort like the
// middleware: a failed insert is logged and the caller gets the nil UUID so
// the request still completes with a defined response shape.
func (s *Server) adminPendingAudit(ctx context.Context, r *http.Request, claims *Claims, action, entityType, entityID, reason string, before, after any) openapi_types.UUID {
	details, err := json.Marshal(adminPendingAuditDetails{Before: before, After: after, Reason: reason})
	if err != nil {
		s.logger.Error("admin pending audit details marshal failed", "action", action, "error", err)
		return openapi_types.UUID(uuid.Nil)
	}
	id, err := audit.NewPg(s.db.Pool()).InsertReturningID(ctx, audit.Entry{
		ActorID:    claims.Subject,
		ActorRole:  claims.Role,
		Action:     action,
		EntityType: entityType,
		EntityID:   entityID,
		Details:    details,
		RequestID:  middleware.GetReqID(ctx),
		IP:         r.RemoteAddr,
		CreatedAt:  time.Now(),
	})
	if err != nil {
		s.logger.Error("admin pending audit insert failed", "action", action, "error", err)
		return openapi_types.UUID(uuid.Nil)
	}
	return openapi_types.UUID(id)
}

// adminPendingTwoPersonOutcome reports how the 4-eyes flow resolved for a
// dangerous action.
type adminPendingTwoPersonOutcome int

const (
	// adminPendingTwoPersonRequired answers 409 TWO_PERSON_REQUIRED: the
	// initiating admin created (or still owns) the pending approval and the
	// flow demands a second, different approver before execution.
	adminPendingTwoPersonRequired adminPendingTwoPersonOutcome = iota
	// adminPendingTwoPersonExecuted means the action may execute now: a
	// different admin approved the pending row (workflow 31 step 5), or the
	// action already has an approved approval.
	adminPendingTwoPersonExecuted
)

// adminPendingTwoPerson routes a dangerous action through the two-person
// approval flow (admin_config.go two_person_approvals, workflow 31):
//   - no approval row yet → the initiating staff member creates the pending
//     approval and the endpoint answers TWO_PERSON_REQUIRED;
//   - a pending approval owned by the SAME actor → still waiting for the
//     second approver (TWO_PERSON_REQUIRED);
//   - a pending approval owned by a DIFFERENT actor → this actor is the
//     second approver: the row is approved (approved_by/decision_comment/
//     decided_at) and execution proceeds server-side;
//   - an already-approved row → execution proceeds (idempotent re-invocation
//     after the approval decision endpoint ran).
//
// ok=false signals a failure that must answer 500 INTERNAL_ERROR.
func (s *Server) adminPendingTwoPerson(r *http.Request, action, entityType string, entityID uuid.UUID, reason string, payload map[string]any) (adminPendingTwoPersonOutcome, bool) {
	actor, ok := s.adminConfigActorID(r)
	if !ok {
		return adminPendingTwoPersonRequired, false
	}
	ctx := r.Context()

	var row adminApprovalRow
	row, err := scanAdminApproval(s.db.Pool().QueryRow(ctx,
		`SELECT `+adminApprovalColumns+` FROM two_person_approvals
		 WHERE action = $1 AND entity_type = $2 AND entity_id = $3
		 ORDER BY created_at DESC, id DESC LIMIT 1`,
		action, entityType, entityID))
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		// Initiating admin: create the pending approval and demand the
		// second approver.
		var p []byte
		if payload != nil {
			p, _ = json.Marshal(payload)
		}
		if _, err := s.db.Pool().Exec(ctx,
			`INSERT INTO two_person_approvals (action, entity_type, entity_id, reason, payload, requested_by)
			 VALUES ($1, $2, $3, $4, $5, $6)`,
			action, entityType, entityID, reason, p, *actor); err != nil {
			s.logger.Error("create pending two-person approval failed", "action", action, "error", err)
			return adminPendingTwoPersonRequired, false
		}
		return adminPendingTwoPersonRequired, true
	case err != nil:
		s.logger.Error("load pending two-person approval failed", "action", action, "error", err)
		return adminPendingTwoPersonRequired, false
	}

	if row.status == "approved" {
		// Already approved (the decision endpoint ran): execute.
		return adminPendingTwoPersonExecuted, true
	}
	if row.requestedBy == *actor {
		// Same initiator: the second, different approver is still required.
		return adminPendingTwoPersonRequired, true
	}

	// A different staff member is deciding: approve the pending row and
	// execute server-side (workflow 31 step 5).
	_, err = s.db.Pool().Exec(ctx,
		`UPDATE two_person_approvals
		 SET status = 'approved', approved_by = $2, decision_comment = $3, decided_at = now()
		 WHERE id = $1`,
		row.id, *actor, reason)
	if err != nil {
		s.logger.Error("approve two-person approval failed", "approval", row.id, "error", err)
		return adminPendingTwoPersonRequired, false
	}
	return adminPendingTwoPersonExecuted, true
}

// adminPendingActorID resolves the authenticated staff subject to its users
// row id for the decided_by / reconciled_by / updated_by stamps.
func (s *Server) adminPendingActorID(r *http.Request) (uuid.UUID, bool) {
	actor, ok := s.adminConfigActorID(r)
	if !ok {
		return uuid.Nil, false
	}
	return *actor, true
}

// adminPendingReasonRequired enforces the contract's ADMIN_REASON_REQUIRED
// 422 for a blank required reason/note.
func adminPendingReasonRequired(w http.ResponseWriter, value string, field string) bool {
	if strings.TrimSpace(value) == "" {
		writeError(w, http.StatusUnprocessableEntity, "ADMIN_REASON_REQUIRED", field+" is required")
		return true
	}
	return false
}

// ---------------------------------------------------------------------------
// 1. rider_approve — POST /admin/riders/{riderId}/approval
// ---------------------------------------------------------------------------

// AdminRiderApprovalDecision applies a staff decision to a rider verification
// (approve or request_changes). approve moves any non-terminal verification
// state to approved; request_changes to changes_requested. A terminal state
// (approved/rejected/suspended) answers 409 RIDER_ALREADY_DECIDED; a missing
// rider 404 RIDER_NOT_FOUND. The audit entry carries the rider.* prefix
// (rider.approved / rider.changes_requested) with the verification state as
// before/after.
func (s *Server) AdminRiderApprovalDecision(w http.ResponseWriter, r *http.Request, riderId openapi_types.UUID) {
	var body gen.AdminRiderApprovalDecisionJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if !body.Decision.Valid() {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "decision must be one of approve, request_changes")
		return
	}
	if adminPendingReasonRequired(w, body.Reason, "reason") {
		return
	}
	if s.db == nil {
		s.logger.Error("rider approval decision failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	claims, ok := requireRBAC(w, r, s, PermProviderVerify)
	if !ok {
		return
	}

	var current string
	err := s.db.Pool().QueryRow(r.Context(),
		`SELECT verification FROM riders WHERE id = $1`, uuid.UUID(riderId)).Scan(&current)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "RIDER_NOT_FOUND", "Rider not found")
		return
	}
	if err != nil {
		s.logger.Error("rider approval lookup failed", "rider", riderId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if current == "approved" || current == "rejected" || current == "suspended" {
		writeError(w, http.StatusConflict, "RIDER_ALREADY_DECIDED", "Rider already has a terminal verification state")
		return
	}

	target := "changes_requested"
	action := "rider.changes_requested"
	if body.Decision == gen.AdminRiderApprovalBodyDecisionApprove {
		target = "approved"
		action = "rider.approved"
	}
	if _, err := s.db.Pool().Exec(r.Context(),
		`UPDATE riders SET verification = $2, updated_at = now() WHERE id = $1`,
		uuid.UUID(riderId), target); err != nil {
		s.logger.Error("rider approval decision update failed", "rider", riderId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	auditEntryID := s.adminPendingAudit(r.Context(), r, claims, action, "rider", uuid.UUID(riderId).String(), body.Reason,
		statusString(current), statusString(target))
	_ = s.AuditLog(r.Context(), r, action, "rider", (*uuid.UUID)(&riderId), nil, nil)
	writeJSON(w, http.StatusOK, gen.AdminRiderApprovalResult{
		RiderId:      riderId,
		Status:       gen.AdminRiderApprovalResultStatus(target),
		AuditEntryId: auditEntryID,
	})
}

// ---------------------------------------------------------------------------
// 2. provider_approve — POST /admin/providers/{providerId}/approval
// ---------------------------------------------------------------------------

// AdminProviderApprovalDecision applies a staff decision to a provider
// verification (approve or request_changes), mirroring the rider decision.
func (s *Server) AdminProviderApprovalDecision(w http.ResponseWriter, r *http.Request, providerId openapi_types.UUID) {
	var body gen.AdminProviderApprovalDecisionJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if !body.Decision.Valid() {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "decision must be one of approve, request_changes")
		return
	}
	if adminPendingReasonRequired(w, body.Reason, "reason") {
		return
	}
	if s.db == nil {
		s.logger.Error("provider approval decision failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	claims, ok := requireRBAC(w, r, s, PermProviderVerify)
	if !ok {
		return
	}

	var current string
	err := s.db.Pool().QueryRow(r.Context(),
		`SELECT verification FROM providers WHERE id = $1`, uuid.UUID(providerId)).Scan(&current)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "PROVIDER_NOT_FOUND", "Provider not found")
		return
	}
	if err != nil {
		s.logger.Error("provider approval lookup failed", "provider", providerId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if current == "approved" || current == "rejected" || current == "suspended" {
		writeError(w, http.StatusConflict, "PROVIDER_ALREADY_DECIDED", "Provider already has a terminal verification state")
		return
	}

	target := "changes_requested"
	action := "provider.changes_requested"
	if body.Decision == gen.AdminProviderApprovalBodyDecisionApprove {
		target = "approved"
		action = "provider.approved"
	}
	if _, err := s.db.Pool().Exec(r.Context(),
		`UPDATE providers SET verification = $2, updated_at = now() WHERE id = $1`,
		uuid.UUID(providerId), target); err != nil {
		s.logger.Error("provider approval decision update failed", "provider", providerId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	auditEntryID := s.adminPendingAudit(r.Context(), r, claims, action, "provider", uuid.UUID(providerId).String(), body.Reason,
		statusString(current), statusString(target))
	_ = s.AuditLog(r.Context(), r, action, "provider", (*uuid.UUID)(&providerId), nil, nil)
	writeJSON(w, http.StatusOK, gen.AdminProviderApprovalResult{
		ProviderId:   providerId,
		Status:       gen.AdminProviderApprovalResultStatus(target),
		AuditEntryId: auditEntryID,
	})
}

// ---------------------------------------------------------------------------
// 3. dispute_resolve — POST /admin/disputes/{disputeId}/decision
// ---------------------------------------------------------------------------

// AdminDisputeDecision resolves a finance dispute (refund, payout or reject).
// refund/payout require amountTZS; a refund additionally appends a refund
// ledger entry on the order's merchant account (negative amount, type
// 'refund', referencing the order). An above-threshold refund/payout is
// 4-eyes-gated (TWO_PERSON_REQUIRED until a second approver confirms). A
// decided dispute answers 409 DISPUTE_ALREADY_DECIDED; a missing one 404
// DISPUTE_NOT_FOUND. Audit prefix dispute.* (dispute.refund / dispute.payout
// / dispute.reject) with the dispute state as before/after.
func (s *Server) AdminDisputeDecision(w http.ResponseWriter, r *http.Request, disputeId openapi_types.UUID) {
	var body gen.AdminDisputeDecisionJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if !body.Decision.Valid() {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "decision must be one of refund, payout, reject")
		return
	}
	if adminPendingReasonRequired(w, body.Reason, "reason") {
		return
	}
	if (body.Decision == gen.AdminDisputeDecisionBodyDecisionRefund || body.Decision == gen.AdminDisputeDecisionBodyDecisionPayout) && body.AmountTZS == nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "amountTZS is required for refund or payout decisions")
		return
	}
	if body.AmountTZS != nil && *body.AmountTZS < 0 {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "amountTZS must not be negative")
		return
	}
	if s.db == nil {
		s.logger.Error("dispute decision failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	claims, ok := requireRBAC(w, r, s, PermRefundApprove)
	if !ok {
		return
	}

	var (
		status   string
		orderID  *uuid.UUID
		userID   uuid.UUID
		decided  bool
	)
	err := s.db.Pool().QueryRow(r.Context(),
		`SELECT status, order_id, user_id, decided_at IS NOT NULL
		 FROM disputes WHERE id = $1`, uuid.UUID(disputeId)).Scan(&status, &orderID, &userID, &decided)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "DISPUTE_NOT_FOUND", "Dispute not found")
		return
	}
	if err != nil {
		s.logger.Error("dispute decision lookup failed", "dispute", disputeId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if decided {
		writeError(w, http.StatusConflict, "DISPUTE_ALREADY_DECIDED", "Dispute already has a decision")
		return
	}

	// Two-person gate: refund/payout above the finance threshold.
	if body.AmountTZS != nil && int64(*body.AmountTZS) > GetSettings().TwoPersonThresholdTZS &&
		(body.Decision == gen.AdminDisputeDecisionBodyDecisionRefund || body.Decision == gen.AdminDisputeDecisionBodyDecisionPayout) {
		outcome, ok := s.adminPendingTwoPerson(r, "large_refund", "dispute", uuid.UUID(disputeId), body.Reason,
			map[string]any{"decision": string(body.Decision), "amountTZS": *body.AmountTZS, "orderId": orderID})
		if !ok {
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		if outcome == adminPendingTwoPersonRequired {
			writeError(w, http.StatusConflict, "TWO_PERSON_REQUIRED", "This decision is above the finance threshold and requires the two-person approval flow")
			return
		}
	}

	target := "resolved"
	action := "dispute.reject"
	switch body.Decision {
	case gen.AdminDisputeDecisionBodyDecisionRefund:
		target = "refunded"
		action = "dispute.refund"
		if err := s.adminPendingAppendRefund(r, orderID, *body.AmountTZS, uuid.UUID(disputeId)); err != nil {
			s.logger.Error("dispute refund ledger append failed", "dispute", disputeId, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
	case gen.AdminDisputeDecisionBodyDecisionPayout:
		action = "dispute.payout"
	}

	actor, _ := s.adminPendingActorID(r)
	if _, err := s.db.Pool().Exec(r.Context(),
		`UPDATE disputes SET status = $2, decision_reason = $3, decided_by = $4, decided_at = now()
		 WHERE id = $1`,
		uuid.UUID(disputeId), target, body.Reason, nullableUUID(actor)); err != nil {
		s.logger.Error("dispute decision update failed", "dispute", disputeId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	auditEntryID := s.adminPendingAudit(r.Context(), r, claims, action, "dispute", uuid.UUID(disputeId).String(), body.Reason,
		statusString(status), map[string]any{"status": "decided", "decision": string(body.Decision), "amountTZS": body.AmountTZS})
	_ = s.AuditLog(r.Context(), r, action, "dispute", (*uuid.UUID)(&disputeId), nil, nil)
	writeJSON(w, http.StatusOK, gen.AdminDisputeDecisionResult{
		DisputeId:    disputeId,
		Decision:     gen.AdminDisputeDecisionResultDecision(string(body.Decision)),
		Status:       gen.Decided,
		AuditEntryId: auditEntryID,
	})
}

// adminPendingAppendRefund appends a refund ledger entry on the order's
// merchant account (negative amount, type 'refund', referencing the order).
// Money is bigint TZS; the running balance follows the ledger pattern
// (wallet.go withdrawal). A missing order or unknown merchant is logged and
// skipped — the dispute row and audit entry still record the decision.
func (s *Server) adminPendingAppendRefund(r *http.Request, orderID *uuid.UUID, amountTZS int, reference uuid.UUID) error {
	if orderID == nil {
		return nil
	}
	var merchantID *uuid.UUID
	err := s.db.Pool().QueryRow(r.Context(),
		`SELECT merchant_id FROM orders WHERE id = $1`, *orderID).Scan(&merchantID)
	if errors.Is(err, pgx.ErrNoRows) {
		s.logger.Warn("dispute refund skipped: order not found", "order", *orderID)
		return nil
	}
	if err != nil {
		return err
	}
	if merchantID == nil {
		s.logger.Warn("dispute refund skipped: order has no merchant", "order", *orderID)
		return nil
	}

	tx, err := s.db.Pool().Begin(r.Context())
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	var balance int64
	err = tx.QueryRow(r.Context(),
		`SELECT balance_tzs FROM ledger_entries
		 WHERE account_owner_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1`,
		*merchantID).Scan(&balance)
	if errors.Is(err, pgx.ErrNoRows) {
		balance = 0
	} else if err != nil {
		return err
	}
	if _, err := tx.Exec(r.Context(),
		`INSERT INTO ledger_entries (account_owner_id, account_type, type, amount_tzs, balance_tzs, reference_type, reference_id, idempotency_key)
		 VALUES ($1, 'merchant', 'refund', $2, $3, 'order', $4, $5)`,
		*merchantID, -int64(amountTZS), balance-int64(amountTZS), *orderID, "refund:dispute:"+reference.String()); err != nil {
		return err
	}
	return tx.Commit(r.Context())
}

// ---------------------------------------------------------------------------
// 4. payout_reconcile — POST /admin/payouts/{batchId}/reconcile
// ---------------------------------------------------------------------------

// AdminPayoutReconcile settles a payout batch (paid) or marks it exceptional
// (failed/exception with the variance note). paid flips the batch to settled
// and its entries to paid; failed/exception flips the batch to exception and
// the pending/processing entries to the matching state. An already-settled
// batch answers 409 PAYOUT_ALREADY_RECONCILED; a missing batch 404
// PAYOUT_BATCH_NOT_FOUND. Audit prefix payout.* (payout.reconciled) with the
// batch settlement state as before/after plus the outcome.
func (s *Server) AdminPayoutReconcile(w http.ResponseWriter, r *http.Request, batchId openapi_types.UUID) {
	var body gen.AdminPayoutReconcileJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if !body.Outcome.Valid() {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "outcome must be one of paid, failed, exception")
		return
	}
	if body.Outcome == gen.AdminPayoutReconcileBodyOutcomeException && (body.Note == nil || strings.TrimSpace(*body.Note) == "") {
		writeError(w, http.StatusUnprocessableEntity, "ADMIN_REASON_REQUIRED", "note is required when outcome is exception")
		return
	}
	if s.db == nil {
		s.logger.Error("payout reconcile failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	claims, ok := requireRBAC(w, r, s, PermFinanceManage)
	if !ok {
		return
	}

	var current string
	err := s.db.Pool().QueryRow(r.Context(),
		`SELECT status FROM payout_batches WHERE id = $1`, uuid.UUID(batchId)).Scan(&current)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "PAYOUT_BATCH_NOT_FOUND", "Payout batch not found")
		return
	}
	if err != nil {
		s.logger.Error("payout reconcile lookup failed", "batch", batchId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if current == "settled" {
		writeError(w, http.StatusConflict, "PAYOUT_ALREADY_RECONCILED", "Payout batch was already reconciled")
		return
	}

	// Two-person gate: payout reconciliation requires 4-eyes approval.
	payload := map[string]any{"outcome": string(body.Outcome)}
	if body.Note != nil {
		payload["note"] = *body.Note
	}
	outcome, ok := s.adminPendingTwoPerson(r, "payout.reconcile", "payout_reconciliation", uuid.Nil, "", payload)
	if !ok {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if outcome == adminPendingTwoPersonRequired {
		writeJSON(w, http.StatusConflict, map[string]any{
			"code": "TWO_PERSON_REQUIRED",
			"message": "This action requires a second admin to approve",
		})
		return
	}

	tx, err := s.db.Pool().Begin(r.Context())
	if err != nil {
		s.logger.Error("payout reconcile begin failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	batchStatus, entryStatus := "exception", "exception"
	switch body.Outcome {
	case gen.AdminPayoutReconcileBodyOutcomePaid:
		batchStatus, entryStatus = "settled", "paid"
	case gen.AdminPayoutReconcileBodyOutcomeFailed:
		entryStatus = "failed"
	}
	if _, err := tx.Exec(r.Context(),
		`UPDATE payout_batches SET status = $2, settled_at = now() WHERE id = $1`,
		uuid.UUID(batchId), batchStatus); err != nil {
		s.logger.Error("payout reconcile batch update failed", "batch", batchId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	var note any
	if body.Note != nil {
		note = *body.Note
	}
	if _, err := tx.Exec(r.Context(),
		`UPDATE payout_entries SET status = $2, reason = $3, paid_at = now()
		 WHERE batch_id = $1 AND status IN ('pending', 'processing')`,
		uuid.UUID(batchId), entryStatus, note); err != nil {
		s.logger.Error("payout reconcile entries update failed", "batch", batchId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	var settledAt time.Time
	if err := tx.QueryRow(r.Context(),
		`SELECT settled_at FROM payout_batches WHERE id = $1`, uuid.UUID(batchId)).Scan(&settledAt); err != nil {
		s.logger.Error("payout reconcile reload failed", "batch", batchId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		s.logger.Error("payout reconcile commit failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	auditEntryID := s.adminPendingAudit(r.Context(), r, claims, "payout.reconciled", "payout_batch", uuid.UUID(batchId).String(), bodyNote(body.Note),
		statusString(current), map[string]any{"status": "reconciled", "outcome": string(body.Outcome)})
	_ = s.AuditLog(r.Context(), r, "payout.reconciled", "payout_batch", (*uuid.UUID)(&batchId), nil, nil)
	writeJSON(w, http.StatusOK, gen.AdminPayoutReconcileResult{
		BatchId:      batchId,
		Outcome:      gen.AdminPayoutReconcileResultOutcome(string(body.Outcome)),
		SettledAt:    settledAt,
		AuditEntryId: auditEntryID,
	})
}

// ---------------------------------------------------------------------------
// 5. cod_decision — POST /admin/riders/{riderId}/cod/{shiftId}/decision
// ---------------------------------------------------------------------------

// AdminRiderCodShiftDecision records the reconciliation decision for a rider
// COD shift (reconciled or mismatch). reconciled moves the session to
// reconciled; mismatch to exception with the variance note. A session under a
// different rider or already decided answers 404 SHIFT_NOT_FOUND /
// 409 SHIFT_ALREADY_DECIDED. Audit prefix cod.* (cod.reconciled /
// cod.mismatch) with expected/collected/variance context.
func (s *Server) AdminRiderCodShiftDecision(w http.ResponseWriter, r *http.Request, riderId openapi_types.UUID, shiftId openapi_types.UUID) {
	var body gen.AdminRiderCodShiftDecisionJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if !body.Status.Valid() {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "status must be one of reconciled, mismatch")
		return
	}
	if body.Status == gen.AdminCodShiftDecisionBodyStatusMismatch && (body.Note == nil || strings.TrimSpace(*body.Note) == "") {
		writeError(w, http.StatusUnprocessableEntity, "ADMIN_REASON_REQUIRED", "note is required when status is mismatch")
		return
	}
	if s.db == nil {
		s.logger.Error("rider cod shift decision failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	claims, ok := requireRBAC(w, r, s, PermCODManage)
	if !ok {
		return
	}

	var (
		current    string
		expected   int64
		collected  int64
	)
	err := s.db.Pool().QueryRow(r.Context(),
		`SELECT status, expected_tzs, collected_tzs FROM cod_reconciliation_sessions
		 WHERE id = $1 AND rider_id = $2`, uuid.UUID(shiftId), uuid.UUID(riderId)).Scan(&current, &expected, &collected)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "SHIFT_NOT_FOUND", "No shift found for this rider")
		return
	}
	if err != nil {
		s.logger.Error("rider cod shift decision lookup failed", "shift", shiftId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if current == "reconciled" || current == "exception" {
		writeError(w, http.StatusConflict, "SHIFT_ALREADY_DECIDED", "Shift already has a reconciliation decision")
		return
	}

	target := "exception"
	action := "cod.mismatch"
	if body.Status == gen.AdminCodShiftDecisionBodyStatusReconciled {
		target = "reconciled"
		action = "cod.reconciled"
	}
	actor, _ := s.adminPendingActorID(r)
	if _, err := s.db.Pool().Exec(r.Context(),
		`UPDATE cod_reconciliation_sessions
		 SET status = $2, note = $3, reconciled_by = $4, ended_at = now()
		 WHERE id = $1`,
		uuid.UUID(shiftId), target, body.Note, nullableUUID(actor)); err != nil {
		s.logger.Error("rider cod shift decision update failed", "shift", shiftId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	variance := expected - collected
	auditEntryID := s.adminPendingAudit(r.Context(), r, claims, action, "cod_shift", uuid.UUID(shiftId).String(), bodyNote(body.Note),
		map[string]any{"status": current, "expectedTZS": expected, "collectedTZS": collected, "varianceTZS": variance},
		map[string]any{"status": target, "expectedTZS": expected, "collectedTZS": collected, "varianceTZS": variance})
	_ = s.AuditLog(r.Context(), r, action, "cod_shift", (*uuid.UUID)(&shiftId), nil, nil)
	writeJSON(w, http.StatusOK, gen.AdminCodShiftDecisionResult{
		ShiftId:      shiftId,
		Status:       gen.AdminCodShiftDecisionResultStatus(string(body.Status)),
		AuditEntryId: auditEntryID,
	})
}

// ---------------------------------------------------------------------------
// 7. chain_onboard — POST /admin/chains/{merchantGroupId}/onboard
// ---------------------------------------------------------------------------

// AdminChainOnboard activates an enterprise chain (tier, SLA level, account
// manager). merchantGroupId is the chain owner's users row id (the /admin/
// chain grouping key). An already-active chain answers 409
// CHAIN_ALREADY_ACTIVE; a missing owner 404 CHAIN_NOT_FOUND. Audit prefix
// chain.* (chain.onboarded) with the chain status plus tier/SLA/account-
// manager assignment as before/after.
func (s *Server) AdminChainOnboard(w http.ResponseWriter, r *http.Request, merchantGroupId openapi_types.UUID) {
	var body gen.AdminChainOnboardJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if !body.Tier.Valid() {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "tier must be one of standard, enterprise")
		return
	}
	if adminPendingReasonRequired(w, body.Reason, "reason") {
		return
	}
	if s.db == nil {
		s.logger.Error("chain onboard failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	claims, ok := requireRBAC(w, r, s, PermMerchantApprove)
	if !ok {
		return
	}

	ownerID := uuid.UUID(merchantGroupId)
	var ownerExists bool
	if err := s.db.Pool().QueryRow(r.Context(),
		`SELECT true FROM users WHERE id = $1`, ownerID).Scan(&ownerExists); errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "CHAIN_NOT_FOUND", "Merchant group not found")
		return
	} else if err != nil {
		s.logger.Error("chain onboard owner lookup failed", "group", merchantGroupId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	// Chain state: an existing active chain_accounts row or any active store
	// means the chain is already live.
	var activeStores int
	if err := s.db.Pool().QueryRow(r.Context(),
		`SELECT count(*) FROM chain_stores WHERE owner_user_id = $1 AND active`, ownerID).Scan(&activeStores); err != nil {
		s.logger.Error("chain onboard store scan failed", "group", merchantGroupId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	var accountStatus *string
	err := s.db.Pool().QueryRow(r.Context(),
		`SELECT status FROM chain_accounts WHERE merchant_group_id = $1`, ownerID).Scan(&accountStatus)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		s.logger.Error("chain onboard account lookup failed", "group", merchantGroupId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if (accountStatus != nil && *accountStatus == "active") || activeStores > 0 {
		writeError(w, http.StatusConflict, "CHAIN_ALREADY_ACTIVE", "Chain is already active; suspension is the only downgrade path")
		return
	}

	actor, _ := s.adminPendingActorID(r)
	if _, err := s.db.Pool().Exec(r.Context(),
		`INSERT INTO chain_accounts (merchant_group_id, tier, sla_level, account_manager, status, updated_by)
		 VALUES ($1, $2, $3, $4, 'active', $5)
		 ON CONFLICT (merchant_group_id) DO UPDATE
		 SET tier = EXCLUDED.tier, sla_level = EXCLUDED.sla_level,
		     account_manager = EXCLUDED.account_manager, status = 'active',
		     updated_by = EXCLUDED.updated_by, updated_at = now()`,
		ownerID, string(body.Tier), body.SlaLevel, body.AccountManager, nullableUUID(actor)); err != nil {
		s.logger.Error("chain onboard account upsert failed", "group", merchantGroupId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if _, err := s.db.Pool().Exec(r.Context(),
		`UPDATE chain_stores SET active = true, updated_at = now() WHERE owner_user_id = $1`, ownerID); err != nil {
		s.logger.Error("chain onboard stores activate failed", "group", merchantGroupId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	auditEntryID := s.adminPendingAudit(r.Context(), r, claims, "chain.onboarded", "chain", ownerID.String(), body.Reason,
		map[string]any{"status": "application"},
		map[string]any{"status": "active", "tier": string(body.Tier), "slaLevel": body.SlaLevel, "accountManager": body.AccountManager})
	_ = s.AuditLog(r.Context(), r, "chain.onboarded", "chain", &ownerID, nil, nil)
	writeJSON(w, http.StatusOK, gen.AdminChainOnboardResult{
		MerchantGroupId: merchantGroupId,
		Tier:            gen.AdminChainOnboardResultTier(string(body.Tier)),
		SlaLevel:        body.SlaLevel,
		AccountManager:  body.AccountManager,
		Status:          gen.AdminChainOnboardResultStatusActive,
		AuditEntryId:    auditEntryID,
	})
}

// ---------------------------------------------------------------------------
// 8. chain_suspend — POST /admin/chains/{merchantGroupId}/suspend
// ---------------------------------------------------------------------------

// AdminChainSuspend suspends an enterprise chain: merchant-group operations
// are disabled (chain_accounts.status = suspended, chain_stores deactivated).
// Suspension is always 4-eyes-gated (TWO_PERSON_REQUIRED until a second
// approver confirms; the initiating admin creates the pending approval). An
// already-suspended chain answers 409 CHAIN_ALREADY_SUSPENDED; a missing
// owner 404 CHAIN_NOT_FOUND. Audit prefix chain.* (chain.suspended) with the
// chain status as before/after.
func (s *Server) AdminChainSuspend(w http.ResponseWriter, r *http.Request, merchantGroupId openapi_types.UUID) {
	var body gen.AdminChainSuspendJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if adminPendingReasonRequired(w, body.Reason, "reason") {
		return
	}
	if s.db == nil {
		s.logger.Error("chain suspend failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	claims, ok := requireRBAC(w, r, s, PermMerchantApprove)
	if !ok {
		return
	}

	ownerID := uuid.UUID(merchantGroupId)
	var ownerExists bool
	if err := s.db.Pool().QueryRow(r.Context(),
		`SELECT true FROM users WHERE id = $1`, ownerID).Scan(&ownerExists); errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "CHAIN_NOT_FOUND", "Merchant group not found")
		return
	} else if err != nil {
		s.logger.Error("chain suspend owner lookup failed", "group", merchantGroupId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	var accountStatus *string
	err := s.db.Pool().QueryRow(r.Context(),
		`SELECT status FROM chain_accounts WHERE merchant_group_id = $1`, ownerID).Scan(&accountStatus)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		s.logger.Error("chain suspend account lookup failed", "group", merchantGroupId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	var activeStores int
	if err := s.db.Pool().QueryRow(r.Context(),
		`SELECT count(*) FROM chain_stores WHERE owner_user_id = $1 AND active`, ownerID).Scan(&activeStores); err != nil {
		s.logger.Error("chain suspend store scan failed", "group", merchantGroupId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if (accountStatus != nil && *accountStatus == "suspended") || (accountStatus == nil && activeStores == 0) {
		writeError(w, http.StatusConflict, "CHAIN_ALREADY_SUSPENDED", "Chain is already suspended")
		return
	}

	// Two-person gate: suspension is always 4-eyes-gated.
	outcome, ok := s.adminPendingTwoPerson(r, "suspend_major_merchant", "chain", ownerID, body.Reason,
		map[string]any{"merchantGroupId": ownerID.String()})
	if !ok {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if outcome == adminPendingTwoPersonRequired {
		writeError(w, http.StatusConflict, "TWO_PERSON_REQUIRED", "Suspension requires the two-person approval flow before execution")
		return
	}

	actor, _ := s.adminPendingActorID(r)
	if _, err := s.db.Pool().Exec(r.Context(),
		`INSERT INTO chain_accounts (merchant_group_id, status, updated_by)
		 VALUES ($1, 'suspended', $2)
		 ON CONFLICT (merchant_group_id) DO UPDATE
		 SET status = 'suspended', updated_by = EXCLUDED.updated_by, updated_at = now()`,
		ownerID, nullableUUID(actor)); err != nil {
		s.logger.Error("chain suspend account update failed", "group", merchantGroupId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if _, err := s.db.Pool().Exec(r.Context(),
		`UPDATE chain_stores SET active = false, updated_at = now() WHERE owner_user_id = $1`, ownerID); err != nil {
		s.logger.Error("chain suspend stores deactivate failed", "group", merchantGroupId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	auditEntryID := s.adminPendingAudit(r.Context(), r, claims, "chain.suspended", "chain", ownerID.String(), body.Reason,
		statusString(chainStateForAudit(accountStatus, activeStores)), statusString("suspended"))
	_ = s.AuditLog(r.Context(), r, "chain.suspended", "chain", &ownerID, nil, nil)
	writeJSON(w, http.StatusOK, gen.AdminChainSuspendResult{
		MerchantGroupId: merchantGroupId,
		Status:          gen.AdminChainSuspendResultStatusSuspended,
		AuditEntryId:    auditEntryID,
	})
}

// ---------------------------------------------------------------------------
// 9. export_approve — POST /admin/data-exports/{jobId}/approval
// ---------------------------------------------------------------------------

// AdminDataExportDecision applies the compliance/finance approval decision to
// a queued data-export job: approve moves queued → processing, reject moves
// it to rejected. A job that is not queued answers 409
// DATA_EXPORT_ALREADY_DECIDED; a missing job 404 DATA_EXPORT_NOT_FOUND.
// Audit prefix export.* (export.approved / export.rejected) with the job
// status as before/after.
func (s *Server) AdminDataExportDecision(w http.ResponseWriter, r *http.Request, jobId openapi_types.UUID) {
	var body gen.AdminDataExportDecisionJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if !body.Decision.Valid() {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "decision must be one of approve, reject")
		return
	}
	if adminPendingReasonRequired(w, body.Reason, "reason") {
		return
	}
	if s.db == nil {
		s.logger.Error("data export decision failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	claims, ok := requireRBAC(w, r, s, PermExportManage)
	if !ok {
		return
	}

	var current string
	err := s.db.Pool().QueryRow(r.Context(),
		`SELECT status FROM data_exports WHERE id = $1`, uuid.UUID(jobId)).Scan(&current)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "DATA_EXPORT_NOT_FOUND", "Data export job not found")
		return
	}
	if err != nil {
		s.logger.Error("data export decision lookup failed", "job", jobId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if current != "queued" {
		writeError(w, http.StatusConflict, "DATA_EXPORT_ALREADY_DECIDED", "Data export job already has an approval decision")
		return
	}

	target := "rejected"
	action := "export.rejected"
	if body.Decision == gen.AdminDataExportDecisionBodyDecisionApprove {
		target = "processing"
		action = "export.approved"
	}
	if _, err := s.db.Pool().Exec(r.Context(),
		`UPDATE data_exports SET status = $2, updated_at = now() WHERE id = $1`,
		uuid.UUID(jobId), target); err != nil {
		s.logger.Error("data export decision update failed", "job", jobId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	auditEntryID := s.adminPendingAudit(r.Context(), r, claims, action, "data_export", uuid.UUID(jobId).String(), body.Reason,
		statusString(current), statusString(target))
	_ = s.AuditLog(r.Context(), r, action, "data_export", (*uuid.UUID)(&jobId), nil, nil)
	writeJSON(w, http.StatusOK, gen.AdminDataExportDecisionResult{
		JobId:        jobId,
		Decision:     gen.AdminDataExportDecisionResultDecision(string(body.Decision)),
		Status:       gen.AdminDataExportDecisionResultStatus(target),
		AuditEntryId: auditEntryID,
	})
}

// ---------------------------------------------------------------------------
// 10. export_rerun — POST /admin/data-exports/{jobId}/rerun
// ---------------------------------------------------------------------------

// AdminDataExportRerun resubmits a failed or expired-ready export job
// (failed → queued, clearing the stale artifact). A job that is queued or
// processing answers 409 DATA_EXPORT_IN_PROGRESS; a missing job 404
// DATA_EXPORT_NOT_FOUND. Audit prefix export.* (export.rerun) with the job
// status as before/after.
func (s *Server) AdminDataExportRerun(w http.ResponseWriter, r *http.Request, jobId openapi_types.UUID) {
	var body gen.AdminDataExportRerunJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if adminPendingReasonRequired(w, body.Reason, "reason") {
		return
	}
	if s.db == nil {
		s.logger.Error("data export rerun failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	claims, ok := requireRBAC(w, r, s, PermExportManage)
	if !ok {
		return
	}

	var current string
	err := s.db.Pool().QueryRow(r.Context(),
		`SELECT status FROM data_exports WHERE id = $1`, uuid.UUID(jobId)).Scan(&current)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "DATA_EXPORT_NOT_FOUND", "Data export job not found")
		return
	}
	if err != nil {
		s.logger.Error("data export rerun lookup failed", "job", jobId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if current == "queued" || current == "processing" {
		writeError(w, http.StatusConflict, "DATA_EXPORT_IN_PROGRESS", "Data export job is already running; cannot re-run")
		return
	}
	if _, err := s.db.Pool().Exec(r.Context(),
		`UPDATE data_exports
		 SET status = 'queued', file_url = NULL, error = NULL, expires_at = NULL, completed_at = NULL, updated_at = now()
		 WHERE id = $1`,
		uuid.UUID(jobId)); err != nil {
		s.logger.Error("data export rerun update failed", "job", jobId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	auditEntryID := s.adminPendingAudit(r.Context(), r, claims, "export.rerun", "data_export", uuid.UUID(jobId).String(), body.Reason,
		statusString(current), statusString("queued"))
	_ = s.AuditLog(r.Context(), r, "export.rerun", "data_export", (*uuid.UUID)(&jobId), nil, nil)
	writeJSON(w, http.StatusOK, gen.AdminDataExportRerunResult{
		JobId:        jobId,
		Status:       gen.AdminDataExportRerunResultStatusQueued,
		AuditEntryId: auditEntryID,
	})
}

// ---------------------------------------------------------------------------
// 11. loyalty_config — PUT /admin/loyalty/config
// ---------------------------------------------------------------------------

// AdminUpdateLoyaltyConfig persists the reviewed platform loyalty config
// (tiers + top-up rewards) into the admin_config registry (key 'loyalty').
// Policy limits: discountBps in [0,10000], thresholds/bonuses non-negative,
// a top-up bonus never exceeding its threshold, unique tier names and
// non-empty tiers — violations answer 422 LOYALTY_CONFIG_INVALID. A missing
// review reason answers 422 ADMIN_REASON_REQUIRED. Audit prefix loyalty.*
// (loyalty.config_update) with the serialized config as before/after.
func (s *Server) AdminUpdateLoyaltyConfig(w http.ResponseWriter, r *http.Request) {
	var body gen.AdminUpdateLoyaltyConfigJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if body.Reason == nil || strings.TrimSpace(*body.Reason) == "" {
		writeError(w, http.StatusUnprocessableEntity, "ADMIN_REASON_REQUIRED", "reason is required")
		return
	}
	if !adminLoyaltyConfigValid(body) {
		writeError(w, http.StatusUnprocessableEntity, "LOYALTY_CONFIG_INVALID", "Config fails loyalty policy validation")
		return
	}
	if s.db == nil {
		s.logger.Error("update loyalty config failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	claims, ok := requireRBAC(w, r, s, PermConfigurationManage)
	if !ok {
		return
	}

	payload, err := json.Marshal(struct {
		Tiers        []gen.LoyaltyTierConfig  `json:"tiers"`
		TopUpRewards []gen.LoyaltyTopUpReward `json:"topUpRewards"`
	}{Tiers: body.Tiers, TopUpRewards: body.TopUpRewards})
	if err != nil {
		s.logger.Error("loyalty config marshal failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	var beforeJSON []byte
	err = s.db.Pool().QueryRow(r.Context(),
		`SELECT value FROM admin_config WHERE key = 'loyalty'`).Scan(&beforeJSON)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		s.logger.Error("loyalty config read failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	var before any
	if beforeJSON != nil {
		_ = json.Unmarshal(beforeJSON, &before)
	}

	actor, _ := s.adminPendingActorID(r)
	var updatedAt time.Time
	if err := s.db.Pool().QueryRow(r.Context(),
		`INSERT INTO admin_config (key, value, updated_by, updated_at)
		 VALUES ('loyalty', $1, $2, now())
		 ON CONFLICT (key) DO UPDATE
		 SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()
		 RETURNING updated_at`,
		payload, nullableUUID(actor)).Scan(&updatedAt); err != nil {
		s.logger.Error("loyalty config upsert failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	var after any
	_ = json.Unmarshal(payload, &after)
	auditEntryID := s.adminPendingAudit(r.Context(), r, claims, "loyalty.config_update", "loyalty_config", "loyalty", *body.Reason,
		before, after)
	_ = s.AuditLog(r.Context(), r, "loyalty.config_update", "loyalty_config", nil, nil, payload)

	out := gen.AdminLoyaltyConfigResult{
		AuditEntryId: auditEntryID,
		UpdatedAt:    updatedAt,
	}
	out.Config.Tiers = body.Tiers
	out.Config.TopUpRewards = body.TopUpRewards
	writeJSON(w, http.StatusOK, out)
}

// adminLoyaltyConfigValid enforces the loyalty policy limits (WORKFLOWS.md
// #12): non-empty tiers, unique names, discountBps within 0..10000,
// non-negative thresholds, non-negative bonuses that never exceed their
// threshold, and perks always present.
func adminLoyaltyConfigValid(body gen.AdminUpdateLoyaltyConfigJSONRequestBody) bool {
	if len(body.Tiers) == 0 {
		return false
	}
	seen := map[string]bool{}
	for _, tier := range body.Tiers {
		if strings.TrimSpace(tier.Name) == "" || seen[tier.Name] {
			return false
		}
		seen[tier.Name] = true
		if tier.DiscountBps < 0 || tier.DiscountBps > 10000 {
			return false
		}
		if tier.ThresholdTZS < 0 {
			return false
		}
	}
	for _, reward := range body.TopUpRewards {
		if reward.ThresholdTZS <= 0 || reward.BonusTZS < 0 {
			return false
		}
		if reward.BonusTZS > reward.ThresholdTZS {
			return false
		}
	}
	return true
}

// ---------------------------------------------------------------------------
// 12. crash_respond — POST /admin/riders/{riderId}/safety/crash
// ---------------------------------------------------------------------------

// AdminCrashRespond records the outcome of a rider crash alert (safe or
// unsafe) as a rider_safety_events row; the note carries the follow-up
// (linked support ticket). A crash event that already has an outcome answers
// 409 SAFETY_EVENT_ALREADY_HANDLED; a missing rider 404 RIDER_NOT_FOUND.
// Audit prefix safety.* (safety.crash_acknowledged) with the safety-event
// state (open → acknowledged) plus the outcome.
func (s *Server) AdminCrashRespond(w http.ResponseWriter, r *http.Request, riderId openapi_types.UUID) {
	var body gen.AdminCrashRespondJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if !body.Outcome.Valid() {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "outcome must be one of safe, unsafe")
		return
	}
	if s.db == nil {
		s.logger.Error("crash respond failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	claims, ok := requireRBAC(w, r, s, PermSafetyManage)
	if !ok {
		return
	}

	var riderExists bool
	if err := s.db.Pool().QueryRow(r.Context(),
		`SELECT true FROM riders WHERE id = $1`, uuid.UUID(riderId)).Scan(&riderExists); errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "RIDER_NOT_FOUND", "Rider not found")
		return
	} else if err != nil {
		s.logger.Error("crash respond rider lookup failed", "rider", riderId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	var handled bool
	if err := s.db.Pool().QueryRow(r.Context(),
		`SELECT EXISTS (
			SELECT 1 FROM rider_safety_events
			WHERE rider_id = $1 AND event_type = 'crash' AND decided_at IS NOT NULL
		 )`, uuid.UUID(riderId)).Scan(&handled); err != nil {
		s.logger.Error("crash respond event check failed", "rider", riderId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if handled {
		writeError(w, http.StatusConflict, "SAFETY_EVENT_ALREADY_HANDLED", "Crash event already has an outcome")
		return
	}

	actor, _ := s.adminPendingActorID(r)
	if _, err := s.db.Pool().Exec(r.Context(),
		`INSERT INTO rider_safety_events (rider_id, event_type, outcome, note, decided_by, decided_at)
		 VALUES ($1, 'crash', $2, $3, $4, now())`,
		uuid.UUID(riderId), string(body.Outcome), body.Note, nullableUUID(actor)); err != nil {
		s.logger.Error("crash respond insert failed", "rider", riderId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	auditEntryID := s.adminPendingAudit(r.Context(), r, claims, "safety.crash_acknowledged", "rider", uuid.UUID(riderId).String(), bodyNote(body.Note),
		statusString("open"), map[string]any{"status": "acknowledged", "outcome": string(body.Outcome)})
	_ = s.AuditLog(r.Context(), r, "safety.crash_acknowledged", "rider", (*uuid.UUID)(&riderId), nil, nil)
	writeJSON(w, http.StatusOK, gen.AdminCrashRespondResult{
		RiderId:      riderId,
		Outcome:      gen.AdminCrashRespondResultOutcome(string(body.Outcome)),
		AuditEntryId: auditEntryID,
	})
}

// ---------------------------------------------------------------------------
// 13. rest_override — POST /admin/riders/{riderId}/rest
// ---------------------------------------------------------------------------

// AdminRiderRestOverride enforces or relieves the mandatory-rest window on a
// rider (ops manager + rider ops). enforce sets forced_rest_until = now +
// adminRestEnforceWindow; relieve clears it early. An enforcement already in
// place (or absent for relieve) answers 409 REST_ALREADY_ENFORCED; a missing
// rider 404 RIDER_NOT_FOUND. Audit prefix rider.* (rider.rest_enforced /
// rider.rest_relieved) with forced_rest_until as before/after.
func (s *Server) AdminRiderRestOverride(w http.ResponseWriter, r *http.Request, riderId openapi_types.UUID) {
	var body gen.AdminRiderRestOverrideJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if body.Action != gen.Enforce && body.Action != gen.Relieve {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "action must be one of enforce, relieve")
		return
	}
	if adminPendingReasonRequired(w, body.Reason, "reason") {
		return
	}
	if s.db == nil {
		s.logger.Error("rest override failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	claims, ok := requireRBAC(w, r, s, PermSafetyManage)
	if !ok {
		return
	}

	var restUntil *time.Time
	err := s.db.Pool().QueryRow(r.Context(),
		`SELECT forced_rest_until FROM riders WHERE id = $1`, uuid.UUID(riderId)).Scan(&restUntil)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "RIDER_NOT_FOUND", "Rider not found")
		return
	}
	if err != nil {
		s.logger.Error("rest override rider lookup failed", "rider", riderId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	now := time.Now()
	action := "rider.rest_enforced"
	if body.Action == gen.Enforce {
		if restUntil != nil && restUntil.After(now) {
			writeError(w, http.StatusConflict, "REST_ALREADY_ENFORCED", "Rest enforcement is already in place")
			return
		}
	} else {
		if restUntil == nil || !restUntil.After(now) {
			writeError(w, http.StatusConflict, "REST_ALREADY_ENFORCED", "No rest enforcement is in place to relieve")
			return
		}
		action = "rider.rest_relieved"
	}

	var (
		target *time.Time
		value  any
	)
	if body.Action == gen.Enforce {
		t := now.Add(time.Duration(GetSettings().AdminRestEnforceHours) * time.Hour)
		target, value = &t, t
	}
	if _, err := s.db.Pool().Exec(r.Context(),
		`UPDATE riders SET forced_rest_until = $2, updated_at = now() WHERE id = $1`,
		uuid.UUID(riderId), value); err != nil {
		s.logger.Error("rest override update failed", "rider", riderId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	auditEntryID := s.adminPendingAudit(r.Context(), r, claims, action, "rider", uuid.UUID(riderId).String(), body.Reason,
		restUntil, target)
	_ = s.AuditLog(r.Context(), r, action, "rider", (*uuid.UUID)(&riderId), nil, nil)
	forced := time.Time{}
	if target != nil {
		forced = *target
	}
	writeJSON(w, http.StatusOK, gen.AdminRestOverrideResult{
		RiderId:         riderId,
		ForcedRestUntil: forced,
		AuditEntryId:    auditEntryID,
	})
}

// ---------------------------------------------------------------------------
// 14. seal_broken_resolve — POST /admin/handoffs/{handoffId}/seal
// ---------------------------------------------------------------------------

// AdminHandoffSealDecision decides a seal-broken handoff incident (resealed
// or damage_claim). resealed restores seal integrity (seal_verified = true);
// damage_claim keeps the breach recorded and opens the claim path. A decided
// incident answers 409 HANDOFF_ALREADY_DECIDED; a missing handoff 404
// HANDOFF_NOT_FOUND. Audit prefix handoff.* (handoff.seal_resealed /
// handoff.seal_damage_claim) with the seal state plus from/to custody
// context as before/after.
func (s *Server) AdminHandoffSealDecision(w http.ResponseWriter, r *http.Request, handoffId openapi_types.UUID) {
	var body gen.AdminHandoffSealDecisionJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if !body.Outcome.Valid() {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "outcome must be one of resealed, damage_claim")
		return
	}
	if adminPendingReasonRequired(w, body.Reason, "reason") {
		return
	}
	if s.db == nil {
		s.logger.Error("handoff seal decision failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	claims, ok := requireRBAC(w, r, s, PermHandoffManage)
	if !ok {
		return
	}

	var (
		sealVerified bool
		decision     *string
		fromEntity   string
		toEntity     string
	)
	err := s.db.Pool().QueryRow(r.Context(),
		`SELECT seal_verified, seal_decision, from_entity_type, to_entity_type
		 FROM handoffs WHERE id = $1`, uuid.UUID(handoffId)).Scan(&sealVerified, &decision, &fromEntity, &toEntity)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "HANDOFF_NOT_FOUND", "Handoff not found")
		return
	}
	if err != nil {
		s.logger.Error("handoff seal decision lookup failed", "handoff", handoffId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if decision != nil {
		writeError(w, http.StatusConflict, "HANDOFF_ALREADY_DECIDED", "Seal incident already decided")
		return
	}

	newSeal := false
	action := "handoff.seal_damage_claim"
	if body.Outcome == gen.AdminHandoffSealBodyOutcomeResealed {
		newSeal = true
		action = "handoff.seal_resealed"
	}
	actor, _ := s.adminPendingActorID(r)
	if _, err := s.db.Pool().Exec(r.Context(),
		`UPDATE handoffs
		 SET seal_verified = $2, seal_decision = $3, seal_decision_reason = $4,
		     seal_decided_by = $5, seal_decided_at = now()
		 WHERE id = $1`,
		uuid.UUID(handoffId), newSeal, string(body.Outcome), body.Reason, nullableUUID(actor)); err != nil {
		s.logger.Error("handoff seal decision update failed", "handoff", handoffId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	auditEntryID := s.adminPendingAudit(r.Context(), r, claims, action, "handoff", uuid.UUID(handoffId).String(), body.Reason,
		map[string]any{"sealIntact": sealVerified, "from": fromEntity, "to": toEntity},
		map[string]any{"sealIntact": newSeal, "outcome": string(body.Outcome), "from": fromEntity, "to": toEntity})
	_ = s.AuditLog(r.Context(), r, action, "handoff", (*uuid.UUID)(&handoffId), nil, nil)
	writeJSON(w, http.StatusOK, gen.AdminHandoffSealResult{
		HandoffId:    handoffId,
		Outcome:      gen.AdminHandoffSealResultOutcome(string(body.Outcome)),
		SealIntact:   newSeal,
		AuditEntryId: auditEntryID,
	})
}

// ---------------------------------------------------------------------------
// 15. anomaly_resolve — POST /admin/logistics-anomalies/{anomalyId}/decision
// ---------------------------------------------------------------------------

// AdminLogisticsAnomalyDecision resolves a logistics anomaly (dismiss,
// freeze or block). dismiss clears the queue row (no shipment effect);
// freeze/block additionally set the shipment status to exception so it is
// excluded from dispatch and loading. A decided anomaly answers 409
// ANOMALY_ALREADY_DECIDED; a missing one 404 ANOMALY_NOT_FOUND. Audit prefix
// anomaly.* (anomaly.dismiss / anomaly.freeze / anomaly.block) with the
// anomaly state as before/after.
func (s *Server) AdminLogisticsAnomalyDecision(w http.ResponseWriter, r *http.Request, anomalyId openapi_types.UUID) {
	var body gen.AdminLogisticsAnomalyDecisionJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if !body.Decision.Valid() {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "decision must be one of dismiss, freeze, block")
		return
	}
	if adminPendingReasonRequired(w, body.Reason, "reason") {
		return
	}
	if s.db == nil {
		s.logger.Error("logistics anomaly decision failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	claims, ok := requireRBAC(w, r, s, PermAnomalyManage)
	if !ok {
		return
	}

	var (
		current    string
		shipmentID *uuid.UUID
		deviceID   *string
		anomalyTyp string
	)
	err := s.db.Pool().QueryRow(r.Context(),
		`SELECT status, shipment_id, device_id, anomaly_type
		 FROM logistics_anomalies WHERE id = $1`, uuid.UUID(anomalyId)).Scan(&current, &shipmentID, &deviceID, &anomalyTyp)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "ANOMALY_NOT_FOUND", "Logistics anomaly not found")
		return
	}
	if err != nil {
		s.logger.Error("logistics anomaly decision lookup failed", "anomaly", anomalyId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if current != "open" {
		writeError(w, http.StatusConflict, "ANOMALY_ALREADY_DECIDED", "Anomaly already decided")
		return
	}

	if body.Decision != gen.AdminLogisticsAnomalyDecisionBodyDecisionDismiss && shipmentID != nil {
		if _, err := s.db.Pool().Exec(r.Context(),
			`UPDATE shipments SET status = 'exception', updated_at = now()
			 WHERE id = $1 AND status NOT IN ('delivered', 'exception')`,
			*shipmentID); err != nil {
			s.logger.Error("logistics anomaly shipment freeze failed", "anomaly", anomalyId, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
	}
	actor, _ := s.adminPendingActorID(r)
	if _, err := s.db.Pool().Exec(r.Context(),
		`UPDATE logistics_anomalies
		 SET status = 'resolved', decision = $2, decision_note = $3, decided_by = $4, decided_at = now()
		 WHERE id = $1`,
		uuid.UUID(anomalyId), string(body.Decision), body.Note, nullableUUID(actor)); err != nil {
		s.logger.Error("logistics anomaly decision update failed", "anomaly", anomalyId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	evidence := map[string]any{"anomalyType": anomalyTyp, "deviceId": deviceID, "shipmentId": shipmentID}
	auditEntryID := s.adminPendingAudit(r.Context(), r, claims, "anomaly."+string(body.Decision), "logistics_anomaly", uuid.UUID(anomalyId).String(), body.Reason,
		map[string]any{"status": "open", "evidence": evidence},
		map[string]any{"status": "resolved", "decision": string(body.Decision), "evidence": evidence})
	_ = s.AuditLog(r.Context(), r, "anomaly."+string(body.Decision), "logistics_anomaly", (*uuid.UUID)(&anomalyId), nil, nil)
	writeJSON(w, http.StatusOK, gen.AdminLogisticsAnomalyDecisionResult{
		AnomalyId:    anomalyId,
		Decision:     gen.AdminLogisticsAnomalyDecisionResultDecision(string(body.Decision)),
		Resolved:     true,
		AuditEntryId: auditEntryID,
	})
}

// ---------------------------------------------------------------------------
// 16. order_cancel — POST /admin/orders/{orderId}/cancel
// ---------------------------------------------------------------------------

// adminCancelableOrderStatuses are the order states an admin may cancel
// (stuck-order resolution): every non-terminal state. Terminal states
// (cancelled/refunded/completed/delivered/failed/disputed) answer 409
// ORDER_NOT_CANCELLABLE.
var adminCancelableOrderStatuses = []string{
	"draft", "pending_payment", "paid", "merchant_accepted", "preparing",
	"rider_assigned", "picked_up", "delivering",
}

// AdminCancelOrder cancels a stuck order (with an optional refund). The
// transition reuses the orders store state machine (TransitionOrder) so the
// event log and version guard stay consistent. A refund above the finance
// threshold is 4-eyes-gated (TWO_PERSON_REQUIRED until a second approver
// confirms); a refund below/without one executes directly and appends a
// refund ledger entry on the merchant account. Audit prefix order.*
// (order.cancel) with the order status and refund amount as before/after.
func (s *Server) AdminCancelOrder(w http.ResponseWriter, r *http.Request, orderId openapi_types.UUID) {
	var body gen.AdminCancelOrderJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if adminPendingReasonRequired(w, body.Reason, "reason") {
		return
	}
	if body.RefundTZS != nil && *body.RefundTZS < 0 {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "refundTZS must not be negative")
		return
	}
	actor, err := s.orderActor(r)
	if err != nil {
		s.writeOrderActorError(w, err)
		return
	}
	if s.db == nil {
		s.logger.Error("admin cancel order failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	claims, ok := requireRBAC(w, r, s, PermOrderManage)
	if !ok {
		return
	}

	st := orders.NewStore(s.db.Pool())
	row, err := st.GetOrderRow(r.Context(), uuid.UUID(orderId))
	if errors.Is(err, orders.ErrNotFound) {
		writeError(w, http.StatusNotFound, "ORDER_NOT_FOUND", "Order not found")
		return
	}
	if err != nil {
		s.logger.Error("admin cancel order lookup failed", "order", orderId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if !adminOrderCancellable(row.Status) {
		writeError(w, http.StatusConflict, "ORDER_NOT_CANCELLABLE", "Order state forbids cancellation")
		return
	}

	// Two-person gate: a refund above the finance threshold.
	if body.RefundTZS != nil && int64(*body.RefundTZS) > GetSettings().TwoPersonThresholdTZS {
		outcome, ok := s.adminPendingTwoPerson(r, "large_refund", "order", uuid.UUID(orderId), body.Reason,
			map[string]any{"refundTZS": *body.RefundTZS})
		if !ok {
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		if outcome == adminPendingTwoPersonRequired {
			writeError(w, http.StatusConflict, "TWO_PERSON_REQUIRED", "This cancellation refund is above the finance threshold and requires the two-person approval flow")
			return
		}
	}

	version, err := st.TransitionOrder(r.Context(), uuid.UUID(orderId), row.Version, adminCancelableOrderStatuses, "cancelled", actor, body.Reason)
	if errors.Is(err, orders.ErrConflict) {
		writeError(w, http.StatusConflict, "ORDER_NOT_CANCELLABLE", "Order state forbids cancellation")
		return
	}
	if err != nil {
		s.logger.Error("admin cancel order transition failed", "order", orderId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	_ = version

	if body.RefundTZS != nil && *body.RefundTZS > 0 {
		merchantID := row.MerchantID
		if err := s.adminPendingAppendOrderRefund(r, merchantID, uuid.UUID(orderId), *body.RefundTZS, actor); err != nil {
			s.logger.Error("admin cancel order refund ledger append failed", "order", orderId, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
	}
	auditEntryID := s.adminPendingAudit(r.Context(), r, claims, "order.cancel", "order", uuid.UUID(orderId).String(), body.Reason,
		map[string]any{"status": row.Status, "refundTZS": body.RefundTZS},
		map[string]any{"status": "cancelled", "refundTZS": body.RefundTZS})
	_ = s.AuditLog(r.Context(), r, "order.cancel", "order", (*uuid.UUID)(&orderId), nil, nil)
	writeJSON(w, http.StatusOK, gen.AdminOrderCancelResult{
		OrderId:      orderId,
		Status:       gen.AdminOrderCancelResultStatusCancelled,
		RefundTZS:    body.RefundTZS,
		AuditEntryId: auditEntryID,
	})
}

// adminOrderCancellable reports whether an order status admits admin
// cancellation (any non-terminal state).
func adminOrderCancellable(status string) bool {
	for _, s := range adminCancelableOrderStatuses {
		if s == status {
			return true
		}
	}
	return false
}

// adminPendingAppendOrderRefund appends a refund ledger entry on the order's
// merchant account (negative amount, type 'refund', referencing the order),
// following the ledger running-balance pattern.
func (s *Server) adminPendingAppendOrderRefund(r *http.Request, merchantID uuid.UUID, orderID uuid.UUID, amountTZS int, actor uuid.UUID) error {
	tx, err := s.db.Pool().Begin(r.Context())
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	var balance int64
	err = tx.QueryRow(r.Context(),
		`SELECT balance_tzs FROM ledger_entries
		 WHERE account_owner_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1`,
		merchantID).Scan(&balance)
	if errors.Is(err, pgx.ErrNoRows) {
		balance = 0
	} else if err != nil {
		return err
	}
	if _, err := tx.Exec(r.Context(),
		`INSERT INTO ledger_entries (account_owner_id, account_type, type, amount_tzs, balance_tzs, reference_type, reference_id, idempotency_key)
		 VALUES ($1, 'merchant', 'refund', $2, $3, 'order', $4, $5)`,
		merchantID, -int64(amountTZS), balance-int64(amountTZS), orderID, "refund:order:"+orderID.String()); err != nil {
		return err
	}
	return tx.Commit(r.Context())
}

// ---------------------------------------------------------------------------
// 17. consignment_missing_resolve — POST /admin/consignments/{consignmentId}/missing
// ---------------------------------------------------------------------------

// AdminConsignmentMissingDecision resolves a missing-orders consignment
// exception (relocate or declare_lost). relocate places the orders on the
// next corridor; declare_lost routes them to the damage-claim path. Either
// way the exception clears (missing_decision recorded on the consignment). A
// resolved exception answers 409 CONSIGNMENT_ALREADY_DECIDED; a missing
// consignment 404 CONSIGNMENT_NOT_FOUND. Audit prefix consignment.*
// (consignment.relocate / consignment.declare_lost) with the exception state
// as before/after.
func (s *Server) AdminConsignmentMissingDecision(w http.ResponseWriter, r *http.Request, consignmentId openapi_types.UUID) {
	var body gen.AdminConsignmentMissingDecisionJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if !body.Decision.Valid() {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "decision must be one of relocate, declare_lost")
		return
	}
	if adminPendingReasonRequired(w, body.Reason, "reason") {
		return
	}
	if s.db == nil {
		s.logger.Error("consignment missing decision failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	claims, ok := requireRBAC(w, r, s, PermExceptionManage)
	if !ok {
		return
	}

	var (
		current  string
		decision *string
	)
	err := s.db.Pool().QueryRow(r.Context(),
		`SELECT status, missing_decision FROM consignments WHERE id = $1`, uuid.UUID(consignmentId)).Scan(&current, &decision)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "CONSIGNMENT_NOT_FOUND", "Consignment not found")
		return
	}
	if err != nil {
		s.logger.Error("consignment missing decision lookup failed", "consignment", consignmentId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if decision != nil {
		writeError(w, http.StatusConflict, "CONSIGNMENT_ALREADY_DECIDED", "Missing-order exception already resolved")
		return
	}

	actor, _ := s.adminPendingActorID(r)
	if _, err := s.db.Pool().Exec(r.Context(),
		`UPDATE consignments
		 SET missing_decision = $2, missing_decision_reason = $3, missing_decided_by = $4, missing_decided_at = now()
		 WHERE id = $1`,
		uuid.UUID(consignmentId), string(body.Decision), body.Reason, nullableUUID(actor)); err != nil {
		s.logger.Error("consignment missing decision update failed", "consignment", consignmentId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	auditEntryID := s.adminPendingAudit(r.Context(), r, claims, "consignment."+string(body.Decision), "consignment", uuid.UUID(consignmentId).String(), body.Reason,
		map[string]any{"status": current, "exception": "CONSIGNMENT_MISSING_ORDERS"},
		map[string]any{"status": "exception_cleared", "decision": string(body.Decision)})
	_ = s.AuditLog(r.Context(), r, "consignment."+string(body.Decision), "consignment", (*uuid.UUID)(&consignmentId), nil, nil)
	writeJSON(w, http.StatusOK, gen.AdminConsignmentMissingResult{
		ConsignmentId: consignmentId,
		Decision:      gen.AdminConsignmentMissingResultDecision(string(body.Decision)),
		Status:        gen.ExceptionCleared,
		AuditEntryId:  auditEntryID,
	})
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

// statusString keeps a value into the audit before/after details as a
// string; nil becomes an empty string so jsonb never stores null.
func statusString(v string) string { return v }

// bodyNote unwraps an optional note into the audit details (nil-safe).
func bodyNote(note *string) string {
	if note == nil {
		return ""
	}
	return *note
}

// nullableUUID maps a uuid into an any for a nullable uuid column; the nil
// UUID is sent as NULL.
func nullableUUID(id uuid.UUID) any {
	if id == uuid.Nil {
		return nil
	}
	return id
}

// chainStateForAudit derives the pre-suspension chain state: the stored
// chain_accounts status when present, otherwise active when any store row is
// active.
func chainStateForAudit(accountStatus *string, activeStores int) string {
	if accountStatus != nil {
		return *accountStatus
	}
	if activeStores > 0 {
		return "active"
	}
	return "suspended"
}