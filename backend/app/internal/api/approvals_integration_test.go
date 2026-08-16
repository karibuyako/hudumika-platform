//go:build integration

// Approvals, tasks, risk and onboarding integration tests against real
// PostgreSQL + Redis (docker compose).
//
//	cd app && go test -tags integration ./internal/api/ -run 'Approval|Task|Risk|Onboarding|Anomaly|Violation|Setup' -count=1
//
// This suite owns the migration-00029 tables (approvals, tasks, risk_events,
// onboarding_profiles, onboarding_docs): it truncates exactly those at setup
// and teardown and clears its own users (phone prefix +255878...). It never
// truncates shared tables.
package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/hudumika/api-backend/internal/gen"
)

// atrPhonePrefix identifies every users row this suite inserts.
const atrPhonePrefix = "+255878"

// atrTables are the tables owned by this suite (migration 00029), truncated
// in one statement at setup and teardown.
var atrTables = []string{"onboarding_docs", "onboarding_profiles", "risk_events", "tasks", "approvals"}

// atrSetup wires a persistent server and truncates only this suite's tables
// plus its own users.
func atrSetup(t *testing.T) (*Server, *pgxpool.Pool) {
	t.Helper()
	s, pool := newPersistentServer(t)
	ctx := context.Background()
	if _, err := pool.Exec(ctx, "TRUNCATE "+strings.Join(atrTables, ", ")); err != nil {
		t.Fatalf("truncate approvals tables: %v", err)
	}
	if _, err := pool.Exec(ctx, `DELETE FROM users WHERE phone LIKE '`+atrPhonePrefix+`%'`); err != nil {
		t.Fatalf("clear approvals users: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(ctx, "TRUNCATE "+strings.Join(atrTables, ", "))
		_, _ = pool.Exec(ctx, `DELETE FROM users WHERE phone LIKE '`+atrPhonePrefix+`%'`)
	})
	return s, pool
}

// atrUser inserts a users row with a per-run unique phone and returns the id
// and phone (the phone doubles as the JWT subject).
func atrUser(t *testing.T, pool *pgxpool.Pool) (uuid.UUID, string) {
	t.Helper()
	phone := fmt.Sprintf("%s%08d", atrPhonePrefix, time.Now().UnixNano()%100_000_000)
	userID := uuid.New()
	if _, err := pool.Exec(context.Background(),
		`INSERT INTO users (id, phone) VALUES ($1, $2)`, userID, phone); err != nil {
		t.Fatalf("insert approvals user: %v", err)
	}
	return userID, phone
}

// atrMerchant returns a merchant-role token bound to a fresh user.
func atrMerchant(t *testing.T, s *Server, pool *pgxpool.Pool) (uuid.UUID, string) {
	t.Helper()
	id, phone := atrUser(t, pool)
	return id, tokenFor(t, s, phone, RoleMerchant, false)
}

// atrStaff returns a staff-role token bound to a fresh user.
func atrStaff(t *testing.T, s *Server, pool *pgxpool.Pool) (uuid.UUID, string) {
	t.Helper()
	id, phone := atrUser(t, pool)
	return id, tokenFor(t, s, phone, RoleAdmin, true)
}

// atrDecodeError decodes an error envelope.
func atrDecodeError(t *testing.T, rec *httptest.ResponseRecorder) gen.ErrorResponse {
	t.Helper()
	var errBody gen.ErrorResponse
	if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
		t.Fatalf("decode error envelope: %v (%s)", err, rec.Body)
	}
	return errBody
}

// atrSeedTask inserts a tasks row directly (task creation has no contract
// endpoint; setup steps and activity submissions create their own).
func atrSeedTask(t *testing.T, pool *pgxpool.Pool, owner uuid.UUID, kind, title, status string) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	if err := pool.QueryRow(context.Background(),
		`INSERT INTO tasks (owner_user_id, kind, title, status) VALUES ($1, $2, $3, $4) RETURNING id`,
		owner, kind, title, status).Scan(&id); err != nil {
		t.Fatalf("seed task: %v", err)
	}
	return id
}

