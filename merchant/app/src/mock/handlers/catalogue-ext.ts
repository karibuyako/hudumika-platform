import { http } from 'msw';
import type {
  BarcodeFormat,
  BarcodeHistoryEntry,
  BarcodeInfo,
  BarcodeLookup,
  BatchBarcodeResult,
  BulkOperation,
  CatalogueExtEvent,
  Combo,
  ComboLine,
  Menu,
  MenuSection,
  ProductRow,
  ProductVideo,
  ServerEvent,
} from '@/api/types';
import { db, uid } from '@/mock/db';
import { emit } from '@/mock/events';
import { audit, json, ok, requirePerm, requireSession } from '@/mock/security';
import { ApiHttpError, h, readJson } from '@/mock/handlers/common';
import type { Session } from '@/mock/types-internal';

/* The shared json() helper spreads bodies, which mangles top-level arrays —
 * contract responses that ARE arrays use Response.json directly. */
const okArray = (value: unknown[]) => Response.json(value);

/* h has no delete wrapper; register DELETE routes with the same wrap/json
 * error filter as h.get/post/patch. */
const BASE = typeof location !== 'undefined' ? location.origin : 'http://localhost';

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

const HTTP_RE = /^https?:\/\/\S+$/;

/* h has no put wrapper either; same wrap/json error filter. */
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

const FORMAT_CODES = new Set(['ean13', 'ean8', 'upca', 'code128', 'code39', 'qr']);

/* P8 event types are appended to types.ts only (shared with a parallel agent);
 * ServerEvent's union lives mid-file, so P8 events cross the bus via the
 * common base event type. */
function p8Emit(event: CatalogueExtEvent) {
  emit(event as unknown as ServerEvent);
}

function merchantStores(session: Session): { id: string; name: string; open: boolean; rating: number | null }[] {
  return db
    .table<{ merchantId: string; id: string; name: string; open?: boolean; rating?: number }>('stores')
    .where((s) => s.merchantId === session.merchantId)
    .map((s) => ({ id: s.id, name: s.name, open: s.open === true, rating: typeof s.rating === 'number' ? s.rating : null }));
}

function findProduct(session: Session, id: string): ProductRow {
  const p = db.table<ProductRow>('products').find(id);
  if (!p || p.merchantId !== session.merchantId) {
    throw new ApiHttpError(404, 'NOT_FOUND', 'Catalogue item not found');
  }
  return p;
}

function requireFormat(format: unknown): BarcodeInfo['format'] {
  const f = String(format ?? '');
  if (!FORMAT_CODES.has(f)) {
    throw new ApiHttpError(400, 'INVALID_BARCODE_FORMAT', 'format must be one of ean13, ean8, upca, code128, code39, qr');
  }
  return f as BarcodeInfo['format'];
}

