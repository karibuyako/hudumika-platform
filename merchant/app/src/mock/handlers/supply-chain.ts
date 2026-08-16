import { http } from 'msw';
import type {
  CancelPurchaseOrderBody,
  CreateSupplierReturnBody,
  InventoryAdjustment,
  InventoryAlert,
  InventoryAlertLevel,
  InventoryItem,
  InventorySyncChannel,
  InventorySyncConfig,
  InventorySyncConfigInput,
  InventoryMasterSource,
  NotificationDto,
  OrderDto,
  PurchaseOrder,
  PurchaseOrderInput,
  PurchaseOrderStatus,
  ReceivePurchaseOrderBody,
  Supplier,
  SupplierInput,
  SupplierReturn,
  SupplierReturnDetail,
  Warehouse,
  WarehouseInput,
} from '@/api/types';
import { db, uid } from '@/mock/db';
import { emit } from '@/mock/events';
import { ApiHttpError, json, ok, requirePerm, requireSession } from '@/mock/security';
import { h, readJson } from '@/mock/handlers/common';

const BASE = typeof location !== 'undefined' ? location.origin : 'http://localhost';

/** Rows are merchant-scoped server-side; responses strip the scope key.
 * Inventory items are keyed by catalogueItemId; the row id mirrors it so the
 * table store can satisfy its Entity constraint. */
type InventoryItemRow = InventoryItem & { id: string; merchantId: string };
type SupplierRow = Supplier & { merchantId: string };
type PurchaseOrderRow = PurchaseOrder & { merchantId: string };
/** Supplier-return rows also keep the submitted items+reason (append-only). */
type SupplierReturnRow = SupplierReturn & {
  merchantId: string;
  supplierId: string;
  items: { catalogueItemId: string; quantity: number }[];
  reason: string;
  processedAt?: number | null;
  rejectedAt?: number | null;
  rejectionReason?: string | null;
};
type WarehouseRow = Warehouse & { merchantId: string };

/** Raw JSON body — the shared `ok()` spreads objects, so array responses go through here. */
const raw = (body: unknown, status = 200) => Response.json(body, { status });

/** 204 — no body allowed. */
const noContent = () => new Response(null, { status: 204 });

/** PUT/DELETE wrappers — same error filter as the shared `h` helpers in handlers/common.ts. */
function put(
  path: string,
  fn: (args: { request: Request; params: Record<string, string> }) => Promise<Response> | Response,
) {
  return http.put(`${BASE}${path}`, async (info) => {
    try {
      return await fn({ request: info.request, params: (info.params ?? {}) as Record<string, string> });
    } catch (e) {
      if (e instanceof ApiHttpError) {
        return json(e.status, { error: { code: e.code, message: e.message, retriable: e.retriable, details: e.details } });
      }
      throw e;
    }
  });
}

function del(
  path: string,
  fn: (args: { request: Request; params: Record<string, string> }) => Promise<Response> | Response,
) {
  return http.delete(`${BASE}${path}`, async (info) => {
    try {
      return await fn({ request: info.request, params: (info.params ?? {}) as Record<string, string> });
    } catch (e) {
      if (e instanceof ApiHttpError) {
        return json(e.status, { error: { code: e.code, message: e.message, retriable: e.retriable, details: e.details } });
      }
      throw e;
    }
  });
}

const MASTER_SOURCES: readonly InventoryMasterSource[] = ['platform', 'pos', 'erp'];
const SYNC_CHANNELS: readonly InventorySyncChannel[] = ['platform_orders', 'dine_in', 'pos', 'delivery_partners', 'mini_program'];
const SUPPLIER_STATUSES = ['active', 'suspended'] as const;
const WAREHOUSE_STATUSES = ['active', 'full', 'maintenance'] as const;

const fmt = (n: number) => `${n.toLocaleString('en-US')}`;

/** Responses must never leak the merchant scope field. */
function strip<T extends { merchantId: string }>(row: T): Omit<T, 'merchantId'> {
  const { merchantId: _m, ...rest } = row;
  return rest;
}

function inventoryRows(merchantId: string): InventoryItemRow[] {
  return db.table<InventoryItemRow>('inventoryItems').where((r) => r.merchantId === merchantId);
}

function requireInventoryRow(merchantId: string, catalogueItemId: string, storeId?: string | null): InventoryItemRow {
  const rows = inventoryRows(merchantId);
  const row = storeId
    ? rows.find((r) => r.catalogueItemId === catalogueItemId && r.storeId === storeId)
    : rows.find((r) => r.catalogueItemId === catalogueItemId);
  if (!row) throw new ApiHttpError(404, 'INVENTORY_ITEM_NOT_FOUND', 'Inventory item not found');
  return row;
}

/** Row key = catalogueItemId (see InventoryItemRow). */
function inventoryRowId(catalogueItemId: string): string {
  return catalogueItemId;
}

/** Guards per doc/INVENTORY-SUPPLY-CHAIN.md: only the platform master owns stock
 * truth until the M9a/M9b connector model ships — pos/erp masters are staged. */
function assertSyncAllowsManualAdjust(merchantId: string) {
  const cfg = syncConfigOf(merchantId);
  if (cfg.enabled && cfg.masterSource !== 'platform') {
    throw new ApiHttpError(409, 'INVENTORY_SYNC_DISABLED', 'Stock is mastered by an external system — manual adjustments are disabled');
  }
}

function syncConfigOf(merchantId: string): InventorySyncConfig {
  const rows = db.table<InventorySyncConfig & { id: string; merchantId: string }>('inventorySyncConfigs').where((r) => r.merchantId === merchantId);
  return rows[0] ?? { enabled: false, masterSource: 'platform', channels: [], lastSyncedAt: null };
}

