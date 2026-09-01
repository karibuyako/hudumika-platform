package api

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/hudumika/api-backend/internal/auth"
	"github.com/hudumika/api-backend/internal/gen"
	openapi_types "github.com/oapi-codegen/runtime/types"
)

// STORE-OPS bounded context (backend/ERROR-CODES.md §store ops, migration
// 00020): kitchen camera, qualification documents, store QR codes, receipt
// templates, payment accounts, self-pickup configuration and compliance
// rechecks. Like the catalogues context, the store-ops merchant id is the
// authenticated merchant's users row id (the real merchant entity does not
// exist yet).

// Limits enforced by the store-ops handlers (contract + ERROR-CODES.md).
// Deprecated: all constants below are now served from GetSettings().
const (
	// These are retained only as compile-time documentation; runtime values
	// come from GetSettings().
	_ = 0 // sentinel
)

// storeOpsMerchantID resolves the authenticated session to the store-ops
// merchant id: only merchant-role sessions may pass (403 FORBIDDEN for any
// other role) and the merchant id is the caller's users row id, resolved
// from the session subject (same milestone simplification as the catalogues
// context).
func (s *Server) storeOpsMerchantID(w http.ResponseWriter, r *http.Request) (uuid.UUID, bool) {
	claims, ok := ClaimsFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing or invalid bearer token")
		return uuid.Nil, false
	}
	if claims.Role != RoleMerchant {
		writeError(w, http.StatusForbidden, "FORBIDDEN", "Only merchant sessions may manage store operations")
		return uuid.Nil, false
	}
	if s.db == nil {
		s.logger.Error("store-ops merchant lookup failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return uuid.Nil, false
	}
	user, err := auth.NewRepo(s.db.Pool()).GetUserByPhone(r.Context(), claims.Subject)
	if err != nil {
		s.logger.Error("store-ops merchant lookup failed", "subject", claims.Subject, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return uuid.Nil, false
	}
	if user == nil {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "No account for this session")
		return uuid.Nil, false
	}
	return user.ID, true
}

// newQrCode generates the `QR-<8 hex>` code for a store QR row (unique via
// the store_qr_codes.code constraint; collisions fail the insert).
func newQrCode() (string, error) {
	b := make([]byte, 4)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("store-ops qr code entropy: %w", err)
	}
	return "QR-" + hex.EncodeToString(b), nil
}

// --- kitchen camera -------------------------------------------------------

// kitchenCameraConfig is the store_kitchen_camera.config jsonb shape; every
// field is optional so PATCH bodies keep untouched fields intact.
type kitchenCameraConfig struct {
	PublicAccess             *bool    `json:"publicAccess,omitempty"`
	RecordingDurationMinutes *int     `json:"recordingDurationMinutes,omitempty"`
	StorageCapacityGb        *float32 `json:"storageCapacityGb,omitempty"`
	StorageUsedGb            *float32 `json:"storageUsedGb,omitempty"`
	VideoQuality             *string  `json:"videoQuality,omitempty"`
}

func kitchenCameraConfigFromContract(c gen.KitchenCamera) kitchenCameraConfig {
	cfg := kitchenCameraConfig{
		PublicAccess:             c.PublicAccess,
		RecordingDurationMinutes: c.RecordingDurationMinutes,
		StorageCapacityGb:        c.StorageCapacityGb,
		StorageUsedGb:            c.StorageUsedGb,
	}
	if c.VideoQuality != nil {
		v := string(*c.VideoQuality)
		cfg.VideoQuality = &v
	}
	return cfg
}

func kitchenCameraToContract(enabled bool, url *string, config []byte, updatedAt time.Time) (gen.KitchenCamera, error) {
	out := gen.KitchenCamera{Enabled: enabled}
	at := updatedAt
	out.LastCheckedAt = &at
	if url != nil && *url != "" {
		out.StreamUrl = url
	}
	if len(config) > 0 {
		var cfg kitchenCameraConfig
		if err := json.Unmarshal(config, &cfg); err != nil {
			return out, fmt.Errorf("store-ops kitchen camera config decode: %w", err)
		}
		out.PublicAccess = cfg.PublicAccess
		out.RecordingDurationMinutes = cfg.RecordingDurationMinutes
		out.StorageCapacityGb = cfg.StorageCapacityGb
		out.StorageUsedGb = cfg.StorageUsedGb
		if cfg.VideoQuality != nil {
			q := gen.KitchenCameraVideoQuality(*cfg.VideoQuality)
			out.VideoQuality = &q
		}
	}
	return out, nil
}

// loadKitchenCamera reads the merchant's camera row; a missing row returns
// ok=false so the caller can distinguish not-configured.
func (s *Server) loadKitchenCamera(ctx context.Context, merchantID uuid.UUID) (gen.KitchenCamera, bool, error) {
	var (
		enabled   bool
		url       *string
		config    []byte
		updatedAt time.Time
	)
	err := s.db.Pool().QueryRow(ctx,
		`SELECT enabled, url, config, updated_at FROM store_kitchen_camera WHERE merchant_id = $1`, merchantID).
		Scan(&enabled, &url, &config, &updatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return gen.KitchenCamera{}, false, nil
	}
	if err != nil {
		return gen.KitchenCamera{}, false, fmt.Errorf("store-ops load kitchen camera: %w", err)
	}
	camera, err := kitchenCameraToContract(enabled, url, config, updatedAt)
	if err != nil {
		return gen.KitchenCamera{}, false, err
	}
	return camera, true, nil
}