// TestApprovalLifecycle: merchant raises a request, staff lists and approves
// it; the merchant only ever sees their own requests.
func TestApprovalLifecycle(t *testing.T) {
	s, pool := atrSetup(t)
	merchantID, merchantToken := atrMerchant(t, s, pool)
	_, staffToken := atrStaff(t, s, pool)
	h := s.Router()

	refID := uuid.New()
	rec := authedDo(t, h, http.MethodPost, "/approvals",
		fmt.Sprintf(`{"type":"price_change","refType":"catalogue_item","refId":"%s","summary":"Weekend discount"}`, refID),
		merchantToken)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create approval = %d (%s)", rec.Code, rec.Body)
	}
	var created gen.ApprovalRequest
	_ = json.NewDecoder(rec.Body).Decode(&created)
	if created.Status != gen.ApprovalStatusPending {
		t.Fatalf("created status = %q, want pending", created.Status)
	}
	if created.RequestedBy != merchantID.String() {
		t.Fatalf("requestedBy = %q, want %s", created.RequestedBy, merchantID)
	}

	rec = authedGET(t, h, "/approvals", merchantToken)
	var mine []gen.ApprovalRequest
	_ = json.NewDecoder(rec.Body).Decode(&mine)
	if rec.Code != http.StatusOK || len(mine) != 1 || mine[0].Id != created.Id {
		t.Fatalf("merchant list = %d, %v (%s)", rec.Code, mine, rec.Body)
	}

	rec = authedGET(t, h, "/approvals", staffToken)
	var all []gen.ApprovalRequest
	_ = json.NewDecoder(rec.Body).Decode(&all)
	if rec.Code != http.StatusOK || len(all) < 1 {
		t.Fatalf("staff list = %d, %v (%s)", rec.Code, all, rec.Body)
	}

	rec = authedDo(t, h, http.MethodPost, "/approvals/"+created.Id.String()+"/decision",
		`{"decision":"approved","comment":"LGTM"}`, staffToken)
	if rec.Code != http.StatusOK {
		t.Fatalf("decide approval = %d (%s)", rec.Code, rec.Body)
	}
	var decided gen.ApprovalRequest
	_ = json.NewDecoder(rec.Body).Decode(&decided)
	if decided.Status != gen.ApprovalStatusApproved {
		t.Fatalf("decided status = %q, want approved", decided.Status)
	}
	if decided.DecisionComment == nil || *decided.DecisionComment != "LGTM" {
		t.Fatalf("decided comment = %v, want LGTM", decided.DecisionComment)
	}
}

// TestApprovalDoubleDecideConflict: a decided approval answers
// APPROVAL_ALREADY_DECIDED on a second decision.
func TestApprovalDoubleDecideConflict(t *testing.T) {
	s, pool := atrSetup(t)
	_, merchantToken := atrMerchant(t, s, pool)
	_, staffToken := atrStaff(t, s, pool)
	h := s.Router()

	rec := authedDo(t, h, http.MethodPost, "/approvals", `{"type":"promotion"}`, merchantToken)
	var created gen.ApprovalRequest
	_ = json.NewDecoder(rec.Body).Decode(&created)

	path := "/approvals/" + created.Id.String() + "/decision"
	rec = authedDo(t, h, http.MethodPost, path, `{"decision":"approved","comment":"ok"}`, staffToken)
	if rec.Code != http.StatusOK {
		t.Fatalf("first decision = %d (%s)", rec.Code, rec.Body)
	}
	rec = authedDo(t, h, http.MethodPost, path, `{"decision":"rejected","comment":"no"}`, staffToken)
	if rec.Code != http.StatusConflict {
		t.Fatalf("second decision = %d, want 409 (%s)", rec.Code, rec.Body)
	}
	if errBody := atrDecodeError(t, rec); errBody.Code != "APPROVAL_ALREADY_DECIDED" {
		t.Fatalf("error code = %q, want APPROVAL_ALREADY_DECIDED", errBody.Code)
	}
}