function putSyncConfig(merchantId: string, cfg: InventorySyncConfig): InventorySyncConfig {
  const table = db.table<InventorySyncConfig & { id: string; merchantId: string }>('inventorySyncConfigs');
  const rows = table.where((r) => r.merchantId === merchantId);
  const next = { ...cfg, lastSyncedAt: cfg.enabled ? Date.now() : null };
  if (rows[0]) table.update(rows[0].id, next);
  else table.insert({ id: `sync_${merchantId}`, merchantId, ...next });
  return next;
}

function parseSyncConfigInput(body: Record<string, unknown>): InventorySyncConfigInput {
  if (typeof body.enabled !== 'boolean') {
    throw new ApiHttpError(422, 'VALIDATION_FAILED', 'enabled must be a boolean');
  }
  const masterSource = MASTER_SOURCES.find((m) => m === body.masterSource);
  if (!masterSource) throw new ApiHttpError(422, 'VALIDATION_FAILED', 'masterSource must be platform, pos or erp');
  const channels = Array.isArray(body.channels) ? body.channels : [];
  const bad = channels.find((c) => !SYNC_CHANNELS.includes(c as InventorySyncChannel));
  if (bad !== undefined) {
    throw new ApiHttpError(422, 'VALIDATION_FAILED', `invalid sync channel: ${String(bad)}`);
  }
  return { enabled: body.enabled, masterSource, channels: channels as InventorySyncChannel[] };
}

function listSupplierRows(merchantId: string): SupplierRow[] {
  return db.table<SupplierRow>('suppliers').where((r) => r.merchantId === merchantId).sort((a, b) => a.name.localeCompare(b.name));
}

function requireSupplierRow(merchantId: string, supplierId: string): SupplierRow {
  const s = db.table<SupplierRow>('suppliers').find(supplierId);
  if (!s || s.merchantId !== merchantId) throw new ApiHttpError(404, 'SUPPLIER_NOT_FOUND', 'Supplier not found');
  return s;
}

function parseSupplierInput(body: Record<string, unknown>): SupplierInput {
  const name = String(body.name ?? '').trim();
  if (!name) throw new ApiHttpError(422, 'VALIDATION_FAILED', 'name is required');
  if (name.length > 160) throw new ApiHttpError(422, 'VALIDATION_FAILED', 'name must be 160 characters or fewer');
  const contactPhone = String(body.contactPhone ?? '').trim();
  if (!contactPhone) throw new ApiHttpError(422, 'VALIDATION_FAILED', 'contactPhone is required');
  const contactEmail = body.contactEmail === undefined || body.contactEmail === null ? undefined : String(body.contactEmail);
  const categories = Array.isArray(body.categories) ? body.categories.map((c) => String(c)) : undefined;
  const paymentTerms = body.paymentTerms === undefined || body.paymentTerms === null ? undefined : String(body.paymentTerms);
  if (paymentTerms && paymentTerms.length > 200) throw new ApiHttpError(422, 'VALIDATION_FAILED', 'paymentTerms must be 200 characters or fewer');
  return { name, contactPhone, contactEmail, categories, paymentTerms };
}

function requireUniqueSupplierPhone(merchantId: string, phone: string, exceptId?: string) {
  const clash = listSupplierRows(merchantId).find((s) => s.id !== exceptId && s.contactPhone === phone);
  if (clash) throw new ApiHttpError(409, 'SUPPLIER_EXISTS', 'A supplier with this contact phone already exists');
}

function requireSupplierActive(row: SupplierRow) {
  if (row.status === 'suspended') {
    throw new ApiHttpError(409, 'SUPPLIER_SUSPENDED', 'Supplier is suspended — new purchase orders are blocked');
  }
}

function listPurchaseOrderRows(merchantId: string, status?: string): PurchaseOrderRow[] {
  const rows = db.table<PurchaseOrderRow>('purchaseOrders').where((r) => r.merchantId === merchantId);
  const filtered = status && status !== 'all' ? rows.filter((r) => r.status === status) : rows;
  return filtered.sort((a, b) => b.createdAt - a.createdAt);
}

function requirePurchaseOrder(merchantId: string, purchaseOrderId: string): PurchaseOrderRow {
  const po = db.table<PurchaseOrderRow>('purchaseOrders').find(purchaseOrderId);
  if (!po || po.merchantId !== merchantId) throw new ApiHttpError(404, 'PURCHASE_ORDER_NOT_FOUND', 'Purchase order not found');
  return po;
}

function poStatusConflict(purchaseOrderId: string, from: PurchaseOrderStatus, to: string): never {
  throw new ApiHttpError(409, 'PURCHASE_ORDER_STATUS_CONFLICT', `Cannot move purchase order ${purchaseOrderId} from ${from} to ${to}`);
}

/** Total (draft) line cost — received quantities stay at the PO's ordered units. */
function poTotal(items: PurchaseOrder['items']): number {
  return items.reduce((sum, it) => sum + it.quantity * it.unitCostTZS, 0);
}

function buildPoItems(
  merchantId: string,
  input: { catalogueItemId: string; quantity: number }[],
  existing?: PurchaseOrderRow['items'],
): PurchaseOrderRow['items'] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new ApiHttpError(422, 'VALIDATION_FAILED', 'items must contain at least one line');
  }
  return input.map((rawItem) => {
    const item = rawItem as { catalogueItemId?: unknown; quantity?: unknown };
    const catalogueItemId = String(item.catalogueItemId ?? '');
    const quantity = Number(item.quantity);
    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw new ApiHttpError(422, 'VALIDATION_FAILED', 'quantity must be a positive integer');
    }
    const inv = requireInventoryRow(merchantId, catalogueItemId);
    const previous = existing?.find((e) => e.catalogueItemId === catalogueItemId);
    return {
      catalogueItemId,
      name: inv.name,
      quantity,
      receivedQuantity: previous?.receivedQuantity ?? 0,
      unitCostTZS: previous?.unitCostTZS ?? inv.unitCostTZS ?? 0,
    };
  });
}