// GetKitchenCamera returns the merchant's kitchen camera configuration
// (GET /store/kitchen-camera). A store that has never configured a camera
// surfaces KITCHEN_CAMERA_NOT_CONFIGURED.
func (s *Server) GetKitchenCamera(w http.ResponseWriter, r *http.Request) {
	merchantID, ok := s.storeOpsMerchantID(w, r)
	if !ok {
		return
	}
	camera, found, err := s.loadKitchenCamera(r.Context(), merchantID)
	if err != nil {
		s.logger.Error("get kitchen camera failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if !found {
		writeError(w, http.StatusNotFound, "KITCHEN_CAMERA_NOT_CONFIGURED", "Kitchen camera is not configured for this store")
		return
	}
	writeJSON(w, http.StatusOK, camera)
}

// UpdateKitchenCamera upserts the merchant's kitchen camera configuration
// (PATCH /store/kitchen-camera). PATCH semantics: fields absent from the
// body keep their current values.
func (s *Server) UpdateKitchenCamera(w http.ResponseWriter, r *http.Request) {
	merchantID, ok := s.storeOpsMerchantID(w, r)
	if !ok {
		return
	}
	var body gen.UpdateKitchenCameraJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}

	ctx := r.Context()
	cfg := kitchenCameraConfig{}
	var curURL *string
	err := s.db.Pool().QueryRow(ctx,
		`SELECT url, config FROM store_kitchen_camera WHERE merchant_id = $1`, merchantID).
		Scan(&curURL, &cfg)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		s.logger.Error("update kitchen camera read failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	incoming := kitchenCameraConfigFromContract(body)
	if incoming.PublicAccess != nil {
		cfg.PublicAccess = incoming.PublicAccess
	}
	if incoming.RecordingDurationMinutes != nil {
		cfg.RecordingDurationMinutes = incoming.RecordingDurationMinutes
	}
	if incoming.StorageCapacityGb != nil {
		cfg.StorageCapacityGb = incoming.StorageCapacityGb
	}
	if incoming.StorageUsedGb != nil {
		cfg.StorageUsedGb = incoming.StorageUsedGb
	}
	if incoming.VideoQuality != nil {
		cfg.VideoQuality = incoming.VideoQuality
	}
	config, err := json.Marshal(cfg)
	if err != nil {
		s.logger.Error("update kitchen camera config marshal failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	url := curURL
	if body.StreamUrl != nil {
		url = body.StreamUrl
	}
	if _, err := s.db.Pool().Exec(ctx,
		`INSERT INTO store_kitchen_camera (merchant_id, enabled, url, config, updated_at)
		 VALUES ($1, $2, $3, $4, now())
		 ON CONFLICT (merchant_id) DO UPDATE
		 SET enabled = EXCLUDED.enabled, url = EXCLUDED.url, config = EXCLUDED.config,
		     updated_at = now()`,
		merchantID, body.Enabled, url, config); err != nil {
		s.logger.Error("update kitchen camera failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	camera, found, err := s.loadKitchenCamera(ctx, merchantID)
	if err != nil || !found {
		s.logger.Error("reload kitchen camera failed", "merchant", merchantID, "found", found, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, camera)
}

// --- qualification documents ----------------------------------------------

// ListQualifications returns the merchant's qualification documents (GET
// /store/qualifications), newest first.
func (s *Server) ListQualifications(w http.ResponseWriter, r *http.Request) {
	merchantID, ok := s.storeOpsMerchantID(w, r)
	if !ok {
		return
	}
	rows, err := s.db.Pool().Query(r.Context(),
		`SELECT id, name, status, submitted_at FROM store_qualifications
		 WHERE merchant_id = $1 ORDER BY submitted_at DESC, id`, merchantID)
	if err != nil {
		s.logger.Error("list qualifications failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer rows.Close()
	out := make([]gen.Qualification, 0, 4)
	for rows.Next() {
		var (
			id          uuid.UUID
			name        string
			status      string
			submittedAt time.Time
		)
		if err := rows.Scan(&id, &name, &status, &submittedAt); err != nil {
			s.logger.Error("scan qualification failed", "merchant", merchantID, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		out = append(out, gen.Qualification{
			Id:        newUUID(id.String()),
			Type:      name,
			Status:    gen.QualificationStatus(status),
			CreatedAt: submittedAt,
		})
	}
	if err := rows.Err(); err != nil {
		s.logger.Error("iterate qualifications failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// UploadQualification submits a qualification document (POST
// /store/qualifications). The submission starts its lifecycle as pending;
// decisions are out of scope for this context. The document url is echoed
// back on creation but not persisted (the store_qualifications schema has no
// url column).
func (s *Server) UploadQualification(w http.ResponseWriter, r *http.Request) {
	merchantID, ok := s.storeOpsMerchantID(w, r)
	if !ok {
		return
	}
	var body gen.UploadQualificationJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if strings.TrimSpace(body.Type) == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "type is required")
		return
	}
	var id uuid.UUID
	if err := s.db.Pool().QueryRow(r.Context(),
		`INSERT INTO store_qualifications (merchant_id, name) VALUES ($1, $2) RETURNING id`,
		merchantID, strings.TrimSpace(body.Type)).Scan(&id); err != nil {
		s.logger.Error("upload qualification failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusCreated, gen.Qualification{
		Id:        newUUID(id.String()),
		Type:      strings.TrimSpace(body.Type),
		Status:    gen.QualificationStatusPending,
		Url:       &body.Url,
		CreatedAt: time.Now().UTC(),
	})
}

// --- store QR codes -------------------------------------------------------

// storeQrPayload returns the deterministic qrPayload derivation base; the
// payload is `prefix + code` (the code is unique per store row).
func storeQrPayload(code string) string {
	return GetSettings().StoreQrPrefix + code
}

// ListStoreQrCodes returns the merchant's active QR codes (GET
// /store/qr-codes), newest first.
func (s *Server) ListStoreQrCodes(w http.ResponseWriter, r *http.Request) {
	merchantID, ok := s.storeOpsMerchantID(w, r)
	if !ok {
		return
	}
	rows, err := s.db.Pool().Query(r.Context(),
		`SELECT id, label, code, created_at FROM store_qr_codes
		 WHERE merchant_id = $1 AND active = true ORDER BY created_at DESC, id`, merchantID)
	if err != nil {
		s.logger.Error("list store qr codes failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer rows.Close()
	out := make([]gen.StoreQrCode, 0, 4)
	for rows.Next() {
		var (
			id        uuid.UUID
			label     string
			code      string
			createdAt time.Time
		)
		if err := rows.Scan(&id, &label, &code, &createdAt); err != nil {
			s.logger.Error("scan store qr code failed", "merchant", merchantID, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		out = append(out, gen.StoreQrCode{
			Id:        newUUID(id.String()),
			Kind:      gen.StoreQrCodeKind(label),
		QrPayload: storeQrPayload(code),
		CreatedAt: &createdAt,
		})
	}
	if err := rows.Err(); err != nil {
		s.logger.Error("iterate store qr codes failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// CreateStoreQrCode generates a store QR code (POST /store/qr-codes). The
// kind is stored in the row label (the store_qr_codes schema has no kind
// column) and round-trips onto StoreQrCode.Kind.
func (s *Server) CreateStoreQrCode(w http.ResponseWriter, r *http.Request) {
	merchantID, ok := s.storeOpsMerchantID(w, r)
	if !ok {
		return
	}
	var body gen.CreateStoreQrCodeJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	kind := string(body.Kind)
	switch kind {
	case "ordering", "collection", "download", "review":
	default:
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "kind must be ordering, collection, download or review")
		return
	}
	code, err := newQrCode()
	if err != nil {
		s.logger.Error("create store qr code entropy failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	var id uuid.UUID
	if err := s.db.Pool().QueryRow(r.Context(),
		`INSERT INTO store_qr_codes (merchant_id, label, code) VALUES ($1, $2, $3) RETURNING id`,
		merchantID, kind, code).Scan(&id); err != nil {
		s.logger.Error("create store qr code failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	createdAt := time.Now().UTC()
	writeJSON(w, http.StatusCreated, gen.StoreQrCode{
		Id:        newUUID(id.String()),
		Kind:      gen.StoreQrCodeKind(kind),
		QrPayload: storeQrPayload(code),
		CreatedAt: &createdAt,
	})
}

// DeleteStoreQrCode deactivates a store QR code (DELETE
// /store/qr-codes/{qrCodeId}): the row is retained with active=false and
// excluded from the list. Unknown or another merchant's id surfaces
// STORE_QR_NOT_FOUND.
func (s *Server) DeleteStoreQrCode(w http.ResponseWriter, r *http.Request, qrCodeId openapi_types.UUID) {
	merchantID, ok := s.storeOpsMerchantID(w, r)
	if !ok {
		return
	}
	tag, err := s.db.Pool().Exec(r.Context(),
		`UPDATE store_qr_codes SET active = false WHERE id = $1 AND merchant_id = $2 AND active = true`,
		qrCodeId, merchantID)
	if err != nil {
		s.logger.Error("delete store qr code failed", "merchant", merchantID, "qrCode", qrCodeId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if tag.RowsAffected() == 0 {
		writeError(w, http.StatusNotFound, "STORE_QR_NOT_FOUND", "Store QR code not found")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// --- receipt templates ----------------------------------------------------

// receiptTemplateFields mirrors the contract ReceiptTemplate.fields toggles.
type receiptTemplateFields struct {
	Address       *bool `json:"address,omitempty"`
	CashierName   *bool `json:"cashierName,omitempty"`
	Date          *bool `json:"date,omitempty"`
	Items         *bool `json:"items,omitempty"`
	Logo          *bool `json:"logo,omitempty"`
	OrderId       *bool `json:"orderId,omitempty"`
	PaymentMethod *bool `json:"paymentMethod,omitempty"`
	Phone         *bool `json:"phone,omitempty"`
	QrCode        *bool `json:"qrCode,omitempty"`
	StoreName     *bool `json:"storeName,omitempty"`
	Subtotal      *bool `json:"subtotal,omitempty"`
	Tax           *bool `json:"tax,omitempty"`
	ThankYou      *bool `json:"thankYou,omitempty"`
	Total         *bool `json:"total,omitempty"`
}

// receiptTemplateBody is the receipt_templates.body jsonb shape: every field
// the contract ReceiptTemplate carries beyond name/id/isActive.
type receiptTemplateBody struct {
	HeaderText string                 `json:"headerText"`
	Fields     *receiptTemplateFields `json:"fields,omitempty"`
	Font       *string                `json:"font,omitempty"`
	PaperSize  *string                `json:"paperSize,omitempty"`
	FooterText *string                `json:"footerText,omitempty"`
	Copies     *int                   `json:"copies,omitempty"`
	ShowLogo   *bool                  `json:"showLogo,omitempty"`
	LogoEmoji  *string                `json:"logoEmoji,omitempty"`
}

func receiptTemplateBodyFromContract(t gen.ReceiptTemplate) (receiptTemplateBody, error) {
	body := receiptTemplateBody{HeaderText: t.HeaderText}
	if t.Fields != nil {
		body.Fields = &receiptTemplateFields{
			Address: t.Fields.Address, CashierName: t.Fields.CashierName, Date: t.Fields.Date,
			Items: t.Fields.Items, Logo: t.Fields.Logo, OrderId: t.Fields.OrderId,
			PaymentMethod: t.Fields.PaymentMethod, Phone: t.Fields.Phone, QrCode: t.Fields.QrCode,
			StoreName: t.Fields.StoreName, Subtotal: t.Fields.Subtotal, Tax: t.Fields.Tax,
			ThankYou: t.Fields.ThankYou, Total: t.Fields.Total,
		}
	}
	if t.Font != nil {
		v := string(*t.Font)
		body.Font = &v
	}
	if t.PaperSize != nil {
		v := string(*t.PaperSize)
		body.PaperSize = &v
	}
	body.FooterText = t.FooterText
	body.Copies = t.Copies
	body.ShowLogo = t.ShowLogo
	body.LogoEmoji = t.LogoEmoji
	return body, nil
}

func receiptTemplateToContract(id uuid.UUID, name string, body []byte, isActive bool, createdAt time.Time) (gen.ReceiptTemplate, error) {
	out := gen.ReceiptTemplate{
		Id:        ptr(newUUID(id.String())),
		Name:      name,
		IsActive:  &isActive,
		CreatedAt: &createdAt,
	}
	var stored receiptTemplateBody
	if err := json.Unmarshal(body, &stored); err != nil {
		return out, fmt.Errorf("store-ops receipt template body decode: %w", err)
	}
	out.HeaderText = stored.HeaderText
	out.Fields = (*struct {
		Address       *bool `json:"address,omitempty"`
		CashierName   *bool `json:"cashierName,omitempty"`
		Date          *bool `json:"date,omitempty"`
		Items         *bool `json:"items,omitempty"`
		Logo          *bool `json:"logo,omitempty"`
		OrderId       *bool `json:"orderId,omitempty"`
		PaymentMethod *bool `json:"paymentMethod,omitempty"`
		Phone         *bool `json:"phone,omitempty"`
		QrCode        *bool `json:"qrCode,omitempty"`
		StoreName     *bool `json:"storeName,omitempty"`
		Subtotal      *bool `json:"subtotal,omitempty"`
		Tax           *bool `json:"tax,omitempty"`
		ThankYou      *bool `json:"thankYou,omitempty"`
		Total         *bool `json:"total,omitempty"`
	})(stored.Fields)
	if stored.Font != nil {
		f := gen.ReceiptTemplateFont(*stored.Font)
		out.Font = &f
	}
	if stored.PaperSize != nil {
		p := gen.ReceiptTemplatePaperSize(*stored.PaperSize)
		out.PaperSize = &p
	}
	out.FooterText = stored.FooterText
	out.Copies = stored.Copies
	out.ShowLogo = stored.ShowLogo
	out.LogoEmoji = stored.LogoEmoji
	return out, nil
}

func ptr[T any](v T) *T { return &v }

// receiptTemplateCount returns how many templates the merchant owns.
func (s *Server) receiptTemplateCount(ctx context.Context, merchantID uuid.UUID) (int, error) {
	var n int
	if err := s.db.Pool().QueryRow(ctx,
		`SELECT count(*) FROM receipt_templates WHERE merchant_id = $1`, merchantID).Scan(&n); err != nil {
		return 0, fmt.Errorf("store-ops count receipt templates: %w", err)
	}
	return n, nil
}

// loadReceiptTemplate loads one template owned by the merchant.
func (s *Server) loadReceiptTemplate(ctx context.Context, merchantID uuid.UUID, templateID uuid.UUID) (gen.ReceiptTemplate, bool, error) {
	var (
		id        uuid.UUID
		name      string
		body      []byte
		isActive  bool
		createdAt time.Time
	)
	err := s.db.Pool().QueryRow(ctx,
		`SELECT id, name, body, is_active, created_at FROM receipt_templates
		 WHERE id = $1 AND merchant_id = $2`, templateID, merchantID).
		Scan(&id, &name, &body, &isActive, &createdAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return gen.ReceiptTemplate{}, false, nil
	}
	if err != nil {
		return gen.ReceiptTemplate{}, false, fmt.Errorf("store-ops load receipt template: %w", err)
	}
	t, err := receiptTemplateToContract(id, name, body, isActive, createdAt)
	if err != nil {
		return gen.ReceiptTemplate{}, false, err
	}
	return t, true, nil
}

// ListReceiptTemplates returns the merchant's receipt templates (GET
// /store/receipt-templates).
func (s *Server) ListReceiptTemplates(w http.ResponseWriter, r *http.Request) {
	merchantID, ok := s.storeOpsMerchantID(w, r)
	if !ok {
		return
	}
	rows, err := s.db.Pool().Query(r.Context(),
		`SELECT id, name, body, is_active, created_at FROM receipt_templates
		 WHERE merchant_id = $1 ORDER BY created_at, id`, merchantID)
	if err != nil {
		s.logger.Error("list receipt templates failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer rows.Close()
	out := make([]gen.ReceiptTemplate, 0, 4)
	for rows.Next() {
		var (
			id        uuid.UUID
			name      string
			body      []byte
			isActive  bool
			createdAt time.Time
		)
		if err := rows.Scan(&id, &name, &body, &isActive, &createdAt); err != nil {
			s.logger.Error("scan receipt template failed", "merchant", merchantID, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		t, err := receiptTemplateToContract(id, name, body, isActive, createdAt)
		if err != nil {
			s.logger.Error("receipt template decode failed", "merchant", merchantID, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		out = append(out, t)
	}
	if err := rows.Err(); err != nil {
		s.logger.Error("iterate receipt templates failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// CreateReceiptTemplate adds a receipt template (POST
// /store/receipt-templates); a merchant may own at most 10
// (RECEIPT_TEMPLATE_LIMIT_REACHED). Names are unique per merchant.
func (s *Server) CreateReceiptTemplate(w http.ResponseWriter, r *http.Request) {
	merchantID, ok := s.storeOpsMerchantID(w, r)
	if !ok {
		return
	}
	var body gen.CreateReceiptTemplateJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	body.Name = strings.TrimSpace(body.Name)
	if body.Name == "" || body.HeaderText == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "name and headerText are required")
		return
	}
	ctx := r.Context()
	count, err := s.receiptTemplateCount(ctx, merchantID)
	if err != nil {
		s.logger.Error("count receipt templates failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if count >= GetSettings().MaxReceiptTemplates {
		writeError(w, http.StatusConflict, "RECEIPT_TEMPLATE_LIMIT_REACHED", "Receipt template limit reached for this store")
		return
	}
	var taken bool
	if err := s.db.Pool().QueryRow(ctx,
		`SELECT EXISTS (SELECT 1 FROM receipt_templates WHERE merchant_id = $1 AND name = $2)`,
		merchantID, body.Name).Scan(&taken); err != nil {
		s.logger.Error("check receipt template name failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if taken {
		writeError(w, http.StatusConflict, "VALIDATION_FAILED", "A template with this name already exists")
		return
	}
	stored, err := receiptTemplateBodyFromContract(body)
	if err != nil {
		s.logger.Error("receipt template body marshal failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	bodyJSON, err := json.Marshal(stored)
	if err != nil {
		s.logger.Error("receipt template body marshal failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	var id uuid.UUID
	if err := s.db.Pool().QueryRow(ctx,
		`INSERT INTO receipt_templates (merchant_id, name, body) VALUES ($1, $2, $3) RETURNING id`,
		merchantID, body.Name, bodyJSON).Scan(&id); err != nil {
		s.logger.Error("create receipt template failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	t, found, err := s.loadReceiptTemplate(ctx, merchantID, id)
	if err != nil || !found {
		s.logger.Error("reload receipt template failed", "merchant", merchantID, "found", found, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusCreated, t)
}

// UpdateReceiptTemplate replaces a receipt template (PUT
// /store/receipt-templates/{templateId}); the active flag is never changed
// by an update. Unknown or another merchant's id surfaces
// RECEIPT_TEMPLATE_NOT_FOUND.
func (s *Server) UpdateReceiptTemplate(w http.ResponseWriter, r *http.Request, templateId openapi_types.UUID) {
	merchantID, ok := s.storeOpsMerchantID(w, r)
	if !ok {
		return
	}
	var body gen.UpdateReceiptTemplateJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	body.Name = strings.TrimSpace(body.Name)
	if body.Name == "" || body.HeaderText == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "name and headerText are required")
		return
	}
	stored, err := receiptTemplateBodyFromContract(body)
	if err != nil {
		s.logger.Error("receipt template body marshal failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	bodyJSON, err := json.Marshal(stored)
	if err != nil {
		s.logger.Error("receipt template body marshal failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	ctx := r.Context()
	tag, err := s.db.Pool().Exec(ctx,
		`UPDATE receipt_templates SET name = $3, body = $4, updated_at = now()
		 WHERE id = $1 AND merchant_id = $2`, templateId, merchantID, body.Name, bodyJSON)
	if err != nil {
		s.logger.Error("update receipt template failed", "merchant", merchantID, "template", templateId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if tag.RowsAffected() == 0 {
		writeError(w, http.StatusNotFound, "RECEIPT_TEMPLATE_NOT_FOUND", "Receipt template not found")
		return
	}
	t, found, err := s.loadReceiptTemplate(ctx, merchantID, templateId)
	if err != nil || !found {
		s.logger.Error("reload receipt template failed", "merchant", merchantID, "found", found, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, t)
}

// DeleteReceiptTemplate deletes a receipt template (DELETE
// /store/receipt-templates/{templateId}). Deleting the only remaining
// template while it is active is blocked with RECEIPT_TEMPLATE_IN_USE so the
// store never ends up without a receipt template it relies on. Unknown or
// another merchant's id surfaces RECEIPT_TEMPLATE_NOT_FOUND.
func (s *Server) DeleteReceiptTemplate(w http.ResponseWriter, r *http.Request, templateId openapi_types.UUID) {
	merchantID, ok := s.storeOpsMerchantID(w, r)
	if !ok {
		return
	}
	ctx := r.Context()
	_, found, err := s.loadReceiptTemplate(ctx, merchantID, templateId)
	if err != nil {
		s.logger.Error("load receipt template for delete failed", "merchant", merchantID, "template", templateId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if !found {
		writeError(w, http.StatusNotFound, "RECEIPT_TEMPLATE_NOT_FOUND", "Receipt template not found")
		return
	}
	tx, err := s.db.Pool().Begin(ctx)
	if err != nil {
		s.logger.Error("delete receipt template begin failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer tx.Rollback(ctx)
	var isActive bool
	var total int
	if err := tx.QueryRow(ctx,
		`SELECT is_active FROM receipt_templates WHERE id = $1 AND merchant_id = $2 FOR UPDATE`,
		templateId, merchantID).Scan(&isActive); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(w, http.StatusNotFound, "RECEIPT_TEMPLATE_NOT_FOUND", "Receipt template not found")
			return
		}
		s.logger.Error("delete receipt template lock failed", "merchant", merchantID, "template", templateId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if err := tx.QueryRow(ctx,
		`SELECT count(*) FROM receipt_templates WHERE merchant_id = $1`, merchantID).Scan(&total); err != nil {
		s.logger.Error("delete receipt template count failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if isActive && total == 1 {
		writeError(w, http.StatusConflict, "RECEIPT_TEMPLATE_IN_USE", "The active receipt template cannot be deleted while it is the only template")
		return
	}
	if _, err := tx.Exec(ctx,
		`DELETE FROM receipt_templates WHERE id = $1 AND merchant_id = $2`, templateId, merchantID); err != nil {
		s.logger.Error("delete receipt template failed", "merchant", merchantID, "template", templateId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if err := tx.Commit(ctx); err != nil {
		s.logger.Error("delete receipt template commit failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ActivateReceiptTemplate makes one template the merchant's active default
// (POST /store/receipt-templates/{templateId}/activate): is_active flips on
// for the target and off for every other template of the merchant, in one
// guarded transaction. Unknown or another merchant's id surfaces
// RECEIPT_TEMPLATE_NOT_FOUND.
func (s *Server) ActivateReceiptTemplate(w http.ResponseWriter, r *http.Request, templateId openapi_types.UUID) {
	merchantID, ok := s.storeOpsMerchantID(w, r)
	if !ok {
		return
	}
	ctx := r.Context()
	tx, err := s.db.Pool().Begin(ctx)
	if err != nil {
		s.logger.Error("activate receipt template begin failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx,
		`UPDATE receipt_templates SET is_active = false, updated_at = now() WHERE merchant_id = $1`, merchantID); err != nil {
		s.logger.Error("activate receipt template clear failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	tag, err := tx.Exec(ctx,
		`UPDATE receipt_templates SET is_active = true, updated_at = now()
		 WHERE id = $1 AND merchant_id = $2`, templateId, merchantID)
	if err != nil {
		s.logger.Error("activate receipt template set failed", "merchant", merchantID, "template", templateId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if tag.RowsAffected() == 0 {
		writeError(w, http.StatusNotFound, "RECEIPT_TEMPLATE_NOT_FOUND", "Receipt template not found")
		return
	}
	if err := tx.Commit(ctx); err != nil {
		s.logger.Error("activate receipt template commit failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	t, found, err := s.loadReceiptTemplate(ctx, merchantID, templateId)
	if err != nil || !found {
		s.logger.Error("reload receipt template failed", "merchant", merchantID, "found", found, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, t)
}

// --- payment accounts -----------------------------------------------------

// paymentAccountToContract maps a payment_accounts row onto the contract
// StorePaymentAccount. status/verified are best-effort constants (no
// verification flow exists yet in this context).
func paymentAccountToContract(id uuid.UUID, label, accountNumber, acctType string, isDefault bool) gen.StorePaymentAccount {
	status := gen.StorePaymentAccountStatusActive
	verified := false
	return gen.StorePaymentAccount{
		Id:            newUUID(id.String()),
		AccountMasked: accountNumber,
		IsDefault:     &isDefault,
		Provider:      label,
		Status:        &status,
		Type:          gen.StorePaymentAccountType(acctType),
		Verified:      &verified,
	}
}

// ListStorePaymentAccounts returns the merchant's payment accounts (GET
// /store/payment-accounts).
func (s *Server) ListStorePaymentAccounts(w http.ResponseWriter, r *http.Request) {
	merchantID, ok := s.storeOpsMerchantID(w, r)
	if !ok {
		return
	}
	rows, err := s.db.Pool().Query(r.Context(),
		`SELECT id, label, account_number, type, is_default FROM payment_accounts
		 WHERE merchant_id = $1 ORDER BY created_at, id`, merchantID)
	if err != nil {
		s.logger.Error("list payment accounts failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer rows.Close()
	out := make([]gen.StorePaymentAccount, 0, 4)
	for rows.Next() {
		var (
			id            uuid.UUID
			label         string
			accountNumber string
			acctType      string
			isDefault     bool
		)
		if err := rows.Scan(&id, &label, &accountNumber, &acctType, &isDefault); err != nil {
			s.logger.Error("scan payment account failed", "merchant", merchantID, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		out = append(out, paymentAccountToContract(id, label, accountNumber, acctType, isDefault))
	}
	if err := rows.Err(); err != nil {
		s.logger.Error("iterate payment accounts failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// CreateStorePaymentAccount adds a payment account (POST
// /store/payment-accounts); a merchant may own at most 5
// (PAYMENT_ACCOUNT_LIMIT_REACHED) and the first account automatically
// becomes the default. The client-sent id is ignored: a fresh server id is
// always assigned.
func (s *Server) CreateStorePaymentAccount(w http.ResponseWriter, r *http.Request) {
	merchantID, ok := s.storeOpsMerchantID(w, r)
	if !ok {
		return
	}
	var body gen.CreateStorePaymentAccountJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	acctType := string(body.Type)
	switch acctType {
	case "bank", "mobile_money":
	default:
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "type must be bank or mobile_money")
		return
	}
	if body.AccountMasked == "" || body.Provider == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "accountMasked and provider are required")
		return
	}
	ctx := r.Context()
	var count int
	if err := s.db.Pool().QueryRow(ctx,
		`SELECT count(*) FROM payment_accounts WHERE merchant_id = $1`, merchantID).Scan(&count); err != nil {
		s.logger.Error("count payment accounts failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if count >= GetSettings().MaxPaymentAccounts {
		writeError(w, http.StatusConflict, "PAYMENT_ACCOUNT_LIMIT_REACHED", "Payment account limit reached for this store")
		return
	}
	var id uuid.UUID
	if err := s.db.Pool().QueryRow(ctx,
		`INSERT INTO payment_accounts (merchant_id, label, type, account_number, is_default)
		 VALUES ($1, $2, $3, $4, $5) RETURNING id`,
		merchantID, body.Provider, acctType, body.AccountMasked, count == 0).Scan(&id); err != nil {
		s.logger.Error("create payment account failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusCreated, paymentAccountToContract(id, body.Provider, body.AccountMasked, acctType, count == 0))
}

// DeleteStorePaymentAccount removes a payment account (DELETE
// /store/payment-accounts/{accountId}). Deleting the last remaining default
// account is blocked with LAST_DEFAULT; deleting a default that has
// siblings promotes the oldest sibling in the same transaction. Unknown or
// another merchant's id surfaces PAYMENT_ACCOUNT_NOT_FOUND.
func (s *Server) DeleteStorePaymentAccount(w http.ResponseWriter, r *http.Request, accountId openapi_types.UUID) {
	merchantID, ok := s.storeOpsMerchantID(w, r)
	if !ok {
		return
	}
	ctx := r.Context()
	var (
		isDefault bool
	)
	err := s.db.Pool().QueryRow(ctx,
		`SELECT is_default FROM payment_accounts WHERE id = $1 AND merchant_id = $2 FOR UPDATE`,
		accountId, merchantID).Scan(&isDefault)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "PAYMENT_ACCOUNT_NOT_FOUND", "Payment account not found")
		return
	}
	if err != nil {
		s.logger.Error("delete payment account load failed", "merchant", merchantID, "account", accountId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	tx, err := s.db.Pool().Begin(ctx)
	if err != nil {
		s.logger.Error("delete payment account begin failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer tx.Rollback(ctx)
	var total int
	if err := tx.QueryRow(ctx,
		`SELECT count(*) FROM payment_accounts WHERE merchant_id = $1`, merchantID).Scan(&total); err != nil {
		s.logger.Error("delete payment account count failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if isDefault && total == 1 {
		writeError(w, http.StatusConflict, "LAST_DEFAULT", "The last default payment account cannot be deleted")
		return
	}
	if _, err := tx.Exec(ctx,
		`DELETE FROM payment_accounts WHERE id = $1 AND merchant_id = $2`, accountId, merchantID); err != nil {
		s.logger.Error("delete payment account failed", "merchant", merchantID, "account", accountId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if isDefault {
		if _, err := tx.Exec(ctx,
			`UPDATE payment_accounts SET is_default = true
			 WHERE id = (SELECT id FROM payment_accounts
			             WHERE merchant_id = $1 AND id <> $2
			             ORDER BY created_at, id LIMIT 1)`,
			merchantID, accountId); err != nil {
			s.logger.Error("delete payment account promote failed", "merchant", merchantID, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
	}
	if err := tx.Commit(ctx); err != nil {
		s.logger.Error("delete payment account commit failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// --- self-pickup configuration --------------------------------------------

// selfPickupHours is the pickup-hours shape kept in the pickup_instructions
// column (the self_pickup_config schema has no hours column): the contract
// carries pickupHours while the table carries a free-text instructions
// field, so the hours object is stored JSON-encoded there.
type selfPickupHours struct {
	Open  *string `json:"open,omitempty"`
	Close *string `json:"close,omitempty"`
}

// GetSelfPickupConfig returns the merchant's self-pickup configuration (GET
// /store/self-pickup). A store that never configured pickup answers with the
// honest default: enabled=false.
func (s *Server) GetSelfPickupConfig(w http.ResponseWriter, r *http.Request) {
	merchantID, ok := s.storeOpsMerchantID(w, r)
	if !ok {
		return
	}
	var (
		enabled      bool
		minutes      int
		instructions *string
	)
	err := s.db.Pool().QueryRow(r.Context(),
		`SELECT enabled, minutes_until_ready, pickup_instructions FROM self_pickup_config
		 WHERE merchant_id = $1`, merchantID).Scan(&enabled, &minutes, &instructions)
	if errors.Is(err, pgx.ErrNoRows) {
		writeJSON(w, http.StatusOK, gen.SelfPickupConfig{Enabled: false})
		return
	}
	if err != nil {
		s.logger.Error("get self-pickup config failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	out := gen.SelfPickupConfig{Enabled: enabled, PickupReadyMinutes: &minutes}
	if instructions != nil && *instructions != "" {
		var hours selfPickupHours
		if json.Unmarshal([]byte(*instructions), &hours) == nil && (hours.Open != nil || hours.Close != nil) {
			out.PickupHours = &struct {
				Close *string `json:"close,omitempty"`
				Open  *string `json:"open,omitempty"`
			}{Close: hours.Close, Open: hours.Open}
		}
	}
	writeJSON(w, http.StatusOK, out)
}

// PutSelfPickupConfig updates the merchant's self-pickup configuration (PUT
// /store/self-pickup). pickupReadyMinutes must be between 5 and 120
// (SELF_PICKUP_INVALID_CONFIG) and equal open/close hours are rejected
// (HOURS_INVALID, ERROR-CODES.md).
func (s *Server) PutSelfPickupConfig(w http.ResponseWriter, r *http.Request) {
	merchantID, ok := s.storeOpsMerchantID(w, r)
	if !ok {
		return
	}
	var body gen.PutSelfPickupConfigJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if body.PickupHours != nil && body.PickupHours.Open != nil && body.PickupHours.Close != nil &&
		*body.PickupHours.Open != "" && *body.PickupHours.Close != "" && *body.PickupHours.Open == *body.PickupHours.Close {
		writeError(w, http.StatusUnprocessableEntity, "HOURS_INVALID", "Pickup open and close hours must differ")
		return
	}
	minutes := 10
	if body.PickupReadyMinutes != nil {
		minutes = *body.PickupReadyMinutes
	}
	if minutes < GetSettings().MinSelfPickupMinutes || minutes > GetSettings().MaxSelfPickupMinutes {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED",
			fmt.Sprintf("pickupReadyMinutes must be between %d and %d", GetSettings().MinSelfPickupMinutes, GetSettings().MaxSelfPickupMinutes))
		return
	}
	var instructions *string
	if body.PickupHours != nil {
		hours := selfPickupHours{Open: body.PickupHours.Open, Close: body.PickupHours.Close}
		encoded, err := json.Marshal(hours)
		if err != nil {
			s.logger.Error("self-pickup hours marshal failed", "merchant", merchantID, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		s := string(encoded)
		instructions = &s
	}
	if _, err := s.db.Pool().Exec(r.Context(),
		`INSERT INTO self_pickup_config (merchant_id, enabled, pickup_instructions, minutes_until_ready, updated_at)
		 VALUES ($1, $2, $3, $4, now())
		 ON CONFLICT (merchant_id) DO UPDATE
		 SET enabled = EXCLUDED.enabled, pickup_instructions = COALESCE(EXCLUDED.pickup_instructions, self_pickup_config.pickup_instructions),
		     minutes_until_ready = EXCLUDED.minutes_until_ready, updated_at = now()`,
		merchantID, body.Enabled, instructions, minutes); err != nil {
		s.logger.Error("update self-pickup config failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	var (
		enabled    bool
		gotMinutes int
		gotInstr   *string
	)
	if err := s.db.Pool().QueryRow(r.Context(),
		`SELECT enabled, minutes_until_ready, pickup_instructions FROM self_pickup_config
		 WHERE merchant_id = $1`, merchantID).Scan(&enabled, &gotMinutes, &gotInstr); err != nil {
		s.logger.Error("reload self-pickup config failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	out := gen.SelfPickupConfig{Enabled: enabled, PickupReadyMinutes: &gotMinutes}
	if gotInstr != nil && *gotInstr != "" {
		var hours selfPickupHours
		if json.Unmarshal([]byte(*gotInstr), &hours) == nil && (hours.Open != nil || hours.Close != nil) {
			out.PickupHours = &struct {
				Close *string `json:"close,omitempty"`
				Open  *string `json:"open,omitempty"`
			}{Close: hours.Close, Open: hours.Open}
		}
	}
	writeJSON(w, http.StatusOK, out)
}

// --- compliance recheck ----------------------------------------------------

// complianceRecheckAccepted is the 202 body for a requested recheck: the
// contract requires status + estimatedMinutes, and the recheck id rides
// along so the merchant can track the run.
type complianceRecheckAccepted struct {
	Status           gen.RequestComplianceRecheck202JSONResponseBodyStatus `json:"status"`
	EstimatedMinutes int                                                   `json:"estimatedMinutes"`
	RecheckId        openapi_types.UUID                                    `json:"recheckId"`
}

// RequestComplianceRecheck starts a compliance recheck (POST
// /store/compliance/recheck). While a recheck is in progress a new one is
// rejected with COMPLIANCE_RECHECK_IN_PROGRESS; the partial unique index on
// in_progress rows makes concurrent requests single-winner.
func (s *Server) RequestComplianceRecheck(w http.ResponseWriter, r *http.Request) {
	merchantID, ok := s.storeOpsMerchantID(w, r)
	if !ok {
		return
	}
	var id uuid.UUID
	err := s.db.Pool().QueryRow(r.Context(),
		`INSERT INTO compliance_rechecks (merchant_id) VALUES ($1) RETURNING id`, merchantID).Scan(&id)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			writeError(w, http.StatusConflict, "COMPLIANCE_RECHECK_IN_PROGRESS", "A compliance recheck is already in progress")
			return
		}
		s.logger.Error("start compliance recheck failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusAccepted, complianceRecheckAccepted{
		Status:           gen.RequestComplianceRecheck202JSONResponseBodyStatusQueued,
		EstimatedMinutes: GetSettings().ComplianceEstimatedMinutes,
		RecheckId:        newUUID(id.String()),
	})
}
