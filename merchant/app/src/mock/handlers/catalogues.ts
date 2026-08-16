import { http } from 'msw';
import type {
  Catalogue,
  CatalogueBulkJobRow,
  CatalogueBulkResult,
  CatalogueExportResult,
  CatalogueImportJobRow,
  CatalogueImportResult,
  CatalogueItemDto,
  CatalogueOptionsGroup,
  CataloguePublishRow,
  CategoryRow,
  OrderDto,
  P1Event,
  ProductRow,
  ServerEvent,
  StoreServer,
} from '@/api/types';
import { db, uid } from '@/mock/db';
import { emit } from '@/mock/events';
import { audit, json, ok, requirePerm, requireSession } from '@/mock/security';
import { ApiHttpError, h, readJson } from '@/mock/handlers/common';
import type { Session } from '@/mock/types-internal';

const BASE = typeof location !== 'undefined' ? location.origin : 'http://localhost';

/* h has no put wrapper; same wrap/json error filter as h.get/post/patch. */
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

const p1Emit = (event: P1Event) => emit(event as unknown as ServerEvent);

/** Orders that have been accepted and are still advancing (not terminal).
 *  Includes the legacy app statuses the mock order machine uses ('preparing',
 *  'ready') plus the contract in-flight statuses. */
const IN_FLIGHT_ORDER_STATUSES = new Set([
  'merchant_accepted',
  'preparing',
  'rider_assigned',
  'rider_arrived_pickup',
  'picked_up',
  'delivering',
  'rider_arrived_dropoff',
  'ready',
]);

interface InFlightItemRef {
  id: string;
  name: string;
  inFlightCount: number;
}

/** MENU-CATALOGUE.md §Price change handling: publishing a new price for an item
 *  referenced by in-flight orders is rejected with ORDER_PRICE_CHANGED. */
function assertNoPriceChangeOnInFlightOrders(session: Session, items: CatalogueItemDto[]): void {
  const refs: InFlightItemRef[] = [];
  const orders = db.table<OrderDto>('orders').all();
  for (const item of items) {
    if (!item.id) continue;
    const existing = db.table<ProductRow>('products').find(item.id);
    if (!existing || existing.merchantId !== session.merchantId) continue;
    if (Math.round(existing.price) === item.priceTZS) continue;
    const inFlightCount = orders.filter(
      (o) => o.merchantId === session.merchantId && IN_FLIGHT_ORDER_STATUSES.has(o.status) && o.items?.some((i) => i.productId === item.id),
    ).length;
    if (inFlightCount > 0) refs.push({ id: item.id, name: item.name, inFlightCount });
  }
  if (refs.length > 0) {
    throw new ApiHttpError(
      409,
      'ORDER_PRICE_CHANGED',
      'Some items are referenced by in-flight orders — keep the price or wait until the orders complete',
      false,
      { items: refs },
    );
  }
}

function primaryStoreId(session: Session): string {
  return db.table<StoreServer>('stores').where((s) => s.merchantId === session.merchantId)[0]?.id ?? 's_demo';
}

function categoryOf(categoryId: string): string | undefined {
  return db.table<CategoryRow>('categories').find(categoryId)?.name;
}

/** Category name lookup within the merchant's own categories (case-insensitive). */
function findCategoryByName(session: Session, name: string): CategoryRow | undefined {
  const q = name.trim().toLowerCase();
  return db
    .table<CategoryRow>('categories')
    .where((c) => c.merchantId === session.merchantId)
    .find((c) => c.name.toLowerCase() === q);
}

function nextSort(storeId: string): number {
  const rows = db.table<ProductRow>('products').where((p) => p.storeId === storeId);
  return rows.reduce((m, p) => Math.max(m, p.sort ?? 0), -1) + 1;
}

function mapOptionsToContract(p: ProductRow): CatalogueOptionsGroup[] {
  return (p.options ?? []).map((g) => ({
    name: g.name,
    choices: g.choices.map((c) => ({ label: c.label, priceTZS: Math.round(c.priceTZS) })),
    required: g.required,
    min: g.min,
    max: g.max,
  }));
}

