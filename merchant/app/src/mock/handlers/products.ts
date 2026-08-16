import { http } from 'msw';
import type {
  AddonOption,
  CategoryRow,
  CatalogueOptionsGroup,
  ComboItem,
  ProductLog,
  ProductRow,
  StoreListItem,
  StoreServer,
  TemplateRow,
  VariantSpec,
} from '@/api/types';
import { db, uid } from '@/mock/db';
import { audit, json, ok, requirePerm, requireSession } from '@/mock/security';
import { ApiHttpError, h, INTERNAL_KEY, readJson } from '@/mock/handlers/common';
import type { Session } from '@/mock/types-internal';

const HTTP_RE = /^https?:\/\/\S+$/;
const SNAP_EXCLUDE = new Set(['id', 'merchantId', 'storeId', 'stock', 'sold', 'updatedAt', 'deleted']);

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

function primaryStoreId(session: Session): string {
  return db.table<StoreServer>('stores').where((s) => s.merchantId === session.merchantId)[0]?.id ?? 's_demo';
}

function nextSort(storeId: string): number {
  const rows = db.table<ProductRow>('products').where((p) => p.storeId === storeId);
  return rows.reduce((m, p) => Math.max(m, p.sort ?? 0), -1) + 1;
}

function nextCategorySort(storeId: string): number {
  const rows = db.table<CategoryRow>('categories').where((c) => c.storeId === storeId);
  return rows.reduce((m, c) => Math.max(m, c.sort ?? 0), -1) + 1;
}

function bySort(a: { sort: number; updatedAt: number }, b: { sort: number; updatedAt: number }) {
  return a.sort - b.sort || b.updatedAt - a.updatedAt;
}

function logProductOp(
  session: Session,
  entry: {
    productId?: string;
    categoryId?: string;
    action: string;
    field?: string;
    before?: unknown;
    after?: unknown;
  },
) {
  let storeId = 's_demo';
  if (entry.productId) storeId = db.table<ProductRow>('products').find(entry.productId)?.storeId ?? storeId;
  else if (entry.categoryId) storeId = db.table<CategoryRow>('categories').find(entry.categoryId)?.storeId ?? storeId;
  const log: ProductLog = {
    id: uid('pl'),
    merchantId: session.merchantId,
    storeId,
    productId: entry.productId,
    categoryId: entry.categoryId,
    action: entry.action,
    field: entry.field,
    before: entry.before,
    after: entry.after,
    actorId: session.staffId,
    role: session.role,
    ts: Date.now(),
  };
  db.table<ProductLog>('productLogs').insert(log);
}

function requireValidVideoUrl(value: unknown) {
  if (value === undefined || value === null || value === '') return;
  if (typeof value !== 'string' || !HTTP_RE.test(value)) {
    throw new ApiHttpError(400, 'INVALID_VIDEO_URL', 'videoUrl must be a valid http(s) URL');
  }
}

function parseVariants(value: unknown): VariantSpec[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new ApiHttpError(400, 'INVALID_VARIANTS', 'variants must be an array');
  return value.map((x, i) => {
    const row = (x ?? {}) as { id?: unknown; name?: unknown; price?: unknown };
    const name = String(row.name ?? '').trim();
    const price = Number(row.price);
    if (!name) throw new ApiHttpError(400, 'INVALID_VARIANTS', `variant ${i} name is required`);
    if (!Number.isFinite(price) || price < 0) {
      throw new ApiHttpError(400, 'INVALID_VARIANTS', `variant ${i} price must be >= 0`);
    }
    return { id: row.id !== undefined ? String(row.id) : uid('v'), name, price: Math.round(price * 100) / 100 };
  });
}

function parseAddons(value: unknown): AddonOption[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new ApiHttpError(400, 'INVALID_ADDONS', 'addons must be an array');
  return value.map((x, i) => {
    const row = (x ?? {}) as { id?: unknown; name?: unknown; price?: unknown; emoji?: unknown };
    const name = String(row.name ?? '').trim();
    const price = Number(row.price);
    if (!name) throw new ApiHttpError(400, 'INVALID_ADDONS', `addon ${i} name is required`);
    if (!Number.isFinite(price) || price < 0) {
      throw new ApiHttpError(400, 'INVALID_ADDONS', `addon ${i} price must be >= 0`);
    }
    return {
      id: row.id !== undefined ? String(row.id) : uid('a'),
      name,
      price: Math.round(price * 100) / 100,
      emoji: row.emoji !== undefined && row.emoji !== null ? String(row.emoji) : undefined,
    };
  });
}

function parseComboItems(session: Session, value: unknown): ComboItem[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new ApiHttpError(400, 'INVALID_COMBO', 'comboItems must be an array');
  return value.map((x, i) => {
    const row = (x ?? {}) as { productId?: unknown; name?: unknown; emoji?: unknown; qty?: unknown; price?: unknown };
    const productId = String(row.productId ?? '');
    const ref = db.table<ProductRow>('products').find(productId);
    if (!ref || ref.merchantId !== session.merchantId) {
      throw new ApiHttpError(400, 'INVALID_COMBO', `combo item ${i} references unknown product ${productId || '(empty)'}`);
    }
    const qty = Number(row.qty);
    const price = Number(row.price);
    if (!Number.isFinite(qty) || qty <= 0) throw new ApiHttpError(400, 'INVALID_COMBO', `combo item ${i} qty must be > 0`);
    if (!Number.isFinite(price) || price < 0) throw new ApiHttpError(400, 'INVALID_COMBO', `combo item ${i} price must be >= 0`);
    return {
      productId,
      name: String(row.name ?? ref.name),
      emoji: String(row.emoji ?? ref.emoji),
      qty: Math.round(qty),
      price: Math.round(price * 100) / 100,
    };
  });
}