// TestApprovalSameActorRejected: 4-eyes — a staff member who raised a request
// cannot decide it (APPROVAL_SAME_ACTOR).
func TestApprovalSameActorRejected(t *testing.T) {
	s, pool := atrSetup(t)
	_, staffToken := atrStaff(t, s, pool)
	h := s.Router()

	rec := authedDo(t, h, http.MethodPost, "/approvals", `{"type":"inventory_adjustment"}`, staffToken)
	if rec.Code != http.StatusCreated {
		t.Fatalf("staff create approval = %d (%s)", rec.Code, rec.Body)
	}
	var created gen.ApprovalRequest
	_ = json.NewDecoder(rec.Body).Decode(&created)

	rec = authedDo(t, h, http.MethodPost, "/approvals/"+created.Id.String()+"/decision",
		`{"decision":"approved","comment":"self"}`, staffToken)
	if rec.Code != http.StatusConflict {
		t.Fatalf("same-actor decision = %d, want 409 (%s)", rec.Code, rec.Body)
	}
	if errBody := atrDecodeError(t, rec); errBody.Code != "APPROVAL_SAME_ACTOR" {
		t.Fatalf("error code = %q, want APPROVAL_SAME_ACTOR", errBody.Code)
	}
}

// TestApprovalRejectRequiresReason: rejecting without a comment answers
// APPROVAL_REASON_REQUIRED.
func TestApprovalRejectRequiresReason(t *testing.T) {
	s, pool := atrSetup(t)
	_, merchantToken := atrMerchant(t, s, pool)
	_, staffToken := atrStaff(t, s, pool)
	h := s.Router()

	rec := authedDo(t, h, http.MethodPost, "/approvals", `{"type":"staff_role_change"}`, merchantToken)
	var created gen.ApprovalRequest
	_ = json.NewDecoder(rec.Body).Decode(&created)

	rec = authedDo(t, h, http.MethodPost, "/approvals/"+created.Id.String()+"/decision",
		`{"decision":"rejected"}`, staffToken)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("reasonless rejection = %d, want 422 (%s)", rec.Code, rec.Body)
	}
	if errBody := atrDecodeError(t, rec); errBody.Code != "APPROVAL_REASON_REQUIRED" {
		t.Fatalf("error code = %q, want APPROVAL_REASON_REQUIRED", errBody.Code)
	}
}

// TestTaskLifecycle covers open → in_progress → completed via the contract
// statuses, plus owner-only reads.
func TestTaskLifecycle(t *testing.T) {
	s, pool := atrSetup(t)
	_, merchantToken := atrMerchant(t, s, pool)
	h := s.Router()

	taskID := atrSeedTask(t, pool, taskOwner(t, s, merchantToken), "anomaly", "Out of stock: fried fish", "open")

	rec := authedGET(t, h, "/tasks/"+taskID.String(), merchantToken)
	if rec.Code != http.StatusOK {
		t.Fatalf("get task = %d (%s)", rec.Code, rec.Body)
	}
	var task gen.TaskItem
	_ = json.NewDecoder(rec.Body).Decode(&task)
	if task.Kind != gen.TaskItemKindAnomaly || task.Status != gen.TaskItemStatusOpen {
		t.Fatalf("task = %+v", task)
	}

	rec = authedDo(t, h, http.MethodPatch, "/tasks/"+taskID.String(), `{"status":"in_progress"}`, merchantToken)
	if rec.Code != http.StatusOK {
		t.Fatalf("start task = %d (%s)", rec.Code, rec.Body)
	}
	_ = json.NewDecoder(rec.Body).Decode(&task)
	if task.Status != gen.TaskItemStatusInProgress {
		t.Fatalf("status = %q, want in_progress", task.Status)
	}

	rec = authedDo(t, h, http.MethodPatch, "/tasks/"+taskID.String(), `{"status":"done"}`, merchantToken)
	if rec.Code != http.StatusOK {
		t.Fatalf("finish task = %d (%s)", rec.Code, rec.Body)
	}
	_ = json.NewDecoder(rec.Body).Decode(&task)
	if task.Status != gen.TaskItemStatusDone {
		t.Fatalf("status = %q, want done", task.Status)
	}

	rec = authedGET(t, h, "/tasks", merchantToken)
	var tasks []gen.TaskItem
	_ = json.NewDecoder(rec.Body).Decode(&tasks)
	if rec.Code != http.StatusOK || len(tasks) != 1 || tasks[0].Id != taskID {
		t.Fatalf("task list = %d, %v (%s)", rec.Code, tasks, rec.Body)
	}
}