function generateCode(format: BarcodeInfo['format'], itemId: string): string {
  if (format === 'qr') {
    return `HUD-${itemId.toUpperCase()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  }
  const digits = format === 'ean8' ? 8 : format === 'upca' ? 12 : 13;
  let code = '';
  for (let i = 0; i < digits; i++) code += Math.floor(Math.random() * 10);
  return code;
}

function parseComboItems(session: Session, value: unknown): ComboLine[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new ApiHttpError(400, 'INVALID_COMBO_ITEMS', 'items must be an array');
  const seen = new Set<string>();
  return value.map((x, i) => {
    const row = (x ?? {}) as { catalogueItemId?: unknown; quantity?: unknown };
    const catalogueItemId = String(row.catalogueItemId ?? '');
    if (!catalogueItemId || seen.has(catalogueItemId)) {
      throw new ApiHttpError(400, 'INVALID_COMBO_ITEMS', `combo item ${i} must reference a distinct catalogue item`);
    }
    findProduct(session, catalogueItemId);
    const quantity = Number(row.quantity);
    if (!Number.isInteger(quantity) || quantity < 1) {
      throw new ApiHttpError(400, 'INVALID_COMBO_ITEMS', `combo item ${i} quantity must be an integer >= 1`);
    }
    seen.add(catalogueItemId);
    return { catalogueItemId, quantity };
  });
}

function parseIntTZS(value: unknown, label: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new ApiHttpError(400, 'INVALID_PRICE_TZS', `${label} must be a non-negative integer`);
  }
  return n;
}

function parseStoreIds(session: Session, value: unknown, label = 'storeIds'): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ApiHttpError(400, 'INVALID_STORE_IDS', `${label} must be a non-empty array`);
  }
  const ids = [...new Set(value.map(String))];
  const stores = merchantStores(session);
  for (const id of ids) {
    if (!stores.some((s) => s.id === id)) {
      throw new ApiHttpError(400, 'INVALID_STORE_IDS', `${label} references unknown store ${id}`);
    }
  }
  return ids;
}

function parseSections(session: Session, value: unknown): MenuSection[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new ApiHttpError(400, 'INVALID_MENU_SECTIONS', 'sections must be an array');
  return value.map((x) => {
    const row = (x ?? {}) as { name?: unknown; itemIds?: unknown };
    const name = String(row.name ?? '').trim();
    if (!name) throw new ApiHttpError(400, 'INVALID_MENU_SECTIONS', 'section name is required');
    const itemIds = Array.isArray(row.itemIds) ? row.itemIds.map(String) : [];
    for (const itemId of itemIds) findProduct(session, itemId);
    return { name, itemIds };
  });
}

function barcodeRows(session: Session): (BarcodeInfo & { merchantId: string })[] {
  return db.table<BarcodeInfo & { merchantId: string }>('barcodes').where((b) => b.merchantId === session.merchantId);
}

type BarcodeHistoryRow = BarcodeHistoryEntry & { code: string; id: string };

function recordBarcodeHistory(code: string, action: BarcodeHistoryEntry['action'], at = Date.now()) {
  db.table<BarcodeHistoryRow>('barcodeHistory').insert({ id: uid('bch'), code, at, action });
}

function buildBulkResults(session: Session, operation: BulkOperation): BulkOperation['results'] {
  const fail = new Set(Array.isArray(operation.payload?.failStoreIds) ? operation.payload.failStoreIds.map(String) : []);
  return operation.storeIds.map((storeId) => {
    const storeExists = merchantStores(session).some((s) => s.id === storeId);
    if (!storeExists || fail.has(storeId)) {
      return { storeId, ok: false, error: storeExists ? 'STORE_REJECTED' : 'INVALID_STORE' };
    }
    return { storeId, ok: true };
  });
}

function advanceBulkOperation(session: Session, operation: BulkOperation): BulkOperation {
  const age = Date.now() - operation.createdAt;
  const next: BulkOperation['status'] = age >= 4000 ? 'completed' : age >= 2000 ? 'processing' : 'queued';
  if (next === operation.status) return operation;
  const updated = db
    .table<BulkOperation & { merchantId: string }>('bulkOperations')
    .update(operation.id, {
      status: next,
      results: next === 'completed' || next === 'processing' ? buildBulkResults(session, operation) : operation.results,
    })!;
  p8Emit({ type: 'catalogue.bulk_updated', operation: updated, at: Date.now() });
  return updated;
}

/* ================= Barcodes ================= */

export const catalogueExtHandlers = [
  h.get('/api/barcodes/formats', ({ request }) => {
    requireSession(request);
    const rows = db.table<BarcodeFormat & { id: string }>('barcodeFormats').all();
    return okArray(rows.map(({ id: _id, ...format }) => format));
  }),

  h.get('/api/products/:itemId/barcodes', ({ request, params }) => {
    const session = requireSession(request);
    findProduct(session, String(params.itemId));
    return okArray(barcodeRows(session).filter((b) => b.catalogueItemId === String(params.itemId)));
  }),

  h.post('/api/products/:itemId/barcode/generate', async ({ request, params }) => {
    const session = requireSession(request);
    requirePerm(session, 'menu:manage');
    const item = findProduct(session, String(params.itemId));
    const body = await readJson(request);
    const format = requireFormat(body.format);
    const code = generateCode(format, item.id);
    const barcode: BarcodeInfo & { merchantId: string } = {
      id: uid('bc'),
      merchantId: session.merchantId,
      code,
      format,
      catalogueItemId: item.id,
      createdAt: Date.now(),
    };
    db.table<BarcodeInfo & { merchantId: string }>('barcodes').insert(barcode);
    recordBarcodeHistory(code, 'generated');
    p8Emit({ type: 'catalogue.barcode_generated', barcode, at: Date.now() });
    audit(session.merchantId, session.staffId, session.role, 'menu:update', 'product', item.id, `generated ${format} barcode for ${item.name}`);
    return json(201, barcode);
  }),

  del('/api/products/:itemId/barcode/:code', ({ request, params }) => {
    const session = requireSession(request);
    requirePerm(session, 'menu:manage');
    findProduct(session, String(params.itemId));
    const code = String(params.code);
    const row = barcodeRows(session).find((b) => b.code === code && b.catalogueItemId === String(params.itemId));
    if (!row) throw new ApiHttpError(404, 'NOT_FOUND', 'Barcode not found for this item');
    db.table<BarcodeInfo & { merchantId: string }>('barcodes').remove(row.id);
    db.table<BarcodeHistoryRow>('barcodeHistory').where((x) => x.code === code).forEach((x) => {
      db.table<BarcodeHistoryRow>('barcodeHistory').remove(x.id);
    });
    audit(session.merchantId, session.staffId, session.role, 'menu:update', 'product', String(params.itemId), `deleted barcode ${code}`);
    return ok({ deleted: true });
  }),

  h.get('/api/barcodes/:code', ({ request, params }) => {
    const session = requireSession(request);
    const code = String(params.code);
    const row = barcodeRows(session).find((b) => b.code === code);
    if (!row) throw new ApiHttpError(404, 'NOT_FOUND', 'Barcode not found');
    const item = db.table<ProductRow>('products').find(row.catalogueItemId)!;
    const lookup: BarcodeLookup = {
      catalogueItemId: item.id,
      name: item.name,
      priceTZS: Math.round(item.price),
      available: item.visible && item.stock > 0,
      stockOnHand: item.stock,
    };
    return ok(lookup);
  }),

  h.get('/api/barcodes/:code/history', ({ request, params }) => {
    const session = requireSession(request);
    const code = String(params.code);
    if (!barcodeRows(session).some((b) => b.code === code)) {
      throw new ApiHttpError(404, 'NOT_FOUND', 'Barcode not found');
    }
    const rows = db.table<BarcodeHistoryRow>('barcodeHistory').where((x) => x.code === code);
    return okArray(
      rows
        .map(({ at, action }) => ({ at, action }))
        .sort((a, b) => b.at - a.at),
    );
  }),

  h.post('/api/barcodes/batch', async ({ request }) => {
    const session = requireSession(request);
    requirePerm(session, 'menu:manage');
    const body = await readJson(request);
    const entries = Array.isArray(body.entries) ? body.entries : [];
    if (!Array.isArray(body.entries)) throw new ApiHttpError(400, 'INVALID_BATCH', 'entries must be an array');
    if (entries.length > 2000) throw new ApiHttpError(400, 'INVALID_BATCH', 'entries must be at most 2000');
    const existing = new Set(barcodeRows(session).map((b) => b.code));
    const seen = new Set<string>();
    let accepted = 0;
    let rejected = 0;
    for (const x of entries) {
      const entry = (x ?? {}) as { code?: unknown; catalogueItemId?: unknown };
      const code = String(entry.code ?? '').trim();
      const catalogueItemId = String(entry.catalogueItemId ?? '');
      const valid =
        code !== '' &&
        !existing.has(code) &&
        !seen.has(code) &&
        (db.table<ProductRow>('products').find(catalogueItemId)?.merchantId ?? '') === session.merchantId;
      if (!valid) {
        rejected += 1;
        continue;
      }
      seen.add(code);
      const barcode: BarcodeInfo & { merchantId: string } = {
        id: uid('bc'),
        merchantId: session.merchantId,
        code,
        format: 'ean13',
        catalogueItemId,
        createdAt: Date.now(),
      };
      db.table<BarcodeInfo & { merchantId: string }>('barcodes').insert(barcode);
      recordBarcodeHistory(code, 'generated');
      accepted += 1;
    }
    const result: BatchBarcodeResult = { jobId: uid('job'), accepted, rejected };
    audit(session.merchantId, session.staffId, session.role, 'menu:update', 'product', 'batch', `barcode batch import: ${accepted} accepted, ${rejected} rejected`);
    return json(202, result);
  }),

  /* ================= Combos ================= */

  h.get('/api/combos', ({ request }) => {
    const session = requireSession(request);
    const rows = db.table<Combo & { merchantId: string }>('combos').where((c) => c.merchantId === session.merchantId);
    return okArray([...rows].sort((a, b) => b.createdAt - a.createdAt));
  }),

  h.post('/api/combos', async ({ request }) => {
    const session = requireSession(request);
    requirePerm(session, 'menu:manage');
    const body = await readJson(request);
    const name = String(body.name ?? '').trim();
    if (!name) throw new ApiHttpError(400, 'NAME_REQUIRED', 'Combo name is required');
    if (name.length > 160) throw new ApiHttpError(400, 'NAME_REQUIRED', 'Combo name must be at most 160 characters');
    const items = parseComboItems(session, body.items);
    if (items.length === 0) throw new ApiHttpError(400, 'INVALID_COMBO_ITEMS', 'A combo needs at least one item');
    const combo: Combo & { merchantId: string } = {
      id: uid('combo'),
      merchantId: session.merchantId,
      name,
      description: body.description !== undefined && body.description !== null ? String(body.description) : undefined,
      items,
      priceTZS: body.priceTZS !== undefined && body.priceTZS !== null ? parseIntTZS(body.priceTZS, 'priceTZS') : undefined,
      imageUrl: body.imageUrl !== undefined && body.imageUrl !== null ? String(body.imageUrl) : null,
      available: body.available !== false,
      createdAt: Date.now(),
    };
    db.table<Combo & { merchantId: string }>('combos').insert(combo);
    p8Emit({ type: 'catalogue.combo_created', combo, at: Date.now() });
    audit(session.merchantId, session.staffId, session.role, 'menu:update', 'combo', combo.id, `created combo "${name}"`);
    return json(201, combo);
  }),

  h.patch('/api/combos/:comboId', async ({ request, params }) => {
    const session = requireSession(request);
    requirePerm(session, 'menu:manage');
    const combo = db.table<Combo & { merchantId: string }>('combos').find(String(params.comboId));
    if (!combo || combo.merchantId !== session.merchantId) throw new ApiHttpError(404, 'NOT_FOUND', 'Combo not found');
    const body = await readJson(request);
    const patch: Partial<Combo> = {};
    if (body.name !== undefined) {
      const name = String(body.name).trim();
      if (!name) throw new ApiHttpError(400, 'NAME_REQUIRED', 'Combo name is required');
      patch.name = name;
    }
    if (body.description !== undefined) {
      patch.description = body.description === null ? undefined : String(body.description);
    }
    if (body.items !== undefined) {
      const items = parseComboItems(session, body.items);
      if (items.length === 0) throw new ApiHttpError(400, 'INVALID_COMBO_ITEMS', 'A combo needs at least one item');
      patch.items = items;
    }
    if (body.priceTZS !== undefined) patch.priceTZS = body.priceTZS === null ? undefined : parseIntTZS(body.priceTZS, 'priceTZS');
    if (body.imageUrl !== undefined) patch.imageUrl = body.imageUrl === null ? null : String(body.imageUrl);
    if (body.available !== undefined) patch.available = body.available === true;
    const updated = db.table<Combo & { merchantId: string }>('combos').update(combo.id, patch)!;
    p8Emit({ type: 'catalogue.combo_updated', combo: updated, at: Date.now() });
    audit(session.merchantId, session.staffId, session.role, 'menu:update', 'combo', combo.id, `updated combo "${updated.name}"`);
    return ok(updated);
  }),

  del('/api/combos/:comboId', ({ request, params }) => {
    const session = requireSession(request);
    requirePerm(session, 'menu:manage');
    const combo = db.table<Combo & { merchantId: string }>('combos').find(String(params.comboId));
    if (!combo || combo.merchantId !== session.merchantId) throw new ApiHttpError(404, 'NOT_FOUND', 'Combo not found');
    db.table<Combo & { merchantId: string }>('combos').remove(combo.id);
    p8Emit({ type: 'catalogue.combo_deleted', comboId: combo.id, at: Date.now() });
    audit(session.merchantId, session.staffId, session.role, 'menu:update', 'combo', combo.id, `deleted combo "${combo.name}"`);
    return new Response(null, { status: 204 });
  }),

  /* ================= Menus (multi-store) ================= */

  h.get('/api/menus', ({ request }) => {
    const session = requireSession(request);
    const rows = db.table<Menu & { merchantId: string }>('menus').where((m) => m.merchantId === session.merchantId);
    return okArray([...rows].sort((a, b) => b.createdAt - a.createdAt));
  }),

  h.post('/api/menus', async ({ request }) => {
    const session = requireSession(request);
    requirePerm(session, 'menu:manage');
    const body = await readJson(request);
    const name = String(body.name ?? '').trim();
    if (!name) throw new ApiHttpError(400, 'NAME_REQUIRED', 'Menu name is required');
    const menu: Menu & { merchantId: string } = {
      id: uid('menu'),
      merchantId: session.merchantId,
      name,
      storeIds: parseStoreIds(session, body.storeIds),
      sections: parseSections(session, body.sections),
      active: body.active !== false,
      createdAt: Date.now(),
    };
    db.table<Menu & { merchantId: string }>('menus').insert(menu);
    p8Emit({ type: 'catalogue.menu_created', menu, at: Date.now() });
    audit(session.merchantId, session.staffId, session.role, 'menu:update', 'menu', menu.id, `created menu "${name}"`);
    return json(201, menu);
  }),

  put('/api/menus/:menuId', async ({ request, params }) => {
    const session = requireSession(request);
    requirePerm(session, 'menu:manage');
    const menu = db.table<Menu & { merchantId: string }>('menus').find(String(params.menuId));
    if (!menu || menu.merchantId !== session.merchantId) throw new ApiHttpError(404, 'NOT_FOUND', 'Menu not found');
    const body = await readJson(request);
    const name = String(body.name ?? '').trim();
    if (!name) throw new ApiHttpError(400, 'NAME_REQUIRED', 'Menu name is required');
    const replaced: Menu & { merchantId: string } = {
      ...menu,
      name,
      storeIds: parseStoreIds(session, body.storeIds),
      sections: parseSections(session, body.sections),
      active: body.active !== false,
    };
    db.table<Menu & { merchantId: string }>('menus').update(menu.id, replaced);
    p8Emit({ type: 'catalogue.menu_updated', menu: replaced, at: Date.now() });
    audit(session.merchantId, session.staffId, session.role, 'menu:update', 'menu', menu.id, `replaced menu "${name}"`);
    return ok(replaced);
  }),

  del('/api/menus/:menuId', ({ request, params }) => {
    const session = requireSession(request);
    requirePerm(session, 'menu:manage');
    const menu = db.table<Menu & { merchantId: string }>('menus').find(String(params.menuId));
    if (!menu || menu.merchantId !== session.merchantId) throw new ApiHttpError(404, 'NOT_FOUND', 'Menu not found');
    db.table<Menu & { merchantId: string }>('menus').remove(menu.id);
    p8Emit({ type: 'catalogue.menu_deleted', menuId: menu.id, at: Date.now() });
    audit(session.merchantId, session.staffId, session.role, 'menu:update', 'menu', menu.id, `deleted menu "${menu.name}"`);
    return new Response(null, { status: 204 });
  }),

  /* ================= Videos ================= */

  h.get('/api/videos', ({ request }) => {
    const session = requireSession(request);
    const rows = db.table<ProductVideo & { merchantId: string }>('productVideos').where((v) => v.merchantId === session.merchantId);
    return okArray([...rows].sort((a, b) => b.createdAt - a.createdAt));
  }),

  h.post('/api/videos', async ({ request }) => {
    const session = requireSession(request);
    requirePerm(session, 'menu:manage');
    const body = await readJson(request);
    const title = String(body.title ?? '').trim();
    if (!title) throw new ApiHttpError(400, 'TITLE_REQUIRED', 'Video title is required');
    if (title.length > 120) throw new ApiHttpError(400, 'TITLE_REQUIRED', 'Video title must be at most 120 characters');
    const url = String(body.url ?? '').trim();
    if (!HTTP_RE.test(url)) throw new ApiHttpError(400, 'INVALID_VIDEO_URL', 'url must be a valid http(s) URL');
    let catalogueItemId: string | null = null;
    if (body.catalogueItemId !== undefined && body.catalogueItemId !== null && body.catalogueItemId !== '') {
      catalogueItemId = findProduct(session, String(body.catalogueItemId)).id;
    }
    const status = body.status === 'processing' || body.status === 'failed' ? body.status : 'active';
    const video: ProductVideo & { merchantId: string } = {
      id: uid('vid'),
      merchantId: session.merchantId,
      title,
      url,
      thumbnailUrl: body.thumbnailUrl !== undefined && body.thumbnailUrl !== null ? String(body.thumbnailUrl) : null,
      catalogueItemId,
      status,
      durationSeconds: body.durationSeconds !== undefined && body.durationSeconds !== null ? Math.max(0, Math.round(Number(body.durationSeconds))) : null,
      views: 0,
      createdAt: Date.now(),
    };
    db.table<ProductVideo & { merchantId: string }>('productVideos').insert(video);
    p8Emit({ type: 'catalogue.video_created', video, at: Date.now() });
    audit(session.merchantId, session.staffId, session.role, 'menu:update', 'video', video.id, `added video "${title}"`);
    return json(201, video);
  }),

  del('/api/videos/:videoId', ({ request, params }) => {
    const session = requireSession(request);
    requirePerm(session, 'menu:manage');
    const video = db.table<ProductVideo & { merchantId: string }>('productVideos').find(String(params.videoId));
    if (!video || video.merchantId !== session.merchantId) throw new ApiHttpError(404, 'NOT_FOUND', 'Video not found');
    db.table<ProductVideo & { merchantId: string }>('productVideos').remove(video.id);
    p8Emit({ type: 'catalogue.video_deleted', videoId: video.id, at: Date.now() });
    audit(session.merchantId, session.staffId, session.role, 'menu:update', 'video', video.id, `deleted video "${video.title}"`);
    return new Response(null, { status: 204 });
  }),

  /* ================= Bulk operations ================= */

  h.get('/api/bulk-operations', ({ request }) => {
    const session = requireSession(request);
    const rows = db.table<BulkOperation & { merchantId: string }>('bulkOperations').where((b) => b.merchantId === session.merchantId);
    return okArray(rows.map((b) => advanceBulkOperation(session, b)).sort((a, b) => b.createdAt - a.createdAt));
  }),

  h.get('/api/bulk-operations/:bulkOperationId', ({ request, params }) => {
    const session = requireSession(request);
    const operation = db.table<BulkOperation & { merchantId: string }>('bulkOperations').find(String(params.bulkOperationId));
    if (!operation || operation.merchantId !== session.merchantId) throw new ApiHttpError(404, 'NOT_FOUND', 'Bulk operation not found');
    return ok(advanceBulkOperation(session, operation));
  }),

  h.post('/api/bulk-operations', async ({ request }) => {
    const session = requireSession(request);
    requirePerm(session, 'store:manage');
    const body = await readJson(request);
    const type = String(body.type ?? '');
    const TYPES = new Set(['price_update', 'availability', 'promotion_apply', 'catalogue_sync']);
    if (!TYPES.has(type)) throw new ApiHttpError(400, 'INVALID_BULK_TYPE', 'type must be price_update, availability, promotion_apply or catalogue_sync');
    const storeIds = parseStoreIds(session, body.storeIds);
    const payload = body.payload !== undefined && body.payload !== null && typeof body.payload === 'object' ? (body.payload as Record<string, unknown>) : {};
    const operation: BulkOperation & { merchantId: string } = {
      id: uid('bulk'),
      merchantId: session.merchantId,
      type: type as BulkOperation['type'],
      storeIds,
      payload,
      status: 'queued',
      results: [],
      createdBy: session.role,
      createdAt: Date.now(),
      requiresApproval: body.requiresApproval === true,
    };
    db.table<BulkOperation & { merchantId: string }>('bulkOperations').insert(operation);
    p8Emit({ type: 'catalogue.bulk_created', operation, at: Date.now() });
    audit(session.merchantId, session.staffId, session.role, 'store:update', 'bulk-operation', operation.id, `created ${type} bulk operation across ${storeIds.length} store(s)`);
    return json(202, operation);
  }),
];