function parseOptions(value: unknown): CatalogueOptionsGroup[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new ApiHttpError(400, 'INVALID_OPTIONS', 'options must be an array');
  return value.map((x, i) => {
    const g = (x ?? {}) as { name?: unknown; choices?: unknown; required?: unknown; min?: unknown; max?: unknown };
    const name = String(g.name ?? '').trim();
    if (!name) throw new ApiHttpError(400, 'INVALID_OPTIONS', `options[${i}] name is required`);
    if (!Array.isArray(g.choices)) throw new ApiHttpError(400, 'INVALID_OPTIONS', `options[${i}] choices must be an array`);
    const choices = g.choices.map((c, j) => {
      const ch = (c ?? {}) as { id?: unknown; label?: unknown; priceTZS?: unknown };
      const label = String(ch.label ?? '').trim();
      if (!label) throw new ApiHttpError(400, 'INVALID_OPTIONS', `options[${i}].choices[${j}] label is required`);
      const priceTZS = Number(ch.priceTZS);
      if (!Number.isInteger(priceTZS) || priceTZS < 0) {
        throw new ApiHttpError(400, 'INVALID_OPTIONS', `options[${i}].choices[${j}] priceTZS must be a non-negative integer`);
      }
      return { id: ch.id !== undefined && ch.id !== null ? String(ch.id) : `optc_${i}_${j}`, label, priceTZS };
    });
    const group: CatalogueOptionsGroup = { name, choices };
    if (g.required !== undefined) group.required = g.required === true;
    if (g.min !== undefined) {
      const min = Number(g.min);
      if (Number.isFinite(min)) group.min = Math.max(0, Math.round(min));
    }
    if (g.max !== undefined) {
      const max = Number(g.max);
      if (Number.isFinite(max)) group.max = Math.max(0, Math.round(max));
    }
    return group;
  });
}

function resolveCategory(session: Session, categoryId: unknown): string {
  const storeId = primaryStoreId(session);
  if (categoryId === undefined || categoryId === null || categoryId === '') {
    const first = db
      .table<CategoryRow>('categories')
      .where((c) => c.storeId === storeId)
      .sort((a, b) => a.sort - b.sort)[0];
    return first?.id ?? '';
  }
  const c = db.table<CategoryRow>('categories').find(String(categoryId));
  if (!c || c.merchantId !== session.merchantId) throw new ApiHttpError(400, 'INVALID_CATEGORY', 'Category not found');
  return c.id;
}

function describeProduct(name: string, categoryName?: string): string {
  return `Charcoal-grilled to order · ${name} — a ${categoryName || 'BBQ'} favorite, seasoned in-house.`;
}

function buildSuggestions(p: ProductRow): { id: string; type: string; title: string; detail: string; value: Record<string, unknown> }[] {
  const out: { type: string; title: string; detail: string; value: Record<string, unknown> }[] = [];
  const categoryName = db.table<CategoryRow>('categories').find(p.categoryId)?.name;
  if (p.stock < 10) {
    out.push({
      type: 'stock',
      title: 'Restock soon',
      detail: 'Low stock may cause order losses',
      value: { stock: Math.max(30, p.stock * 3) },
    });
  }
  if (p.stock === 0) {
    out.push({
      type: 'stock',
      title: 'Zero stock — show as sold out',
      detail: 'Show a sold-out label instead of hiding the item',
      value: { zeroStockAction: 'showSoldOut' },
    });
  }
  const sameCategory = db
    .table<ProductRow>('products')
    .where((x) => x.categoryId === p.categoryId && x.storeId === p.storeId && !x.deleted)
    .map((x) => x.price)
    .sort((a, b) => a - b);
  if (sameCategory.length > 1) {
    const mid = Math.floor(sameCategory.length / 2);
    const median = sameCategory.length % 2 ? sameCategory[mid] : (sameCategory[mid - 1] + sameCategory[mid]) / 2;
    if (p.price > median * 1.5) {
      out.push({
        type: 'price',
        title: 'Price above category median',
        detail: 'Lowering toward the category median may boost conversion',
        value: { price: Math.round(median * 100) / 100 },
      });
    } else if (p.price < median * 0.5) {
      out.push({
        type: 'price',
        title: 'Price below category premium tier',
        detail: 'Customers may perceive this as low quality — consider a premium tier price',
        value: { price: Math.round(median * 1.2 * 100) / 100 },
      });
    }
  }
  if (p.variants.length === 0 && p.price >= 40) {
    out.push({
      type: 'specs',
      title: 'Add portion variants',
      detail: 'Split into Small/Large portions to raise average order value',
      value: {
        variants: [
          { id: uid('v'), name: 'Small', price: Math.max(1, Math.round(p.price * 0.8)) },
          { id: uid('v'), name: 'Large', price: Math.round(p.price * 1.3) },
        ],
      },
    });
  }
  if (p.sold > 30) {
    out.push({
      type: 'name',
      title: 'Signature naming',
      detail: 'Best sellers convert better with a signature label',
      value: { name: `Signature ${p.name}` },
    });
  }
  if (!p.description) {
    out.push({
      type: 'description',
      title: 'Add a description',
      detail: 'Descriptions lift conversion on the customer menu',
      value: { description: describeProduct(p.name, categoryName) },
    });
  }
  const descIdx = out.findIndex((s) => s.type === 'description');
  if (descIdx > 0) out.unshift(out.splice(descIdx, 1)[0]);
  return out.slice(0, 5).map((s, i) => ({ id: `sugg-${i + 1}`, ...s }));
}