function mapProductToCatalogueItem(p: ProductRow): CatalogueItemDto {
  return {
    id: p.id,
    name: p.name,
    description: p.description || undefined,
    priceTZS: Math.round(p.price),
    category: categoryOf(p.categoryId) ?? '',
    categoryId: p.categoryId,
    imageUrl: p.images[0] ?? null,
    videoUrl: p.videoUrl ?? null,
    emoji: p.emoji || null,
    available: p.visible && !p.deleted,
    zeroStockAction: p.zeroStockAction === 'hide' ? 'hide' : 'show_sold_out',
    sort: p.sort,
    options: mapOptionsToContract(p),
    addons: p.addons.map((a) => ({ name: a.name, priceTZS: Math.round(a.price), emoji: a.emoji ?? null })),
    comboItems: p.comboItems.map((c) => ({ catalogueItemId: c.productId, quantity: c.qty })),
  };
}

function buildCatalogue(merchantId: string, items: CatalogueItemDto[], publishedAt: string | null): Catalogue {
  return { merchantId, items, publishedAt };
}

function myCatalogue(session: Session): Catalogue {
  const items = db
    .table<ProductRow>('products')
    .where((p) => p.merchantId === session.merchantId)
    .sort((a, b) => a.sort - b.sort)
    .map(mapProductToCatalogueItem);
  const row = db.table<CataloguePublishRow>('catalogues').where((c) => c.merchantId === session.merchantId)[0];
  return buildCatalogue(session.merchantId, items, row?.publishedAt ?? null);
}

/** Validate a contract options group (name + choices); keeps the app extension
 *  fields (required/min/max) so the round-trip back into ProductRow preserves
 *  the editor settings. Returns the contract-compatible shape. */
function parseOptionsGroup(raw: unknown, ref: string): CatalogueOptionsGroup[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new ApiHttpError(400, 'INVALID_OPTIONS', `${ref}: options must be an array`);
  return raw.map((x, i) => {
    const g = (x ?? {}) as { name?: unknown; choices?: unknown; required?: unknown; min?: unknown; max?: unknown };
    const name = String(g.name ?? '').trim();
    if (!name) throw new ApiHttpError(400, 'INVALID_OPTIONS', `${ref}: options[${i}] name is required`);
    if (!Array.isArray(g.choices)) throw new ApiHttpError(400, 'INVALID_OPTIONS', `${ref}: options[${i}] choices must be an array`);
    const choices = g.choices.map((c, j) => {
      const ch = (c ?? {}) as { label?: unknown; priceTZS?: unknown };
      const label = String(ch.label ?? '').trim();
      if (!label) throw new ApiHttpError(400, 'INVALID_OPTIONS', `${ref}: options[${i}].choices[${j}] label is required`);
      const priceTZS = Number(ch.priceTZS);
      if (!Number.isInteger(priceTZS) || priceTZS < 0) {
        throw new ApiHttpError(400, 'INVALID_OPTIONS', `${ref}: options[${i}].choices[${j}] priceTZS must be a non-negative integer`);
      }
      return { label, priceTZS };
    });
    const group: CatalogueOptionsGroup = { name, choices };
    if (g.required !== undefined) group.required = g.required === true;
    if (g.min !== undefined) group.min = Math.max(0, Math.round(Number(g.min)));
    if (g.max !== undefined) group.max = Math.max(0, Math.round(Number(g.max)));
    return group;
  });
}

/** Validate contract addons ({name, priceTZS, emoji}) and keep the contract
 *  shape for the upsert conversion step. */
function parseAddonsContract(raw: unknown, ref: string): { name: string; priceTZS: number; emoji?: string | null }[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new ApiHttpError(400, 'INVALID_ADDONS', `${ref}: addons must be an array`);
  return raw.map((x, i) => {
    const a = (x ?? {}) as { name?: unknown; priceTZS?: unknown; emoji?: unknown };
    const name = String(a.name ?? '').trim();
    if (!name) throw new ApiHttpError(400, 'INVALID_ADDONS', `${ref}: addons[${i}] name is required`);
    const priceTZS = Number(a.priceTZS);
    if (!Number.isInteger(priceTZS) || priceTZS < 0) {
      throw new ApiHttpError(400, 'INVALID_ADDONS', `${ref}: addons[${i}] priceTZS must be a non-negative integer`);
    }
    return {
      name,
      priceTZS,
      emoji: a.emoji !== undefined && a.emoji !== null && String(a.emoji) ? String(a.emoji) : null,
    };
  });
}

