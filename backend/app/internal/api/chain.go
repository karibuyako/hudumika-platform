package api

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/hudumika/api-backend/internal/gen"
	"github.com/hudumika/api-backend/internal/merchants"
	openapi_types "github.com/oapi-codegen/runtime/types"
)

// CHAIN bounded context (API-CONTRACT.yaml /chain/* and /bulk-operations):
// one merchant owner manages multiple stores through chain_stores and queues
// cross-store changes through bulk_operations.
//
// Milestone notes:
//   - The chain owner is the authenticated merchant session's users row id:
//     chain_stores.owner_user_id and bulk_operations.owner_user_id store that
//     id, resolved by the shared merchant owner gate (merchants.go). The
//     contract's "merchant id == subject user id" simplification stands until
//     real chain membership lands.
//   - "Paid orders" means every order at or beyond the paid status (paid,
//     merchant_accepted, preparing, rider_assigned, picked_up, delivering,
//     delivered, completed); draft/pending_payment/cancelled/refunded/failed/
//     disputed never contribute revenue. ActiveOrders is the same set minus
//     the terminal completed state.
//   - bulk_operations.kind uses the migration CHECK enum (inventory,
//     price_change, promotion, closure) rather than the generated
//     BulkOperationType enum (availability/catalogue_sync/price_update/
//     promotion_apply): the DB is authoritative for this milestone and the
//     decide flow keys off 'closure'. The storage statuses map onto the
//     contract status enum: pending→queued, approved→processing,
//     applied→completed, rejected→failed, failed→failed.
//   - The contract defines no staff decide route (only POST+GET
//     /bulk-operations and GET /bulk-operations/{bulkOperationId}); the staff
//     approval flow lands with a contract revision. The DB transitions it
//     will run are documented here and exercised at the SQL level by the
//     integration suite: approving a 'closure' applies
//     `UPDATE chain_stores SET active=false WHERE id = ANY($1) AND
//     owner_user_id = $2` and marks the operation applied with applied_count
//     set to the affected stores; other kinds are marked applied with
//     applied_count 0. Rejections set status rejected and persist the staff
//     reason (a rejection without a reason is 422 ADMIN_REASON_REQUIRED in
//     the future handler).
//   - POST /chain/reports (exportChainReport) answers NOT_IMPLEMENTED: the
//     scheduled-reporting milestone owns report generation.

const (
	defaultBulkListLimit = 20
	maxBulkListLimit     = 100
)

// chainPaidStatuses are the order statuses that count as paid for chain
// aggregates (see the file comment).
var chainPaidStatuses = []string{
	"paid", "merchant_accepted", "preparing", "rider_assigned",
	"picked_up", "delivering", "delivered", "completed",
}

// chainActiveStatuses are the paid statuses still in flight (ActiveOrders):
// everything paid and beyond except the terminal completed.
var chainActiveStatuses = []string{
	"paid", "merchant_accepted", "preparing", "rider_assigned",
	"picked_up", "delivering", "delivered",
}

// chainIntPtr is the chain context's local pointer helper (kept separate so
// this file never depends on sibling contexts).
func chainIntPtr(v int) *int {
	return &v
}