// taskOwner resolves the users row for a merchant token's subject.
func taskOwner(t *testing.T, s *Server, merchantToken string) uuid.UUID {
	t.Helper()
	claims, err := s.parseToken(merchantToken)
	if err != nil {
		t.Fatalf("parse token: %v", err)
	}
	uid, ok := s.userIDByPhone(context.Background(), claims.Subject)
	if !ok {
		t.Fatalf("resolve owner %s", claims.Subject)
	}
	return uid
}

// TestTaskBadTransition: backwards moves and moves off a terminal state
// answer TASK_STATUS_INVALID.
func TestTaskBadTransition(t *testing.T) {
	s, pool := atrSetup(t)
	_, merchantToken := atrMerchant(t, s, pool)
	h := s.Router()

	taskID := atrSeedTask(t, pool, taskOwner(t, s, merchantToken), "violation", "Rating drop", "open")

	rec := authedDo(t, h, http.MethodPatch, "/tasks/"+taskID.String(), `{"status":"done"}`, merchantToken)
	if rec.Code != http.StatusOK {
		t.Fatalf("open→done = %d (%s)", rec.Code, rec.Body)
	}
	rec = authedDo(t, h, http.MethodPatch, "/tasks/"+taskID.String(), `{"status":"in_progress"}`, merchantToken)
	if rec.Code != http.StatusConflict {
		t.Fatalf("done→in_progress = %d, want 409 (%s)", rec.Code, rec.Body)
	}
	if errBody := atrDecodeError(t, rec); errBody.Code != "TASK_STATUS_INVALID" {
		t.Fatalf("error code = %q, want TASK_STATUS_INVALID", errBody.Code)
	}
}

// TestAnomaliesAndViolationsList: the dedicated surfaces filter the task
// feed by kind and never return nil ([]).
func TestAnomaliesAndViolationsList(t *testing.T) {
	s, pool := atrSetup(t)
	_, merchantToken := atrMerchant(t, s, pool)
	h := s.Router()
	uid := taskOwner(t, s, merchantToken)

	atrSeedTask(t, pool, uid, "anomaly", "Pricing error", "open")
	atrSeedTask(t, pool, uid, "violation", "Policy breach", "open")

	rec := authedGET(t, h, "/tasks/anomalies", merchantToken)
	var anomalies []gen.TaskItem
	_ = json.NewDecoder(rec.Body).Decode(&anomalies)
	if rec.Code != http.StatusOK || len(anomalies) != 1 || anomalies[0].Kind != gen.TaskItemKindAnomaly {
		t.Fatalf("anomalies = %d, %v (%s)", rec.Code, anomalies, rec.Body)
	}

	rec = authedGET(t, h, "/tasks/violations", merchantToken)
	var violations []gen.TaskItem
	_ = json.NewDecoder(rec.Body).Decode(&violations)
	if rec.Code != http.StatusOK || len(violations) != 1 || violations[0].Kind != gen.TaskItemKindViolation {
		t.Fatalf("violations = %d, %v (%s)", rec.Code, violations, rec.Body)
	}
}