/** Validate contract combo items ({catalogueItemId, quantity}) and keep the
 *  contract shape for the upsert conversion step. */
function parseComboItemsContract(
  raw: unknown,
  ref: string,
): { catalogueItemId: string; quantity: number }[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new ApiHttpError(400, 'INVALID_COMBO', `${ref}: comboItems must be an array`);
  return raw.map((x, i) => {
    const c = (x ?? {}) as { catalogueItemId?: unknown; quantity?: unknown };
    const catalogueItemId = String(c.catalogueItemId ?? '').trim();
    if (!catalogueItemId) {
      throw new ApiHttpError(400, 'INVALID_COMBO', `${ref}: comboItems[${i}] catalogueItemId is required`);
    }
    const quantity = Number(c.quantity);
    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw new ApiHttpError(400, 'INVALID_COMBO', `${ref}: comboItems[${i}] quantity must be a positive integer`);
    }
    return { catalogueItemId, quantity };
  });
}

/** Contract options → app options (re-key choices with stable editor ids). */
function mapContractOptionsToApp(raw: CatalogueItemDto['options']): CatalogueOptionsGroup[] {
  return (raw ?? []).map((g, i) => ({
    name: g.name,
    choices: g.choices.map((c, j) => ({ id: `optc_${i}_${j}`, label: c.label, priceTZS: Math.round(c.priceTZS) })),
    required: (g as CatalogueOptionsGroup).required,
    min: (g as CatalogueOptionsGroup).min,
    max: (g as CatalogueOptionsGroup).max,
  }));
}

/** Contract addons → app addon rows (editor shape with ids). */
function mapContractAddonsToApp(
  raw: CatalogueItemDto['addons'],
): { id: string; name: string; price: number; emoji?: string }[] {
  return (raw ?? []).map((a, i) => ({
    id: `a_${i}`,
    name: a.name,
    price: a.priceTZS,
    emoji: a.emoji && String(a.emoji) ? String(a.emoji) : undefined,
  }));
}

/** Contract combo items → app combo rows (resolves the referenced product
 *  within the merchant and copies name/emoji/price). */
function mapContractComboItemsToApp(
  raw: CatalogueItemDto['comboItems'],
  session: Session,
): { productId: string; name: string; emoji: string; qty: number; price: number }[] {
  return (raw ?? []).map((c) => {
    const product = db.table<ProductRow>('products').find(c.catalogueItemId);
    if (!product || product.merchantId !== session.merchantId) {
      throw new ApiHttpError(400, 'INVALID_COMBO', `comboItems references unknown item ${c.catalogueItemId}`);
    }
    return { productId: product.id, name: product.name, emoji: product.emoji, qty: c.quantity, price: product.price };
  });
}