// GetChainDashboard returns the unified dashboard across the caller's chain
// stores (GET /chain/dashboard). A single GROUP BY query aggregates paid
// orders per merchant_id and LEFT JOINs chain_stores so stores without
// orders still appear with honest zeros; totals (store count as the stores
// array length, orders, revenue, active orders) are summed in Go from the
// same rows. LowStockAlerts is an honest 0 until the inventory milestone.
func (s *Server) GetChainDashboard(w http.ResponseWriter, r *http.Request) {
	ownerID, ok := s.merchantOwnerID(w, r)
	if !ok {
		return
	}
	rows, err := s.db.Pool().Query(r.Context(), `
		SELECT cs.id, cs.name, cs.active,
		       COALESCE(a.orders, 0),
		       COALESCE(a.active_orders, 0),
		       COALESCE(a.revenue, 0)
		FROM chain_stores cs
		LEFT JOIN (
			SELECT o.merchant_id,
			       count(*)                                   AS orders,
			       count(*) FILTER (WHERE o.status = ANY($3)) AS active_orders,
			       SUM(o.total_tzs)                           AS revenue
			FROM orders o
			WHERE o.merchant_id IN (SELECT merchant_id FROM chain_stores WHERE owner_user_id = $1)
			  AND o.status = ANY($2)
			GROUP BY o.merchant_id
		) a ON a.merchant_id = cs.merchant_id
		WHERE cs.owner_user_id = $1
		ORDER BY cs.name, cs.id`,
		ownerID, chainPaidStatuses, chainActiveStatuses)
	if err != nil {
		s.logger.Error("chain dashboard query failed", "owner", ownerID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer rows.Close()

	stores := make([]gen.ChainStorePerformance, 0, 8)
	totalOrders, totalActiveOrders, totalRevenue := 0, 0, int64(0)
	for rows.Next() {
		var (
			storeID      uuid.UUID
			name         string
			active       bool
			orders       int
			activeOrders int
			revenue      int64
		)
		if err := rows.Scan(&storeID, &name, &active, &orders, &activeOrders, &revenue); err != nil {
			s.logger.Error("scan chain dashboard row failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		totalOrders += orders
		totalActiveOrders += activeOrders
		totalRevenue += revenue
		stores = append(stores, chainPerformance(storeID, name, active, orders, revenue))
	}
	if err := rows.Err(); err != nil {
		s.logger.Error("iterate chain dashboard rows failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	writeJSON(w, http.StatusOK, gen.ChainDashboard{
		Date:   openapi_types.Date{Time: time.Now().UTC()},
		Stores: stores,
		Totals: &struct {
			ActiveOrders   *int `json:"activeOrders,omitempty"`
			LowStockAlerts *int `json:"lowStockAlerts,omitempty"`
			Orders         *int `json:"orders,omitempty"`
			RevenueTZS     *int `json:"revenueTZS,omitempty"`
		}{
			ActiveOrders:   chainIntPtr(totalActiveOrders),
			LowStockAlerts: chainIntPtr(0),
			Orders:         chainIntPtr(totalOrders),
			RevenueTZS:     chainIntPtr(int(totalRevenue)),
		},
	})
}

// GetChainAnalytics returns the per-store comparison across the caller's
// chain stores (GET /chain/analytics), optionally restricted to the [from,
// to] day window (created_at based). The aggregate query groups paid orders
// by merchant_id and joins chain_stores so closed or order-less stores still
// appear with honest zeros.
func (s *Server) GetChainAnalytics(w http.ResponseWriter, r *http.Request, params gen.GetChainAnalyticsParams) {
	ownerID, ok := s.merchantOwnerID(w, r)
	if !ok {
		return
	}
	query := `
		SELECT cs.id, cs.name, cs.active,
		       COALESCE(a.orders, 0),
		       COALESCE(a.revenue, 0)
		FROM chain_stores cs
		LEFT JOIN (
			SELECT o.merchant_id, count(*) AS orders, SUM(o.total_tzs) AS revenue
			FROM orders o
			WHERE o.merchant_id IN (SELECT merchant_id FROM chain_stores WHERE owner_user_id = $1)
			  AND o.status = ANY($2)`
	args := []any{ownerID, chainPaidStatuses}
	if params.From != nil {
		args = append(args, params.From.Time)
		query += fmt.Sprintf(` AND o.created_at >= $%d`, len(args))
	}
	if params.To != nil {
		args = append(args, params.To.Time.Add(24*time.Hour))
		query += fmt.Sprintf(` AND o.created_at < $%d`, len(args))
	}
	query += `
			GROUP BY o.merchant_id
		) a ON a.merchant_id = cs.merchant_id
		WHERE cs.owner_user_id = $1
		ORDER BY cs.name, cs.id`

	rows, err := s.db.Pool().Query(r.Context(), query, args...)
	if err != nil {
		s.logger.Error("chain analytics query failed", "owner", ownerID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer rows.Close()

	out := make([]gen.ChainStorePerformance, 0, 8)
	for rows.Next() {
		var (
			storeID uuid.UUID
			name    string
			active  bool
			orders  int
			revenue int64
		)
		if err := rows.Scan(&storeID, &name, &active, &orders, &revenue); err != nil {
			s.logger.Error("scan chain analytics row failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		out = append(out, chainPerformance(storeID, name, active, orders, revenue))
	}
	if err := rows.Err(); err != nil {
		s.logger.Error("iterate chain analytics rows failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// ExportChainReport is the POST /chain/reports surface. Consolidated report
// export is a scheduled-reporting milestone, so every merchant call answers
// the NOT_IMPLEMENTED envelope.
func (s *Server) ExportChainReport(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.merchantOwnerID(w, r); !ok {
		return
	}
	writeError(w, http.StatusNotImplemented, "NOT_IMPLEMENTED", "Chain report export lands with the scheduled-reporting milestone")
}

// CreateBulkOperation enqueues a bulk operation across the caller's chain
// stores (POST /bulk-operations, contract 202 Accepted). kind must be one of
// the storage enum (inventory, price_change, promotion, closure) and payload
// a JSON object; the effective store id list (payload.storeIds wins, the
// top-level contract storeIds field otherwise) must be non-empty and parse
// as uuids — otherwise 422 BULK_OPERATION_INVALID. The row is inserted as
// pending (contract status queued); closure flags requiresApproval for the
// staff decide flow.
func (s *Server) CreateBulkOperation(w http.ResponseWriter, r *http.Request) {
	ownerID, ok := s.merchantOwnerID(w, r)
	if !ok {
		return
	}
	var raw struct {
		Type     *string              `json:"type"`
		Payload  json.RawMessage      `json:"payload"`
		StoreIds []openapi_types.UUID `json:"storeIds"`
	}
	if err := decodeJSON(r, &raw); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	kind := ""
	if raw.Type != nil {
		kind = strings.TrimSpace(*raw.Type)
	}
	if !validBulkKind(kind) {
		writeError(w, http.StatusUnprocessableEntity, "BULK_OPERATION_INVALID",
			"kind must be one of inventory, price_change, promotion, closure")
		return
	}
	payload := map[string]any{}
	if len(raw.Payload) > 0 {
		trimmed := bytes.TrimSpace(raw.Payload)
		if trimmed[0] != '{' {
			writeError(w, http.StatusUnprocessableEntity, "BULK_OPERATION_INVALID",
				"payload must be a JSON object")
			return
		}
		if err := json.Unmarshal(trimmed, &payload); err != nil {
			writeError(w, http.StatusUnprocessableEntity, "BULK_OPERATION_INVALID",
				"payload must be a JSON object")
			return
		}
	}
	storeIDs, ok := effectiveBulkStoreIDs(payload, raw.StoreIds)
	if !ok {
		writeError(w, http.StatusUnprocessableEntity, "BULK_OPERATION_INVALID",
			"storeIds must be a non-empty array of valid store ids")
		return
	}
	payload["storeIds"] = storeIDs
	payloadBytes, err := json.Marshal(payload)
	if err != nil {
		s.logger.Error("bulk operation payload marshal failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	var opID uuid.UUID
	var createdAt time.Time
	err = s.db.Pool().QueryRow(r.Context(),
		`INSERT INTO bulk_operations (owner_user_id, kind, status, payload, requested_by)
		 VALUES ($1, $2, 'pending', $3, $4)
		 RETURNING id, created_at`,
		ownerID, kind, payloadBytes, ownerID).Scan(&opID, &createdAt)
	if err != nil {
		s.logger.Error("bulk operation insert failed", "owner", ownerID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	requiresApproval := kind == "closure"
	ids := make([]openapi_types.UUID, 0, len(storeIDs))
	for _, id := range storeIDs {
		ids = append(ids, newUUID(id))
	}
	writeJSON(w, http.StatusAccepted, gen.BulkOperation{
		Id:               newUUID(opID.String()),
		Type:             gen.BulkOperationType(kind),
		Status:           bulkStatusToContract("pending"),
		StoreIds:         ids,
		Payload:          &payload,
		RequiresApproval: &requiresApproval,
		CreatedAt:        createdAt,
	})
}

// ListBulkOperations returns the caller's bulk operations newest first with
// (created_at, id) keyset pagination (GET /bulk-operations). The contract
// declares no query parameters, so limit and cursor ride the query string
// (default 20, max 100) and the next cursor the X-Next-Cursor header,
// mirroring AdminListMerchants.
func (s *Server) ListBulkOperations(w http.ResponseWriter, r *http.Request) {
	ownerID, ok := s.merchantOwnerID(w, r)
	if !ok {
		return
	}
	limit := defaultBulkListLimit
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			limit = n
			if limit > maxBulkListLimit {
				limit = maxBulkListLimit
			}
		}
	}
	afterCreated, afterID, err := merchants.ParseCursor(r.URL.Query().Get("cursor"))
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "cursor is invalid")
		return
	}
	query := `SELECT ` + bulkOperationColumns + `
		FROM bulk_operations
		WHERE owner_user_id = $1`
	args := []any{ownerID}
	if afterCreated != nil && afterID != nil {
		args = append(args, *afterCreated, *afterID)
		query += fmt.Sprintf(` AND (created_at, id) < ($%d, $%d)`, len(args)-1, len(args))
	}
	args = append(args, limit+1)
	query += ` ORDER BY created_at DESC, id DESC LIMIT $` + fmt.Sprintf("%d", len(args))

	rows, err := s.db.Pool().Query(r.Context(), query, args...)
	if err != nil {
		s.logger.Error("list bulk operations failed", "owner", ownerID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer rows.Close()

	ops := make([]gen.BulkOperation, 0, limit)
	var lastInPage bulkOperationRow
	for rows.Next() {
		var row bulkOperationRow
		if err := scanBulkOperation(rows, &row); err != nil {
			s.logger.Error("scan bulk operation row failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		ops = append(ops, toBulkOperation(row))
		if len(ops) <= limit {
			lastInPage = row
		}
	}
	if err := rows.Err(); err != nil {
		s.logger.Error("iterate bulk operation rows failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	next := ""
	if len(ops) > limit {
		ops = ops[:limit]
		next = merchants.EncodeCursor(lastInPage.createdAt, lastInPage.id)
	}
	if next != "" {
		w.Header().Set("X-Next-Cursor", next)
	}
	writeJSON(w, http.StatusOK, ops)
}

// GetBulkOperation returns one bulk operation to its owner or to staff (GET
// /bulk-operations/{bulkOperationId}); a missing row — or someone else's row
// for a non-staff caller — answers 404.
func (s *Server) GetBulkOperation(w http.ResponseWriter, r *http.Request, bulkOperationId openapi_types.UUID) {
	claims, ok := ClaimsFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing or invalid bearer token")
		return
	}
	if s.db == nil {
		s.logger.Error("get bulk operation failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	query := `SELECT ` + bulkOperationColumns + ` FROM bulk_operations WHERE id = $1`
	args := []any{bulkOperationId}
	if !isStaffRole(claims.Role) {
		ownerID, ok := s.merchantOwnerID(w, r)
		if !ok {
			return
		}
		args = append(args, ownerID)
		query += ` AND owner_user_id = $2`
	}
	var row bulkOperationRow
	if err := scanBulkOperation(s.db.Pool().QueryRow(r.Context(), query, args...), &row); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(w, http.StatusNotFound, "NOT_FOUND", "Bulk operation not found")
			return
		}
		s.logger.Error("get bulk operation failed", "operation", bulkOperationId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, toBulkOperation(row))
}

const bulkOperationColumns = `id, kind, status, payload, reason, applied_count, created_at, updated_at`

// bulkOperationRow mirrors one bulk_operations row; reason and applied_count
// are kept for the staff decide surface (see the file comment) even though
// the current contract exposes neither.
type bulkOperationRow struct {
	id           uuid.UUID
	kind         string
	status       string
	payload      []byte
	reason       *string
	appliedCount int
	createdAt    time.Time
	updatedAt    time.Time
}

// scanBulkOperation scans a bulk_operations row from any pgx row source.
func scanBulkOperation(row pgx.Row, dst *bulkOperationRow) error {
	return row.Scan(&dst.id, &dst.kind, &dst.status, &dst.payload, &dst.reason,
		&dst.appliedCount, &dst.createdAt, &dst.updatedAt)
}

// toBulkOperation maps a bulk_operations row onto the contract
// BulkOperation: the storage payload is echoed with storeIds normalized onto
// the contract's required StoreIds field, the status maps per the file
// comment, and closure marks requiresApproval.
func toBulkOperation(row bulkOperationRow) gen.BulkOperation {
	payload := map[string]any{}
	if len(row.payload) > 0 {
		if err := json.Unmarshal(row.payload, &payload); err != nil {
			payload = map[string]any{}
		}
	}
	storeIDs := make([]openapi_types.UUID, 0, 8)
	if raw, ok := payload["storeIds"].([]any); ok {
		for _, item := range raw {
			s, ok := item.(string)
			if !ok {
				continue
			}
			if id, err := uuid.Parse(s); err == nil {
				storeIDs = append(storeIDs, newUUID(id.String()))
			}
		}
	}
	requiresApproval := row.kind == "closure"
	return gen.BulkOperation{
		Id:               newUUID(row.id.String()),
		Type:             gen.BulkOperationType(row.kind),
		Status:           bulkStatusToContract(row.status),
		StoreIds:         storeIDs,
		Payload:          &payload,
		RequiresApproval: &requiresApproval,
		CreatedAt:        row.createdAt,
	}
}

// validBulkKind reports whether kind is a member of the storage enum (the
// migration CHECK constraint is authoritative for this milestone; the
// generated BulkOperationType enum differs and is not used here).
func validBulkKind(kind string) bool {
	switch kind {
	case "inventory", "price_change", "promotion", "closure":
		return true
	default:
		return false
	}
}

// effectiveBulkStoreIDs resolves the store id list for a bulk operation:
// payload.storeIds wins (closure carries it there), otherwise the top-level
// contract storeIds field. Every id must parse as a uuid and the list must
// be non-empty.
func effectiveBulkStoreIDs(payload map[string]any, topLevel []openapi_types.UUID) ([]string, bool) {
	if raw, ok := payload["storeIds"]; ok {
		list, ok := raw.([]any)
		if !ok {
			return nil, false
		}
		ids := make([]string, 0, len(list))
		for _, item := range list {
			s, ok := item.(string)
			if !ok {
				return nil, false
			}
			if _, err := uuid.Parse(s); err != nil {
				return nil, false
			}
			ids = append(ids, s)
		}
		if len(ids) == 0 {
			return nil, false
		}
		return ids, true
	}
	if len(topLevel) == 0 {
		return nil, false
	}
	ids := make([]string, 0, len(topLevel))
	for _, id := range topLevel {
		ids = append(ids, id.String())
	}
	return ids, true
}

// bulkStatusToContract maps the storage status enum onto the contract
// BulkOperationStatus enum (see the file comment).
func bulkStatusToContract(status string) gen.BulkOperationStatus {
	switch status {
	case "pending":
		return gen.BulkOperationStatusQueued
	case "approved":
		return gen.BulkOperationStatusProcessing
	case "applied":
		return gen.BulkOperationStatusCompleted
	default: // rejected, failed
		return gen.BulkOperationStatusFailed
	}
}

// chainPerformance maps one aggregate row onto the contract performance
// shape; every schema field is filled, with honest zeros where this
// milestone has no source yet (rating, conversionRate, lowStockCount).
func chainPerformance(storeID uuid.UUID, name string, active bool, orders int, revenue int64) gen.ChainStorePerformance {
	o := orders
	r := int(revenue)
	a := active
	zeroInt := chainIntPtr(0)
	zeroFloat := float32(0)
	return gen.ChainStorePerformance{
		StoreId:        newUUID(storeID.String()),
		BusinessName:   name,
		IsOpen:         &a,
		OrderCount:     &o,
		RevenueTZS:     &r,
		Rating:         &zeroFloat,
		ConversionRate: &zeroFloat,
		LowStockCount:  zeroInt,
	}
}
