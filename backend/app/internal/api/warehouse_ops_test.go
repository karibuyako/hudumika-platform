package api

// WAREHOUSE OPS handler unit tests (no database): the stock-adjust and
// fulfill endpoints under /warehouses/{warehouseId}/ are bearer-protected
// (401 UNAUTHORIZED without a token) and an authenticated session with no
// database wired surfaces the 500 INTERNAL_ERROR envelope before any state
// is touched. The registry endpoints (GET/POST /warehouses,
// GET/PATCH /warehouses/{warehouseId}) are covered by the logistics-extra
// suite.

import (
	"net/http"
	"testing"
)

const warehouseOpsUUID = "33333333-3333-4333-8333-333333333333"

func TestWarehouseOpsAdjustStockRequiresToken(t *testing.T) {
	logisticsExtra401(t, http.MethodPut, "/warehouses/"+warehouseOpsUUID+"/stock",
		`{"items":[{"catalogueItemId":"`+warehouseOpsUUID+`","delta":5}]}`)
}

func TestWarehouseOpsFulfillRequiresToken(t *testing.T) {
	logisticsExtra401(t, http.MethodPost, "/warehouses/"+warehouseOpsUUID+"/fulfill",
		`{"orderId":"`+warehouseOpsUUID+`"}`)
}

func TestWarehouseOpsAdjustStockWithoutDB(t *testing.T) {
	logisticsExtra500(t, http.MethodPut, "/warehouses/"+warehouseOpsUUID+"/stock",
		`{"items":[{"catalogueItemId":"`+warehouseOpsUUID+`","delta":5}]}`)
}

func TestWarehouseOpsFulfillWithoutDB(t *testing.T) {
	logisticsExtra500(t, http.MethodPost, "/warehouses/"+warehouseOpsUUID+"/fulfill",
		`{"orderId":"`+warehouseOpsUUID+`"}`)
}