/** Validate + normalize one raw catalogue item; throws with a row-scoped message. */
function parseCatalogueItem(raw: unknown, ref: string, session: Session): CatalogueItemDto {
  const row = (raw ?? {}) as Record<string, unknown>;
  const name = String(row.name ?? '').trim();
  if (!name) throw new ApiHttpError(400, 'NAME_REQUIRED', `${ref}: name is required`);
  if (name.length > 160) throw new ApiHttpError(400, 'NAME_TOO_LONG', `${ref}: name must be ≤ 160 chars`);
  const priceRaw = row.priceTZS;
  if (priceRaw === undefined || priceRaw === null) {
    throw new ApiHttpError(400, 'PRICE_REQUIRED', `${ref}: priceTZS is required`);
  }
  const priceTZS = Number(priceRaw);
  if (!Number.isInteger(priceTZS) || priceTZS < 0) {
    throw new ApiHttpError(400, 'INVALID_PRICE_TZS', `${ref}: priceTZS must be a non-negative integer`);
  }
  const category = String(row.category ?? '').trim();
  if (!category) throw new ApiHttpError(400, 'CATEGORY_REQUIRED', `${ref}: category is required`);
  const cat = findCategoryByName(session, category);
  if (!cat) throw new ApiHttpError(400, 'CATEGORY_NOT_FOUND', `${ref}: category "${category}" not found`);
  const options = parseOptionsGroup(row.options, ref);
  const addons = parseAddonsContract(row.addons, ref);
  const comboItems = parseComboItemsContract(row.comboItems, ref);
  return {
    id: row.id !== undefined && row.id !== null ? String(row.id) : undefined,
    name,
    priceTZS,
    category: cat.name,
    categoryId: cat.id,
    description: row.description !== undefined && row.description !== null ? String(row.description) : undefined,
    emoji: row.emoji !== undefined && row.emoji !== null ? String(row.emoji) : undefined,
    available: row.available === undefined || row.available === null ? true : row.available === true,
    zeroStockAction: row.zeroStockAction === 'hide' ? 'hide' : 'show_sold_out',
    sort: Number(row.sort ?? 0) || 0,
    options,
    addons,
    comboItems,
  };
}

function upsertItem(session: Session, item: CatalogueItemDto): ProductRow {
  const storeId = primaryStoreId(session);
  const existing = item.id ? db.table<ProductRow>('products').find(item.id) : undefined;
  if (existing) {
    if (existing.merchantId !== session.merchantId) {
      throw new ApiHttpError(404, 'NOT_FOUND', `Item ${item.id} not found`);
    }
    return db.table<ProductRow>('products').update(existing.id, {
      name: item.name,
      price: item.priceTZS,
      categoryId: item.categoryId ?? existing.categoryId,
      description: item.description ?? existing.description,
      emoji: item.emoji ?? existing.emoji,
      visible: item.available !== false,
      zeroStockAction: item.zeroStockAction === 'hide' ? 'hide' : 'showSoldOut',
      options: item.options?.length ? mapContractOptionsToApp(item.options) : existing.options ?? [],
      addons: item.addons?.length ? mapContractAddonsToApp(item.addons) : existing.addons,
      comboItems: item.comboItems?.length ? mapContractComboItemsToApp(item.comboItems, session) : existing.comboItems,
      updatedAt: Date.now(),
    })!;
  }
  const product: ProductRow = {
    id: uid('p'),
    merchantId: session.merchantId,
    storeId,
    categoryId: item.categoryId ?? '',
    name: item.name,
    emoji: item.emoji ?? '🍢',
    price: item.priceTZS,
    stock: 0,
    sold: 0,
    visible: item.available !== false,
    description: item.description ?? '',
    images: item.imageUrl ? [item.imageUrl] : [],
    variants: [],
    options: item.options?.length ? mapContractOptionsToApp(item.options) : [],
    addons: item.addons?.length ? mapContractAddonsToApp(item.addons) : [],
    comboItems: item.comboItems?.length ? mapContractComboItemsToApp(item.comboItems, session) : [],
    zeroStockAction: item.zeroStockAction === 'hide' ? 'hide' : 'showSoldOut',
    sort: item.sort ?? nextSort(storeId),
    updatedAt: Date.now(),
  };
  db.table<ProductRow>('products').insert(product);
  return product;
}

