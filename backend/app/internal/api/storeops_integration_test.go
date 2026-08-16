//go:build integration

// Store-ops integration tests against real PostgreSQL + Redis.
//
//	cd app && go test -tags integration ./internal/api/ -run 'StoreOps|Kitchen|Receipt|PaymentAccount|SelfPickup|Compliance|Qualification' -count=1
//
// This suite owns the store-ops tables (migration 00020): it truncates the
// seven storeops tables at setup and clears its own users (phone prefix
// +255878...) — it never truncates shared tables.
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

// storeOpsPhonePrefix identifies every users row this suite inserts.
const storeOpsPhonePrefix = "+255878"

// storeOpsTables are the tables owned by this suite (migration 00020).
var storeOpsTables = []string{
	"compliance_rechecks",
	"self_pickup_config",
	"payment_accounts",
	"receipt_templates",
	"store_qr_codes",
	"store_qualifications",
	"store_kitchen_camera",
}

// storeOpsSetup wires a persistent server and truncates only this suite's
// tables plus its own users. All seven tables are truncated in one statement
// so the payment_accounts→receipt_templates dependency order is irrelevant.
func storeOpsSetup(t *testing.T) (*Server, *pgxpool.Pool) {
	t.Helper()
	s, pool := newPersistentServer(t)
	ctx := context.Background()
	if _, err := pool.Exec(ctx, "TRUNCATE "+strings.Join(storeOpsTables, ", ")); err != nil {
		t.Fatalf("truncate store ops tables: %v", err)
	}
	if _, err := pool.Exec(ctx, `DELETE FROM users WHERE phone LIKE '`+storeOpsPhonePrefix+`%'`); err != nil {
		t.Fatalf("clear store ops users: %v", err)
	}
	return s, pool
}

// storeOpsMerchant inserts a users row with a per-run unique phone and
// returns the merchant id and the phone (the session subject).
func storeOpsMerchant(t *testing.T, pool *pgxpool.Pool) (uuid.UUID, string) {
	t.Helper()
	ctx := context.Background()
	phone := fmt.Sprintf("%s%08d", storeOpsPhonePrefix, time.Now().UnixNano()%100_000_000)
	userID := uuid.New()
	if _, err := pool.Exec(ctx, `INSERT INTO users (id, phone) VALUES ($1, $2)`, userID, phone); err != nil {
		t.Fatalf("insert store ops merchant user: %v", err)
	}
	return userID, phone
}

// storeOpsErr decodes an error envelope and asserts its code.
func storeOpsErr(t *testing.T, rec *httptest.ResponseRecorder) gen.ErrorResponse {
	t.Helper()
	var errBody gen.ErrorResponse
	if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
		t.Fatalf("decode error body: %v", err)
	}
	return errBody
}