// TestTaskActivitySubmission: submitting a platform activity creates a task
// row and duplicates answer ACTIVITY_ALREADY_SUBMITTED.
func TestTaskActivitySubmission(t *testing.T) {
	s, pool := atrSetup(t)
	_, merchantToken := atrMerchant(t, s, pool)
	h := s.Router()

	eventID := uuid.New()
	body := fmt.Sprintf(`{"platformEventId":"%s","status":"submitted"}`, eventID)
	rec := authedDo(t, h, http.MethodPost, "/tasks/activities", body, merchantToken)
	if rec.Code != http.StatusCreated {
		t.Fatalf("submit activity = %d (%s)", rec.Code, rec.Body)
	}
	var submission gen.ActivitySubmission
	_ = json.NewDecoder(rec.Body).Decode(&submission)
	if submission.PlatformEventId != eventID || submission.Status != gen.ActivitySubmissionStatusSubmitted {
		t.Fatalf("submission = %+v", submission)
	}

	rec = authedDo(t, h, http.MethodPost, "/tasks/activities", body, merchantToken)
	if rec.Code != http.StatusConflict {
		t.Fatalf("duplicate submit = %d, want 409 (%s)", rec.Code, rec.Body)
	}
	if errBody := atrDecodeError(t, rec); errBody.Code != "ACTIVITY_ALREADY_SUBMITTED" {
		t.Fatalf("error code = %q, want ACTIVITY_ALREADY_SUBMITTED", errBody.Code)
	}

	rec = authedGET(t, h, "/tasks/activities", merchantToken)
	var submissions []gen.ActivitySubmission
	_ = json.NewDecoder(rec.Body).Decode(&submissions)
	if rec.Code != http.StatusOK || len(submissions) != 1 {
		t.Fatalf("activities = %d, %v (%s)", rec.Code, submissions, rec.Body)
	}
}

// TestSetupGuideSteps: the checklist starts incomplete, marking a step
// complete persists across requests.
func TestSetupGuideSteps(t *testing.T) {
	s, pool := atrSetup(t)
	_, merchantToken := atrMerchant(t, s, pool)
	h := s.Router()

	rec := authedGET(t, h, "/tasks/setup-guide", merchantToken)
	if rec.Code != http.StatusOK {
		t.Fatalf("setup guide = %d (%s)", rec.Code, rec.Body)
	}
	var steps []gen.SetupStep
	_ = json.NewDecoder(rec.Body).Decode(&steps)
	if len(steps) < 3 {
		t.Fatalf("setup steps = %d, want >= 3 (%s)", len(steps), rec.Body)
	}
	for i, step := range steps {
		if step.Completed {
			t.Fatalf("step %d starts completed", i)
		}
	}

	first := steps[0].Id
	rec = authedDo(t, h, http.MethodPost, "/tasks/setup-guide/"+first.String()+"/complete", "", merchantToken)
	if rec.Code != http.StatusOK {
		t.Fatalf("complete step = %d (%s)", rec.Code, rec.Body)
	}
	_ = json.NewDecoder(rec.Body).Decode(&steps)
	if !steps[0].Completed || steps[1].Completed {
		t.Fatalf("after complete: %+v", steps)
	}

	rec = authedGET(t, h, "/tasks/setup-guide", merchantToken)
	_ = json.NewDecoder(rec.Body).Decode(&steps)
	if !steps[0].Completed || steps[1].Completed {
		t.Fatalf("persisted steps: %+v", steps)
	}

	rec = authedDo(t, h, http.MethodPost, "/tasks/setup-guide/"+uuid.New().String()+"/complete", "", merchantToken)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("unknown step = %d, want 422 (%s)", rec.Code, rec.Body)
	}
	if errBody := atrDecodeError(t, rec); errBody.Code != "ONBOARDING_STEP_INVALID" {
		t.Fatalf("error code = %q, want ONBOARDING_STEP_INVALID", errBody.Code)
	}
}