export const catalogueHandlers = [
  /* ---- GET /catalogues/export — spreadsheet export payload (audited) ---- */
  h.get('/api/catalogues/export', ({ request }) => {
    const session = requireSession(request);
    requirePerm(session, 'menu:manage');
    const jobId = uid('cexp');
    const result: CatalogueExportResult = {
      downloadUrl: `https://export.hudumika.app/catalogues/${jobId}.csv?token=${encodeURIComponent(session.token.slice(0, 16))}`,
      expiresInSeconds: 900,
    };
    audit(session.merchantId, session.staffId, session.role, 'catalogue:export', 'catalogue', 'all', `exported ${db.table<ProductRow>('products').where((p) => p.merchantId === session.merchantId && !p.deleted).length} items`);
    return ok(result);
  }),

  /* ---- GET /catalogues/me — own catalogue with items + publishedAt ---- */
  h.get('/api/catalogues/me', ({ request }) => {
    const session = requireSession(request);
    return ok(myCatalogue(session));
  }),

  /* ---- PUT /catalogues/me — full catalogue replace (draft publish) ---- */
  put('/api/catalogues/me', async ({ request }) => {
    const session = requireSession(request);
    requirePerm(session, 'menu:manage');
    const body = await readJson(request);
    if (body.merchantId !== undefined && body.merchantId !== null && body.merchantId !== session.merchantId) {
      throw new ApiHttpError(403, 'FORBIDDEN', 'Cannot publish another merchant\'s catalogue');
    }
    const rawItems = body.items;
    if (!Array.isArray(rawItems)) throw new ApiHttpError(400, 'INVALID_ITEMS', 'items must be an array');
    const items: CatalogueItemDto[] = [];
    for (let i = 0; i < rawItems.length; i += 1) {
      try {
        items.push(parseCatalogueItem(rawItems[i], `item[${i}]`, session));
      } catch (e) {
        if (e instanceof ApiHttpError) {
          throw new ApiHttpError(422, 'VALIDATION_ERROR', e.message, false, {
            errors: [{ field: `items.${i}`, code: e.code, message: e.message }],
          });
        }
        throw e;
      }
    }
    assertNoPriceChangeOnInFlightOrders(session, items);
    const upserted = items.map((item) => upsertItem(session, item));
    const now = new Date().toISOString();
    const existing = db.table<CataloguePublishRow>('catalogues').where((c) => c.merchantId === session.merchantId)[0];
    if (existing) {
      db.table<CataloguePublishRow>('catalogues').update(existing.id, { publishedAt: now, items });
    } else {
      db.table<CataloguePublishRow>('catalogues').insert({ id: uid('cat'), merchantId: session.merchantId, publishedAt: now, items });
    }
    const published: Catalogue = { merchantId: session.merchantId, publishedAt: now, items: upserted.map(mapProductToCatalogueItem) };
    p1Emit({ type: 'catalogue.published', catalogue: published, at: Date.now() });
    audit(session.merchantId, session.staffId, session.role, 'catalogue:publish', 'catalogue', session.merchantId, `published ${upserted.length} items`);
    return ok(published);
  }),

  /* ---- GET /catalogues/{merchantId} — public catalogue (approved items only) ---- */
  h.get('/api/catalogues/:merchantId', ({ params }) => {
    const merchantId = String(params.merchantId);
    const merchant = db.table('merchants').find(merchantId);
    if (!merchant) throw new ApiHttpError(404, 'NOT_FOUND', 'Merchant not found');
    const items = db
      .table<ProductRow>('products')
      .where((p) => p.merchantId === merchantId && p.visible && !p.deleted)
      .sort((a, b) => a.sort - b.sort)
      .map(mapProductToCatalogueItem);
    const row = db.table<CataloguePublishRow>('catalogues').where((c) => c.merchantId === merchantId)[0];
    return ok(buildCatalogue(merchantId, items, row?.publishedAt ?? null));
  }),

  /* ---- POST /catalogue-items/bulk — bulk create/update (max 500) ---- */
  h.post('/api/catalogue-items/bulk', async ({ request }) => {
    const session = requireSession(request);
    requirePerm(session, 'menu:manage');
    const body = await readJson(request);
    const rawItems = body.items;
    if (!Array.isArray(rawItems)) throw new ApiHttpError(400, 'INVALID_ITEMS', 'items must be an array');
    if (rawItems.length > 500) throw new ApiHttpError(400, 'BULK_EXCEEDS_LIMIT', 'items must not exceed 500');
    const overwritePrices = body.overwritePrices === true;
    let accepted = 0;
    let rejected = 0;
    const failures: { index: number; reason: string }[] = [];
    const upserted: ProductRow[] = [];
    rawItems.forEach((raw, i) => {
      try {
        const item = parseCatalogueItem(raw, `item[${i}]`, session);
        if (item.id) {
          const existing = db.table<ProductRow>('products').find(item.id);
          if (!existing || existing.merchantId !== session.merchantId) {
            throw new ApiHttpError(404, 'NOT_FOUND', `item[${i}]: item ${item.id} not found`);
          }
          if (!overwritePrices && existing.price !== item.priceTZS) {
            throw new ApiHttpError(409, 'OVERWRITE_PRICES_REQUIRED', `item[${i}]: price differs — set overwritePrices to apply`);
          }
        }
        upserted.push(upsertItem(session, item));
        accepted += 1;
      } catch (e) {
        rejected += 1;
        const reason = e instanceof ApiHttpError ? `${e.code} — ${e.message}` : 'INVALID_ITEM';
        failures.push({ index: i, reason });
      }
    });
    const job: CatalogueBulkJobRow = {
      id: uid('bulk'),
      merchantId: session.merchantId,
      accepted,
      rejected,
      failures,
      createdAt: Date.now(),
    };
    const row = db.table<CatalogueBulkJobRow>('catalogueBulkJobs').insert(job);
    p1Emit({ type: 'catalogue.bulk_completed', job: row, at: Date.now() });
    audit(session.merchantId, session.staffId, session.role, 'catalogue:bulk', 'catalogue', 'all', `bulk: ${accepted} accepted, ${rejected} rejected`);
    const result: CatalogueBulkResult & { failures?: { index: number; reason: string }[] } = {
      jobId: job.id,
      accepted,
      rejected,
      failures: failures.length ? failures : undefined,
    };
    return json(202, result);
  }),

  /* ---- POST /catalogues/import — spreadsheet rows (max 5000) ---- */
  h.post('/api/catalogues/import', async ({ request }) => {
    const session = requireSession(request);
    requirePerm(session, 'menu:manage');
    const body = await readJson(request);
    const rawRows = body.rows;
    if (!Array.isArray(rawRows)) throw new ApiHttpError(400, 'INVALID_ROWS', 'rows must be an array');
    if (rawRows.length > 5000) throw new ApiHttpError(400, 'IMPORT_EXCEEDS_LIMIT', 'rows must not exceed 5000');
    let accepted = 0;
    let rejected = 0;
    const failures: { row: number; reason: string }[] = [];
    const upserted: ProductRow[] = [];
    rawRows.forEach((raw, i) => {
      try {
        const row = (raw ?? {}) as Record<string, unknown>;
        const item = parseCatalogueItem({ ...row, id: undefined }, `row[${i + 1}]`, session);
        const product = upsertItem(session, item);
        if (row.quantity !== undefined && row.quantity !== null) {
          const qty = Number(row.quantity);
          if (Number.isInteger(qty) && qty >= 0) {
            db.table<ProductRow>('products').update(product.id, { stock: qty });
          }
        }
        upserted.push(product);
        accepted += 1;
      } catch (e) {
        rejected += 1;
        const reason = e instanceof ApiHttpError ? `${e.code} — ${e.message}` : 'INVALID_ROW';
        failures.push({ row: i + 1, reason });
      }
    });
    const job: CatalogueImportJobRow = {
      id: uid('imp'),
      merchantId: session.merchantId,
      status: rejected === 0 && accepted === 0 ? 'failed' : 'completed',
      accepted,
      rejected,
      failures,
      createdAt: Date.now(),
    };
    const row = db.table<CatalogueImportJobRow>('catalogueImportJobs').insert(job);
    p1Emit({ type: 'catalogue.import_completed', job: row, at: Date.now() });
    audit(session.merchantId, session.staffId, session.role, 'catalogue:import', 'catalogue', 'all', `import: ${accepted} accepted, ${rejected} rejected`);
    const result: CatalogueImportResult & { failures?: { row: number; reason: string }[] } = {
      jobId: job.id,
      status: job.status,
      failures: failures.length ? failures : undefined,
    };
    return json(202, result);
  }),
];