/** Record a stock_in adjustment (PO receive side effect) — stock increases server-side. */
function applyStockIn(merchantId: string, actorId: string, actorRole: string, line: { catalogueItemId: string; quantity: number; unitCostTZS: number }) {
  const row = requireInventoryRow(merchantId, line.catalogueItemId);
  const before = row.stockOnHand;
  db.table<InventoryItemRow>('inventoryItems').update(inventoryRowId(row.catalogueItemId), {
    stockOnHand: before + line.quantity,
    available: before + line.quantity - row.reserved,
    unitCostTZS: line.unitCostTZS,
    lastRestockedAt: Date.now(),
  });
  const adjustment: InventoryAdjustment = {
    id: uid('ia'),
    itemId: line.catalogueItemId,
    delta: line.quantity,
    reason: 'stock_in · purchase order receive',
    storeId: row.storeId ?? null,
    at: Date.now(),
    by: actorRole === 'system' ? 'system' : `${actorId} (${actorRole})`,
  };
  db.table<InventoryAdjustment & { merchantId: string }>('inventoryAdjustments').insert({ ...adjustment, merchantId });
  return adjustment;
}

function listWarehouseRows(merchantId: string): WarehouseRow[] {
  return db.table<WarehouseRow>('warehouses').where((r) => r.merchantId === merchantId).sort((a, b) => a.name.localeCompare(b.name));
}

function requireWarehouse(merchantId: string, warehouseId: string): WarehouseRow {
  const w = db.table<WarehouseRow>('warehouses').find(warehouseId);
  if (!w || w.merchantId !== merchantId) throw new ApiHttpError(404, 'WAREHOUSE_NOT_FOUND', 'Warehouse not found');
  return w;
}

function parseWarehouseInput(body: Record<string, unknown>): WarehouseInput {
  const name = String(body.name ?? '').trim();
  if (!name) throw new ApiHttpError(422, 'VALIDATION_FAILED', 'name is required');
  if (name.length > 120) throw new ApiHttpError(422, 'VALIDATION_FAILED', 'name must be 120 characters or fewer');
  const cityId = String(body.cityId ?? '').trim();
  if (!cityId) throw new ApiHttpError(422, 'VALIDATION_FAILED', 'cityId is required');
  const address = body.address === undefined || body.address === null ? undefined : String(body.address);
  if (address && address.length > 300) throw new ApiHttpError(422, 'VALIDATION_FAILED', 'address must be 300 characters or fewer');
  const lat = body.lat === undefined || body.lat === null ? null : Number(body.lat);
  const lon = body.lon === undefined || body.lon === null ? null : Number(body.lon);
  if ((lat !== null && !Number.isFinite(lat)) || (lon !== null && !Number.isFinite(lon))) {
    throw new ApiHttpError(422, 'VALIDATION_FAILED', 'lat/lon must be numeric');
  }
  const servingCities = Array.isArray(body.servingCities) ? body.servingCities.map((c) => String(c)) : [];
  const status = body.status === undefined ? 'active' : WAREHOUSE_STATUSES.find((s) => s === body.status);
  if (body.status !== undefined && !status) throw new ApiHttpError(422, 'VALIDATION_FAILED', 'status must be active, full or maintenance');
  return { name, cityId, address, lat, lon, servingCities, status };
}

function warehouseTotalUnits(w: WarehouseRow): number {
  return w.stock.reduce((sum, s) => sum + s.quantity, 0);
}

/* ---- P8d additions: notification rows + threshold-crossing events
 * (ISC L33, L81, L179-187; the mock inserts NotificationDto rows directly,
 * matching the established event→notification pattern in staff-ops/refunds). */

function notify(merchantId: string, title: string, body: string) {
  db.table<NotificationDto>('notifications').insert({
    id: uid('n'),
    merchantId,
    type: 'system',
    category: 'important',
    title,
    body,
    ts: Date.now(),
    read: false,
  });
}

/** Emit `inventory.low_stock` / `inventory.out_of_stock` + in-app notification
 *  when an adjustment/receipt pushes an item across its threshold. */
function stockLevelEvent(merchantId: string, row: InventoryItemRow, before: number) {
  const after = row.stockOnHand;
  if (after > before) return;
  const crossedLow = before > row.lowStockThreshold && after <= row.lowStockThreshold;
  const hitZero = after === 0 && before > 0;
  if (crossedLow || hitZero) {
    const out = hitZero || after === 0;
    /* P8d event types are appended to types.ts only (shared with parallel
     * agents); they cross the bus via the common base event type. */
    emit({ type: out ? 'inventory.out_of_stock' : 'inventory.low_stock', item: strip(row), at: Date.now() } as never);
    notify(
      merchantId,
      out ? `Out of stock · ${row.name}` : `Low stock · ${row.name}`,
      `${row.name} is ${out ? 'out of stock' : `down to ${after} (threshold ${row.lowStockThreshold})`} — reorder to keep service levels.`,
    );
  }
}

/** Warehouse serving threshold for `warehouse.stock_low` — mirrors the
 *  catalogue item's lowStockThreshold (default 10) per ISC L179. */
function warehouseThresholdOf(merchantId: string, catalogueItemId: string): number {
  const row = db
    .table<InventoryItemRow>('inventoryItems')
    .where((r) => r.merchantId === merchantId && r.catalogueItemId === catalogueItemId)[0];
  return row?.lowStockThreshold ?? 10;
}