// TestKitchenCameraUpsertRoundtrip covers not-configured → upsert → PATCH
// field merge → GET round-trip.
func TestKitchenCameraUpsertRoundtrip(t *testing.T) {
	s, pool := storeOpsSetup(t)
	_, phone := storeOpsMerchant(t, pool)
	token := tokenFor(t, s, phone, RoleMerchant, false)
	h := s.Router()

	rec := authedGET(t, h, "/store/kitchen-camera", token)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("get unconfigured camera = %d, want 404 (%s)", rec.Code, rec.Body)
	}
	if errBody := storeOpsErr(t, rec); errBody.Code != "KITCHEN_CAMERA_NOT_CONFIGURED" {
		t.Fatalf("error code = %q, want KITCHEN_CAMERA_NOT_CONFIGURED", errBody.Code)
	}

	rec = authedDo(t, h, http.MethodPatch, "/store/kitchen-camera",
		`{"enabled":true,"streamUrl":"https://cam.example/live","publicAccess":true,"recordingDurationMinutes":120,"videoQuality":"hd"}`, token)
	if rec.Code != http.StatusOK {
		t.Fatalf("update camera = %d (%s)", rec.Code, rec.Body)
	}
	var camera gen.KitchenCamera
	if err := json.NewDecoder(rec.Body).Decode(&camera); err != nil {
		t.Fatalf("decode camera: %v", err)
	}
	if !camera.Enabled || camera.StreamUrl == nil || *camera.StreamUrl != "https://cam.example/live" {
		t.Fatalf("unexpected camera: %+v", camera)
	}
	if camera.PublicAccess == nil || !*camera.PublicAccess || camera.RecordingDurationMinutes == nil || *camera.RecordingDurationMinutes != 120 {
		t.Fatalf("camera config not round-tripped: %+v", camera)
	}
	if camera.VideoQuality == nil || *camera.VideoQuality != "hd" {
		t.Fatalf("camera videoQuality = %v, want hd", camera.VideoQuality)
	}
	if camera.LastCheckedAt == nil {
		t.Fatalf("camera lastCheckedAt missing: %+v", camera)
	}

	// PATCH merge: enabled flips off but streamUrl and duration survive.
	rec = authedDo(t, h, http.MethodPatch, "/store/kitchen-camera", `{"enabled":false}`, token)
	if rec.Code != http.StatusOK {
		t.Fatalf("merge camera = %d (%s)", rec.Code, rec.Body)
	}
	if err := json.NewDecoder(rec.Body).Decode(&camera); err != nil {
		t.Fatalf("decode merged camera: %v", err)
	}
	if camera.Enabled {
		t.Fatalf("merged camera still enabled: %+v", camera)
	}
	if camera.StreamUrl == nil || *camera.StreamUrl != "https://cam.example/live" {
		t.Fatalf("merged camera lost streamUrl: %+v", camera)
	}
	if camera.RecordingDurationMinutes == nil || *camera.RecordingDurationMinutes != 120 {
		t.Fatalf("merged camera lost duration: %+v", camera)
	}

	rec = authedGET(t, h, "/store/kitchen-camera", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("get camera = %d (%s)", rec.Code, rec.Body)
	}
	if err := json.NewDecoder(rec.Body).Decode(&camera); err != nil {
		t.Fatalf("decode camera: %v", err)
	}
	if camera.Enabled {
		t.Fatalf("get camera enabled after merge: %+v", camera)
	}
}

// TestStoreQrCodeLifecycle covers create → list → deactivate → not found.
func TestStoreQrCodeLifecycle(t *testing.T) {
	s, pool := storeOpsSetup(t)
	_, phone := storeOpsMerchant(t, pool)
	token := tokenFor(t, s, phone, RoleMerchant, false)
	h := s.Router()

	rec := authedDo(t, h, http.MethodPost, "/store/qr-codes", `{"kind":"ordering"}`, token)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create qr = %d (%s)", rec.Code, rec.Body)
	}
	var created gen.StoreQrCode
	if err := json.NewDecoder(rec.Body).Decode(&created); err != nil {
		t.Fatalf("decode qr: %v", err)
	}
	if created.Id.String() == "" || created.Kind != "ordering" || created.QrPayload == "" {
		t.Fatalf("unexpected created qr: %+v", created)
	}

	rec = authedDo(t, h, http.MethodPost, "/store/qr-codes", `{"kind":"collection"}`, token)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create second qr = %d (%s)", rec.Code, rec.Body)
	}
	rec = authedDo(t, h, http.MethodPost, "/store/qr-codes", `{"kind":"fridge_magnet"}`, token)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("invalid kind = %d, want 422 (%s)", rec.Code, rec.Body)
	}

	rec = authedGET(t, h, "/store/qr-codes", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("list qr = %d (%s)", rec.Code, rec.Body)
	}
	var list []gen.StoreQrCode
	if err := json.NewDecoder(rec.Body).Decode(&list); err != nil {
		t.Fatalf("decode qr list: %v", err)
	}
	if len(list) != 2 {
		t.Fatalf("qr count = %d, want 2", len(list))
	}

	rec = authedDo(t, h, http.MethodDelete, "/store/qr-codes/"+created.Id.String(), "", token)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("delete qr = %d (%s)", rec.Code, rec.Body)
	}
	rec = authedDo(t, h, http.MethodDelete, "/store/qr-codes/"+created.Id.String(), "", token)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("delete missing qr = %d, want 404", rec.Code)
	}
	if errBody := storeOpsErr(t, rec); errBody.Code != "STORE_QR_NOT_FOUND" {
		t.Fatalf("error code = %q, want STORE_QR_NOT_FOUND", errBody.Code)
	}
	rec = authedGET(t, h, "/store/qr-codes", token)
	if err := json.NewDecoder(rec.Body).Decode(&list); err != nil {
		t.Fatalf("decode qr list: %v", err)
	}
	if len(list) != 1 {
		t.Fatalf("qr count after delete = %d, want 1", len(list))
	}
}