function deleteProductById({ request, params }: { request: Request; params: Record<string, string> }) {
  const session = requireSession(request);
  requirePerm(session, 'menu:manage');
  const p = db.table<ProductRow>('products').find(String(params.id));
  if (!p || p.merchantId !== session.merchantId || p.deleted) {
    throw new ApiHttpError(404, 'NOT_FOUND', 'Product not found');
  }
  const updated = db.table<ProductRow>('products').update(p.id, { visible: false, deleted: true, updatedAt: Date.now() })!;
  logProductOp(session, { productId: p.id, action: 'product:delete', before: p, after: updated });
  audit(session.merchantId, session.staffId, session.role, 'menu:update', 'product', p.id, `deleted ${p.name}`);
  return ok({ deleted: true, product: updated });
}

/* Contract-path aliases share these cores with the legacy paths so the two
 * routes can never drift apart: the contract path is the same handler
 * function (itemId is renamed to id internally where the routes differ). */
function listProductLogs({ request, params }: { request: Request; params?: Record<string, string> }) {
  const session = requireSession(request);
  const url = new URL(request.url);
  const itemId = params?.itemId !== undefined && params?.itemId !== '' ? String(params.itemId) : undefined;
  const productId = itemId ?? url.searchParams.get('productId');
  const categoryId = url.searchParams.get('categoryId');
  const action = url.searchParams.get('action');
  const limit = Math.min(300, Math.max(1, Number(url.searchParams.get('limit') ?? 100)));
  let rows = db.table<ProductLog>('productLogs').where((l) => l.merchantId === session.merchantId);
  if (productId) rows = rows.filter((l) => l.productId === productId);
  if (categoryId) rows = rows.filter((l) => l.categoryId === categoryId);
  if (action) rows = rows.filter((l) => l.action === action);
  return ok({ logs: [...rows].sort((a, b) => b.ts - a.ts).slice(0, limit) });
}

function createProductHandler({ request }: { request: Request }) {
  const session = requireSession(request);
  requirePerm(session, 'menu:manage');
  return createProductCore(request, session);
}

async function createProductCore(request: Request, session: Session) {
  const body = await readJson(request);
  const name = String(body.name ?? '').trim();
  if (!name) throw new ApiHttpError(400, 'NAME_REQUIRED', 'Product name is required');
  const price = Number(body.price);
  if (!Number.isFinite(price) || price <= 0) throw new ApiHttpError(400, 'INVALID_PRICE', 'Price must be greater than 0');
  const storeId = primaryStoreId(session);
  const categoryId = resolveCategory(session, body.categoryId);
  requireValidVideoUrl(body.videoUrl);
  if (body.zeroStockAction !== undefined && body.zeroStockAction !== 'hide' && body.zeroStockAction !== 'showSoldOut') {
    throw new ApiHttpError(400, 'INVALID_ZERO_STOCK', 'zeroStockAction must be hide or showSoldOut');
  }
  const stockRaw = body.stock === undefined || body.stock === null ? 0 : Number(body.stock);
  if (!Number.isFinite(stockRaw)) throw new ApiHttpError(400, 'INVALID_STOCK', 'stock must be numeric');
  const product: ProductRow = {
    id: uid('p'),
    merchantId: session.merchantId,
    storeId,
    categoryId,
    name,
    emoji: String(body.emoji ?? '🍢'),
    price: Math.round(price * 100) / 100,
    stock: Math.max(0, Math.round(stockRaw)),
    sold: 0,
    visible: body.visible !== false,
    description: String(body.description ?? ''),
    images: Array.isArray(body.images) ? body.images.map(String) : [],
    videoUrl: body.videoUrl !== undefined && body.videoUrl !== null ? String(body.videoUrl) : undefined,
    variants: parseVariants(body.variants),
    options: parseOptions(body.options),
    addons: parseAddons(body.addons),
    comboItems: parseComboItems(session, body.comboItems),
    zeroStockAction: body.zeroStockAction === 'hide' ? 'hide' : 'showSoldOut',
    sort: nextSort(storeId),
    updatedAt: Date.now(),
  };
  db.table<ProductRow>('products').insert(product);
  logProductOp(session, { productId: product.id, action: 'product:create', after: product });
  audit(session.merchantId, session.staffId, session.role, 'menu:update', 'product', product.id, `created "${product.name}"`);
  return ok({ product });
}

function patchProductById({ request, params }: { request: Request; params: Record<string, string> }) {
  return patchProductCore(request, params);
}