function warehouseLowRows(w: WarehouseRow): { catalogueItemId: string; quantity: number; threshold: number }[] {
  return w.stock
    .map((s) => ({ catalogueItemId: s.catalogueItemId, quantity: s.quantity, threshold: warehouseThresholdOf(w.merchantId, s.catalogueItemId) }))
    .filter((s) => s.quantity <= s.threshold);
}

/** Emit `warehouse.stock_low` + notification per item under its threshold. */
function warehouseStockLowAlerts(w: WarehouseRow) {
  for (const low of warehouseLowRows(w)) {
    emit({
      type: 'warehouse.stock_low',
      warehouseId: w.id,
      warehouseName: w.name,
      item: low,
      at: Date.now(),
    } as never);
    notify(
      w.merchantId,
      `Warehouse low stock · ${w.name}`,
      `${low.catalogueItemId} is running low at ${w.name} (${low.quantity} units) — reorder for the next-day promise.`,
    );
  }
}

function supplierReturnRows(merchantId: string): SupplierReturnRow[] {
  return db
    .table<SupplierReturnRow>('supplierReturns')
    .where((r) => r.merchantId === merchantId)
    .sort((a, b) => b.createdAt - a.createdAt);
}

function requireSupplierReturnRow(merchantId: string, returnId: string): SupplierReturnRow {
  const row = db.table<SupplierReturnRow>('supplierReturns').find(returnId);
  if (!row || row.merchantId !== merchantId) {
    throw new ApiHttpError(404, 'SUPPLIER_RETURN_NOT_FOUND', 'Supplier return not found');
  }
  return row;
}

function supplierReturnDetail(row: SupplierReturnRow): SupplierReturnDetail {
  const { merchantId: _m, ...rest } = row;
  return rest;
}