// TestReceiptTemplateLifecycle covers the 10-template limit, the
// activate-swaps-active-flag rule and the delete-in-use guard.
func TestReceiptTemplateLifecycle(t *testing.T) {
	s, pool := storeOpsSetup(t)
	_, phone := storeOpsMerchant(t, pool)
	token := tokenFor(t, s, phone, RoleMerchant, false)
	h := s.Router()

	ids := make([]gen.ReceiptTemplate, 0, 11)
	for i := 1; i <= 10; i++ {
		rec := authedDo(t, h, http.MethodPost, "/store/receipt-templates",
			fmt.Sprintf(`{"name":"Template %d","headerText":"Header %d","copies":2}`, i, i), token)
		if rec.Code != http.StatusCreated {
			t.Fatalf("create template %d = %d (%s)", i, rec.Code, rec.Body)
		}
		var tpl gen.ReceiptTemplate
		if err := json.NewDecoder(rec.Body).Decode(&tpl); err != nil {
			t.Fatalf("decode template: %v", err)
		}
		if tpl.Id == nil || tpl.IsActive == nil || *tpl.IsActive {
			t.Fatalf("unexpected created template: %+v", tpl)
		}
		ids = append(ids, tpl)
	}

	rec := authedDo(t, h, http.MethodPost, "/store/receipt-templates",
		`{"name":"Overflow","headerText":"Header"}`, token)
	if rec.Code != http.StatusConflict {
		t.Fatalf("11th template = %d, want 409 (%s)", rec.Code, rec.Body)
	}
	if errBody := storeOpsErr(t, rec); errBody.Code != "RECEIPT_TEMPLATE_LIMIT_REACHED" {
		t.Fatalf("error code = %q, want RECEIPT_TEMPLATE_LIMIT_REACHED", errBody.Code)
	}

	// Activate template 1: exactly one active afterwards.
	rec = authedDo(t, h, http.MethodPost, "/store/receipt-templates/"+ids[0].Id.String()+"/activate", "", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("activate template = %d (%s)", rec.Code, rec.Body)
	}
	var active gen.ReceiptTemplate
	if err := json.NewDecoder(rec.Body).Decode(&active); err != nil {
		t.Fatalf("decode activated template: %v", err)
	}
	if active.IsActive == nil || !*active.IsActive {
		t.Fatalf("activated template not active: %+v", active)
	}
	// Activate template 2: the flag swaps — template 1 is off again.
	rec = authedDo(t, h, http.MethodPost, "/store/receipt-templates/"+ids[1].Id.String()+"/activate", "", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("swap activation = %d (%s)", rec.Code, rec.Body)
	}
	rec = authedGET(t, h, "/store/receipt-templates", token)
	var all []gen.ReceiptTemplate
	if err := json.NewDecoder(rec.Body).Decode(&all); err != nil {
		t.Fatalf("decode template list: %v", err)
	}
	activeCount := 0
	for _, tpl := range all {
		if tpl.IsActive != nil && *tpl.IsActive {
			activeCount++
			if tpl.Id.String() != ids[1].Id.String() {
				t.Fatalf("unexpected active template: %+v", tpl)
			}
		}
	}
	if activeCount != 1 {
		t.Fatalf("active templates = %d, want exactly 1", activeCount)
	}

	// Delete 9 inactive templates (all but the active one), then deleting
	// the last (active) template is blocked with RECEIPT_TEMPLATE_IN_USE.
	for _, tpl := range append(ids[2:], ids[0]) {
		rec = authedDo(t, h, http.MethodDelete, "/store/receipt-templates/"+tpl.Id.String(), "", token)
		if rec.Code != http.StatusNoContent {
			t.Fatalf("delete inactive template = %d (%s)", rec.Code, rec.Body)
		}
	}
	rec = authedDo(t, h, http.MethodDelete, "/store/receipt-templates/"+ids[1].Id.String(), "", token)
	if rec.Code != http.StatusConflict {
		t.Fatalf("delete last active template = %d, want 409 (%s)", rec.Code, rec.Body)
	}
	if errBody := storeOpsErr(t, rec); errBody.Code != "RECEIPT_TEMPLATE_IN_USE" {
		t.Fatalf("error code = %q, want RECEIPT_TEMPLATE_IN_USE", errBody.Code)
	}

	// Unknown template id → RECEIPT_TEMPLATE_NOT_FOUND.
	rec = authedDo(t, h, http.MethodPost, "/store/receipt-templates/"+uuid.NewString()+"/activate", "", token)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("activate missing template = %d, want 404", rec.Code)
	}
	if errBody := storeOpsErr(t, rec); errBody.Code != "RECEIPT_TEMPLATE_NOT_FOUND" {
		t.Fatalf("error code = %q, want RECEIPT_TEMPLATE_NOT_FOUND", errBody.Code)
	}
}

