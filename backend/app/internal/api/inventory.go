package api

import (
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/hudumika/api-backend/internal/auth"
	"github.com/hudumika/api-backend/internal/gen"
	"github.com/hudumika/api-backend/internal/inventory"
	openapi_types "github.com/oapi-codegen/runtime/types"
)

// INVENTORY & PROCUREMENT bounded context (backend/DATA-MODEL.md "Inventory
// and procurement"). Every surface is merchant-gated: the merchant id is the
// authenticated subject's users row id (see the catalogues package comment —
// the merchants bounded context does not exist yet).
//
// The contract exposes no create-item or resolve-alert endpoints in this
// milestone: items arrive via purchase-order receipts and adjustments, and
// the store methods behind them exist for the integration suite.

// Pagination bounds shared by the inventory listings.
const (
	defaultInventoryListLimit = 50
	maxInventoryListLimit     = 100
)

// inventoryMerchantID resolves the authenticated session to the inventory
// merchant id: only merchant-role sessions may pass (403 FORBIDDEN
// otherwise) and the id is the subject's users row id. A missing database
// surfaces the 500 envelope — the merchant identity cannot be resolved.
func (s *Server) inventoryMerchantID(w http.ResponseWriter, r *http.Request) (uuid.UUID, bool) {
	claims, ok := ClaimsFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing or invalid bearer token")
		return uuid.Nil, false
	}
	if claims.Role != RoleMerchant {
		writeError(w, http.StatusForbidden, "FORBIDDEN", "Only merchant sessions may manage inventory and procurement")
		return uuid.Nil, false
	}
	if s.db == nil {
		s.logger.Error("inventory merchant lookup failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return uuid.Nil, false
	}
	user, err := auth.NewRepo(s.db.Pool()).GetUserByPhone(r.Context(), claims.Subject)
	if err != nil {
		s.logger.Error("inventory merchant lookup failed", "subject", claims.Subject, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return uuid.Nil, false
	}
	if user == nil {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "No account for this session")
		return uuid.Nil, false
	}
	return user.ID, true
}

// inventoryLimit clamps the limit query parameter to the shared bounds.
func inventoryLimit(limit *int) int {
	out := defaultInventoryListLimit
	if limit != nil && *limit > 0 {
		out = *limit
		if out > maxInventoryListLimit {
			out = maxInventoryListLimit
		}
	}
	return out
}

// toGenInventoryItem maps an inventory row onto the contract InventoryItem.
// The item id doubles as catalogueItemId (the contract treats inventory and
// catalogue items as one namespace); reserved stock is always zero because
// the reservations table lands with the orders milestone.
func toGenInventoryItem(it inventory.Item) gen.InventoryItem {
	id := newUUID(it.ID.String())
	out := gen.InventoryItem{
		CatalogueItemId:   id,
		Name:              it.Name,
		StockOnHand:       it.Quantity,
		LowStockThreshold: it.LowStockThreshold,
	}
	available := it.Quantity
	reserved := 0
	out.Available = &available
	out.Reserved = &reserved
	unitCost := int(it.CostTZS)
	out.UnitCostTZS = &unitCost
	return out
}

// inventoryAdjustmentView mirrors the contract's inline adjustment object
// ({id, itemId, delta, reason, at, by}) — no generated type exists.
type inventoryAdjustmentView struct {
	Id     openapi_types.UUID `json:"id"`
	ItemId openapi_types.UUID `json:"itemId"`
	Delta  int                `json:"delta"`
	Reason string             `json:"reason"`
	At     time.Time          `json:"at"`
	By     string             `json:"by"`
}

// supplierReturnView mirrors the contract's inline create-return response
// ({id, status, createdAt}) — no generated type exists.
type supplierReturnView struct {
	Id        openapi_types.UUID                                `json:"id"`
	Status    gen.CreateSupplierReturn201JSONResponseBodyStatus `json:"status"`
	CreatedAt time.Time                                         `json:"createdAt"`
}