// TestRiskReviewLifecycle: the risk feed is staff-only; a review resolves the
// event and a second review answers RISK_ALREADY_REVIEWED.
func TestRiskReviewLifecycle(t *testing.T) {
	s, pool := atrSetup(t)
	_, merchantToken := atrMerchant(t, s, pool)
	_, staffToken := atrStaff(t, s, pool)
	h := s.Router()

	var eventID uuid.UUID
	if err := pool.QueryRow(context.Background(),
		`INSERT INTO risk_events (entity_type, entity_id, signal, score, status)
		 VALUES ('merchant', $1, 'refund_velocity', 0.85, 'open') RETURNING id`,
		uuid.New()).Scan(&eventID); err != nil {
		t.Fatalf("seed risk event: %v", err)
	}

	rec := authedGET(t, h, "/risk/events", merchantToken)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("merchant risk list = %d, want 403 (%s)", rec.Code, rec.Body)
	}

	rec = authedGET(t, h, "/risk/events", staffToken)
	if rec.Code != http.StatusOK {
		t.Fatalf("staff risk list = %d (%s)", rec.Code, rec.Body)
	}
	var events []gen.RiskEvent
	_ = json.NewDecoder(rec.Body).Decode(&events)
	if len(events) != 1 || events[0].Status != gen.RiskEventStatusOpen {
		t.Fatalf("risk events = %v", events)
	}
	if events[0].Severity != gen.RiskEventSeverity("high") {
		t.Fatalf("severity = %q, want high for score 0.85", events[0].Severity)
	}

	path := "/risk/" + eventID.String() + "/review"
	rec = authedDo(t, h, http.MethodPost, path, `{"decision":"resolved","reason":"verified with merchant"}`, staffToken)
	if rec.Code != http.StatusOK {
		t.Fatalf("review risk event = %d (%s)", rec.Code, rec.Body)
	}
	var reviewed gen.RiskEvent
	_ = json.NewDecoder(rec.Body).Decode(&reviewed)
	if reviewed.Status != gen.RiskEventStatusResolved {
		t.Fatalf("reviewed status = %q, want resolved", reviewed.Status)
	}

	rec = authedDo(t, h, http.MethodPost, path, `{"decision":"dismissed","reason":"dup"}`, staffToken)
	if rec.Code != http.StatusConflict {
		t.Fatalf("re-review = %d, want 409 (%s)", rec.Code, rec.Body)
	}
	if errBody := atrDecodeError(t, rec); errBody.Code != "RISK_ALREADY_REVIEWED" {
		t.Fatalf("error code = %q, want RISK_ALREADY_REVIEWED", errBody.Code)
	}
}