// TestPaymentAccountFirstBecomesDefault covers the 5-account limit and the
// first-account-is-default rule.
func TestPaymentAccountFirstBecomesDefault(t *testing.T) {
	s, pool := storeOpsSetup(t)
	_, phone := storeOpsMerchant(t, pool)
	token := tokenFor(t, s, phone, RoleMerchant, false)
	h := s.Router()

	rec := authedDo(t, h, http.MethodPost, "/store/payment-accounts",
		fmt.Sprintf(`{"id":%q,"accountMasked":"****1234","provider":"CRDB Bank","type":"bank"}`, uuid.NewString()), token)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create first account = %d (%s)", rec.Code, rec.Body)
	}
	var first gen.StorePaymentAccount
	if err := json.NewDecoder(rec.Body).Decode(&first); err != nil {
		t.Fatalf("decode first account: %v", err)
	}
	if first.IsDefault == nil || !*first.IsDefault {
		t.Fatalf("first account not default: %+v", first)
	}

	rec = authedDo(t, h, http.MethodPost, "/store/payment-accounts",
		`{"id":"00000000-0000-4000-8000-000000000001","accountMasked":"****5678","provider":"M-Pesa","type":"mobile_money"}`, token)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create second account = %d (%s)", rec.Code, rec.Body)
	}
	var second gen.StorePaymentAccount
	if err := json.NewDecoder(rec.Body).Decode(&second); err != nil {
		t.Fatalf("decode second account: %v", err)
	}
	if second.IsDefault == nil || *second.IsDefault {
		t.Fatalf("second account unexpectedly default: %+v", second)
	}

	for i := 0; i < 3; i++ {
		rec = authedDo(t, h, http.MethodPost, "/store/payment-accounts",
			fmt.Sprintf(`{"id":%q,"accountMasked":"****999%d","provider":"Bank %d","type":"bank"}`, uuid.NewString(), i, i), token)
		if rec.Code != http.StatusCreated {
			t.Fatalf("create account %d = %d (%s)", i+3, rec.Code, rec.Body)
		}
	}
	rec = authedDo(t, h, http.MethodPost, "/store/payment-accounts",
		`{"id":"00000000-0000-4000-8000-000000000006","accountMasked":"****0000","provider":"Sixth","type":"bank"}`, token)
	if rec.Code != http.StatusConflict {
		t.Fatalf("6th account = %d, want 409 (%s)", rec.Code, rec.Body)
	}
	if errBody := storeOpsErr(t, rec); errBody.Code != "PAYMENT_ACCOUNT_LIMIT_REACHED" {
		t.Fatalf("error code = %q, want PAYMENT_ACCOUNT_LIMIT_REACHED", errBody.Code)
	}

	rec = authedGET(t, h, "/store/payment-accounts", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("list accounts = %d (%s)", rec.Code, rec.Body)
	}
	var list []gen.StorePaymentAccount
	if err := json.NewDecoder(rec.Body).Decode(&list); err != nil {
		t.Fatalf("decode account list: %v", err)
	}
	if len(list) != 5 {
		t.Fatalf("account count = %d, want 5", len(list))
	}
	defaults := 0
	for _, a := range list {
		if a.IsDefault != nil && *a.IsDefault {
			defaults++
		}
	}
	if defaults != 1 {
		t.Fatalf("default accounts = %d, want 1", defaults)
	}
}