export const supplyChainHandlers = [
  /* ================= Inventory (contract /inventory*) ================= */

  h.get('/api/inventory/items', ({ request }) => {
    const session = requireSession(request);
    const url = new URL(request.url);
    const storeId = url.searchParams.get('storeId');
    const lowStockOnly = url.searchParams.get('lowStockOnly') === 'true';
    let rows = inventoryRows(session.merchantId);
    if (storeId) rows = rows.filter((r) => r.storeId === storeId);
    if (lowStockOnly) rows = rows.filter((r) => r.stockOnHand <= r.lowStockThreshold);
    return raw(rows.map(({ merchantId: _m, ...item }) => item));
  }),

  h.post('/api/inventory/items/:itemId/adjust', async ({ request, params }) => {
    const session = requireSession(request);
    const staff = requirePerm(session, 'store:manage');
    const catalogueItemId = String(params.itemId);
    const body = await readJson(request);
    const reason = String(body.reason ?? '').trim();
    if (!reason) {
      throw new ApiHttpError(422, 'INVENTORY_ADJUSTMENT_REASON_REQUIRED', 'A reason is required for stock adjustments');
    }
    if (reason.length > 500) throw new ApiHttpError(422, 'VALIDATION_FAILED', 'reason must be 500 characters or fewer');
    const delta = Number(body.delta);
    if (!Number.isInteger(delta) || delta === 0) {
      throw new ApiHttpError(422, 'VALIDATION_FAILED', 'delta must be a non-zero integer');
    }
    const storeId = body.storeId === undefined || body.storeId === null ? null : String(body.storeId);
    const row = requireInventoryRow(session.merchantId, catalogueItemId, storeId);
    assertSyncAllowsManualAdjust(session.merchantId);
    const next = row.stockOnHand + delta;
    if (next < 0) {
      throw new ApiHttpError(409, 'INVENTORY_NEGATIVE_STOCK', `Adjustment would take ${row.name} below zero — current stock is ${row.stockOnHand}`);
    }
    db.table<InventoryItemRow>('inventoryItems').update(inventoryRowId(row.catalogueItemId), { stockOnHand: next, available: next - row.reserved, lastRestockedAt: Date.now() });
    const adjustment: InventoryAdjustment = {
      id: uid('ia'),
      itemId: row.catalogueItemId,
      delta,
      reason,
      storeId,
      at: Date.now(),
      by: `${staff.id} (${staff.role})`,
    };
    db.table<InventoryAdjustment & { merchantId: string }>('inventoryAdjustments').insert({ ...adjustment, merchantId: session.merchantId });
    const updated = requireInventoryRow(session.merchantId, catalogueItemId, storeId);
    stockLevelEvent(session.merchantId, updated, row.stockOnHand);
    emit({ type: 'inventory.adjusted', item: updated, adjustment, at: Date.now() });
    return ok(strip(updated));
  }),

  h.get('/api/inventory/adjustments', ({ request }) => {
    const session = requireSession(request);
    const rows = db.table<InventoryAdjustment & { merchantId: string }>('inventoryAdjustments')
      .where((r) => r.merchantId === session.merchantId)
      .sort((a, b) => b.at - a.at);
    return raw(rows.map(({ merchantId: _m, ...a }) => a));
  }),

  h.get('/api/inventory/alerts', ({ request }) => {
    const session = requireSession(request);
    const alerts: InventoryAlert[] = inventoryRows(session.merchantId)
      .filter((r) => r.stockOnHand <= r.lowStockThreshold)
      .map((r) => {
        const level: InventoryAlertLevel = r.stockOnHand === 0 ? 'out_of_stock' : 'low';
        return {
          catalogueItemId: r.catalogueItemId,
          name: r.name,
          storeId: r.storeId ?? null,
          level,
          stockOnHand: r.stockOnHand,
          suggestedReorderQty: level === 'out_of_stock' ? Math.max(10, r.lowStockThreshold * 3) : r.lowStockThreshold * 2,
        };
      });
    return raw(alerts);
  }),

  h.get('/api/inventory/sync-config', ({ request }) => {
    const session = requireSession(request);
    return ok(syncConfigOf(session.merchantId));
  }),

  put('/api/inventory/sync-config', async ({ request }) => {
    const session = requireSession(request);
    requirePerm(session, 'store:manage');
    const body = await readJson(request);
    const input = parseSyncConfigInput(body);
    const next = putSyncConfig(session.merchantId, { ...input, lastSyncedAt: null });
    emit({ type: 'inventory.sync_updated', config: next, at: Date.now() });
    return ok(next);
  }),

  /* ================= Suppliers (contract /suppliers) ================= */

  h.get('/api/suppliers', ({ request }) => {
    const session = requireSession(request);
    return raw(listSupplierRows(session.merchantId).map(({ merchantId: _m, ...s }) => s));
  }),

  h.post('/api/suppliers', async ({ request }) => {
    const session = requireSession(request);
    requirePerm(session, 'store:manage');
    const body = await readJson(request);
    const input = parseSupplierInput(body);
    requireUniqueSupplierPhone(session.merchantId, input.contactPhone);
    const supplier: SupplierRow = { id: uid('sup'), merchantId: session.merchantId, ...input, status: 'active', createdAt: Date.now() };
    db.table<SupplierRow>('suppliers').insert(supplier);
    emit({ type: 'suppliers.created', supplier, at: Date.now() });
    return json(201, strip(supplier));
  }),

  h.patch('/api/suppliers/:supplierId', async ({ request, params }) => {
    const session = requireSession(request);
    requirePerm(session, 'store:manage');
    const supplier = requireSupplierRow(session.merchantId, String(params.supplierId));
    const body = await readJson(request);
    const input = parseSupplierInput(body);
    requireUniqueSupplierPhone(session.merchantId, input.contactPhone, supplier.id);
    const status = body.status === undefined ? supplier.status : SUPPLIER_STATUSES.find((s) => s === body.status);
    if (body.status !== undefined && !status) throw new ApiHttpError(422, 'VALIDATION_FAILED', 'status must be active or suspended');
    const updated = db.table<SupplierRow>('suppliers').update(supplier.id, { ...input, status: status ?? supplier.status })!;
    emit({ type: 'suppliers.updated', supplier: updated, at: Date.now() });
    return ok(strip(updated));
  }),

  del('/api/suppliers/:supplierId', ({ request, params }) => {
    const session = requireSession(request);
    requirePerm(session, 'store:manage');
    const supplier = requireSupplierRow(session.merchantId, String(params.supplierId));
    const updated = db.table<SupplierRow>('suppliers').update(supplier.id, { status: 'suspended' })!;
    emit({ type: 'suppliers.deactivated', supplierId: updated.id, at: Date.now() });
    return noContent();
  }),

  /* ================= Purchase orders (contract /purchase-orders) ================= */

  h.get('/api/purchase-orders', ({ request }) => {
    const session = requireSession(request);
    const url = new URL(request.url);
    const status = url.searchParams.get('status') ?? undefined;
    return raw(listPurchaseOrderRows(session.merchantId, status).map(({ merchantId: _m, ...po }) => po));
  }),

  h.get('/api/purchase-orders/:purchaseOrderId', ({ request, params }) => {
    const session = requireSession(request);
    const po = requirePurchaseOrder(session.merchantId, String(params.purchaseOrderId));
    return ok(strip(po));
  }),

  h.post('/api/purchase-orders', async ({ request }) => {
    const session = requireSession(request);
    requirePerm(session, 'store:manage');
    const body = (await readJson(request)) as unknown as PurchaseOrderInput;
    const supplier = requireSupplierRow(session.merchantId, String(body.supplierId ?? ''));
    requireSupplierActive(supplier);
    const items = buildPoItems(session.merchantId, Array.isArray(body.items) ? body.items : []);
    const note = body.note === undefined || body.note === null ? undefined : String(body.note);
    if (note && note.length > 500) throw new ApiHttpError(422, 'VALIDATION_FAILED', 'note must be 500 characters or fewer');
    const expectedArrivalAt = body.expectedArrivalAt === undefined || body.expectedArrivalAt === null ? null : Number(body.expectedArrivalAt);
    const po: PurchaseOrderRow = {
      id: uid('po'),
      merchantId: session.merchantId,
      supplierId: supplier.id,
      storeId: body.storeId ?? null,
      status: 'draft',
      items,
      expectedArrivalAt,
      totalCostTZS: poTotal(items),
      note,
      createdAt: Date.now(),
      receivedAt: null,
    };
    db.table<PurchaseOrderRow>('purchaseOrders').insert(po);
    emit({ type: 'purchase_orders.created', purchaseOrder: po, at: Date.now() });
    return json(201, strip(po));
  }),

  h.post('/api/purchase-orders/:purchaseOrderId/send', ({ request, params }) => {
    const session = requireSession(request);
    requirePerm(session, 'store:manage');
    const po = requirePurchaseOrder(session.merchantId, String(params.purchaseOrderId));
    if (po.status !== 'draft') poStatusConflict(po.id, po.status, 'sent');
    const updated = db.table<PurchaseOrderRow>('purchaseOrders').update(po.id, { status: 'sent' })!;
    emit({ type: 'purchase_orders.sent', purchaseOrder: updated, at: Date.now() });
    return ok(strip(updated));
  }),

  h.post('/api/purchase-orders/:purchaseOrderId/receive', async ({ request, params }) => {
    const session = requireSession(request);
    requirePerm(session, 'store:manage');
    const po = requirePurchaseOrder(session.merchantId, String(params.purchaseOrderId));
    if (po.status !== 'sent' && po.status !== 'partially_received') {
      poStatusConflict(po.id, po.status, 'received');
    }
    const body = (await readJson(request)) as unknown as ReceivePurchaseOrderBody;
    const lines = Array.isArray(body.items) ? body.items : [];
    if (lines.length === 0) throw new ApiHttpError(422, 'VALIDATION_FAILED', 'items must contain at least one line');
    const items = po.items.map((line) => ({ ...line }));
    const adjustments: InventoryAdjustment[] = [];
    for (const received of lines) {
      const line = received as { catalogueItemId?: unknown; quantity?: unknown };
      const catalogueItemId = String(line.catalogueItemId ?? '');
      const quantity = Number(line.quantity);
      if (!Number.isInteger(quantity) || quantity < 0) {
        throw new ApiHttpError(422, 'VALIDATION_FAILED', 'quantity must be a non-negative integer');
      }
      const match = items.find((it) => it.catalogueItemId === catalogueItemId);
      if (!match) throw new ApiHttpError(404, 'INVENTORY_ITEM_NOT_FOUND', `Line ${catalogueItemId} is not on this purchase order`);
      if (match.receivedQuantity + quantity > match.quantity) {
        throw new ApiHttpError(
          409,
          'PURCHASE_ORDER_RECEIPT_EXCEEDS_QTY',
          `Receipt of ${catalogueItemId} exceeds the ordered quantity (${match.quantity})`,
        );
      }
      match.receivedQuantity += quantity;
      if (quantity > 0) adjustments.push(applyStockIn(session.merchantId, session.staffId, session.role, { catalogueItemId, quantity, unitCostTZS: match.unitCostTZS }));
    }
    const allReceived = items.every((it) => it.receivedQuantity >= it.quantity);
    const anyReceived = items.some((it) => it.receivedQuantity > 0);
    const status: PurchaseOrderStatus = allReceived ? 'received' : anyReceived ? 'partially_received' : po.status;
    const updated = db.table<PurchaseOrderRow>('purchaseOrders').update(po.id, {
      items,
      status,
      totalCostTZS: poTotal(items),
      receivedAt: status === 'received' ? Date.now() : po.receivedAt,
    })!;
    emit({ type: 'purchase_orders.received', purchaseOrder: updated, at: Date.now() });
    /* ISC L81 — the merchant gets the `purchase_order.received` in-app
     * notification (contract event name is singular; the mock emits both). */
    emit({ type: 'purchase_order.received', purchaseOrder: updated, at: Date.now() } as never);
    notify(
      session.merchantId,
      `Purchase order received · ${updated.items.length} line(s)`,
      `Receipt recorded${status === 'received' ? ' in full' : ' (partial)'} — stock and COGS updated.`,
    );
    return ok(strip(updated));
  }),

  h.post('/api/purchase-orders/:purchaseOrderId/cancel', async ({ request, params }) => {
    const session = requireSession(request);
    requirePerm(session, 'store:manage');
    const po = requirePurchaseOrder(session.merchantId, String(params.purchaseOrderId));
    const body = (await readJson(request)) as unknown as CancelPurchaseOrderBody;
    const reason = String(body.reason ?? '').trim();
    if (!reason) throw new ApiHttpError(422, 'VALIDATION_FAILED', 'A cancellation reason is required');
    if (reason.length > 500) throw new ApiHttpError(422, 'VALIDATION_FAILED', 'reason must be 500 characters or fewer');
    if (po.status === 'received' || po.status === 'closed' || po.status === 'partially_received') {
      throw new ApiHttpError(409, 'PURCHASE_ORDER_CANCELLED', 'A purchase order with received stock cannot be cancelled');
    }
    if (po.status === 'cancelled') return ok(po); // idempotent replay
    const updated = db.table<PurchaseOrderRow>('purchaseOrders').update(po.id, { status: 'cancelled' })!;
    emit({ type: 'purchase_orders.cancelled', purchaseOrder: updated, at: Date.now() });
    return ok(strip(updated));
  }),

  /* ================= Supplier returns (contract /supplier-returns) ================= */

  h.post('/api/supplier-returns', async ({ request }) => {
    const session = requireSession(request);
    requirePerm(session, 'store:manage');
    const body = (await readJson(request)) as unknown as CreateSupplierReturnBody;
    const supplier = requireSupplierRow(session.merchantId, String(body.supplierId ?? ''));
    const items = Array.isArray(body.items) ? body.items : [];
    if (items.length === 0) throw new ApiHttpError(422, 'VALIDATION_FAILED', 'items must contain at least one line');
    for (const it of items) {
      const line = it as { catalogueItemId?: unknown; quantity?: unknown };
      const quantity = Number(line.quantity);
      if (!Number.isInteger(quantity) || quantity <= 0) {
        throw new ApiHttpError(422, 'VALIDATION_FAILED', 'quantity must be a positive integer');
      }
      requireInventoryRow(session.merchantId, String(line.catalogueItemId ?? ''));
    }
    const reason = String(body.reason ?? '').trim();
    if (!reason) throw new ApiHttpError(422, 'VALIDATION_FAILED', 'A return reason is required');
    if (reason.length > 500) throw new ApiHttpError(422, 'VALIDATION_FAILED', 'reason must be 500 characters or fewer');
    const supplierReturn: SupplierReturnRow = {
      id: uid('sr'),
      merchantId: session.merchantId,
      supplierId: supplier.id,
      items,
      reason,
      status: 'pending',
      createdAt: Date.now(),
    };
    db.table<SupplierReturnRow>('supplierReturns').insert(supplierReturn);
    emit({ type: 'supplier_returns.created', supplierReturn, at: Date.now() });
    return json(201, { id: supplierReturn.id, status: supplierReturn.status, createdAt: supplierReturn.createdAt });
  }),

  /* Returns list (mock extension — the merchant screen renders the pills from
   * the refreshed list; ISC L91). Detail shape = SupplierReturnDetail. */
  h.get('/api/supplier-returns', ({ request }) => {
    const session = requireSession(request);
    return raw(supplierReturnRows(session.merchantId).map(supplierReturnDetail));
  }),

  /* pending → processed: the supplier accepted the return; stock is reduced
   * server-side (ISC L92 — the client never pre-adjusts). */
  h.post('/api/supplier-returns/:returnId/process', ({ request, params }) => {
    const session = requireSession(request);
    requirePerm(session, 'store:manage');
    const row = requireSupplierReturnRow(session.merchantId, String(params.returnId));
    if (row.status !== 'pending') {
      throw new ApiHttpError(409, 'SUPPLIER_RETURN_STATUS_CONFLICT', `Return ${row.id} is already ${row.status}`);
    }
    for (const it of row.items) {
      const item = requireInventoryRow(session.merchantId, it.catalogueItemId);
      if (item.stockOnHand < it.quantity) {
        throw new ApiHttpError(
          409,
          'INVENTORY_NEGATIVE_STOCK',
          `Processing the return of ${it.catalogueItemId} would take stock below zero — current stock is ${item.stockOnHand}`,
        );
      }
    }
    for (const it of row.items) {
      const item = requireInventoryRow(session.merchantId, it.catalogueItemId);
      const next = item.stockOnHand - it.quantity;
      db.table<InventoryItemRow>('inventoryItems').update(inventoryRowId(item.catalogueItemId), { stockOnHand: next, available: next - item.reserved });
      const adjustment: InventoryAdjustment = {
        id: uid('ia'),
        itemId: it.catalogueItemId,
        delta: -it.quantity,
        reason: `supplier return · ${row.reason}`,
        storeId: null,
        at: Date.now(),
        by: `${session.staffId} (${session.role})`,
      };
      db.table<InventoryAdjustment & { merchantId: string }>('inventoryAdjustments').insert({ ...adjustment, merchantId: session.merchantId });
    }
    const updated = db.table<SupplierReturnRow>('supplierReturns').update(row.id, { status: 'processed', processedAt: Date.now() })!;
    const detail = supplierReturnDetail(updated);
    emit({ type: 'supplier_returns.processed', supplierReturn: detail, at: Date.now() } as never);
    notify(
      session.merchantId,
      'Supplier return processed',
      `Return ${row.id} was accepted — ${row.items.reduce((s, it) => s + it.quantity, 0)} unit(s) credited back to the supplier.`,
    );
    return ok(detail);
  }),

  /* pending → rejected with reason; stale refs surface SUPPLIER_RETURN_NOT_FOUND. */
  h.post('/api/supplier-returns/:returnId/reject', async ({ request, params }) => {
    const session = requireSession(request);
    requirePerm(session, 'store:manage');
    const row = requireSupplierReturnRow(session.merchantId, String(params.returnId));
    if (row.status !== 'pending') {
      throw new ApiHttpError(409, 'SUPPLIER_RETURN_STATUS_CONFLICT', `Return ${row.id} is already ${row.status}`);
    }
    const body = await readJson(request);
    const reason = String(body.reason ?? '').trim();
    if (!reason) throw new ApiHttpError(422, 'VALIDATION_FAILED', 'A rejection reason is required');
    if (reason.length > 500) throw new ApiHttpError(422, 'VALIDATION_FAILED', 'reason must be 500 characters or fewer');
    const updated = db.table<SupplierReturnRow>('supplierReturns').update(row.id, { status: 'rejected', rejectedAt: Date.now(), rejectionReason: reason })!;
    const detail = supplierReturnDetail(updated);
    emit({ type: 'supplier_returns.rejected', supplierReturn: detail, at: Date.now() } as never);
    notify(session.merchantId, 'Supplier return rejected', `Return ${row.id} was rejected: ${reason}`);
    return ok(detail);
  }),

  /* ================= Warehouses (contract /warehouses) ================= */

  h.get('/api/warehouses', ({ request }) => {
    const session = requireSession(request);
    const rows = listWarehouseRows(session.merchantId);
    return raw(rows.map((w) => {
      const { merchantId: _m, ...rest } = w;
      return { ...rest, totalUnits: warehouseTotalUnits(w) };
    }));
  }),

  h.get('/api/warehouses/:warehouseId', ({ request, params }) => {
    const session = requireSession(request);
    const w = requireWarehouse(session.merchantId, String(params.warehouseId));
    const { merchantId: _m, ...rest } = w;
    /* A6: totals are server-computed — the detail view carries the same
     * totalUnits the list carries (ISC L171-172, never client-summed). */
    return ok({ ...rest, totalUnits: warehouseTotalUnits(w) });
  }),

  h.post('/api/warehouses', async ({ request }) => {
    const session = requireSession(request);
    requirePerm(session, 'store:manage');
    const body = await readJson(request);
    const input = parseWarehouseInput(body);
    const warehouse: WarehouseRow = {
      id: uid('wh'),
      merchantId: session.merchantId,
      ...input,
      servingCities: input.servingCities ?? [],
      status: input.status ?? 'active',
      stock: [],
      createdAt: Date.now(),
    };
    db.table<WarehouseRow>('warehouses').insert(warehouse);
    emit({ type: 'warehouses.created', warehouse, at: Date.now() });
    return json(201, strip(warehouse));
  }),

  h.patch('/api/warehouses/:warehouseId', async ({ request, params }) => {
    const session = requireSession(request);
    requirePerm(session, 'store:manage');
    const warehouse = requireWarehouse(session.merchantId, String(params.warehouseId));
    const body = await readJson(request);
    const input = parseWarehouseInput(body);
    const updated = db.table<WarehouseRow>('warehouses').update(warehouse.id, input)!;
    emit({ type: 'warehouses.updated', warehouse: updated, at: Date.now() });
    return ok(strip(updated));
  }),

  put('/api/warehouses/:warehouseId/stock', async ({ request, params }) => {
    const session = requireSession(request);
    requirePerm(session, 'store:manage');
    const warehouse = requireWarehouse(session.merchantId, String(params.warehouseId));
    const idemKey = request.headers.get('idempotency-key');
    const body = await readJson(request);
    const rawLines = Array.isArray((body as { items?: unknown }).items) ? (body as { items: unknown[] }).items : [];
    if (rawLines.length === 0) throw new ApiHttpError(422, 'VALIDATION_FAILED', 'items must contain at least one line');
    const deltas: { catalogueItemId: string; delta: number }[] = [];
    for (const it of rawLines) {
      const line = it as { catalogueItemId?: unknown; delta?: unknown };
      const catalogueItemId = String(line.catalogueItemId ?? '');
      const delta = Number(line.delta);
      if (!Number.isInteger(delta) || delta === 0) {
        throw new ApiHttpError(422, 'VALIDATION_FAILED', 'delta must be a non-zero integer');
      }
      requireInventoryRow(session.merchantId, catalogueItemId);
      deltas.push({ catalogueItemId, delta });
    }
    /* ISC L154-156 — negative deltas (write-off / return) require a reason,
     * captured in the flow; the mock enforces it server-side too. */
    const hasNegative = deltas.some((d) => d.delta < 0);
    const reason = String(body.reason ?? '').trim();
    if (hasNegative && !reason) {
      throw new ApiHttpError(422, 'VALIDATION_FAILED', 'A reason is required when stock deltas are negative (write-off or return)');
    }
    if (reason.length > 500) throw new ApiHttpError(422, 'VALIDATION_FAILED', 'reason must be 500 characters or fewer');
    if (idemKey) {
      const hit = db.table<{ id: string; key: string; warehouseId: string }>('warehouseStockIdempotency').find(idemKey);
      if (hit && hit.warehouseId === warehouse.id) return ok(strip(warehouse));
    }
    const stock = warehouse.stock.map((s) => ({ ...s }));
    for (const d of deltas) {
      const row = stock.find((s) => s.catalogueItemId === d.catalogueItemId);
      const current = row?.quantity ?? 0;
      const next = current + d.delta;
      if (next < 0) {
        throw new ApiHttpError(
          409,
          'INVENTORY_NEGATIVE_STOCK',
          `Stock delta for ${d.catalogueItemId} would take quantity below zero — current quantity is ${fmt(current)}`,
        );
      }
      if (row) row.quantity = next;
      else stock.push({ catalogueItemId: d.catalogueItemId, quantity: next });
    }
    const updated = db.table<WarehouseRow>('warehouses').update(warehouse.id, { stock })!;
    if (idemKey) db.table<{ id: string; key: string; warehouseId: string }>('warehouseStockIdempotency').insert({ id: `whk_${idemKey}`, key: idemKey, warehouseId: warehouse.id });
    if (hasNegative) {
      db.table<{ id: string; merchantId: string; warehouseId: string; reason: string; items: { catalogueItemId: string; delta: number }[]; by: string; at: number }>('warehouseStockLogs').insert({
        id: uid('wsl'),
        merchantId: session.merchantId,
        warehouseId: warehouse.id,
        reason,
        items: deltas,
        by: `${session.staffId} (${session.role})`,
        at: Date.now(),
      });
    }
    emit({ type: 'warehouses.stock_updated', warehouse: strip(updated), at: Date.now() });
    /* ISC L179-187 — warehouse.stock_low alerts when an item sits under its
     * serving threshold after the inbound. */
    warehouseStockLowAlerts(updated);
    return ok(strip(updated));
  }),

  h.post('/api/warehouses/:warehouseId/fulfill', async ({ request, params }) => {
    const session = requireSession(request);
    requirePerm(session, 'store:manage');
    const warehouse = requireWarehouse(session.merchantId, String(params.warehouseId));
    const body = await readJson(request);
    const orderId = String(body.orderId ?? '');
    if (!orderId) throw new ApiHttpError(422, 'VALIDATION_FAILED', 'orderId is required');
    const order = db.table<OrderDto>('orders').find(orderId);
    if (!order || order.merchantId !== session.merchantId) throw new ApiHttpError(404, 'NOT_FOUND', 'Order not found');
    if (warehouse.status === 'maintenance' || warehouse.status === 'full') {
      throw new ApiHttpError(409, 'WAREHOUSE_OUT_OF_SERVICE', `Warehouse is ${warehouse.status} and cannot fulfill orders`);
    }
    const stock = warehouse.stock.map((s) => ({ ...s }));
    for (const it of order.items) {
      const row = stock.find((s) => s.catalogueItemId === it.productId);
      if (!row || row.quantity < it.qty) {
        throw new ApiHttpError(
          409,
          'WAREHOUSE_STOCK_UNAVAILABLE',
          `${it.name} is not available at ${warehouse.name} (needed ${it.qty}, in stock ${row?.quantity ?? 0})`,
        );
      }
    }
    for (const it of order.items) {
      const row = stock.find((s) => s.catalogueItemId === it.productId)!;
      row.quantity -= it.qty;
    }
    const updated = db.table<WarehouseRow>('warehouses').update(warehouse.id, { stock })!;
    emit({ type: 'warehouses.fulfilled', orderId: order.id, warehouseId: updated.id, at: Date.now() });
    return ok(order);
  }),
];
