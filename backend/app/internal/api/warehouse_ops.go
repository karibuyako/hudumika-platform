package api

// WAREHOUSE OPS bounded surface (API-CONTRACT.yaml
// /warehouses/{warehouseId}/stock and /warehouses/{warehouseId}/fulfill,
// ERROR-CODES.md "Logistics"): merchant bulk inbound / adjustment of
// pre-positioned stock and the regional-warehouse fulfill flow. The
// registry handlers (List/Create/Get/UpdateWarehouse) live in the
// logistics-extra surface; this file owns only the two stock endpoints.
//
// AdjustWarehouseStock applies a batch of signed deltas to a warehouse's
// stock lines (WAREHOUSE_NOT_FOUND 404, WAREHOUSE_OUT_OF_SERVICE 409,
// INVENTORY_NEGATIVE_STOCK 409) and answers 200 with the Warehouse plus its
// stock levels, per the contract.
//
// FulfillFromWarehouse ships an order from the warehouse
// (WAREHOUSE_NOT_FOUND 404, ORDER_NOT_FOUND 404, WAREHOUSE_OUT_OF_SERVICE
// 409, WAREHOUSE_STOCK_UNAVAILABLE 409, SHIPMENT_ALREADY_EXISTS 409) and
// answers 200 with the Order, per the contract.

import (
	"errors"
	"net/http"

	"github.com/google/uuid"

	"github.com/hudumika/api-backend/internal/gen"
	"github.com/hudumika/api-backend/internal/logistics"
	"github.com/hudumika/api-backend/internal/orders"
	openapi_types "github.com/oapi-codegen/runtime/types"
)

// warehouseStockResponseLimit caps the stock lines echoed on the adjust
// response (the stock surface of a warehouse is bounded in practice).
const warehouseStockResponseLimit = 1000

// AdjustWarehouseStock applies the batch of item deltas to the warehouse's
// stock (PUT /warehouses/{warehouseId}/stock). The batch is applied
// line-by-line inside per-line transactions: a failure on any line leaves
// the earlier lines applied (each line is an independent adjustment, like
// the inventory lane). The 200 body is the Warehouse with its stock levels.
func (s *Server) AdjustWarehouseStock(w http.ResponseWriter, r *http.Request, warehouseId openapi_types.UUID) {
	if !s.logisticsReady(w, r) {
		return
	}
	var body gen.AdjustWarehouseStockJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if len(body.Items) == 0 {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "items must contain at least one entry")
		return
	}
	st := logistics.NewWarehouseStore(s.db.Pool())
	ctx := r.Context()
	whID := uuid.UUID(warehouseId)
	for _, item := range body.Items {
		itemID := uuid.UUID(item.CatalogueItemId)
		if itemID == uuid.Nil {
			writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "catalogueItemId is required")
			return
		}
		if _, err := st.AdjustStock(ctx, whID, itemID, item.Delta); err != nil {
			switch {
			case errors.Is(err, logistics.ErrWarehouseNotFound):
				writeError(w, http.StatusNotFound, "WAREHOUSE_NOT_FOUND", "Warehouse not found")
				return
			case errors.Is(err, logistics.ErrWarehouseOutOfService):
				writeError(w, http.StatusConflict, "WAREHOUSE_OUT_OF_SERVICE", "Warehouse is out of service")
				return
			case errors.Is(err, logistics.ErrNegativeStock):
				writeError(w, http.StatusConflict, "INVENTORY_NEGATIVE_STOCK", "Adjustment would drive stock negative")
				return
			}
			s.logger.Error("adjust warehouse stock failed", "warehouse", warehouseId, "item", itemID, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
	}
	row, err := logistics.NewExtraStore(s.db.Pool()).GetWarehouse(ctx, whID)
	if err != nil {
		s.logger.Error("reload warehouse after stock adjust failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	stock, _, err := st.ListStock(ctx, whID, warehouseStockResponseLimit, "")
	if err != nil {
		s.logger.Error("list warehouse stock after adjust failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, warehouseWithStock(row, stock))
}

// FulfillFromWarehouse ships an order from the warehouse
// (POST /warehouses/{warehouseId}/fulfill): the order's items are reserved
// against the warehouse stock and a pending shipment is created. Answers 200
// with the Order.
func (s *Server) FulfillFromWarehouse(w http.ResponseWriter, r *http.Request, warehouseId openapi_types.UUID) {
	if !s.logisticsReady(w, r) {
		return
	}
	var body gen.FulfillFromWarehouseJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	orderID := uuid.UUID(body.OrderId)
	if orderID == uuid.Nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "orderId is required")
		return
	}
	err := logistics.NewWarehouseStore(s.db.Pool()).Fulfill(r.Context(), uuid.UUID(warehouseId), orderID)
	switch {
	case errors.Is(err, logistics.ErrWarehouseNotFound):
		writeError(w, http.StatusNotFound, "WAREHOUSE_NOT_FOUND", "Warehouse not found")
		return
	case errors.Is(err, logistics.ErrOrderNotFound):
		writeError(w, http.StatusNotFound, "ORDER_NOT_FOUND", "Order not found")
		return
	case errors.Is(err, logistics.ErrWarehouseOutOfService):
		writeError(w, http.StatusConflict, "WAREHOUSE_OUT_OF_SERVICE", "Warehouse is out of service")
		return
	case errors.Is(err, logistics.ErrStockUnavailable):
		writeError(w, http.StatusConflict, "WAREHOUSE_STOCK_UNAVAILABLE", "Insufficient stock at the warehouse to fulfill the order")
		return
	case errors.Is(err, logistics.ErrAlreadyExists):
		writeError(w, http.StatusConflict, "SHIPMENT_ALREADY_EXISTS", "Order already has a shipment")
		return
	case err != nil:
		s.logger.Error("fulfill from warehouse failed", "warehouse", warehouseId, "order", orderID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	row, err := orders.NewStore(s.db.Pool()).GetOrderRow(r.Context(), orderID)
	if err != nil {
		s.logger.Error("reload order after warehouse fulfill failed", "order", orderID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, toGenOrder(*row))
}

// warehouseWithStock maps a warehouse row and its stock lines onto the
// contract Warehouse (toGenWarehouse plus the stock array).
func warehouseWithStock(row logistics.WarehouseRow, stock []logistics.StockRow) gen.Warehouse {
	out := toGenWarehouse(row)
	if len(stock) > 0 {
		lines := make([]struct {
			CatalogueItemId openapi_types.UUID `json:"catalogueItemId"`
			Quantity        int                `json:"quantity"`
		}, 0, len(stock))
		for _, s := range stock {
			lines = append(lines, struct {
				CatalogueItemId openapi_types.UUID `json:"catalogueItemId"`
				Quantity        int                `json:"quantity"`
			}{
				CatalogueItemId: newUUID(s.CatalogueItemID.String()),
				Quantity:        s.Quantity,
			})
		}
		out.Stock = &lines
	}
	return out
}