// TestPaymentAccountDeleteLastDefault covers promotion on default deletion
// and the LAST_DEFAULT guard for the final account.
func TestPaymentAccountDeleteLastDefault(t *testing.T) {
	s, pool := storeOpsSetup(t)
	_, phone := storeOpsMerchant(t, pool)
	token := tokenFor(t, s, phone, RoleMerchant, false)
	h := s.Router()

	rec := authedDo(t, h, http.MethodPost, "/store/payment-accounts",
		fmt.Sprintf(`{"id":%q,"accountMasked":"****1111","provider":"Bank A","type":"bank"}`, uuid.NewString()), token)
	var first gen.StorePaymentAccount
	_ = json.NewDecoder(rec.Body).Decode(&first)
	rec = authedDo(t, h, http.MethodPost, "/store/payment-accounts",
		fmt.Sprintf(`{"id":%q,"accountMasked":"****2222","provider":"Bank B","type":"bank"}`, uuid.NewString()), token)
	var second gen.StorePaymentAccount
	_ = json.NewDecoder(rec.Body).Decode(&second)

	// Deleting the default promotes the sibling.
	rec = authedDo(t, h, http.MethodDelete, "/store/payment-accounts/"+first.Id.String(), "", token)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("delete default = %d (%s)", rec.Code, rec.Body)
	}
	var promoted gen.StorePaymentAccount
	if err := pool.QueryRow(context.Background(),
		`SELECT label, is_default FROM payment_accounts WHERE id = $1`, second.Id).Scan(&promoted.Provider, &promoted.IsDefault); err != nil {
		t.Fatalf("load promoted account: %v", err)
	}
	if promoted.IsDefault == nil || !*promoted.IsDefault {
		t.Fatalf("sibling not promoted to default: %+v", promoted)
	}

	// The last remaining default cannot be deleted.
	rec = authedDo(t, h, http.MethodDelete, "/store/payment-accounts/"+second.Id.String(), "", token)
	if rec.Code != http.StatusConflict {
		t.Fatalf("delete last default = %d, want 409 (%s)", rec.Code, rec.Body)
	}
	if errBody := storeOpsErr(t, rec); errBody.Code != "LAST_DEFAULT" {
		t.Fatalf("error code = %q, want LAST_DEFAULT", errBody.Code)
	}

	// Unknown account → PAYMENT_ACCOUNT_NOT_FOUND.
	rec = authedDo(t, h, http.MethodDelete, "/store/payment-accounts/"+uuid.NewString(), "", token)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("delete missing account = %d, want 404", rec.Code)
	}
	if errBody := storeOpsErr(t, rec); errBody.Code != "PAYMENT_ACCOUNT_NOT_FOUND" {
		t.Fatalf("error code = %q, want PAYMENT_ACCOUNT_NOT_FOUND", errBody.Code)
	}
}

// TestSelfPickupValidation covers the honest default, the 5-120 minute
// bound and the HOURS_INVALID rule.
func TestSelfPickupValidation(t *testing.T) {
	s, pool := storeOpsSetup(t)
	_, phone := storeOpsMerchant(t, pool)
	token := tokenFor(t, s, phone, RoleMerchant, false)
	h := s.Router()

	rec := authedGET(t, h, "/store/self-pickup", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("get unconfigured pickup = %d (%s)", rec.Code, rec.Body)
	}
	var cfg gen.SelfPickupConfig
	if err := json.NewDecoder(rec.Body).Decode(&cfg); err != nil {
		t.Fatalf("decode pickup config: %v", err)
	}
	if cfg.Enabled {
		t.Fatalf("unconfigured pickup enabled: %+v", cfg)
	}

	rec = authedDo(t, h, http.MethodPut, "/store/self-pickup", `{"enabled":true,"pickupReadyMinutes":2}`, token)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("minutes 2 = %d, want 422 (%s)", rec.Code, rec.Body)
	}
	if errBody := storeOpsErr(t, rec); errBody.Code != "SELF_PICKUP_INVALID_CONFIG" {
		t.Fatalf("error code = %q, want SELF_PICKUP_INVALID_CONFIG", errBody.Code)
	}

	rec = authedDo(t, h, http.MethodPut, "/store/self-pickup",
		`{"enabled":true,"pickupReadyMinutes":10,"pickupHours":{"open":"08:00","close":"20:00"}}`, token)
	if rec.Code != http.StatusOK {
		t.Fatalf("valid pickup = %d (%s)", rec.Code, rec.Body)
	}
	if err := json.NewDecoder(rec.Body).Decode(&cfg); err != nil {
		t.Fatalf("decode updated pickup: %v", err)
	}
	if !cfg.Enabled || cfg.PickupReadyMinutes == nil || *cfg.PickupReadyMinutes != 10 {
		t.Fatalf("unexpected pickup config: %+v", cfg)
	}
	if cfg.PickupHours == nil || cfg.PickupHours.Open == nil || *cfg.PickupHours.Open != "08:00" ||
		cfg.PickupHours.Close == nil || *cfg.PickupHours.Close != "20:00" {
		t.Fatalf("pickup hours not round-tripped: %+v", cfg)
	}

	rec = authedDo(t, h, http.MethodPut, "/store/self-pickup",
		`{"enabled":true,"pickupReadyMinutes":15,"pickupHours":{"open":"08:00","close":"08:00"}}`, token)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("equal hours = %d, want 422 (%s)", rec.Code, rec.Body)
	}
	if errBody := storeOpsErr(t, rec); errBody.Code != "HOURS_INVALID" {
		t.Fatalf("error code = %q, want HOURS_INVALID", errBody.Code)
	}

	rec = authedGET(t, h, "/store/self-pickup", token)
	if err := json.NewDecoder(rec.Body).Decode(&cfg); err != nil {
		t.Fatalf("decode final pickup: %v", err)
	}
	if cfg.PickupReadyMinutes == nil || *cfg.PickupReadyMinutes != 10 {
		t.Fatalf("rejected update leaked into config: %+v", cfg)
	}
}