// ListInventoryItems returns the merchant's master inventory list (GET
// /inventory/items). The contract's storeId parameter targets chain stores;
// this milestone is single-store per merchant, so the filter is accepted and
// ignored. lowStockOnly filters to items at or below threshold.
func (s *Server) ListInventoryItems(w http.ResponseWriter, r *http.Request, params gen.ListInventoryItemsParams) {
	merchantID, ok := s.inventoryMerchantID(w, r)
	if !ok {
		return
	}
	lowStockOnly := false
	if params.LowStockOnly != nil {
		lowStockOnly = *params.LowStockOnly
	}
	cursor := ""
	if params.Cursor != nil {
		cursor = *params.Cursor
	}
	items, next, err := inventory.NewStore(s.db.Pool()).ListItems(r.Context(), merchantID, lowStockOnly, inventoryLimit(params.Limit), cursor)
	if errors.Is(err, inventory.ErrInvalidCursor) {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "cursor is invalid")
		return
	}
	if err != nil {
		s.logger.Error("list inventory items failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if next != "" {
		w.Header().Set("X-Next-Cursor", next)
	}
	out := make([]gen.InventoryItem, 0, len(items))
	for _, it := range items {
		out = append(out, toGenInventoryItem(it))
	}
	writeJSON(w, http.StatusOK, out)
}