async function patchProductCore(request: Request, params: Record<string, string>) {
  const session = requireSession(request);
  requirePerm(session, 'menu:manage');
  const p = db.table<ProductRow>('products').find(String(params.id));
  if (!p || p.merchantId !== session.merchantId) throw new ApiHttpError(404, 'NOT_FOUND', 'Product not found');
  const body = await readJson(request);
  const patch: Partial<ProductRow> = {};
  const changed: { field: string; before: unknown; after: unknown }[] = [];
  const change = <K extends keyof ProductRow>(key: K, after: ProductRow[K], before: unknown) => {
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      patch[key] = after;
      changed.push({ field: String(key), before, after });
    }
  };
  if (body.name !== undefined) {
    const name = String(body.name).trim();
    if (!name) throw new ApiHttpError(400, 'NAME_REQUIRED', 'Product name is required');
    change('name', name, p.name);
  }
  if (body.price !== undefined) {
    const price = Number(body.price);
    if (!Number.isFinite(price) || price <= 0) throw new ApiHttpError(400, 'INVALID_PRICE', 'Price must be greater than 0');
    change('price', Math.round(price * 100) / 100, p.price);
  }
  if (body.emoji !== undefined) {
    const emoji = String(body.emoji).trim();
    if (emoji) change('emoji', emoji, p.emoji);
  }
  if (body.stock !== undefined) {
    const stock = Number(body.stock);
    if (!Number.isFinite(stock)) throw new ApiHttpError(400, 'INVALID_STOCK', 'stock must be numeric');
    change('stock', Math.max(0, Math.round(stock)), p.stock);
  }
  if (body.visible !== undefined) change('visible', body.visible === true, p.visible);
  if (body.description !== undefined) change('description', String(body.description), p.description);
  if (body.images !== undefined) {
    change('images', Array.isArray(body.images) ? body.images.map(String) : [], p.images);
  }
  if (body.videoUrl !== undefined) {
    requireValidVideoUrl(body.videoUrl);
    const videoUrl = body.videoUrl === null || body.videoUrl === '' ? undefined : String(body.videoUrl);
    change('videoUrl', videoUrl, p.videoUrl);
  }
  if (body.variants !== undefined) change('variants', parseVariants(body.variants), p.variants);
  if (body.options !== undefined) change('options', parseOptions(body.options), p.options ?? []);
  if (body.addons !== undefined) change('addons', parseAddons(body.addons), p.addons);
  if (body.comboItems !== undefined) change('comboItems', parseComboItems(session, body.comboItems), p.comboItems);
  if (body.zeroStockAction !== undefined) {
    if (body.zeroStockAction !== 'hide' && body.zeroStockAction !== 'showSoldOut') {
      throw new ApiHttpError(400, 'INVALID_ZERO_STOCK', 'zeroStockAction must be hide or showSoldOut');
    }
    change('zeroStockAction', body.zeroStockAction, p.zeroStockAction);
  }
  if (body.sort !== undefined) {
    const sort = Number(body.sort);
    if (!Number.isFinite(sort)) throw new ApiHttpError(400, 'INVALID_SORT', 'sort must be numeric');
    change('sort', Math.round(sort), p.sort);
  }
  if (body.categoryId !== undefined) change('categoryId', resolveCategory(session, body.categoryId), p.categoryId);
  patch.updatedAt = Date.now();
  const updated = db.table<ProductRow>('products').update(p.id, patch)!;
  for (const c of changed) {
    logProductOp(session, { productId: p.id, action: 'product:update', field: c.field, before: c.before, after: c.after });
  }
  audit(session.merchantId, session.staffId, session.role, 'menu:update', 'product', p.id, `updated ${updated.name}`);
  return ok({ product: updated });
}

function listStoresHandler({ request }: { request: Request }) {
  const session = requireSession(request);
  const stores = db.table<StoreServer>('stores').where((s) => s.merchantId === session.merchantId);
  const list: StoreListItem[] = stores.map((s) => ({
    id: s.id,
    name: s.name,
    address: s.address,
    open: s.open,
    productCount: db.table<ProductRow>('products').where((p) => p.storeId === s.id && !p.deleted).length,
  }));
  return ok({ stores: list });
}

function listTemplatesHandler({ request }: { request: Request }) {
  const session = requireSession(request);
  const list = db.table<TemplateRow>('templates').where((t) => t.merchantId === session.merchantId);
  return ok({ templates: [...list].sort((a, b) => b.createdAt - a.createdAt) });
}

async function createTemplateHandler({ request }: { request: Request }) {
  const session = requireSession(request);
  requirePerm(session, 'menu:manage');
  const body = await readJson(request);
  const name = String(body.name ?? '').trim();
  if (!name) throw new ApiHttpError(400, 'NAME_REQUIRED', 'Template name is required');
  const p = db.table<ProductRow>('products').find(String(body.productId ?? ''));
  if (!p || p.merchantId !== session.merchantId) throw new ApiHttpError(404, 'NOT_FOUND', 'Product not found');
  const draft: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p)) {
    if (SNAP_EXCLUDE.has(k)) continue;
    draft[k] = v;
  }
  const template: TemplateRow = {
    id: uid('tpl'),
    merchantId: session.merchantId,
    name,
    draft,
    createdAt: Date.now(),
  };
  db.table<TemplateRow>('templates').insert(template);
  logProductOp(session, { productId: p.id, action: 'template:create', field: 'templateId', after: template.id });
  audit(session.merchantId, session.staffId, session.role, 'menu:update', 'template', template.id, `created template "${name}" from ${p.name}`);
  return ok({ template });
}