// TestComplianceRecheckConflict covers the 202 acceptance and the
// COMPLIANCE_RECHECK_IN_PROGRESS guard on a second call.
func TestComplianceRecheckConflict(t *testing.T) {
	s, pool := storeOpsSetup(t)
	_, phone := storeOpsMerchant(t, pool)
	token := tokenFor(t, s, phone, RoleMerchant, false)
	h := s.Router()

	rec := authedDo(t, h, http.MethodPost, "/store/compliance/recheck", "", token)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("first recheck = %d, want 202 (%s)", rec.Code, rec.Body)
	}
	var accepted struct {
		Status           string `json:"status"`
		EstimatedMinutes int    `json:"estimatedMinutes"`
		RecheckId        string `json:"recheckId"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&accepted); err != nil {
		t.Fatalf("decode recheck: %v", err)
	}
	if accepted.Status != "queued" || accepted.EstimatedMinutes <= 0 || accepted.RecheckId == "" {
		t.Fatalf("unexpected recheck acceptance: %+v", accepted)
	}

	rec = authedDo(t, h, http.MethodPost, "/store/compliance/recheck", "", token)
	if rec.Code != http.StatusConflict {
		t.Fatalf("second recheck = %d, want 409 (%s)", rec.Code, rec.Body)
	}
	if errBody := storeOpsErr(t, rec); errBody.Code != "COMPLIANCE_RECHECK_IN_PROGRESS" {
		t.Fatalf("error code = %q, want COMPLIANCE_RECHECK_IN_PROGRESS", errBody.Code)
	}
}

// TestQualificationUploadList covers the pending-status lifecycle and the
// list round-trip.
func TestQualificationUploadList(t *testing.T) {
	s, pool := storeOpsSetup(t)
	_, phone := storeOpsMerchant(t, pool)
	token := tokenFor(t, s, phone, RoleMerchant, false)
	h := s.Router()

	rec := authedDo(t, h, http.MethodPost, "/store/qualifications",
		`{"type":"health_certificate","url":"https://docs.example/cert.pdf"}`, token)
	if rec.Code != http.StatusCreated {
		t.Fatalf("upload qualification = %d (%s)", rec.Code, rec.Body)
	}
	var created gen.Qualification
	if err := json.NewDecoder(rec.Body).Decode(&created); err != nil {
		t.Fatalf("decode qualification: %v", err)
	}
	if created.Id.String() == "" || created.Type != "health_certificate" || created.Status != gen.QualificationStatusPending {
		t.Fatalf("unexpected qualification: %+v", created)
	}

	rec = authedGET(t, h, "/store/qualifications", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("list qualifications = %d (%s)", rec.Code, rec.Body)
	}
	var list []gen.Qualification
	if err := json.NewDecoder(rec.Body).Decode(&list); err != nil {
		t.Fatalf("decode qualification list: %v", err)
	}
	if len(list) != 1 || list[0].Type != "health_certificate" || list[0].Status != gen.QualificationStatusPending {
		t.Fatalf("unexpected qualification list: %+v", list)
	}
}