// AdjustInventoryItem applies a signed stock delta with a mandatory reason
// (POST /inventory/items/{itemId}/adjust). A missing reason is 422
// INVENTORY_ADJUSTMENT_REASON_REQUIRED; a result below zero is 409
// INVENTORY_NEGATIVE_STOCK and nothing is written.
func (s *Server) AdjustInventoryItem(w http.ResponseWriter, r *http.Request, itemId openapi_types.UUID) {
	merchantID, ok := s.inventoryMerchantID(w, r)
	if !ok {
		return
	}
	var body gen.AdjustInventoryItemJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if strings.TrimSpace(body.Reason) == "" {
		writeError(w, http.StatusUnprocessableEntity, "INVENTORY_ADJUSTMENT_REASON_REQUIRED", "A reason is required for every stock adjustment")
		return
	}
	st := inventory.NewStore(s.db.Pool())
	if _, err := st.Adjust(r.Context(), merchantID, itemId, body.Delta, strings.TrimSpace(body.Reason)); err != nil {
		switch {
		case errors.Is(err, inventory.ErrNegativeStock):
			writeError(w, http.StatusConflict, "INVENTORY_NEGATIVE_STOCK", "Adjustment would drive stock below zero")
		case errors.Is(err, inventory.ErrItemNotFound):
			writeError(w, http.StatusNotFound, "INVENTORY_ITEM_NOT_FOUND", "Inventory item not found")
		default:
			s.logger.Error("adjust inventory item failed", "merchant", merchantID, "item", itemId, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		}
		return
	}
	it, err := st.GetItem(r.Context(), merchantID, itemId)
	if err != nil {
		s.logger.Error("reload inventory item failed", "merchant", merchantID, "item", itemId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, toGenInventoryItem(it))
}

// ListInventoryAdjustments returns the merchant's adjustment log (GET
// /inventory/adjustments). The by field carries the acting user id.
func (s *Server) ListInventoryAdjustments(w http.ResponseWriter, r *http.Request) {
	merchantID, ok := s.inventoryMerchantID(w, r)
	if !ok {
		return
	}
	adjustments, _, err := inventory.NewStore(s.db.Pool()).ListAdjustments(r.Context(), merchantID, maxInventoryListLimit, "")
	if err != nil {
		s.logger.Error("list inventory adjustments failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	out := make([]inventoryAdjustmentView, 0, len(adjustments))
	for _, a := range adjustments {
		out = append(out, inventoryAdjustmentView{
			Id:     newUUID(a.ID.String()),
			ItemId: newUUID(a.ItemID.String()),
			Delta:  a.Delta,
			Reason: a.Reason,
			At:     a.CreatedAt,
			By:     a.ByUserID.String(),
		})
	}
	writeJSON(w, http.StatusOK, out)
}

// ListInventoryAlerts returns the merchant's unresolved low-stock and
// out-of-stock alerts with the current stock level and a suggested reorder
// quantity (GET /inventory/alerts). Resolved alerts are not exposed.
func (s *Server) ListInventoryAlerts(w http.ResponseWriter, r *http.Request) {
	merchantID, ok := s.inventoryMerchantID(w, r)
	if !ok {
		return
	}
	alerts, _, err := inventory.NewStore(s.db.Pool()).ListAlerts(r.Context(), merchantID, maxInventoryListLimit, "")
	if err != nil {
		s.logger.Error("list inventory alerts failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	items := make(map[uuid.UUID]inventory.Item, len(alerts))
	for _, a := range alerts {
		it, err := inventory.NewStore(s.db.Pool()).GetItem(r.Context(), merchantID, a.ItemID)
		if err != nil {
			continue
		}
		items[a.ItemID] = it
	}
	out := make([]gen.InventoryAlert, 0, len(alerts))
	for _, a := range alerts {
		level := gen.InventoryAlertLevelLow
		if a.Type == "out_of_stock" {
			level = gen.InventoryAlertLevelOutOfStock
		}
		alert := gen.InventoryAlert{
			CatalogueItemId: newUUID(a.ItemID.String()),
			Level:           level,
			Name:            a.ItemID.String(),
		}
		if it, ok := items[a.ItemID]; ok {
			alert.Name = it.Name
			alert.StockOnHand = it.Quantity
			suggestion := it.LowStockThreshold - it.Quantity
			if suggestion < 1 {
				suggestion = 1
			}
			alert.SuggestedReorderQty = &suggestion
		}
		out = append(out, alert)
	}
	writeJSON(w, http.StatusOK, out)
}

// GetInventorySyncConfig returns the merchant's sync-config master record
// (GET /inventory/sync-config). A missing row honestly returns the default
// disabled config rather than a fabricated 404.
func (s *Server) GetInventorySyncConfig(w http.ResponseWriter, r *http.Request) {
	merchantID, ok := s.inventoryMerchantID(w, r)
	if !ok {
		return
	}
	cfg, err := inventory.NewStore(s.db.Pool()).GetSyncConfig(r.Context(), merchantID)
	if err != nil {
		s.logger.Error("get inventory sync config failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, toGenSyncConfig(cfg))
}

// PutInventorySyncConfig upserts the merchant's sync-config master record
// (PUT /inventory/sync-config).
func (s *Server) PutInventorySyncConfig(w http.ResponseWriter, r *http.Request) {
	merchantID, ok := s.inventoryMerchantID(w, r)
	if !ok {
		return
	}
	var body gen.PutInventorySyncConfigJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	enabled := false
	if body.Enabled != nil {
		enabled = *body.Enabled
	}
	provider := ""
	if body.MasterSource != nil {
		provider = string(*body.MasterSource)
	}
	cfg, err := inventory.NewStore(s.db.Pool()).UpsertSyncConfig(r.Context(), inventory.SyncConfig{
		MerchantID: merchantID,
		Enabled:    enabled,
		Provider:   provider,
	})
	if err != nil {
		s.logger.Error("put inventory sync config failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, toGenSyncConfig(cfg))
}

// toGenSyncConfig maps the sync-config row onto the contract shape; the
// master-source enum lands in provider and the last write surfaces as
// lastSyncedAt. The url/api key columns are not part of the contract schema.
func toGenSyncConfig(cfg inventory.SyncConfig) gen.InventorySyncConfig {
	out := gen.InventorySyncConfig{
		Enabled: &cfg.Enabled,
	}
	if cfg.Provider != "" {
		src := gen.InventorySyncConfigMasterSource(cfg.Provider)
		if src.Valid() {
			out.MasterSource = &src
		}
	}
	if !cfg.UpdatedAt.IsZero() {
		out.LastSyncedAt = &cfg.UpdatedAt
	}
	return out
}

// toGenSupplier maps a suppliers row onto the contract Supplier. Contact
// email, categories and payment terms are not stored in this milestone.
func toGenSupplier(sup inventory.Supplier) gen.Supplier {
	id := newUUID(sup.ID.String())
	status := gen.SupplierStatus(sup.Status)
	return gen.Supplier{
		Id:           &id,
		Name:         sup.Name,
		ContactPhone: sup.ContactPhone,
		Status:       &status,
		CreatedAt:    &sup.CreatedAt,
	}
}

// ListSuppliers returns the merchant's suppliers (GET /suppliers).
func (s *Server) ListSuppliers(w http.ResponseWriter, r *http.Request) {
	merchantID, ok := s.inventoryMerchantID(w, r)
	if !ok {
		return
	}
	suppliers, err := inventory.NewStore(s.db.Pool()).ListSuppliers(r.Context(), merchantID)
	if err != nil {
		s.logger.Error("list suppliers failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	out := make([]gen.Supplier, 0, len(suppliers))
	for _, sup := range suppliers {
		out = append(out, toGenSupplier(sup))
	}
	writeJSON(w, http.StatusOK, out)
}

// CreateSupplier adds a supplier (POST /suppliers, 201). name and
// contactPhone are required; status defaults to active.
func (s *Server) CreateSupplier(w http.ResponseWriter, r *http.Request) {
	merchantID, ok := s.inventoryMerchantID(w, r)
	if !ok {
		return
	}
	var body gen.CreateSupplierJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	body.Name = strings.TrimSpace(body.Name)
	if body.Name == "" || strings.TrimSpace(body.ContactPhone) == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "name and contactPhone are required")
		return
	}
	status := string(gen.SupplierStatusActive)
	if body.Status != nil {
		if *body.Status != gen.SupplierStatusActive && *body.Status != gen.SupplierStatusSuspended {
			writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "status must be active or suspended")
			return
		}
		status = string(*body.Status)
	}
	sup, err := inventory.NewStore(s.db.Pool()).CreateSupplier(r.Context(), merchantID, body.Name, strings.TrimSpace(body.ContactPhone), status)
	if err != nil {
		s.logger.Error("create supplier failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusCreated, toGenSupplier(sup))
}

// UpdateSupplier patches a supplier (PATCH /suppliers/{supplierId}); a
// missing or cross-merchant supplier is 404 SUPPLIER_NOT_FOUND.
func (s *Server) UpdateSupplier(w http.ResponseWriter, r *http.Request, supplierId openapi_types.UUID) {
	merchantID, ok := s.inventoryMerchantID(w, r)
	if !ok {
		return
	}
	var body gen.UpdateSupplierJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if strings.TrimSpace(body.Name) == "" || strings.TrimSpace(body.ContactPhone) == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "name and contactPhone are required")
		return
	}
	status := string(gen.SupplierStatusActive)
	if body.Status != nil {
		if *body.Status != gen.SupplierStatusActive && *body.Status != gen.SupplierStatusSuspended {
			writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "status must be active or suspended")
			return
		}
		status = string(*body.Status)
	}
	sup, err := inventory.NewStore(s.db.Pool()).UpdateSupplier(r.Context(), merchantID, supplierId,
		strings.TrimSpace(body.Name), strings.TrimSpace(body.ContactPhone), status)
	if errors.Is(err, inventory.ErrSupplierNotFound) {
		writeError(w, http.StatusNotFound, "SUPPLIER_NOT_FOUND", "Supplier not found")
		return
	}
	if err != nil {
		s.logger.Error("update supplier failed", "merchant", merchantID, "supplier", supplierId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, toGenSupplier(sup))
}

// DeleteSupplier deactivates a supplier (DELETE /suppliers/{supplierId},
// 204); a missing or cross-merchant supplier is 404 SUPPLIER_NOT_FOUND.
func (s *Server) DeleteSupplier(w http.ResponseWriter, r *http.Request, supplierId openapi_types.UUID) {
	merchantID, ok := s.inventoryMerchantID(w, r)
	if !ok {
		return
	}
	err := inventory.NewStore(s.db.Pool()).DeleteSupplier(r.Context(), merchantID, supplierId)
	if errors.Is(err, inventory.ErrSupplierNotFound) {
		writeError(w, http.StatusNotFound, "SUPPLIER_NOT_FOUND", "Supplier not found")
		return
	}
	if err != nil {
		s.logger.Error("delete supplier failed", "merchant", merchantID, "supplier", supplierId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func intPtr(v int64) *int {
	out := int(v)
	return &out
}

// toGenPurchaseOrder maps a purchase order onto the contract PurchaseOrder.
func toGenPurchaseOrder(po inventory.PurchaseOrder) gen.PurchaseOrder {
	status := gen.PurchaseOrderStatus(po.Status)
	out := gen.PurchaseOrder{
		Id:           newUUID(po.ID.String()),
		SupplierId:   newUUID(po.SupplierID.String()),
		Status:       status,
		CreatedAt:    po.CreatedAt,
		Note:         &po.Note,
		TotalCostTZS: intPtr(po.TotalTZS),
	}
	items := make([]struct {
		CatalogueItemId  openapi_types.UUID `json:"catalogueItemId"`
		Name             string             `json:"name"`
		Quantity         int                `json:"quantity"`
		ReceivedQuantity *int               `json:"receivedQuantity,omitempty"`
		UnitCostTZS      int                `json:"unitCostTZS"`
	}, 0, len(po.Items))
	for _, it := range po.Items {
		received := it.ReceivedQuantity
		items = append(items, struct {
			CatalogueItemId  openapi_types.UUID `json:"catalogueItemId"`
			Name             string             `json:"name"`
			Quantity         int                `json:"quantity"`
			ReceivedQuantity *int               `json:"receivedQuantity,omitempty"`
			UnitCostTZS      int                `json:"unitCostTZS"`
		}{
			CatalogueItemId:  newUUID(it.ItemID.String()),
			Name:             it.NameSnapshot,
			Quantity:         it.Quantity,
			ReceivedQuantity: &received,
			UnitCostTZS:      int(it.UnitCostTZS),
		})
	}
	out.Items = items
	return out
}

// ListPurchaseOrders returns the merchant's purchase orders, optionally
// filtered by status (GET /purchase-orders).
func (s *Server) ListPurchaseOrders(w http.ResponseWriter, r *http.Request, params gen.ListPurchaseOrdersParams) {
	merchantID, ok := s.inventoryMerchantID(w, r)
	if !ok {
		return
	}
	status := ""
	if params.Status != nil {
		status = string(*params.Status)
	}
	cursor := ""
	if params.Cursor != nil {
		cursor = *params.Cursor
	}
	pos, next, err := inventory.NewStore(s.db.Pool()).ListPOs(r.Context(), merchantID, status, inventoryLimit(params.Limit), cursor)
	if errors.Is(err, inventory.ErrInvalidCursor) {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "cursor is invalid")
		return
	}
	if err != nil {
		s.logger.Error("list purchase orders failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if next != "" {
		w.Header().Set("X-Next-Cursor", next)
	}
	out := make([]gen.PurchaseOrder, 0, len(pos))
	for _, po := range pos {
		out = append(out, toGenPurchaseOrder(po))
	}
	writeJSON(w, http.StatusOK, out)
}

// CreatePurchaseOrder creates a draft purchase order (POST /purchase-orders,
// 201). The body is the contract PurchaseOrder shape; items must carry a
// positive quantity, non-negative unit cost and reference items owned by the
// merchant. totalCostTZS is computed server-side.
func (s *Server) CreatePurchaseOrder(w http.ResponseWriter, r *http.Request) {
	merchantID, ok := s.inventoryMerchantID(w, r)
	if !ok {
		return
	}
	var body gen.CreatePurchaseOrderJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if len(body.Items) == 0 {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "at least one item is required")
		return
	}
	items := make([]inventory.POItemInput, 0, len(body.Items))
	for _, it := range body.Items {
		if it.Quantity < 1 || it.UnitCostTZS < 0 {
			writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "each item needs quantity >= 1 and unitCostTZS >= 0")
			return
		}
		items = append(items, inventory.POItemInput{
			ItemID:      it.CatalogueItemId,
			Quantity:    it.Quantity,
			UnitCostTZS: int64(it.UnitCostTZS),
		})
	}
	note := ""
	if body.Note != nil {
		note = *body.Note
	}
	st := inventory.NewStore(s.db.Pool())
	poID, err := st.CreatePO(r.Context(), merchantID, body.SupplierId, items, note)
	switch {
	case errors.Is(err, inventory.ErrSupplierSuspended):
		writeError(w, http.StatusConflict, "SUPPLIER_SUSPENDED", "Supplier is suspended and cannot receive purchase orders")
		return
	case errors.Is(err, inventory.ErrSupplierNotFound):
		writeError(w, http.StatusNotFound, "SUPPLIER_NOT_FOUND", "Supplier not found")
		return
	case errors.Is(err, inventory.ErrItemNotFound):
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "an item does not belong to this merchant")
		return
	case err != nil:
		s.logger.Error("create purchase order failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	po, err := st.GetPO(r.Context(), merchantID, poID)
	if err != nil {
		s.logger.Error("reload purchase order failed", "merchant", merchantID, "po", poID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusCreated, toGenPurchaseOrder(po))
}

// GetPurchaseOrder returns one purchase order (GET
// /purchase-orders/{purchaseOrderId}); missing or cross-merchant orders are
// 404 PURCHASE_ORDER_NOT_FOUND.
func (s *Server) GetPurchaseOrder(w http.ResponseWriter, r *http.Request, purchaseOrderId openapi_types.UUID) {
	merchantID, ok := s.inventoryMerchantID(w, r)
	if !ok {
		return
	}
	po, err := inventory.NewStore(s.db.Pool()).GetPO(r.Context(), merchantID, purchaseOrderId)
	if errors.Is(err, inventory.ErrPurchaseOrderNotFound) {
		writeError(w, http.StatusNotFound, "PURCHASE_ORDER_NOT_FOUND", "Purchase order not found")
		return
	}
	if err != nil {
		s.logger.Error("get purchase order failed", "merchant", merchantID, "po", purchaseOrderId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, toGenPurchaseOrder(po))
}

// SendPurchaseOrder moves a draft purchase order to sent (POST
// /purchase-orders/{purchaseOrderId}/send); any other state is 409
// PURCHASE_ORDER_STATUS_CONFLICT.
func (s *Server) SendPurchaseOrder(w http.ResponseWriter, r *http.Request, purchaseOrderId openapi_types.UUID) {
	merchantID, ok := s.inventoryMerchantID(w, r)
	if !ok {
		return
	}
	po, err := inventory.NewStore(s.db.Pool()).SendPO(r.Context(), merchantID, purchaseOrderId)
	switch {
	case errors.Is(err, inventory.ErrPurchaseOrderNotFound):
		writeError(w, http.StatusNotFound, "PURCHASE_ORDER_NOT_FOUND", "Purchase order not found")
		return
	case errors.Is(err, inventory.ErrStatusConflict):
		writeError(w, http.StatusConflict, "PURCHASE_ORDER_STATUS_CONFLICT", "Only draft purchase orders can be sent")
		return
	case err != nil:
		s.logger.Error("send purchase order failed", "merchant", merchantID, "po", purchaseOrderId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, toGenPurchaseOrder(po))
}

// ReceivePurchaseOrder records partial or full receipts (POST
// /purchase-orders/{purchaseOrderId}/receive): stock increases by the
// received quantities and the order advances sent -> partially_received ->
// received. Over-receipt is 409 PURCHASE_ORDER_RECEIPT_EXCEEDS_QTY;
// receiving on a cancelled order is 409 PURCHASE_ORDER_CANCELLED; receiving
// on a draft or fully-received order is 409 PURCHASE_ORDER_STATUS_CONFLICT.
func (s *Server) ReceivePurchaseOrder(w http.ResponseWriter, r *http.Request, purchaseOrderId openapi_types.UUID) {
	merchantID, ok := s.inventoryMerchantID(w, r)
	if !ok {
		return
	}
	var body gen.ReceivePurchaseOrderJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if len(body.Items) == 0 {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "at least one item is required")
		return
	}
	receipts := make([]inventory.POReceipt, 0, len(body.Items))
	for _, it := range body.Items {
		if it.Quantity < 1 {
			writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "each receipt needs quantity >= 1")
			return
		}
		receipts = append(receipts, inventory.POReceipt{ItemID: it.CatalogueItemId, Quantity: it.Quantity})
	}
	po, err := inventory.NewStore(s.db.Pool()).ReceivePO(r.Context(), merchantID, purchaseOrderId, receipts)
	switch {
	case errors.Is(err, inventory.ErrPurchaseOrderNotFound):
		writeError(w, http.StatusNotFound, "PURCHASE_ORDER_NOT_FOUND", "Purchase order not found")
		return
	case errors.Is(err, inventory.ErrReceiptExceedsQty):
		writeError(w, http.StatusConflict, "PURCHASE_ORDER_RECEIPT_EXCEEDS_QTY", "Receipt quantity exceeds the ordered quantity")
		return
	case errors.Is(err, inventory.ErrAlreadyCancelled):
		writeError(w, http.StatusConflict, "PURCHASE_ORDER_CANCELLED", "Purchase order was cancelled")
		return
	case errors.Is(err, inventory.ErrStatusConflict):
		writeError(w, http.StatusConflict, "PURCHASE_ORDER_STATUS_CONFLICT", "Only sent or partially received purchase orders accept receipts")
		return
	case errors.Is(err, inventory.ErrItemNotFound):
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "a receipt item is not on this purchase order")
		return
	case err != nil:
		s.logger.Error("receive purchase order failed", "merchant", merchantID, "po", purchaseOrderId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, toGenPurchaseOrder(po))
}

// CancelPurchaseOrder cancels a draft or sent purchase order (POST
// /purchase-orders/{purchaseOrderId}/cancel). An already-cancelled order is
// 409 PURCHASE_ORDER_CANCELLED; orders past sending cannot be cancelled
// (409 PURCHASE_ORDER_STATUS_CONFLICT).
func (s *Server) CancelPurchaseOrder(w http.ResponseWriter, r *http.Request, purchaseOrderId openapi_types.UUID) {
	merchantID, ok := s.inventoryMerchantID(w, r)
	if !ok {
		return
	}
	var body gen.CancelPurchaseOrderJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if strings.TrimSpace(body.Reason) == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "reason is required")
		return
	}
	po, err := inventory.NewStore(s.db.Pool()).CancelPO(r.Context(), merchantID, purchaseOrderId)
	switch {
	case errors.Is(err, inventory.ErrPurchaseOrderNotFound):
		writeError(w, http.StatusNotFound, "PURCHASE_ORDER_NOT_FOUND", "Purchase order not found")
		return
	case errors.Is(err, inventory.ErrAlreadyCancelled):
		writeError(w, http.StatusConflict, "PURCHASE_ORDER_CANCELLED", "Purchase order was already cancelled")
		return
	case errors.Is(err, inventory.ErrStatusConflict):
		writeError(w, http.StatusConflict, "PURCHASE_ORDER_STATUS_CONFLICT", "Purchase order can no longer be cancelled")
		return
	case err != nil:
		s.logger.Error("cancel purchase order failed", "merchant", merchantID, "po", purchaseOrderId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, toGenPurchaseOrder(po))
}

// CreateSupplierReturn records a supplier return request (POST
// /supplier-returns, 201). The contract body carries one or more items; one
// supplier_returns row is written per item and the response reports the
// first row's id. The stored status 'requested' is exposed as 'pending' per
// the contract enum.
func (s *Server) CreateSupplierReturn(w http.ResponseWriter, r *http.Request) {
	merchantID, ok := s.inventoryMerchantID(w, r)
	if !ok {
		return
	}
	var body gen.CreateSupplierReturnJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if strings.TrimSpace(body.Reason) == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "reason is required")
		return
	}
	if len(body.Items) == 0 {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "at least one item is required")
		return
	}
	for _, it := range body.Items {
		if it.Quantity < 1 {
			writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "each item needs quantity >= 1")
			return
		}
	}
	st := inventory.NewStore(s.db.Pool())
	var (
		firstID   uuid.UUID
		createdAt time.Time
	)
	for _, it := range body.Items {
		ret, err := st.CreateSupplierReturn(r.Context(), merchantID, body.SupplierId, it.CatalogueItemId, nil, it.Quantity, strings.TrimSpace(body.Reason))
		switch {
		case errors.Is(err, inventory.ErrSupplierNotFound):
			writeError(w, http.StatusNotFound, "SUPPLIER_NOT_FOUND", "Supplier not found")
			return
		case errors.Is(err, inventory.ErrItemNotFound):
			writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "an item does not belong to this merchant")
			return
		case err != nil:
			s.logger.Error("create supplier return failed", "merchant", merchantID, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		if firstID == uuid.Nil {
			firstID = ret.ID
			createdAt = ret.CreatedAt
		}
	}
	writeJSON(w, http.StatusCreated, supplierReturnView{
		Id:        newUUID(firstID.String()),
		Status:    gen.CreateSupplierReturn201JSONResponseBodyStatusPending,
		CreatedAt: createdAt,
	})
}