async function applyTemplateHandler({ request, params }: { request: Request; params: Record<string, string> }) {
  const session = requireSession(request);
  requirePerm(session, 'menu:manage');
  const t = db.table<TemplateRow>('templates').find(String(params.id));
  if (!t || t.merchantId !== session.merchantId) throw new ApiHttpError(404, 'NOT_FOUND', 'Template not found');
  const body = await readJson(request);
  const storeIds = Array.isArray(body.storeIds) ? body.storeIds.map(String) : [];
  const created: { storeId: string; productId: string }[] = [];
  const failed: { storeId: string; reason: string }[] = [];
  for (const storeId of storeIds) {
    const store = db.table<StoreServer>('stores').find(storeId);
    if (!store || store.merchantId !== session.merchantId) {
      failed.push({ storeId, reason: 'INVALID_STORE' });
      continue;
    }
    const d = t.draft;
    const product: ProductRow = {
      id: uid('p'),
      merchantId: session.merchantId,
      storeId,
      name: String(d.name ?? ''),
      emoji: String(d.emoji ?? '🍢'),
      price: Number(d.price ?? 0),
      categoryId: String(d.categoryId ?? ''),
      description: String(d.description ?? ''),
      images: Array.isArray(d.images) ? d.images.map(String) : [],
      videoUrl: d.videoUrl !== undefined && d.videoUrl !== null ? String(d.videoUrl) : undefined,
      variants: parseVariants(d.variants),
      options: parseOptions(d.options),
      addons: parseAddons(d.addons),
      comboItems: parseComboItems(session, d.comboItems),
      zeroStockAction: d.zeroStockAction === 'hide' ? 'hide' : 'showSoldOut',
      stock: 0,
      sold: 0,
      visible: true,
      deleted: undefined,
      sort: nextSort(storeId),
      updatedAt: Date.now(),
    };
    db.table<ProductRow>('products').insert(product);
    logProductOp(session, { productId: product.id, action: 'product:create', field: 'viaTemplate', after: t.name });
    created.push({ storeId, productId: product.id });
  }
  if (created.length) {
    logProductOp(session, { action: 'template:apply', field: 'templateId', after: t.id });
    audit(session.merchantId, session.staffId, session.role, 'menu:update', 'template', t.id, `applied template "${t.name}" to ${created.length} store(s)`);
  }
  return ok({ created, failed });
}