// TestOnboardingFlow: profile → docs → submit with the step gates; the
// wizard status tracks progress and submittedAt.
func TestOnboardingFlow(t *testing.T) {
	s, pool := atrSetup(t)
	_, merchantToken := atrMerchant(t, s, pool)
	h := s.Router()

	rec := authedGET(t, h, "/onboarding/status", merchantToken)
	if rec.Code != http.StatusOK {
		t.Fatalf("onboarding status = %d (%s)", rec.Code, rec.Body)
	}
	var status gen.OnboardingStatus
	_ = json.NewDecoder(rec.Body).Decode(&status)
	if len(status.Steps) != 3 || status.CurrentStep != 1 {
		t.Fatalf("initial status = %+v", status)
	}

	rec = authedDo(t, h, http.MethodPost, "/onboarding/submit", "", merchantToken)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("submit before profile = %d, want 422 (%s)", rec.Code, rec.Body)
	}
	if errBody := atrDecodeError(t, rec); errBody.Code != "ONBOARDING_STEP_INVALID" {
		t.Fatalf("error code = %q, want ONBOARDING_STEP_INVALID", errBody.Code)
	}

	rec = authedDo(t, h, http.MethodPost, "/onboarding/profile",
		`{"businessName":"Mama's Kitchen","category":"restaurant","city":"Dar es Salaam","address":"Kwetu St 4"}`, merchantToken)
	if rec.Code != http.StatusOK {
		t.Fatalf("save profile = %d (%s)", rec.Code, rec.Body)
	}
	_ = json.NewDecoder(rec.Body).Decode(&status)
	if status.CurrentStep != 2 || !status.Steps[0].Completed || status.Steps[1].Completed {
		t.Fatalf("after profile = %+v", status)
	}

	rec = authedDo(t, h, http.MethodPost, "/onboarding/submit", "", merchantToken)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("submit before docs = %d, want 422 (%s)", rec.Code, rec.Body)
	}
	if errBody := atrDecodeError(t, rec); errBody.Code != "ONBOARDING_STEP_INVALID" {
		t.Fatalf("error code = %q, want ONBOARDING_STEP_INVALID", errBody.Code)
	}

	rec = authedDo(t, h, http.MethodPost, "/onboarding/docs",
		`{"documents":[{"type":"business_license","url":"https://example.com/license.pdf"},{"type":"tax_clearance","url":"https://example.com/tax.pdf"}]}`,
		merchantToken)
	if rec.Code != http.StatusCreated {
		t.Fatalf("upload docs = %d (%s)", rec.Code, rec.Body)
	}
	_ = json.NewDecoder(rec.Body).Decode(&status)
	if status.CurrentStep != 3 || !status.Steps[1].Completed {
		t.Fatalf("after docs = %+v", status)
	}
	var docCount int
	if err := pool.QueryRow(context.Background(),
		`SELECT count(*) FROM onboarding_docs WHERE owner_user_id = $1`, taskOwner(t, s, merchantToken)).Scan(&docCount); err != nil {
		t.Fatalf("doc count: %v", err)
	}
	if docCount != 2 {
		t.Fatalf("onboarding docs = %d, want 2", docCount)
	}

	rec = authedDo(t, h, http.MethodPost, "/onboarding/submit", "", merchantToken)
	if rec.Code != http.StatusOK {
		t.Fatalf("submit = %d (%s)", rec.Code, rec.Body)
	}
	_ = json.NewDecoder(rec.Body).Decode(&status)
	if status.SubmittedAt == nil || !status.Steps[2].Completed {
		t.Fatalf("after submit = %+v", status)
	}

	rec = authedDo(t, h, http.MethodPost, "/onboarding/submit", "", merchantToken)
	if rec.Code != http.StatusConflict {
		t.Fatalf("second submit = %d, want 409 (%s)", rec.Code, rec.Body)
	}
	if errBody := atrDecodeError(t, rec); errBody.Code != "ONBOARDING_ALREADY_SUBMITTED" {
		t.Fatalf("error code = %q, want ONBOARDING_ALREADY_SUBMITTED", errBody.Code)
	}
}

// TestTaskPagination25: 25 seeded tasks page as 20 + 5 with limit/offset.
func TestTaskPagination25(t *testing.T) {
	s, pool := atrSetup(t)
	_, merchantToken := atrMerchant(t, s, pool)
	h := s.Router()
	uid := taskOwner(t, s, merchantToken)

	for i := 0; i < 25; i++ {
		atrSeedTask(t, pool, uid, "general", fmt.Sprintf("Task %02d", i), "open")
	}

	rec := authedGET(t, h, "/tasks?limit=20", merchantToken)
	var page1 []gen.TaskItem
	_ = json.NewDecoder(rec.Body).Decode(&page1)
	if rec.Code != http.StatusOK || len(page1) != 20 {
		t.Fatalf("page 1 = %d, %d tasks (%s)", rec.Code, len(page1), rec.Body)
	}

	rec = authedGET(t, h, "/tasks?limit=20&offset=20", merchantToken)
	var page2 []gen.TaskItem
	_ = json.NewDecoder(rec.Body).Decode(&page2)
	if rec.Code != http.StatusOK || len(page2) != 5 {
		t.Fatalf("page 2 = %d, %d tasks (%s)", rec.Code, len(page2), rec.Body)
	}
	seen := map[uuid.UUID]bool{}
	for _, task := range append(page1, page2...) {
		if seen[task.Id] {
			t.Fatalf("duplicate task across pages: %s", task.Id)
		}
		seen[task.Id] = true
	}
}