export const productHandlers = [
  /* ---- Products (merchant session OR internal customer-platform) ---- */
  h.get('/api/products', ({ request }) => {
    const internal = request.headers.get('x-internal-key');
    const session = internal === INTERNAL_KEY ? undefined : requireSession(request);
    const merchantId = session ? session.merchantId : 'm_demo';
    const url = new URL(request.url);
    const categoryId = url.searchParams.get('categoryId');
    const q = (url.searchParams.get('q') ?? '').trim().toLowerCase();
    const includeDeleted = url.searchParams.get('includeDeleted') === '1';
    const storeId = url.searchParams.get('storeId') ?? 's_demo';
    let list = db.table<ProductRow>('products').where((p) => p.merchantId === merchantId && p.storeId === storeId);
    if (!includeDeleted) list = list.filter((p) => !p.deleted);
    if (categoryId) list = list.filter((p) => p.categoryId === categoryId);
    if (q) list = list.filter((p) => p.name.toLowerCase().includes(q));
    return ok({ products: [...list].sort(bySort) });
  }),

  h.get('/api/products/logs', listProductLogs),

  /* ---- Contract GET /catalogue-items/{itemId}/logs — alias of /products/logs scoped to the item ---- */
  h.get('/api/catalogue-items/:itemId/logs', listProductLogs),

  h.get('/api/products/assistant/suggestions', ({ request }) => {
    const session = requireSession(request);
    const url = new URL(request.url);
    const productId = url.searchParams.get('productId') ?? '';
    const p = db.table<ProductRow>('products').find(productId);
    if (!p || p.merchantId !== session.merchantId) throw new ApiHttpError(404, 'NOT_FOUND', 'Product not found');
    return ok({ suggestions: buildSuggestions(p) });
  }),

  h.post('/api/products/assistant/apply', async ({ request }) => {
    const session = requireSession(request);
    requirePerm(session, 'menu:manage');
    const body = await readJson(request);
    const productId = String(body.productId ?? '');
    const p = db.table<ProductRow>('products').find(productId);
    if (!p || p.merchantId !== session.merchantId) throw new ApiHttpError(404, 'NOT_FOUND', 'Product not found');
    const suggestion = buildSuggestions(p).find((s) => s.id === body.suggestionId);
    if (!suggestion) throw new ApiHttpError(404, 'SUGGESTION_NOT_FOUND', 'Suggestion no longer applies to this product');
    const value = suggestion.value;
    const patch: Partial<ProductRow> = {};
    if (value.name !== undefined) {
      const name = String(value.name).trim();
      if (!name) throw new ApiHttpError(400, 'NAME_REQUIRED', 'Product name is required');
      patch.name = name;
    }
    if (value.price !== undefined) {
      const price = Number(value.price);
      if (!Number.isFinite(price) || price <= 0) throw new ApiHttpError(400, 'INVALID_PRICE', 'Price must be greater than 0');
      patch.price = Math.round(price * 100) / 100;
    }
    if (value.stock !== undefined) {
      const stock = Number(value.stock);
      if (!Number.isFinite(stock)) throw new ApiHttpError(400, 'INVALID_STOCK', 'stock must be numeric');
      patch.stock = Math.max(0, Math.round(stock));
    }
    if (value.zeroStockAction !== undefined) {
      patch.zeroStockAction = value.zeroStockAction === 'hide' ? 'hide' : 'showSoldOut';
    }
    if (value.variants !== undefined) patch.variants = parseVariants(value.variants);
    if (value.description !== undefined) patch.description = String(value.description);
    patch.updatedAt = Date.now();
    const updated = db.table<ProductRow>('products').update(p.id, patch)!;
    logProductOp(session, { productId: p.id, action: 'assistant:apply', field: suggestion.type, after: value });
    audit(session.merchantId, session.staffId, session.role, 'menu:update', 'product', p.id, `assistant applied "${suggestion.title}"`);
    return ok({ product: updated, applied: suggestion.id });
  }),

  h.post('/api/products/assistant/describe', async ({ request }) => {
    const session = requireSession(request);
    requirePerm(session, 'menu:manage');
    const body = await readJson(request);
    const name = String(body.name ?? '').trim();
    if (!name) throw new ApiHttpError(400, 'NAME_REQUIRED', 'Product name is required');
    const category = body.category !== undefined && body.category !== null ? String(body.category) : undefined;
    return ok({ description: describeProduct(name, category) });
  }),

  h.post('/api/products/stock-adjust', async ({ request }) => {
    const session = requireSession(request);
    requirePerm(session, 'menu:manage');
    const body = await readJson(request);
    const items = Array.isArray(body.items) ? body.items : [];
    const reason = body.reason !== undefined && body.reason !== null ? String(body.reason) : undefined;
    const updated: { id: string; stock: number }[] = [];
    for (const x of items) {
      const it = (x ?? {}) as { id?: unknown; set?: unknown; delta?: unknown };
      const id = String(it.id ?? '');
      const p = db.table<ProductRow>('products').find(id);
      if (!p || p.merchantId !== session.merchantId) throw new ApiHttpError(404, 'NOT_FOUND', `Product ${id} not found`);
      let stock: number;
      if (it.set !== undefined) {
        const set = Number(it.set);
        if (!Number.isFinite(set)) throw new ApiHttpError(400, 'INVALID_STOCK', `set for ${id} must be numeric`);
        stock = Math.max(0, Math.round(set));
      } else if (it.delta !== undefined) {
        const delta = Number(it.delta);
        if (!Number.isFinite(delta)) throw new ApiHttpError(400, 'INVALID_STOCK', `delta for ${id} must be numeric`);
        stock = Math.max(0, Math.round(p.stock + delta));
      } else {
        throw new ApiHttpError(400, 'INVALID_STOCK', `item ${id} requires set or delta`);
      }
      const before = p.stock;
      db.table<ProductRow>('products').update(id, { stock, updatedAt: Date.now() });
      logProductOp(session, { productId: id, action: 'product:stock', field: 'stock', before, after: stock });
      audit(session.merchantId, session.staffId, session.role, 'menu:update', 'product', id, `stock adjust ${before} -> ${stock}${reason ? ` (${reason})` : ''}`);
      updated.push({ id, stock });
    }
    return ok({ updated });
  }),

  h.post('/api/products', createProductHandler),

  /* ---- Contract POST /catalogue-items — alias of POST /products ---- */
  h.post('/api/catalogue-items', createProductHandler),

  h.patch('/api/products/:id', patchProductById),

  /* ---- Contract PATCH /catalogue-items/{itemId} — alias of PATCH /products/:id (itemId → id) ---- */
  h.patch('/api/catalogue-items/:itemId', ({ request, params }) =>
    patchProductById({ request, params: { id: String(params.itemId) } }),
  ),

  del('/api/products/:id', (ctx) => deleteProductById(ctx)),
  del('/api/catalogue-items/:itemId', ({ request, params }) => deleteProductById({ request, params: { id: String(params.itemId) } })),

  /* ---- Categories ---- */
  h.get('/api/categories', ({ request }) => {
    const session = requireSession(request);
    const url = new URL(request.url);
    const storeId = url.searchParams.get('storeId');
    let rows = db.table<CategoryRow>('categories').where((c) => c.merchantId === session.merchantId);
    if (storeId) rows = rows.filter((c) => c.storeId === storeId);
    return ok({ categories: [...rows].sort((a, b) => a.sort - b.sort) });
  }),

  h.post('/api/categories', async ({ request }) => {
    const session = requireSession(request);
    requirePerm(session, 'menu:manage');
    const body = await readJson(request);
    const name = String(body.name ?? '').trim();
    if (!name) throw new ApiHttpError(400, 'NAME_REQUIRED', 'Category name is required');
    const storeId = primaryStoreId(session);
    const category: CategoryRow = {
      id: uid('c'),
      merchantId: session.merchantId,
      storeId,
      name,
      sort: nextCategorySort(storeId),
      visible: true,
    };
    db.table<CategoryRow>('categories').insert(category);
    logProductOp(session, { categoryId: category.id, action: 'category:create', after: category });
    audit(session.merchantId, session.staffId, session.role, 'menu:update', 'category', category.id, `created category "${name}"`);
    return ok({ category });
  }),

  h.post('/api/categories/sort', async ({ request }) => {
    const session = requireSession(request);
    requirePerm(session, 'menu:manage');
    const body = await readJson(request);
    const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
    const before = db.table<CategoryRow>('categories').where((c) => c.merchantId === session.merchantId);
    const beforeMap = new Map(before.map((c) => [c.id, c]));
    ids.forEach((id, i) => {
      const c = beforeMap.get(id);
      if (!c) throw new ApiHttpError(400, 'INVALID_CATEGORY', `Category ${id} not found`);
      db.table<CategoryRow>('categories').update(id, { sort: i });
    });
    const after = db.table<CategoryRow>('categories').where((c) => c.merchantId === session.merchantId);
    logProductOp(session, { action: 'category:sort', before: before, after });
    audit(session.merchantId, session.staffId, session.role, 'menu:update', 'category', 'all', `reordered ${ids.length} categories`);
    return ok({ ok: true });
  }),

  h.patch('/api/categories/:id', async ({ request, params }) => {
    const session = requireSession(request);
    requirePerm(session, 'menu:manage');
    const c = db.table<CategoryRow>('categories').find(String(params.id));
    if (!c || c.merchantId !== session.merchantId) throw new ApiHttpError(404, 'NOT_FOUND', 'Category not found');
    const body = await readJson(request);
    const patch: Partial<CategoryRow> = {};
    const changed: { field: string; before: unknown; after: unknown }[] = [];
    if (body.name !== undefined) {
      const name = String(body.name).trim();
      if (!name) throw new ApiHttpError(400, 'NAME_REQUIRED', 'Category name is required');
      patch.name = name;
      changed.push({ field: 'name', before: c.name, after: name });
    }
    if (body.sort !== undefined) {
      const sort = Number(body.sort);
      if (!Number.isFinite(sort)) throw new ApiHttpError(400, 'INVALID_SORT', 'sort must be numeric');
      patch.sort = Math.round(sort);
      changed.push({ field: 'sort', before: c.sort, after: patch.sort });
    }
    if (body.visible !== undefined) {
      patch.visible = body.visible === true;
      changed.push({ field: 'visible', before: c.visible, after: patch.visible });
    }
    const updated = db.table<CategoryRow>('categories').update(c.id, patch)!;
    for (const ch of changed) {
      logProductOp(session, { categoryId: c.id, action: 'category:update', field: ch.field, before: ch.before, after: ch.after });
    }
    audit(session.merchantId, session.staffId, session.role, 'menu:update', 'category', c.id, `updated category ${c.name}`);
    return ok({ category: updated });
  }),

  del('/api/categories/:id', ({ request, params }) => {
    const session = requireSession(request);
    requirePerm(session, 'menu:manage');
    const c = db.table<CategoryRow>('categories').find(String(params.id));
    if (!c || c.merchantId !== session.merchantId) throw new ApiHttpError(404, 'NOT_FOUND', 'Category not found');
    const count = db.table<ProductRow>('products').where((p) => p.categoryId === c.id && p.merchantId === session.merchantId).length;
    if (count > 0) {
      throw new ApiHttpError(409, 'PRODUCTS_ASSIGNED', `Category still has ${count} product(s) — move them first`);
    }
    db.table<CategoryRow>('categories').remove(c.id);
    logProductOp(session, { categoryId: c.id, action: 'category:delete', before: c });
    audit(session.merchantId, session.staffId, session.role, 'menu:update', 'category', c.id, `deleted category ${c.name}`);
    return ok({ deleted: true });
  }),

  /* ---- Stores & customer-facing menu ---- */
  h.get('/api/stores', listStoresHandler),

  /* ---- Contract GET /merchants/me/stores — chain store list (alias of /api/stores) ---- */
  h.get('/api/merchants/me/stores', listStoresHandler),

  h.get('/api/stores/:id/menu', ({ request, params }) => {
    const session = requireSession(request);
    const store = db.table<StoreServer>('stores').find(String(params.id));
    if (!store || store.merchantId !== session.merchantId) throw new ApiHttpError(404, 'NOT_FOUND', 'Store not found');
    const list = db.table<ProductRow>('products').where((p) => p.storeId === store.id && p.visible && !p.deleted);
    const menu = list.filter((p) => p.stock > 0 || p.zeroStockAction === 'showSoldOut');
    return ok({ products: [...menu].sort((a, b) => a.sort - b.sort) });
  }),

  h.patch('/api/stores/:id/menu', async ({ request, params }) => {
    const session = requireSession(request);
    requirePerm(session, 'menu:manage');
    const store = db.table<StoreServer>('stores').find(String(params.id));
    if (!store || store.merchantId !== session.merchantId) throw new ApiHttpError(404, 'NOT_FOUND', 'Store not found');
    const body = await readJson(request);
    const items = Array.isArray(body.items) ? body.items : [];
    let n = 0;
    for (const x of items) {
      const it = (x ?? {}) as { id?: unknown; visible?: unknown; sort?: unknown };
      const p = db.table<ProductRow>('products').find(String(it.id ?? ''));
      if (!p || p.storeId !== store.id) continue;
      const patch: Partial<ProductRow> = {};
      if (it.visible !== undefined) {
        patch.visible = it.visible === true;
        logProductOp(session, { productId: p.id, action: 'menu:update', field: 'visible', before: p.visible, after: patch.visible });
      }
      if (it.sort !== undefined) {
        const sort = Number(it.sort);
        if (!Number.isFinite(sort)) throw new ApiHttpError(400, 'INVALID_SORT', 'sort must be numeric');
        patch.sort = Math.round(sort);
        logProductOp(session, { productId: p.id, action: 'menu:update', field: 'sort', before: p.sort, after: patch.sort });
      }
      if (Object.keys(patch).length) {
        patch.updatedAt = Date.now();
        db.table<ProductRow>('products').update(p.id, patch);
        audit(session.merchantId, session.staffId, session.role, 'menu:update', 'product', p.id, `menu update (${Object.keys(patch).filter((k) => k !== 'updatedAt').join(', ')})`);
        n += 1;
      }
    }
    return ok({ updated: n });
  }),

  /* ---- Templates ---- */
  h.get('/api/templates', listTemplatesHandler),

  /* ---- Contract GET /product-templates — alias of GET /templates ---- */
  h.get('/api/product-templates', listTemplatesHandler),

  h.post('/api/templates', createTemplateHandler),

  /* ---- Contract POST /product-templates — alias of POST /templates ---- */
  h.post('/api/product-templates', createTemplateHandler),

  del('/api/templates/:id', ({ request, params }) => {
    const session = requireSession(request);
    requirePerm(session, 'menu:manage');
    const t = db.table<TemplateRow>('templates').find(String(params.id));
    if (!t || t.merchantId !== session.merchantId) throw new ApiHttpError(404, 'NOT_FOUND', 'Template not found');
    db.table<TemplateRow>('templates').remove(t.id);
    logProductOp(session, { action: 'template:delete', field: 'templateId', after: t.id });
    audit(session.merchantId, session.staffId, session.role, 'menu:update', 'template', t.id, `deleted template "${t.name}"`);
    return ok({ deleted: true });
  }),

  h.post('/api/templates/:id/apply', applyTemplateHandler),

  /* ---- Contract POST /product-templates/{templateId}/apply — alias of /templates/:id/apply (templateId → id) ---- */
  h.post('/api/product-templates/:templateId/apply', ({ request, params }) =>
    applyTemplateHandler({ request, params: { id: String(params.templateId) } }),
  ),

  /* ---- Product templates (contract PATCH/DELETE /product-templates/{templateId}) ----
   * Multi-store product templates; rows live in the app's `templates` table
   * (TemplateRow) and are mapped to the contract ProductTemplate shape. */
  h.patch('/api/product-templates/:id', async ({ request, params }) => {
    const session = requireSession(request);
    requirePerm(session, 'menu:manage');
    const t = db.table<TemplateRow>('templates').find(String(params.id));
    if (!t || t.merchantId !== session.merchantId) throw new ApiHttpError(404, 'NOT_FOUND', 'Template not found');
    const body = await readJson(request);
    const patch: Partial<TemplateRow> = {};
    if (body.name !== undefined) {
      const name = String(body.name).trim();
      if (!name) throw new ApiHttpError(400, 'NAME_REQUIRED', 'Template name is required');
      if (name.length > 160) throw new ApiHttpError(400, 'NAME_TOO_LONG', 'Template name must be ≤ 160 chars');
      patch.name = name;
    }
    if (body.items !== undefined && body.items !== null) {
      if (!Array.isArray(body.items)) throw new ApiHttpError(400, 'INVALID_ITEMS', 'items must be an array');
      const items = (body.items as unknown[]).map((x, i) => {
        const it = (x ?? {}) as { catalogueItemId?: unknown; priceTZS?: unknown; available?: unknown };
        const product = db.table<ProductRow>('products').find(String(it.catalogueItemId ?? ''));
        if (!product || product.merchantId !== session.merchantId) {
          throw new ApiHttpError(400, 'INVALID_ITEMS', `items[${i}] references unknown product ${String(it.catalogueItemId ?? '')}`);
        }
        return {
          catalogueItemId: product.id,
          priceTZS: it.priceTZS !== undefined && it.priceTZS !== null ? Math.round(Number(it.priceTZS)) : Math.round(product.price),
          available: it.available === undefined || it.available === null ? true : it.available === true,
        };
      });
      patch.draft = { ...t.draft, templateItems: items };
    }
    if (body.appliedStoreIds !== undefined && body.appliedStoreIds !== null) {
      if (!Array.isArray(body.appliedStoreIds)) throw new ApiHttpError(400, 'INVALID_STORES', 'appliedStoreIds must be an array');
      const ids = body.appliedStoreIds.map(String);
      for (const id of ids) {
        const store = db.table<StoreServer>('stores').find(id);
        if (!store || store.merchantId !== session.merchantId) {
          throw new ApiHttpError(400, 'INVALID_STORES', `appliedStoreIds references unknown store ${id}`);
        }
      }
      patch.draft = { ...(patch.draft ?? t.draft), appliedStoreIds: ids };
    }
    if (Object.keys(patch).length === 0) {
      throw new ApiHttpError(400, 'EMPTY_PATCH', 'At least one field is required');
    }
    const updated = db.table<TemplateRow>('templates').update(t.id, patch)!;
    logProductOp(session, { action: 'template:update', field: 'templateId', before: t, after: updated });
    audit(session.merchantId, session.staffId, session.role, 'menu:update', 'template', t.id, `updated template "${updated.name}"`);
    return ok({
      template: {
        id: updated.id,
        name: updated.name,
        items: (updated.draft.templateItems as { catalogueItemId: string; priceTZS: number; available: boolean }[] | undefined) ?? [],
        appliedStoreIds: (updated.draft.appliedStoreIds as string[] | undefined) ?? [],
        createdAt: new Date(updated.createdAt).toISOString(),
      },
    });
  }),

  del('/api/product-templates/:id', ({ request, params }) => {
    const session = requireSession(request);
    requirePerm(session, 'menu:manage');
    const t = db.table<TemplateRow>('templates').find(String(params.id));
    if (!t || t.merchantId !== session.merchantId) throw new ApiHttpError(404, 'NOT_FOUND', 'Template not found');
    db.table<TemplateRow>('templates').remove(t.id);
    logProductOp(session, { action: 'template:delete', field: 'templateId', before: t });
    audit(session.merchantId, session.staffId, session.role, 'menu:update', 'template', t.id, `deleted template "${t.name}"`);
    return new Response(null, { status: 204 });
  }),
];
