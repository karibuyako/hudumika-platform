import { http } from 'msw';
import type {
  ClosureProtection,
  ComplianceCheck,
  ComplianceRecheckJob,
  ComplianceStatus,
  ContractReceiptTemplate,
  KitchenCamera,
  NotificationDto,
  OrderDto,
  PaymentAccount,
  Printer,
  Qualification,
  QualificationUpload,
  ReceiptTemplate,
  ReceiptTemplateFields,
  Refund,
  SelfPickupConfig,
  StoreLog,
  StoreQrCode,
  StoreServer,
  TableRow,
} from '@/api/types';
import { db, uid } from '@/mock/db';
import { emit } from '@/mock/events';
import { audit, json, ok, requirePerm, requireSession } from '@/mock/security';
import { ApiHttpError, h, readJson } from '@/mock/handlers/common';
import type { Session } from '@/mock/types-internal';

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
        return Response.json(
          { error: { code: e.code, message: e.message, retriable: e.retriable, details: e.details } },
          { status: e.status },
        );
      }
      throw e;
    }
  });
}

function put(
  path: string,
  fn: (args: { request: Request; params: Record<string, string> }) => Promise<Response> | Response,
) {
  return http.put(`${BASE}${path}`, async (info) => {
    try {
      return await fn({ request: info.request, params: (info.params ?? {}) as Record<string, string> });
    } catch (e) {
      if (e instanceof ApiHttpError) {
        return Response.json(
          { error: { code: e.code, message: e.message, retriable: e.retriable, details: e.details } },
          { status: e.status },
        );
      }
      throw e;
    }
  });
}

function notify(merchantId: string, title: string, body: string, category: string = 'system') {
  const note: NotificationDto = {
    id: uid('n'),
    merchantId,
    type: 'system',
    category: category as NotificationDto['category'],
    title,
    body,
    ts: Date.now(),
    read: false,
  };
  db.table<NotificationDto>('notifications').insert(note);
}

export function logStoreOp(
  session: { merchantId: string; staffId: string; role: string },
  storeId: string,
  entry: { action: string; field?: string; before?: unknown; after?: unknown },
) {
  const log: StoreLog = {
    id: uid('sl'),
    merchantId: session.merchantId,
    storeId,
    action: entry.action,
    field: entry.field,
    before: entry.before,
    after: entry.after,
    actorId: session.staffId,
    role: session.role,
    ts: Date.now(),
  };
  db.table<StoreLog>('storeLogs').insert(log);
}

function requireStore(session: Session, storeId: string): StoreServer {
  const store = db.table<StoreServer>('stores').find(storeId);
  if (!store || store.merchantId !== session.merchantId) throw new ApiHttpError(404, 'NOT_FOUND', 'Store not found');
  return store;
}

/* P6b contract helpers — merchant-scoped contract paths (see the handler
 * section at the bottom of this file). The optional ?storeId= query scopes
 * the demo (one merchant, several stores); the default is the merchant's
 * first store — same convention as the legacy /api endpoints. */
function storeForQuery(session: Session, url: URL): StoreServer {
  const stores = db.table<StoreServer>('stores').where((s) => s.merchantId === session.merchantId);
  if (!stores.length) throw new ApiHttpError(404, 'NOT_FOUND', 'No store for this merchant');
  const id = url.searchParams.get('storeId') ?? stores[0].id;
  const store = stores.find((s) => s.id === id);
  if (!store) throw new ApiHttpError(404, 'NOT_FOUND', 'Store not found');
  return store;
}

const DEFAULT_RECEIPT_FIELDS: ReceiptTemplateFields = {
  logo: true,
  storeName: true,
  address: true,
  phone: true,
  orderId: true,
  date: true,
  items: true,
  subtotal: true,
  tax: true,
  total: true,
  paymentMethod: true,
  thankYou: true,
  qrCode: false,
  cashierName: false,
};

/** Map the app ReceiptTemplate row onto the contract ReceiptTemplate shape. */
function toContractTemplate(t: ReceiptTemplate): ContractReceiptTemplate {
  return {
    id: t.id,
    name: t.name,
    headerText: t.headerText,
    footerText: t.footerText,
    showLogo: t.showLogo,
    logoEmoji: t.logoEmoji || null,
    paperSize: t.paperSize,
    copies: t.copies,
    font: 'monospace',
    fields: { ...DEFAULT_RECEIPT_FIELDS, logo: t.showLogo, qrCode: t.showQRCode, paymentMethod: t.showPayment, cashierName: t.showRider },
    isActive: t.isDefault,
    createdAt: t.updatedAt,
  };
}

const DAY_MS = 86400000;

function protectionDays(from: number, to: number): number {
  return Math.max(1, Math.ceil((to - from) / DAY_MS));
}

function yearStartMs(now = Date.now()): number {
  return new Date(new Date(now).getFullYear(), 0, 1).getTime();
}

function fmtWindow(from: number, to: number): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const fmt = (d: Date) => `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `${fmt(new Date(from))} → ${fmt(new Date(to))}`;
}

function usedProtectionDays(storeId: string, now = Date.now()): number {
  const from = yearStartMs(now);
  return db
    .table<ClosureProtection>('closureProtections')
    .where((p) => p.storeId === storeId && p.status !== 'cancelled' && p.from >= from)
    .reduce((sum, p) => sum + protectionDays(p.from, p.to), 0);
}

function maskAccount(a: PaymentAccount): PaymentAccount {
  return { ...a, account: a.accountMasked };
}

const HTTP_RE = /^https?:\/\/\S+$/;
const ACCOUNT_TYPES = ['bank', 'mobile_money'] as const;
const ACCOUNT_PROVIDERS = ['mpesa', 'tigo_pesa', 'airtel_money', 'ezy_pesa', 'halotel'] as const;
const PAPER_SIZES = ['58mm', '80mm'] as const;
const TABLE_STATUSES = ['idle', 'occupied', 'reserved'] as const;

function computeCompliance(store: StoreServer): ComplianceStatus {
  const now = Date.now();
  const week = now - 7 * DAY_MS;
  const merchant = db.table('merchants').find(store.merchantId);
  const checks: ComplianceCheck[] = [];
  const add = (key: string, label: string, pass: boolean, detail: string) => checks.push({ key, label, pass, detail });

  add(
    'store-info',
    'Store profile complete',
    !!(store.name && store.address && store.phone && store.hours?.open && store.hours?.close && store.hours.open !== store.hours.close),
    'Name, address, phone and valid opening hours',
  );
  add('license', 'Merchant license active', merchant?.status === 'active', `Merchant status: ${merchant?.status ?? 'unknown'}`);
  add('rating', 'Customer rating healthy', (store.rating ?? 0) >= 4.0, `Current rating ${store.rating ?? 0}/5`);
  const approvedRefunds = db
    .table<Refund>('refunds')
    .where((r) => r.merchantId === store.merchantId && r.status === 'approved' && r.createdAt >= week).length;
  const completed = db
    .table<OrderDto>('orders')
    .where((o) => o.merchantId === store.merchantId && o.status === 'completed' && (o.completedAt ?? 0) >= week).length;
  const refundRatio = completed > 0 ? approvedRefunds / completed : 0;
  add('refund-ratio', 'Refund ratio within limits', refundRatio < 0.15, `${approvedRefunds}/${completed} refunds vs completed orders (7d)`);
  const activeAccounts = db.table<PaymentAccount>('paymentAccounts').where((a) => a.storeId === store.id && a.status === 'active').length;
  add('payment-account', 'Active payment account', activeAccounts >= 1, `${activeAccounts} active account(s)`);
  add(
    'delivery',
    'Delivery settings valid',
    (store.deliveryRadiusKm ?? 0) >= 1 && (store.deliveryFee ?? 0) >= 0 && (store.minOrder ?? 0) >= 0,
    `Radius ${store.deliveryRadiusKm}km · fee ${store.deliveryFee} · min ${store.minOrder}`,
  );
  const tableCount = db.table<TableRow>('tables').where((t) => t.storeId === store.id && !t.disabled).length;
  add('tables', 'Dine-in tables configured', tableCount >= 1, `${tableCount} active table(s)`);
  add('open-hours', 'Opening hours set', !!(store.hours?.open && store.hours?.close), `${store.hours?.open} – ${store.hours?.close}`);

  const passed = checks.filter((c) => c.pass).length;
  const score = Math.round((passed / checks.length) * 100);
  const status: ComplianceStatus['status'] =
    merchant?.status === 'suspended' ? 'suspended' : passed === checks.length ? 'compliant' : 'attention';
  return { status, score, checks, updatedAt: now };
}

/* In-flight compliance rechecks (merchant-scoped POST /store/compliance/recheck) —
 * keyed by storeId so a repeat request is blocked while one is running. */
const complianceJobs = new Map<string, ComplianceRecheckJob>();
const COMPLIANCE_RECHECK_BLOCK_MS = 15000;

function deleteReceiptTemplateById({ request, params }: { request: Request; params: Record<string, string> }) {
  const session = requireSession(request);
  requirePerm(session, 'store:manage');
  const template = db.table<ReceiptTemplate>('receiptTemplates').find(String(params.id));
  if (!template) throw new ApiHttpError(404, 'NOT_FOUND', 'Receipt template not found');
  requireStore(session, template.storeId);
  const store = db.table<StoreServer>('stores').find(template.storeId);
  if (template.isDefault && store?.receiptTemplateId === template.id) {
    throw new ApiHttpError(409, 'TEMPLATE_IN_USE', 'This template is assigned to the store — assign another before deleting');
  }
  db.table<ReceiptTemplate>('receiptTemplates').remove(template.id);
  audit(session.merchantId, session.staffId, session.role, 'receipt-template:delete', 'receipt-template', template.id, `deleted template "${template.name}"`);
  return ok({ deleted: true });
}

function deleteTableById({ request, params }: { request: Request; params: Record<string, string> }) {
  const session = requireSession(request);
  requirePerm(session, 'store:manage');
  const table = db.table<TableRow>('tables').find(String(params.id));
  if (!table) throw new ApiHttpError(404, 'NOT_FOUND', 'Table not found');
  requireStore(session, table.storeId);
  db.table<TableRow>('tables').remove(table.id);
  audit(session.merchantId, session.staffId, session.role, 'table:delete', 'table', table.id, `removed table "${table.name}"`);
  return ok({ deleted: true });
}

export const storeOpsHandlers = [
  /* ---- Store ---- */
  h.get('/api/stores/:id', ({ request, params }) => {
    const session = requireSession(request);
    const store = requireStore(session, String(params.id));
    return ok({ store });
  }),

  h.patch('/api/stores/:id/settings', async ({ request, params }) => {
    const session = requireSession(request);
    requirePerm(session, 'store:manage');
    const store = requireStore(session, String(params.id));
    const body = await readJson(request);
    const patch: Partial<StoreServer> = {};
    const changed: { field: string; before: unknown; after: unknown }[] = [];
    const apply = <K extends keyof StoreServer>(key: K, value: StoreServer[K]) => {
      if (JSON.stringify(store[key]) !== JSON.stringify(value)) {
        patch[key] = value;
        changed.push({ field: String(key), before: store[key], after: value });
      }
    };
    const numeric = (value: unknown) => {
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0) throw new ApiHttpError(400, 'INVALID_VALUE', 'Numeric fields must be >= 0');
      return n;
    };
    if (body.name !== undefined) {
      const name = String(body.name).trim();
      if (!name) throw new ApiHttpError(400, 'NAME_REQUIRED', 'Store name is required');
      apply('name', name);
    }
    if (body.address !== undefined) {
      const address = String(body.address).trim();
      if (!address) throw new ApiHttpError(400, 'ADDRESS_REQUIRED', 'Store address is required');
      apply('address', address);
    }
    if (body.phone !== undefined) {
      const phone = String(body.phone).trim();
      if (!phone) throw new ApiHttpError(400, 'PHONE_REQUIRED', 'Store phone is required');
      apply('phone', phone);
    }
    if (body.description !== undefined) apply('description', String(body.description));
    if (body.announcement !== undefined) apply('announcement', String(body.announcement));
    if (body.coverImage !== undefined) apply('coverImage', String(body.coverImage));
    if (body.bannerColor !== undefined) apply('bannerColor', String(body.bannerColor));
    if (body.hours !== undefined) {
      const hours = (body.hours ?? {}) as Record<string, unknown>;
      const open = String(hours.open ?? store.hours.open);
      const close = String(hours.close ?? store.hours.close);
      if (open === close) throw new ApiHttpError(400, 'INVALID_HOURS', 'Opening and closing time cannot be the same');
      let closedDays: unknown[] = store.hours.closedDays;
      if (Array.isArray(hours.closedDays)) {
        const days = hours.closedDays.map(Number);
        if (days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
          throw new ApiHttpError(400, 'INVALID_HOURS', 'closedDays must be day numbers 0-6');
        }
        closedDays = days;
      }
      apply('hours', { open, close, closedDays } as StoreServer['hours']);
    }
    if (body.open !== undefined) apply('open', body.open === true);
    if (body.scheduledReopenAt !== undefined) {
      if (body.scheduledReopenAt === null) {
        apply('scheduledReopenAt', undefined);
      } else {
        const at = Number(body.scheduledReopenAt);
        if (!Number.isFinite(at) || at <= Date.now()) {
          throw new ApiHttpError(400, 'INVALID_REOPEN', 'scheduledReopenAt must be a future timestamp (or null to clear)');
        }
        apply('scheduledReopenAt', at);
      }
    }
    if (body.freeDeliveryThreshold !== undefined) {
      const thr = Number(body.freeDeliveryThreshold);
      if (!Number.isFinite(thr) || thr < 0) throw new ApiHttpError(400, 'INVALID_VALUE', 'freeDeliveryThreshold must be >= 0');
      apply('freeDeliveryThreshold', thr);
    }
    if (body.deliveryRadiusKm !== undefined) apply('deliveryRadiusKm', numeric(body.deliveryRadiusKm));
    if (body.deliveryFee !== undefined) apply('deliveryFee', numeric(body.deliveryFee));
    if (body.minOrder !== undefined) apply('minOrder', numeric(body.minOrder));
    if (body.deliveryEtaMin !== undefined) apply('deliveryEtaMin', numeric(body.deliveryEtaMin));
    if (body.pickupReadyMinutes !== undefined) apply('pickupReadyMinutes', numeric(body.pickupReadyMinutes));
    if (body.orderSettings !== undefined) {
      apply('orderSettings', { ...store.orderSettings, ...((body.orderSettings ?? {}) as Record<string, unknown>) });
    }
    if (body.decoration !== undefined) {
      apply('decoration', { ...store.decoration, ...((body.decoration ?? {}) as Record<string, unknown>) });
    }
    if (body.featuredProductIds !== undefined) {
      apply('featuredProductIds', Array.isArray(body.featuredProductIds) ? body.featuredProductIds.map(String) : []);
    }
    if (body.paymentMethods !== undefined) {
      const pm = (body.paymentMethods ?? {}) as Record<string, unknown>;
      apply('paymentMethods', { mpesa: pm.mpesa === true, airtel_money: pm.airtel_money === true, cod: pm.cod === true, card: pm.card === true });
    }
    if (body.dualScreen !== undefined) {
      apply('dualScreen', { ...store.dualScreen, ...((body.dualScreen ?? {}) as Record<string, unknown>) });
    }
    if (body.qrOrdering !== undefined) {
      apply('qrOrdering', { ...store.qrOrdering, ...((body.qrOrdering ?? {}) as Record<string, unknown>) });
    }
    if (body.receiptTemplateId !== undefined) {
      const tid = body.receiptTemplateId === null || body.receiptTemplateId === '' ? undefined : String(body.receiptTemplateId);
      if (tid) {
        const template = db.table<ReceiptTemplate>('receiptTemplates').find(tid);
        if (!template || template.storeId !== store.id) {
          throw new ApiHttpError(400, 'INVALID_TEMPLATE', 'Receipt template does not exist for this store');
        }
      }
      apply('receiptTemplateId', tid);
    }
    db.table<StoreServer>('stores').update(store.id, patch)!;
    const activeProtection = db
      .table<ClosureProtection>('closureProtections')
      .where((p) => p.storeId === store.id && p.status === 'active')[0];
    if (body.open === true && !store.open && activeProtection) {
      db.table<ClosureProtection>('closureProtections').update(activeProtection.id, { status: 'cancelled' });
      logStoreOp(session, store.id, { action: 'closure:cancel', field: 'status', before: 'active', after: 'cancelled' });
      audit(
        session.merchantId,
        session.staffId,
        session.role,
        'closure:cancel',
        'closure',
        activeProtection.id,
        `cancelled closure protection for ${store.name} — store reopened manually`,
      );
      notify(session.merchantId, 'Closure protection cancelled', 'The store was reopened manually — protection ended.', 'important');
    }
    // Opening manually must also clear any pending scheduled reopen.
    if (body.open === true && store.scheduledReopenAt) {
      apply('scheduledReopenAt', undefined);
      db.table<StoreServer>('stores').update(store.id, { scheduledReopenAt: undefined });
    }
    if (changed.length) {
      audit(session.merchantId, session.staffId, session.role, 'store:update', 'store', store.id, `updated store settings (${changed.map((c) => c.field).join(', ')})`);
      for (const c of changed) {
        logStoreOp(session, store.id, { action: 'store:update', field: c.field, before: c.before, after: c.after });
      }
    }
    const finalStore = db.table<StoreServer>('stores').find(store.id)!;
    if (changed.length) emit({ type: 'merchant.updated', store: finalStore, at: Date.now() });
    return ok({ store: finalStore });
  }),

  h.get('/api/stores/:id/logs', ({ request, params }) => {
    const session = requireSession(request);
    const store = requireStore(session, String(params.id));
    const logs = db
      .table<StoreLog>('storeLogs')
      .where((l) => l.storeId === store.id && l.merchantId === session.merchantId)
      .sort((a, b) => b.ts - a.ts)
      .slice(0, 100);
    return ok({ logs });
  }),

  h.get('/api/stores/:id/qr', ({ request, params }) => {
    const session = requireSession(request);
    const store = requireStore(session, String(params.id));
    const qrToken = uid('sqr');
    const base = store.qrOrdering?.urlPattern || 'https://order.example.com/q';
    return ok({ qrUrl: `${base}/${store.id}?t=${qrToken}`, qrToken });
  }),

  /* ---- Closure protection ---- */
  h.post('/api/closure/apply', async ({ request }) => {
    const session = requireSession(request);
    requirePerm(session, 'store:manage');
    const body = await readJson(request);
    const storeId = String(body.storeId ?? '');
    const store = requireStore(session, storeId);
    const reason = String(body.reason ?? '').trim();
    if (!reason) throw new ApiHttpError(400, 'REASON_REQUIRED', 'A closure reason is required');
    const now = Date.now();
    const from = Number(body.from);
    const to = Number(body.to);
    if (!Number.isFinite(from) || !Number.isFinite(to)) {
      throw new ApiHttpError(400, 'INVALID_PERIOD', 'from and to must be valid timestamps');
    }
    if (from < now - 3600000 || from > now + 30 * DAY_MS) {
      throw new ApiHttpError(400, 'INVALID_PERIOD', 'from must be within the next 30 days');
    }
    if (to <= from) throw new ApiHttpError(400, 'INVALID_PERIOD', 'to must be after from');
    const active = db.table<ClosureProtection>('closureProtections').where((p) => p.storeId === storeId && p.status === 'active');
    if (active.length) throw new ApiHttpError(409, 'PROTECTION_ACTIVE', 'A closure protection is already active for this store');
    const days = protectionDays(from, to);
    if (usedProtectionDays(storeId, now) + days > 15) {
      throw new ApiHttpError(409, 'PROTECTION_QUOTA', 'Closure protection is capped at 15 days per year');
    }
    const protection: ClosureProtection = {
      id: uid('cp'),
      storeId,
      from,
      to,
      reason,
      status: 'active',
      createdAt: now,
    };
    db.table<ClosureProtection>('closureProtections').insert(protection);
    db.table<StoreServer>('stores').update(storeId, { open: false });
    audit(session.merchantId, session.staffId, session.role, 'closure:apply', 'closure', protection.id, `closed ${store.name} ${fmtWindow(from, to)} (${days} day(s)) — ${reason}`);
    logStoreOp(session, storeId, { action: 'closure:apply', after: { from, to } });
    notify(session.merchantId, 'Closure protection active', `Store closed ${fmtWindow(from, to)} (${days} day(s)). Reopen manually when ready.`, 'important');
    return ok({ protection });
  }),

  h.get('/api/closure/status', ({ request }) => {
    requireSession(request);
    const url = new URL(request.url);
    const storeId = url.searchParams.get('storeId') ?? '';
    const now = Date.now();
    const active = db
      .table<ClosureProtection>('closureProtections')
      .where((p) => p.storeId === storeId && p.status === 'active')
      .sort((a, b) => b.from - a.from)[0];
    const usedDaysThisYear = usedProtectionDays(storeId, now);
    return ok({ protection: active ?? null, usedDaysThisYear, remainingDays: Math.max(0, 15 - usedDaysThisYear) });
  }),

  h.post('/api/closure/cancel', async ({ request }) => {
    const session = requireSession(request);
    requirePerm(session, 'store:manage');
    const body = await readJson(request);
    const storeId = String(body.storeId ?? '');
    const store = requireStore(session, storeId);
    const protection = db.table<ClosureProtection>('closureProtections').where((p) => p.storeId === storeId && p.status === 'active')[0];
    if (!protection) throw new ApiHttpError(404, 'NOT_FOUND', 'No active closure protection');
    db.table<ClosureProtection>('closureProtections').update(protection.id, { status: 'cancelled' });
    audit(session.merchantId, session.staffId, session.role, 'closure:cancel', 'closure', protection.id, `cancelled closure protection for ${store.name}`);
    logStoreOp(session, storeId, { action: 'closure:cancel', field: 'status', before: 'active', after: 'cancelled' });
    notify(session.merchantId, 'Closure protection cancelled', `The closure window ${fmtWindow(protection.from, protection.to)} was cancelled. The store stays closed until you reopen it.`, 'important');
    return ok({ cancelled: true });
  }),

  /* ---- Payment accounts ---- */
  h.get('/api/payment-accounts', ({ request }) => {
    requireSession(request);
    const url = new URL(request.url);
    const storeId = url.searchParams.get('storeId') ?? '';
    return ok({ accounts: db.table<PaymentAccount>('paymentAccounts').where((a) => a.storeId === storeId).map(maskAccount) });
  }),

  h.post('/api/payment-accounts', async ({ request }) => {
    const session = requireSession(request);
    requirePerm(session, 'store:manage');
    const body = await readJson(request);
    const storeId = String(body.storeId ?? '');
    requireStore(session, storeId);
    const name = String(body.name ?? '').trim();
    if (!name) throw new ApiHttpError(400, 'NAME_REQUIRED', 'Account name is required');
    const type = ACCOUNT_TYPES.includes(String(body.type) as (typeof ACCOUNT_TYPES)[number]) ? (String(body.type) as PaymentAccount['type']) : undefined;
    if (!type) throw new ApiHttpError(400, 'INVALID_ACCOUNT', 'type must be bank or mobile_money');
    const provider =
      type === 'bank' ? 'bank' : ((ACCOUNT_PROVIDERS as readonly string[]).includes(String(body.provider)) ? String(body.provider) : 'mpesa');
    const account = String(body.account ?? '').trim();
    if (!/^\d{8,32}$/.test(account)) throw new ApiHttpError(400, 'INVALID_ACCOUNT', 'Account must be 8-32 digits');
    const existing = db.table<PaymentAccount>('paymentAccounts').where((a) => a.storeId === storeId);
    const row: PaymentAccount = {
      id: uid('pa'),
      storeId,
      type,
      provider,
      name,
      account,
      accountMasked: `****${account.slice(-4)}`,
      status: 'pending',
      isDefault: existing.length === 0,
      createdAt: Date.now(),
    };
    db.table<PaymentAccount>('paymentAccounts').insert(row);
    audit(session.merchantId, session.staffId, session.role, 'payment-account:create', 'payment-account', row.id, `added ${type} account "${name}" (${row.accountMasked})`);
    return ok({ account: maskAccount(row) });
  }),

  h.post('/api/payment-accounts/:id/verify', async ({ request, params }) => {
    const session = requireSession(request);
    requirePerm(session, 'store:manage');
    const account = db.table<PaymentAccount>('paymentAccounts').find(String(params.id));
    if (!account) throw new ApiHttpError(404, 'NOT_FOUND', 'Payment account not found');
    requireStore(session, account.storeId);
    if (account.status !== 'active') {
      db.table<PaymentAccount>('paymentAccounts').update(account.id, { status: 'active' });
      audit(session.merchantId, session.staffId, session.role, 'payment-account:verify', 'payment-account', account.id, `verified ${account.type} account "${account.name}"`);
    }
    return ok({ account: maskAccount(db.table<PaymentAccount>('paymentAccounts').find(account.id)!) });
  }),

  h.patch('/api/payment-accounts/:id', async ({ request, params }) => {
    const session = requireSession(request);
    requirePerm(session, 'store:manage');
    const account = db.table<PaymentAccount>('paymentAccounts').find(String(params.id));
    if (!account) throw new ApiHttpError(404, 'NOT_FOUND', 'Payment account not found');
    requireStore(session, account.storeId);
    const body = await readJson(request);
    const patch: Partial<PaymentAccount> = {};
    if (body.name !== undefined) {
      const name = String(body.name).trim();
      if (!name) throw new ApiHttpError(400, 'NAME_REQUIRED', 'Account name is required');
      patch.name = name;
    }
    if (body.type !== undefined) {
      if (!ACCOUNT_TYPES.includes(String(body.type) as (typeof ACCOUNT_TYPES)[number])) {
        throw new ApiHttpError(400, 'INVALID_ACCOUNT', 'type must be bank or mobile_money');
      }
      patch.type = String(body.type) as PaymentAccount['type'];
    }
    if (body.isDefault !== undefined) {
      const isDefault = body.isDefault === true;
      if (!isDefault && account.isDefault) {
        const defaults = db.table<PaymentAccount>('paymentAccounts').where((a) => a.storeId === account.storeId && a.isDefault);
        if (defaults.length <= 1) throw new ApiHttpError(409, 'LAST_DEFAULT', 'At least one default payment account is required');
      }
      patch.isDefault = isDefault;
      if (isDefault) {
        db.table<PaymentAccount>('paymentAccounts')
          .where((a) => a.storeId === account.storeId && a.id !== account.id && a.isDefault)
          .forEach((a) => db.table<PaymentAccount>('paymentAccounts').update(a.id, { isDefault: false }));
      }
    }
    const updated = db.table<PaymentAccount>('paymentAccounts').update(account.id, patch)!;
    audit(session.merchantId, session.staffId, session.role, 'payment-account:update', 'payment-account', account.id, `updated "${updated.name}" (${Object.keys(patch).join(', ') || 'no change'})`);
    return ok({ account: maskAccount(updated) });
  }),

  del('/api/payment-accounts/:id', ({ request, params }) => {
    const session = requireSession(request);
    requirePerm(session, 'store:manage');
    const account = db.table<PaymentAccount>('paymentAccounts').find(String(params.id));
    if (!account) throw new ApiHttpError(404, 'NOT_FOUND', 'Payment account not found');
    requireStore(session, account.storeId);
    const remaining = db.table<PaymentAccount>('paymentAccounts').where((a) => a.storeId === account.storeId && a.id !== account.id);
    db.table<PaymentAccount>('paymentAccounts').remove(account.id);
    let newDefault: { id: string; accountMasked: string } | undefined;
    if (account.isDefault && remaining.length) {
      const replacement = [...remaining].sort((a, b) => b.createdAt - a.createdAt)[0];
      db.table<PaymentAccount>('paymentAccounts').update(replacement.id, { isDefault: true });
      newDefault = { id: replacement.id, accountMasked: replacement.accountMasked };
    }
    audit(session.merchantId, session.staffId, session.role, 'payment-account:delete', 'payment-account', account.id, `removed ${account.type} account "${account.name}"`);
    return ok({ deleted: true, newDefault });
  }),

  /* ---- Receipt templates ---- */
  h.get('/api/receipt-templates/active', ({ request }) => {
    requireSession(request);
    const url = new URL(request.url);
    const storeId = url.searchParams.get('storeId') ?? '';
    const template = db.table<ReceiptTemplate>('receiptTemplates').where((t) => t.storeId === storeId && t.isDefault)[0];
    if (!template) throw new ApiHttpError(404, 'NOT_FOUND', 'No default receipt template for this store');
    return ok({ template });
  }),

  h.get('/api/receipt-templates', ({ request }) => {
    requireSession(request);
    const url = new URL(request.url);
    const storeId = url.searchParams.get('storeId') ?? '';
    return ok({ templates: db.table<ReceiptTemplate>('receiptTemplates').where((t) => t.storeId === storeId) });
  }),

  h.post('/api/receipt-templates', async ({ request }) => {
    const session = requireSession(request);
    requirePerm(session, 'store:manage');
    const body = await readJson(request);
    const storeId = String(body.storeId ?? '');
    requireStore(session, storeId);
    const name = String(body.name ?? '').trim();
    if (!name) throw new ApiHttpError(400, 'NAME_REQUIRED', 'Template name is required');
    const paperSize = body.paperSize === '58mm' ? '58mm' : '80mm';
    const copies = body.copies === undefined ? 1 : Number(body.copies);
    if (!Number.isInteger(copies) || copies < 1 || copies > 5) throw new ApiHttpError(400, 'INVALID_COPIES', 'copies must be between 1 and 5');
    const existing = db.table<ReceiptTemplate>('receiptTemplates').where((t) => t.storeId === storeId);
    const template: ReceiptTemplate = {
      id: uid('rt'),
      storeId,
      name,
      headerText: String(body.headerText ?? ''),
      footerText: String(body.footerText ?? 'Thanks!'),
      showLogo: body.showLogo === undefined ? true : body.showLogo === true,
      showQRCode: body.showQRCode === undefined ? true : body.showQRCode === true,
      showPayment: body.showPayment === undefined ? true : body.showPayment === true,
      showRider: body.showRider === undefined ? true : body.showRider === true,
      paperSize,
      copies,
      logoEmoji: String(body.logoEmoji ?? '🍢'),
      isDefault: existing.length === 0,
      updatedAt: Date.now(),
    };
    db.table<ReceiptTemplate>('receiptTemplates').insert(template);
    audit(session.merchantId, session.staffId, session.role, 'receipt-template:create', 'receipt-template', template.id, `created template "${name}"`);
    return ok({ template });
  }),

  h.patch('/api/receipt-templates/:id', async ({ request, params }) => {
    const session = requireSession(request);
    requirePerm(session, 'store:manage');
    const template = db.table<ReceiptTemplate>('receiptTemplates').find(String(params.id));
    if (!template) throw new ApiHttpError(404, 'NOT_FOUND', 'Receipt template not found');
    requireStore(session, template.storeId);
    const body = await readJson(request);
    const patch: Partial<ReceiptTemplate> = {};
    if (body.name !== undefined) {
      const name = String(body.name).trim();
      if (!name) throw new ApiHttpError(400, 'NAME_REQUIRED', 'Template name is required');
      patch.name = name;
    }
    if (body.headerText !== undefined) patch.headerText = String(body.headerText);
    if (body.footerText !== undefined) patch.footerText = String(body.footerText);
    if (body.logoEmoji !== undefined) patch.logoEmoji = String(body.logoEmoji);
    if (body.showLogo !== undefined) patch.showLogo = body.showLogo === true;
    if (body.showQRCode !== undefined) patch.showQRCode = body.showQRCode === true;
    if (body.showPayment !== undefined) patch.showPayment = body.showPayment === true;
    if (body.showRider !== undefined) patch.showRider = body.showRider === true;
    if (body.paperSize !== undefined) {
      if (!PAPER_SIZES.includes(body.paperSize as (typeof PAPER_SIZES)[number])) {
        throw new ApiHttpError(400, 'INVALID_PAPER', 'paperSize must be 58mm or 80mm');
      }
      patch.paperSize = body.paperSize as ReceiptTemplate['paperSize'];
    }
    if (body.copies !== undefined) {
      const copies = Number(body.copies);
      if (!Number.isInteger(copies) || copies < 1 || copies > 5) throw new ApiHttpError(400, 'INVALID_COPIES', 'copies must be between 1 and 5');
      patch.copies = copies;
    }
    const updated = db.table<ReceiptTemplate>('receiptTemplates').update(template.id, { ...patch, updatedAt: Date.now() })!;
    audit(session.merchantId, session.staffId, session.role, 'receipt-template:update', 'receipt-template', template.id, `updated template "${updated.name}"`);
    return ok({ template: updated });
  }),

  del('/api/receipt-templates/:id', (ctx) => deleteReceiptTemplateById(ctx)),
  del('/api/store/receipt-templates/:templateId', ({ request, params }) => deleteReceiptTemplateById({ request, params: { id: String(params.templateId) } })),

  /* ---- Printers ---- */
  h.get('/api/printers', ({ request }) => {
    requireSession(request);
    const url = new URL(request.url);
    const storeId = url.searchParams.get('storeId') ?? '';
    return ok({ printers: db.table<Printer>('printers').where((p) => p.storeId === storeId) });
  }),

  h.post('/api/printers', async ({ request }) => {
    const session = requireSession(request);
    requirePerm(session, 'store:manage');
    const body = await readJson(request);
    const storeId = String(body.storeId ?? '');
    requireStore(session, storeId);
    const name = String(body.name ?? '').trim();
    if (!name) throw new ApiHttpError(400, 'NAME_REQUIRED', 'Printer name is required');
    const type = body.type === 'bluetooth' || body.type === 'network' || body.type === 'cloud' ? body.type : undefined;
    if (!type) throw new ApiHttpError(400, 'INVALID_PRINTER', 'type must be bluetooth, network or cloud');
    const paperSize = body.paperSize === '58mm' ? '58mm' : '80mm';
    const copies = body.copies === undefined ? 1 : Number(body.copies);
    if (!Number.isInteger(copies) || copies < 1 || copies > 5) throw new ApiHttpError(400, 'INVALID_COPIES', 'copies must be between 1 and 5');
    let purpose: Printer['purpose'] = 'receipt';
    if (body.purpose !== undefined) {
      if (body.purpose !== 'receipt' && body.purpose !== 'kitchen') {
        throw new ApiHttpError(400, 'INVALID_PURPOSE', 'purpose must be receipt or kitchen');
      }
      purpose = body.purpose;
    }
    const existing = db.table<Printer>('printers').where((p) => p.storeId === storeId);
    const printer: Printer = {
      id: uid('pr'),
      storeId,
      name,
      type,
      status: 'pairing',
      paperSize,
      copies,
      purpose,
      isDefault: existing.length === 0,
      createdAt: Date.now(),
    };
    db.table<Printer>('printers').insert(printer);
    audit(session.merchantId, session.staffId, session.role, 'printer:create', 'printer', printer.id, `added ${type} printer "${name}"`);
    return ok({ printer });
  }),

  h.post('/api/printers/:id/connect', async ({ request, params }) => {
    const session = requireSession(request);
    requirePerm(session, 'store:manage');
    const printer = db.table<Printer>('printers').find(String(params.id));
    if (!printer) throw new ApiHttpError(404, 'NOT_FOUND', 'Printer not found');
    requireStore(session, printer.storeId);
    if (printer.status !== 'connected') {
      db.table<Printer>('printers').update(printer.id, { status: 'connected' });
      audit(session.merchantId, session.staffId, session.role, 'printer:connect', 'printer', printer.id, `connected "${printer.name}"`);
    }
    return ok({ printer: db.table<Printer>('printers').find(printer.id)! });
  }),

  h.patch('/api/printers/:id', async ({ request, params }) => {
    const session = requireSession(request);
    requirePerm(session, 'store:manage');
    const printer = db.table<Printer>('printers').find(String(params.id));
    if (!printer) throw new ApiHttpError(404, 'NOT_FOUND', 'Printer not found');
    requireStore(session, printer.storeId);
    const body = await readJson(request);
    const patch: Partial<Printer> = {};
    if (body.name !== undefined) {
      const name = String(body.name).trim();
      if (!name) throw new ApiHttpError(400, 'NAME_REQUIRED', 'Printer name is required');
      patch.name = name;
    }
    if (body.paperSize !== undefined) {
      if (!PAPER_SIZES.includes(body.paperSize as (typeof PAPER_SIZES)[number])) {
        throw new ApiHttpError(400, 'INVALID_PAPER', 'paperSize must be 58mm or 80mm');
      }
      patch.paperSize = body.paperSize as Printer['paperSize'];
    }
    if (body.copies !== undefined) {
      const copies = Number(body.copies);
      if (!Number.isInteger(copies) || copies < 1 || copies > 5) throw new ApiHttpError(400, 'INVALID_COPIES', 'copies must be between 1 and 5');
      patch.copies = copies;
    }
    if (body.purpose !== undefined) {
      if (body.purpose !== 'receipt' && body.purpose !== 'kitchen') {
        throw new ApiHttpError(400, 'INVALID_PURPOSE', 'purpose must be receipt or kitchen');
      }
      patch.purpose = body.purpose as Printer['purpose'];
    }
    if (body.isDefault !== undefined) {
      const isDefault = body.isDefault === true;
      patch.isDefault = isDefault;
      if (isDefault) {
        db.table<Printer>('printers')
          .where((p) => p.storeId === printer.storeId && p.id !== printer.id && p.isDefault)
          .forEach((p) => db.table<Printer>('printers').update(p.id, { isDefault: false }));
      }
    }
    const updated = db.table<Printer>('printers').update(printer.id, patch)!;
    audit(session.merchantId, session.staffId, session.role, 'printer:update', 'printer', printer.id, `updated "${updated.name}" (${Object.keys(patch).join(', ') || 'no change'})`);
    return ok({ printer: updated });
  }),

  h.post('/api/printers/:id/test', async ({ request, params }) => {
    const session = requireSession(request);
    requirePerm(session, 'store:manage');
    const printer = db.table<Printer>('printers').find(String(params.id));
    if (!printer) throw new ApiHttpError(404, 'NOT_FOUND', 'Printer not found');
    requireStore(session, printer.storeId);
    if (printer.status !== 'connected') throw new ApiHttpError(409, 'PRINTER_OFFLINE', 'Printer is not connected');
    const jobId = uid('pj');
    audit(session.merchantId, session.staffId, session.role, 'printer:test', 'printer', printer.id, `sent test print to "${printer.name}" (${jobId})`);
    return ok({ printed: true, jobId });
  }),

  del('/api/printers/:id', ({ request, params }) => {
    const session = requireSession(request);
    requirePerm(session, 'store:manage');
    const printer = db.table<Printer>('printers').find(String(params.id));
    if (!printer) throw new ApiHttpError(404, 'NOT_FOUND', 'Printer not found');
    requireStore(session, printer.storeId);
    db.table<Printer>('printers').remove(printer.id);
    audit(session.merchantId, session.staffId, session.role, 'printer:delete', 'printer', printer.id, `removed "${printer.name}"`);
    return ok({ deleted: true });
  }),

  /* ---- Tables ---- */
  h.get('/api/tables', ({ request }) => {
    requireSession(request);
    const url = new URL(request.url);
    const storeId = url.searchParams.get('storeId') ?? '';
    return ok({ tables: db.table<TableRow>('tables').where((t) => t.storeId === storeId) });
  }),

  h.post('/api/tables', async ({ request }) => {
    const session = requireSession(request);
    requirePerm(session, 'store:manage');
    const body = await readJson(request);
    const storeId = String(body.storeId ?? '');
    const store = requireStore(session, storeId);
    const name = String(body.name ?? '').trim();
    const capacity = Number(body.capacity);
    if (!name || !Number.isInteger(capacity) || capacity < 1) {
      throw new ApiHttpError(400, 'INVALID_TABLE', 'Table name and capacity >= 1 are required');
    }
    const id = uid('tbl');
    const qrToken = uid('qr');
    const base = store.qrOrdering?.urlPattern || 'https://order.example.com/q';
    const table: TableRow = {
      id,
      storeId,
      name,
      zone: body.zone !== undefined && body.zone !== null ? String(body.zone) : '',
      capacity,
      status: 'idle',
      qrToken,
      qrUrl: `${base}/${storeId}/${id}?t=${qrToken}`,
      disabled: false,
      createdAt: Date.now(),
    };
    db.table<TableRow>('tables').insert(table);
    audit(session.merchantId, session.staffId, session.role, 'table:create', 'table', table.id, `added table "${name}" (capacity ${capacity})`);
    return ok({ table });
  }),

  h.patch('/api/tables/:id', async ({ request, params }) => {
    const session = requireSession(request);
    requirePerm(session, 'store:manage');
    const table = db.table<TableRow>('tables').find(String(params.id));
    if (!table) throw new ApiHttpError(404, 'NOT_FOUND', 'Table not found');
    requireStore(session, table.storeId);
    const body = await readJson(request);
    const patch: Partial<TableRow> = {};
    if (body.name !== undefined) {
      const name = String(body.name).trim();
      if (!name) throw new ApiHttpError(400, 'INVALID_TABLE', 'Table name is required');
      patch.name = name;
    }
    if (body.zone !== undefined) patch.zone = String(body.zone);
    if (body.capacity !== undefined) {
      const capacity = Number(body.capacity);
      if (!Number.isInteger(capacity) || capacity < 1) throw new ApiHttpError(400, 'INVALID_TABLE', 'capacity must be >= 1');
      patch.capacity = capacity;
    }
    if (body.status !== undefined) {
      if (!TABLE_STATUSES.includes(body.status as (typeof TABLE_STATUSES)[number])) {
        throw new ApiHttpError(400, 'INVALID_TABLE', 'status must be idle, occupied or reserved');
      }
      patch.status = body.status as TableRow['status'];
    }
    if (body.disabled !== undefined) patch.disabled = body.disabled === true;
    const updated = db.table<TableRow>('tables').update(table.id, patch)!;
    audit(session.merchantId, session.staffId, session.role, 'table:update', 'table', table.id, `updated table "${updated.name}" (${Object.keys(patch).join(', ') || 'no change'})`);
    return ok({ table: updated });
  }),

  h.post('/api/tables/:id/qr', async ({ request, params }) => {
    const session = requireSession(request);
    requirePerm(session, 'store:manage');
    const table = db.table<TableRow>('tables').find(String(params.id));
    if (!table) throw new ApiHttpError(404, 'NOT_FOUND', 'Table not found');
    const store = requireStore(session, table.storeId);
    const qrToken = uid('qr');
    const base = store.qrOrdering?.urlPattern || 'https://order.example.com/q';
    const updated = db.table<TableRow>('tables').update(table.id, { qrToken, qrUrl: `${base}/${table.storeId}/${table.id}?t=${qrToken}` })!;
    audit(session.merchantId, session.staffId, session.role, 'table:qr', 'table', table.id, `regenerated QR for table "${table.name}"`);
    return ok({ table: updated });
  }),

  del('/api/tables/:id', (ctx) => deleteTableById(ctx)),
  del('/api/dine-in/tables/:tableId', ({ request, params }) => deleteTableById({ request, params: { id: String(params.tableId) } })),

  /* ---- QR ordering & dual screen ---- */
  h.get('/api/stores/:id/qr-ordering', ({ request, params }) => {
    const session = requireSession(request);
    const store = requireStore(session, String(params.id));
    return ok({ qrOrdering: store.qrOrdering });
  }),

  h.patch('/api/stores/:id/qr-ordering', async ({ request, params }) => {
    const session = requireSession(request);
    requirePerm(session, 'store:manage');
    const store = requireStore(session, String(params.id));
    const body = await readJson(request);
    const qrOrdering = { ...store.qrOrdering };
    if (body.enabled !== undefined) qrOrdering.enabled = body.enabled === true;
    if (body.type !== undefined) {
      if (body.type !== 'table' && body.type !== 'counter') throw new ApiHttpError(400, 'INVALID_TYPE', 'type must be table or counter');
      qrOrdering.type = body.type;
    }
    if (body.urlPattern !== undefined) {
      const url = String(body.urlPattern);
      if (!HTTP_RE.test(url)) throw new ApiHttpError(400, 'INVALID_URL', 'urlPattern must be a valid http(s) URL');
      qrOrdering.urlPattern = url;
    }
    const updated = db.table<StoreServer>('stores').update(store.id, { qrOrdering })!;
    audit(session.merchantId, session.staffId, session.role, 'store:update', 'store', store.id, `updated qr-ordering (${Object.keys(body).join(', ')})`);
    emit({ type: 'merchant.updated', store: updated, at: Date.now() });
    return ok({ qrOrdering: updated.qrOrdering });
  }),

  h.get('/api/stores/:id/dual-screen', ({ request, params }) => {
    const session = requireSession(request);
    const store = requireStore(session, String(params.id));
    return ok({ dualScreen: store.dualScreen });
  }),

  h.patch('/api/stores/:id/dual-screen', async ({ request, params }) => {
    const session = requireSession(request);
    requirePerm(session, 'store:manage');
    const store = requireStore(session, String(params.id));
    const body = await readJson(request);
    const dualScreen = { ...store.dualScreen };
    if (body.enabled !== undefined) dualScreen.enabled = body.enabled === true;
    if (body.screen !== undefined) {
      if (body.screen !== 'orders' && body.screen !== 'kitchen' && body.screen !== 'media') {
        throw new ApiHttpError(400, 'INVALID_SCREEN', 'screen must be orders, kitchen or media');
      }
      dualScreen.screen = body.screen;
    }
    if (body.refreshSec !== undefined) {
      const refreshSec = Number(body.refreshSec);
      if (!Number.isInteger(refreshSec) || refreshSec < 5 || refreshSec > 60) {
        throw new ApiHttpError(400, 'INVALID_REFRESH', 'refreshSec must be between 5 and 60');
      }
      dualScreen.refreshSec = refreshSec;
    }
    if (body.showOrderNumbers !== undefined) dualScreen.showOrderNumbers = body.showOrderNumbers === true;
    if (body.theme !== undefined) {
      if (body.theme !== 'dark' && body.theme !== 'light') throw new ApiHttpError(400, 'INVALID_THEME', 'theme must be dark or light');
      dualScreen.theme = body.theme;
    }
    const updated = db.table<StoreServer>('stores').update(store.id, { dualScreen })!;
    audit(session.merchantId, session.staffId, session.role, 'store:update', 'store', store.id, `updated dual-screen (${Object.keys(body).join(', ')})`);
    emit({ type: 'merchant.updated', store: updated, at: Date.now() });
    return ok({ dualScreen: updated.dualScreen });
  }),

  h.post('/api/dual-screen/pair', async ({ request }) => {
    const session = requireSession(request);
    requirePerm(session, 'store:manage');
    const body = await readJson(request);
    const code = String(body.code ?? '').trim();
    const store = db.table<StoreServer>('stores').all().find((s) => s.dualScreen?.pairingCode === code);
    if (!store) throw new ApiHttpError(404, 'PAIR_NOT_FOUND', 'No store found for this pairing code');
    return ok({ paired: true, storeId: store.id });
  }),

  /* ---- Compliance ---- */
  h.get('/api/stores/:id/compliance', ({ request, params }) => {
    const session = requireSession(request);
    const store = requireStore(session, String(params.id));
    return ok({ compliance: computeCompliance(store) });
  }),

  h.post('/api/stores/:id/compliance/recheck', async ({ request, params }) => {
    const session = requireSession(request);
    requirePerm(session, 'store:manage');
    const store = requireStore(session, String(params.id));
    const compliance = computeCompliance(store);
    audit(session.merchantId, session.staffId, session.role, 'compliance:recheck', 'store', store.id, `rechecked compliance → ${compliance.status} (${compliance.score}/100)`);
    logStoreOp(session, store.id, { action: 'compliance:recheck', after: { status: compliance.status, score: compliance.score } });
    return ok({ compliance });
  }),

  /* ---- Assigned receipt template (print screen convenience) ---- */
  h.get('/api/stores/:id/receipt-template', ({ request, params }) => {
    const session = requireSession(request);
    const store = requireStore(session, String(params.id));
    const template =
      db.table<ReceiptTemplate>('receiptTemplates').find(store.receiptTemplateId ?? '') ??
      db.table<ReceiptTemplate>('receiptTemplates').where((t) => t.storeId === store.id && t.isDefault)[0];
    if (!template) throw new ApiHttpError(404, 'NOT_FOUND', 'No receipt template assigned to this store');
    return ok({ template });
  }),

  /* ================= P6b contract: store settings (merchant-scoped) =================
   * Paths mirror API-CONTRACT.yaml: /store/kitchen-camera, /store/qualifications,
   * /store/self-pickup, /store/qr-codes, /store/receipt-templates. */

  /* ---- Kitchen camera (GET/PATCH /store/kitchen-camera) ---- */
  h.get('/api/store/kitchen-camera', ({ request }) => {
    const session = requireSession(request);
    const store = storeForQuery(session, new URL(request.url));
    const row = db.table<KitchenCamera & { id: string; storeId: string }>('kitchenCameras').where((c) => c.storeId === store.id)[0];
    if (!row) throw new ApiHttpError(404, 'KITCHEN_CAMERA_NOT_CONFIGURED', 'Kitchen camera is not configured for this store');
    const { id: _id, storeId: _sid, ...camera } = row;
    return ok(camera);
  }),

  h.patch('/api/store/kitchen-camera', async ({ request }) => {
    const session = requireSession(request);
    requirePerm(session, 'store:manage');
    const store = storeForQuery(session, new URL(request.url));
    const body = await readJson(request);
    const table = db.table<KitchenCamera & { id: string; storeId: string }>('kitchenCameras');
    const current = table.where((c) => c.storeId === store.id)[0];
    const next: KitchenCamera = {
      enabled: body.enabled === undefined ? (current?.enabled ?? false) : body.enabled === true,
      streamUrl: body.streamUrl === undefined ? current?.streamUrl : body.streamUrl === null ? null : String(body.streamUrl),
      publicAccess: body.publicAccess === undefined ? (current?.publicAccess ?? false) : body.publicAccess === true,
      recordingDurationMinutes: body.recordingDurationMinutes === undefined ? (current?.recordingDurationMinutes ?? 30) : Number(body.recordingDurationMinutes),
      storageUsedGb: body.storageUsedGb === undefined ? current?.storageUsedGb : body.storageUsedGb === null ? null : Number(body.storageUsedGb),
      storageCapacityGb: body.storageCapacityGb === undefined ? (current?.storageCapacityGb ?? 10) : Number(body.storageCapacityGb),
      videoQuality: body.videoQuality === undefined ? (current?.videoQuality ?? 'hd') : (String(body.videoQuality) as KitchenCamera['videoQuality']),
      lastCheckedAt: body.lastCheckedAt === undefined ? current?.lastCheckedAt : body.lastCheckedAt === null ? null : Number(body.lastCheckedAt),
    };
    if (next.streamUrl !== null && next.streamUrl !== undefined && !/^[a-z][a-z0-9+.-]*:\/\/\S+$/i.test(next.streamUrl)) {
      throw new ApiHttpError(422, 'VALIDATION_FAILED', 'streamUrl must be a valid URI (e.g. rtsp:// or https://)');
    }
    if (next.videoQuality !== 'sd' && next.videoQuality !== 'hd' && next.videoQuality !== 'fhd') {
      throw new ApiHttpError(422, 'VALIDATION_FAILED', 'videoQuality must be sd, hd or fhd');
    }
    const duration = next.recordingDurationMinutes ?? 30;
    if (!Number.isInteger(duration) || duration < 1) {
      throw new ApiHttpError(422, 'VALIDATION_FAILED', 'recordingDurationMinutes must be a positive integer');
    }
    if (current) {
      table.update(current.id, next);
    } else {
      table.insert({ id: uid('kc'), storeId: store.id, ...next });
    }
    audit(session.merchantId, session.staffId, session.role, 'store:kitchen-camera', 'store', store.id, 'updated kitchen camera configuration');
    logStoreOp(session, store.id, { action: 'store:kitchen-camera', after: { enabled: next.enabled, videoQuality: next.videoQuality } });
    emit({ type: 'store.kitchen_camera_updated', config: next, at: Date.now() } as unknown as Parameters<typeof emit>[0]);
    return ok(next);
  }),

  /* ---- Qualification documents (GET/POST /store/qualifications) ---- */
  h.get('/api/store/qualifications', ({ request }) => {
    const session = requireSession(request);
    const store = storeForQuery(session, new URL(request.url));
    const rows = db
      .table<Qualification & { storeId: string }>('qualifications')
      .where((q) => q.storeId === store.id)
      .sort((a, b) => b.createdAt - a.createdAt);
    return ok(rows.map(({ storeId: _sid, ...q }) => q));
  }),

  h.post('/api/store/qualifications', async ({ request }) => {
    const session = requireSession(request);
    requirePerm(session, 'store:manage');
    const store = storeForQuery(session, new URL(request.url));
    const body = (await readJson(request)) as unknown as QualificationUpload;
    const type = String(body.type ?? '').trim();
    if (!type) throw new ApiHttpError(422, 'VALIDATION_FAILED', 'type is required');
    const url = String(body.url ?? '').trim();
    if (!HTTP_RE.test(url)) throw new ApiHttpError(422, 'VALIDATION_FAILED', 'url must be a valid http(s) URL');
    const now = Date.now();
    const row: Qualification & { storeId: string } = {
      id: uid('q'),
      storeId: store.id,
      type,
      url,
      status: 'pending',
      expiryDate: null,
      createdAt: now,
    };
    db.table<Qualification & { storeId: string }>('qualifications').insert(row);
    audit(session.merchantId, session.staffId, session.role, 'store:qualification', 'store', store.id, `uploaded qualification "${type}" (pending review)`);
    const { storeId: _sid, ...qualification } = row;
    emit({ type: 'store.qualification_uploaded', qualification, at: now } as unknown as Parameters<typeof emit>[0]);
    return json(201, qualification);
  }),

  /* ---- Store QR codes (GET/POST /store/qr-codes, DELETE /store/qr-codes/{id}) ---- */
  h.get('/api/store/qr-codes', ({ request }) => {
    const session = requireSession(request);
    const store = storeForQuery(session, new URL(request.url));
    const rows = db
      .table<StoreQrCode & { storeId: string }>('storeQrCodes')
      .where((q) => q.storeId === store.id)
      .sort((a, b) => b.createdAt - a.createdAt);
    return ok(rows.map(({ storeId: _sid, ...qr }) => qr));
  }),

  h.post('/api/store/qr-codes', async ({ request }) => {
    const session = requireSession(request);
    requirePerm(session, 'store:manage');
    const store = storeForQuery(session, new URL(request.url));
    const body = await readJson(request);
    const kind = String(body.kind ?? '');
    if (!['ordering', 'collection', 'download', 'review'].includes(kind)) {
      throw new ApiHttpError(422, 'VALIDATION_FAILED', 'kind must be ordering, collection, download or review');
    }
    const now = Date.now();
    const row: StoreQrCode & { storeId: string } = {
      id: uid('sq'),
      storeId: store.id,
      kind: kind as StoreQrCode['kind'],
      qrPayload: `https://hudumika.app/qr/${uid('c')}`,
      createdBy: session.staffId,
      createdAt: now,
    };
    db.table<StoreQrCode & { storeId: string }>('storeQrCodes').insert(row);
    audit(session.merchantId, session.staffId, session.role, 'store:qr-code', 'store', store.id, `generated ${kind} QR code`);
    const { storeId: _sid, ...qr } = row;
    emit({ type: 'store.qr_code_created', qrCode: qr, at: now } as unknown as Parameters<typeof emit>[0]);
    return json(201, qr);
  }),

  del('/api/store/qr-codes/:qrCodeId', ({ request, params }) => {
    const session = requireSession(request);
    requirePerm(session, 'store:manage');
    const store = storeForQuery(session, new URL(request.url));
    const qr = db.table<StoreQrCode & { storeId: string }>('storeQrCodes').find(String(params.qrCodeId));
    if (!qr || qr.storeId !== store.id) throw new ApiHttpError(404, 'STORE_QR_NOT_FOUND', 'Store QR code not found');
    db.table<StoreQrCode & { storeId: string }>('storeQrCodes').remove(qr.id);
    audit(session.merchantId, session.staffId, session.role, 'store:qr-code', 'store', store.id, `deleted ${qr.kind} QR code`);
    emit({ type: 'store.qr_code_deleted', qrCodeId: qr.id, at: Date.now() } as unknown as Parameters<typeof emit>[0]);
    return new Response(null, { status: 204 });
  }),

  /* ---- Self-pickup (GET/PUT /store/self-pickup) ---- */
  h.get('/api/store/self-pickup', ({ request }) => {
    const session = requireSession(request);
    const store = storeForQuery(session, new URL(request.url));
    const row = db.table<SelfPickupConfig & { id: string; storeId: string }>('selfPickup').where((c) => c.storeId === store.id)[0];
    if (!row) return ok({ enabled: false });
    const { id: _id, storeId: _sid, ...config } = row;
    return ok(config);
  }),

  put('/api/store/self-pickup', async ({ request }) => {
    const session = requireSession(request);
    requirePerm(session, 'store:manage');
    const store = storeForQuery(session, new URL(request.url));
    const body = await readJson(request);
    if (typeof body.enabled !== 'boolean') {
      throw new ApiHttpError(422, 'VALIDATION_FAILED', 'enabled is required');
    }
    const minutes = body.pickupReadyMinutes === undefined ? 10 : Number(body.pickupReadyMinutes);
    if (!Number.isInteger(minutes) || minutes < 5 || minutes > 120) {
      throw new ApiHttpError(422, 'SELF_PICKUP_INVALID_CONFIG', 'pickupReadyMinutes must be between 5 and 120');
    }
    const hoursRaw = (body.pickupHours ?? null) as { open?: unknown; close?: unknown } | null;
    let hours: { open: string; close: string } | null = null;
    if (hoursRaw && (hoursRaw.open !== undefined || hoursRaw.close !== undefined)) {
      const open = hoursRaw.open === undefined || hoursRaw.open === null ? '' : String(hoursRaw.open);
      const close = hoursRaw.close === undefined || hoursRaw.close === null ? '' : String(hoursRaw.close);
      if (open && close && open === close) {
        throw new ApiHttpError(422, 'HOURS_INVALID', 'Pickup open and close hours must differ');
      }
      if ((open && !/^\d{2}:\d{2}$/.test(open)) || (close && !/^\d{2}:\d{2}$/.test(close))) {
        throw new ApiHttpError(422, 'VALIDATION_FAILED', 'pickupHours open/close must be HH:MM');
      }
      hours = { open, close };
    }
    const table = db.table<SelfPickupConfig & { id: string; storeId: string }>('selfPickup');
    const existing = table.where((c) => c.storeId === store.id)[0];
    const config: SelfPickupConfig = { enabled: body.enabled === true, pickupReadyMinutes: minutes, pickupHours: hours };
    if (existing) {
      table.update(existing.id, config);
    } else {
      table.insert({ id: uid('sp'), storeId: store.id, ...config });
    }
    audit(session.merchantId, session.staffId, session.role, 'store:self-pickup', 'store', store.id, `updated self-pickup config (enabled=${config.enabled}, ${config.pickupReadyMinutes} min)`);
    logStoreOp(session, store.id, { action: 'store:self-pickup', after: config });
    emit({ type: 'store.self_pickup_updated', config, at: Date.now() } as unknown as Parameters<typeof emit>[0]);
    return ok(config);
  }),

  /* ---- Receipt templates (GET/POST /store/receipt-templates, PUT
   *      /store/receipt-templates/{templateId},
   *      POST /store/receipt-templates/{templateId}/activate) ---- */
  h.get('/api/store/receipt-templates', ({ request }) => {
    const session = requireSession(request);
    const store = storeForQuery(session, new URL(request.url));
    const rows = db
      .table<ReceiptTemplate>('receiptTemplates')
      .where((t) => t.storeId === store.id)
      .sort((a, b) => b.updatedAt - a.updatedAt);
    return ok(rows.map(toContractTemplate));
  }),

  h.post('/api/store/receipt-templates', async ({ request }) => {
    const session = requireSession(request);
    requirePerm(session, 'store:manage');
    const store = storeForQuery(session, new URL(request.url));
    const body = await readJson(request);
    const name = String(body.name ?? '').trim();
    const headerText = String(body.headerText ?? '').trim();
    if (!name || !headerText) {
      throw new ApiHttpError(422, 'VALIDATION_FAILED', 'name and headerText are required');
    }
    const paperSize = body.paperSize === '58mm' ? '58mm' : '80mm';
    const copies = body.copies === undefined ? 1 : Number(body.copies);
    if (!Number.isInteger(copies) || copies < 1 || copies > 5) {
      throw new ApiHttpError(422, 'VALIDATION_FAILED', 'copies must be between 1 and 5');
    }
    const existing = db.table<ReceiptTemplate>('receiptTemplates').where((t) => t.storeId === store.id);
    const now = Date.now();
    const template: ReceiptTemplate = {
      id: uid('rt'),
      storeId: store.id,
      name,
      headerText,
      footerText: body.footerText === undefined || body.footerText === null ? '' : String(body.footerText),
      showLogo: body.showLogo === undefined ? true : body.showLogo === true,
      showQRCode: body.showQRCode === undefined ? true : body.showQRCode === true,
      showPayment: body.showPayment === undefined ? true : body.showPayment === true,
      showRider: body.showRider === undefined ? true : body.showRider === true,
      paperSize,
      copies,
      logoEmoji: body.logoEmoji === undefined || body.logoEmoji === null ? '' : String(body.logoEmoji),
      isDefault: existing.length === 0,
      updatedAt: now,
    };
    db.table<ReceiptTemplate>('receiptTemplates').insert(template);
    audit(session.merchantId, session.staffId, session.role, 'receipt-template:create', 'receipt-template', template.id, `created template "${name}"`);
    return json(201, toContractTemplate(template));
  }),

  put('/api/store/receipt-templates/:templateId', async ({ request, params }) => {
    const session = requireSession(request);
    requirePerm(session, 'store:manage');
    const template = db.table<ReceiptTemplate>('receiptTemplates').find(String(params.templateId));
    if (!template) throw new ApiHttpError(404, 'RECEIPT_TEMPLATE_NOT_FOUND', 'Receipt template not found');
    const store = requireStore(session, template.storeId);
    const body = await readJson(request);
    const name = String(body.name ?? '').trim();
    const headerText = String(body.headerText ?? '').trim();
    if (!name || !headerText) {
      throw new ApiHttpError(422, 'VALIDATION_FAILED', 'name and headerText are required');
    }
    const paperSize = body.paperSize === undefined ? template.paperSize : body.paperSize;
    if (paperSize !== '58mm' && paperSize !== '80mm') {
      throw new ApiHttpError(422, 'VALIDATION_FAILED', 'paperSize must be 58mm or 80mm');
    }
    const copies = body.copies === undefined ? template.copies : Number(body.copies);
    if (!Number.isInteger(copies) || copies < 1 || copies > 5) {
      throw new ApiHttpError(422, 'VALIDATION_FAILED', 'copies must be between 1 and 5');
    }
    if (body.font !== undefined && body.font !== 'monospace' && body.font !== 'sans_serif') {
      throw new ApiHttpError(422, 'VALIDATION_FAILED', 'font must be monospace or sans_serif');
    }
    const fields = (body.fields ?? {}) as Partial<ReceiptTemplateFields>;
    const patch: Partial<ReceiptTemplate> = {
      name,
      headerText,
      footerText: body.footerText === undefined ? template.footerText : String(body.footerText ?? ''),
      paperSize: paperSize as ReceiptTemplate['paperSize'],
      copies,
      logoEmoji: body.logoEmoji === undefined || body.logoEmoji === null ? template.logoEmoji : String(body.logoEmoji),
      showLogo: fields.logo !== undefined ? fields.logo === true : body.showLogo === undefined ? template.showLogo : body.showLogo === true,
      showQRCode: fields.qrCode !== undefined ? fields.qrCode === true : body.showQRCode === undefined ? template.showQRCode : body.showQRCode === true,
      showPayment: fields.paymentMethod !== undefined ? fields.paymentMethod === true : body.showPayment === undefined ? template.showPayment : body.showPayment === true,
      showRider: fields.cashierName !== undefined ? fields.cashierName === true : body.showRider === undefined ? template.showRider : body.showRider === true,
      updatedAt: Date.now(),
    };
    const updated = db.table<ReceiptTemplate>('receiptTemplates').update(template.id, patch)!;
    audit(session.merchantId, session.staffId, session.role, 'receipt-template:update', 'receipt-template', template.id, `updated template "${name}"`);
    logStoreOp(session, store.id, { action: 'receipt-template:update', field: 'template', after: { name } });
    emit({ type: 'store.receipt_template_updated', template: updated, at: Date.now() } as unknown as Parameters<typeof emit>[0]);
    return ok(toContractTemplate(updated));
  }),

  h.post('/api/store/receipt-templates/:templateId/activate', ({ request, params }) => {
    const session = requireSession(request);
    requirePerm(session, 'store:manage');
    const template = db.table<ReceiptTemplate>('receiptTemplates').find(String(params.templateId));
    if (!template) throw new ApiHttpError(404, 'RECEIPT_TEMPLATE_NOT_FOUND', 'Receipt template not found');
    const store = requireStore(session, template.storeId);
    if (!template.isDefault) {
      db.table<ReceiptTemplate>('receiptTemplates')
        .where((t) => t.storeId === store.id && t.isDefault)
        .forEach((t) => db.table<ReceiptTemplate>('receiptTemplates').update(t.id, { isDefault: false, updatedAt: Date.now() }));
      db.table<ReceiptTemplate>('receiptTemplates').update(template.id, { isDefault: true, updatedAt: Date.now() });
      // Keep the legacy app notion (store.receiptTemplateId) in sync with the
      // contract's active flag so the receipt screen shows the same default.
      db.table<StoreServer>('stores').update(store.id, { receiptTemplateId: template.id });
      audit(session.merchantId, session.staffId, session.role, 'receipt-template:activate', 'receipt-template', template.id, `activated template "${template.name}"`);
      logStoreOp(session, store.id, { action: 'receipt-template:activate', field: 'isDefault', before: false, after: true });
    }
    const activated = db.table<ReceiptTemplate>('receiptTemplates').find(template.id)!;
    emit({ type: 'store.receipt_template_activated', template: activated, at: Date.now() } as unknown as Parameters<typeof emit>[0]);
    return ok(toContractTemplate(activated));
  }),

  /* ================= Drift-C: contract-path aliases =================
   * The app now calls the API-CONTRACT.yaml paths below; each registration
   * mirrors the legacy /api handler above it (same success shape, same error
   * codes) so the contract path and the legacy path behave identically. The
   * legacy registrations stay in place — the legacy tests still hit them. */

  /* ---- Payment accounts (GET/POST /store/payment-accounts,
   *      POST /store/payment-accounts/{accountId}/verify,
   *      DELETE /store/payment-accounts/{accountId}) ---- */
  h.get('/api/store/payment-accounts', ({ request }) => {
    requireSession(request);
    const url = new URL(request.url);
    const storeId = url.searchParams.get('storeId') ?? '';
    return ok({ accounts: db.table<PaymentAccount>('paymentAccounts').where((a) => a.storeId === storeId).map(maskAccount) });
  }),

  h.post('/api/store/payment-accounts', async ({ request }) => {
    const session = requireSession(request);
    requirePerm(session, 'store:manage');
    const body = await readJson(request);
    const storeId = String(body.storeId ?? '');
    requireStore(session, storeId);
    const name = String(body.name ?? '').trim();
    if (!name) throw new ApiHttpError(400, 'NAME_REQUIRED', 'Account name is required');
    const type = ACCOUNT_TYPES.includes(String(body.type) as (typeof ACCOUNT_TYPES)[number]) ? (String(body.type) as PaymentAccount['type']) : undefined;
    if (!type) throw new ApiHttpError(400, 'INVALID_ACCOUNT', 'type must be bank or mobile_money');
    const provider =
      type === 'bank' ? 'bank' : ((ACCOUNT_PROVIDERS as readonly string[]).includes(String(body.provider)) ? String(body.provider) : 'mpesa');
    const account = String(body.account ?? '').trim();
    if (!/^\d{8,32}$/.test(account)) throw new ApiHttpError(400, 'INVALID_ACCOUNT', 'Account must be 8-32 digits');
    const existing = db.table<PaymentAccount>('paymentAccounts').where((a) => a.storeId === storeId);
    const row: PaymentAccount = {
      id: uid('pa'),
      storeId,
      type,
      provider,
      name,
      account,
      accountMasked: `****${account.slice(-4)}`,
      status: 'pending',
      isDefault: existing.length === 0,
      createdAt: Date.now(),
    };
    db.table<PaymentAccount>('paymentAccounts').insert(row);
    audit(session.merchantId, session.staffId, session.role, 'payment-account:create', 'payment-account', row.id, `added ${type} account "${name}" (${row.accountMasked})`);
    return ok({ account: maskAccount(row) });
  }),

  h.post('/api/store/payment-accounts/:accountId/verify', async ({ request, params }) => {
    const session = requireSession(request);
    requirePerm(session, 'store:manage');
    const account = db.table<PaymentAccount>('paymentAccounts').find(String(params.accountId));
    if (!account) throw new ApiHttpError(404, 'NOT_FOUND', 'Payment account not found');
    requireStore(session, account.storeId);
    if (account.status !== 'active') {
      db.table<PaymentAccount>('paymentAccounts').update(account.id, { status: 'active' });
      audit(session.merchantId, session.staffId, session.role, 'payment-account:verify', 'payment-account', account.id, `verified ${account.type} account "${account.name}"`);
    }
    return ok({ account: maskAccount(db.table<PaymentAccount>('paymentAccounts').find(account.id)!) });
  }),

  del('/api/store/payment-accounts/:accountId', ({ request, params }) => {
    const session = requireSession(request);
    requirePerm(session, 'store:manage');
    const account = db.table<PaymentAccount>('paymentAccounts').find(String(params.accountId));
    if (!account) throw new ApiHttpError(404, 'NOT_FOUND', 'Payment account not found');
    requireStore(session, account.storeId);
    const remaining = db.table<PaymentAccount>('paymentAccounts').where((a) => a.storeId === account.storeId && a.id !== account.id);
    db.table<PaymentAccount>('paymentAccounts').remove(account.id);
    let newDefault: { id: string; accountMasked: string } | undefined;
    if (account.isDefault && remaining.length) {
      const replacement = [...remaining].sort((a, b) => b.createdAt - a.createdAt)[0];
      db.table<PaymentAccount>('paymentAccounts').update(replacement.id, { isDefault: true });
      newDefault = { id: replacement.id, accountMasked: replacement.accountMasked };
    }
    audit(session.merchantId, session.staffId, session.role, 'payment-account:delete', 'payment-account', account.id, `removed ${account.type} account "${account.name}"`);
    return ok({ deleted: true, newDefault });
  }),

  /* ---- Dine-in tables (GET/POST /dine-in/tables,
   *      PATCH /dine-in/tables/{tableId} — DELETE alias added earlier).
   * Contract shape (DINE-IN.md): DineInTable {id, label ≤40, capacity ≥1
   * (default 4), active, currentOrderId}. The app TableRow keeps `name`/
   * `disabled`; the mock emits both (label = name, active = !disabled) so
   * either surface can read it. Manual `status` patches can no longer
   * fabricate occupancy — occupancy is derived from currentOrderId only. */
  h.get('/api/dine-in/tables', ({ request }) => {
    requireSession(request);
    const url = new URL(request.url);
    const storeId = url.searchParams.get('storeId') ?? '';
    const rows = db.table<TableRow>('tables').where((t) => t.storeId === storeId);
    return ok({
      tables: rows.map((t) => ({ ...t, label: t.label ?? t.name, active: t.active ?? !t.disabled })),
    });
  }),

  h.post('/api/dine-in/tables', async ({ request }) => {
    const session = requireSession(request);
    requirePerm(session, 'store:manage');
    const body = await readJson(request);
    const storeId = String(body.storeId ?? '');
    const store = requireStore(session, storeId);
    const name = String(body.label ?? body.name ?? '').trim();
    if (!name) throw new ApiHttpError(400, 'INVALID_TABLE', 'label is required');
    if (name.length > 40) throw new ApiHttpError(422, 'VALIDATION_FAILED', 'label must be at most 40 characters');
    const capacity = body.capacity === undefined || body.capacity === null ? 4 : Number(body.capacity);
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new ApiHttpError(400, 'INVALID_TABLE', 'capacity must be an integer >= 1');
    }
    const active = body.active === undefined ? true : body.active === true;
    const id = uid('tbl');
    const qrToken = uid('qr');
    const base = store.qrOrdering?.urlPattern || 'https://order.example.com/q';
    const table: TableRow = {
      id,
      storeId,
      name,
      label: name,
      zone: body.zone !== undefined && body.zone !== null ? String(body.zone) : '',
      capacity,
      status: 'idle',
      qrToken,
      qrUrl: `${base}/${storeId}/${id}?t=${qrToken}`,
      disabled: !active,
      active,
      createdAt: Date.now(),
    };
    db.table<TableRow>('tables').insert(table);
    audit(session.merchantId, session.staffId, session.role, 'table:create', 'table', table.id, `added table "${name}" (capacity ${capacity})`);
    return ok({ table });
  }),

  h.patch('/api/dine-in/tables/:tableId', async ({ request, params }) => {
    const session = requireSession(request);
    requirePerm(session, 'store:manage');
    const table = db.table<TableRow>('tables').find(String(params.tableId));
    if (!table) throw new ApiHttpError(404, 'NOT_FOUND', 'Table not found');
    requireStore(session, table.storeId);
    const body = await readJson(request);
    const patch: Partial<TableRow> = {};
    const label = body.label !== undefined ? body.label : body.name;
    if (label !== undefined) {
      const name = String(label).trim();
      if (!name) throw new ApiHttpError(400, 'INVALID_TABLE', 'label is required');
      if (name.length > 40) throw new ApiHttpError(422, 'VALIDATION_FAILED', 'label must be at most 40 characters');
      patch.name = name;
      patch.label = name;
    }
    if (body.zone !== undefined) patch.zone = String(body.zone);
    if (body.capacity !== undefined) {
      const capacity = Number(body.capacity);
      if (!Number.isInteger(capacity) || capacity < 1) throw new ApiHttpError(400, 'INVALID_TABLE', 'capacity must be an integer >= 1');
      patch.capacity = capacity;
    }
    if (body.active !== undefined) {
      patch.active = body.active === true;
      patch.disabled = !patch.active;
    }
    if (body.disabled !== undefined) {
      patch.disabled = body.disabled === true;
      patch.active = !patch.disabled;
    }
    if (body.status !== undefined) {
      throw new ApiHttpError(409, 'DINE_IN_TABLE_IN_USE', 'Table status is derived from the open bill — it cannot be set manually');
    }
    const updated = db.table<TableRow>('tables').update(table.id, patch)!;
    audit(session.merchantId, session.staffId, session.role, 'table:update', 'table', table.id, `updated table "${updated.name}" (${Object.keys(patch).join(', ') || 'no change'})`);
    return ok({ table: updated });
  }),

  /* ---- Devices (POST /devices/{deviceId}/pair, POST /devices/{deviceId}/test) —
   *      contract names for the legacy printer connect/test actions; the
   *      /devices CRUD lives in devices.ts (P6d). ---- */
  h.post('/api/devices/:deviceId/pair', async ({ request, params }) => {
    const session = requireSession(request);
    requirePerm(session, 'store:manage');
    const printer = db.table<Printer>('printers').find(String(params.deviceId));
    if (!printer) throw new ApiHttpError(404, 'NOT_FOUND', 'Printer not found');
    requireStore(session, printer.storeId);
    if (printer.status !== 'connected') {
      db.table<Printer>('printers').update(printer.id, { status: 'connected' });
      audit(session.merchantId, session.staffId, session.role, 'printer:connect', 'printer', printer.id, `connected "${printer.name}"`);
    }
    return ok({ printer: db.table<Printer>('printers').find(printer.id)! });
  }),

  h.post('/api/devices/:deviceId/test', async ({ request, params }) => {
    const session = requireSession(request);
    requirePerm(session, 'store:manage');
    const printer = db.table<Printer>('printers').find(String(params.deviceId));
    if (!printer) throw new ApiHttpError(404, 'NOT_FOUND', 'Printer not found');
    requireStore(session, printer.storeId);
    if (printer.status !== 'connected') throw new ApiHttpError(409, 'PRINTER_OFFLINE', 'Printer is not connected');
    const jobId = uid('pj');
    audit(session.merchantId, session.staffId, session.role, 'printer:test', 'printer', printer.id, `sent test print to "${printer.name}" (${jobId})`);
    return ok({ printed: true, jobId });
  }),

  /* ---- Compliance (POST /store/compliance/recheck — merchant-scoped).
   * Async job semantics per STORE-MANAGEMENT.md:119-122: a running job blocks
   * repeats with COMPLIANCE_RECHECK_IN_PROGRESS; the response carries the job
   * state machine (queued → processing → completed) plus the fresh score. ---- */
  h.post('/api/store/compliance/recheck', async ({ request }) => {
    const session = requireSession(request);
    requirePerm(session, 'store:manage');
    const store = storeForQuery(session, new URL(request.url));
    const active = complianceJobs.get(store.id);
    if (active && active.blockedUntil > Date.now()) {
      throw new ApiHttpError(409, 'COMPLIANCE_RECHECK_IN_PROGRESS', 'A compliance recheck is already running for this store');
    }
    const job: ComplianceRecheckJob = {
      jobId: uid('cre'),
      storeId: store.id,
      status: 'queued',
      blockedUntil: Date.now() + COMPLIANCE_RECHECK_BLOCK_MS,
    };
    complianceJobs.set(store.id, job);
    job.status = 'processing';
    const compliance = computeCompliance(store);
    job.status = 'completed';
    job.compliance = compliance;
    emit({ type: 'compliance.recheck_completed', job, at: Date.now() } as unknown as Parameters<typeof emit>[0]);
    audit(session.merchantId, session.staffId, session.role, 'compliance:recheck', 'store', store.id, `rechecked compliance → ${compliance.status} (${compliance.score}/100)`);
    logStoreOp(session, store.id, { action: 'compliance:recheck', after: { status: compliance.status, score: compliance.score } });
    return ok({ jobId: job.jobId, status: job.status, compliance });
  }),

  /* ---- Store logs (GET /store/logs — merchant-scoped) ---- */
  h.get('/api/store/logs', ({ request }) => {
    const session = requireSession(request);
    const store = storeForQuery(session, new URL(request.url));
    const logs = db
      .table<StoreLog>('storeLogs')
      .where((l) => l.storeId === store.id && l.merchantId === session.merchantId)
      .sort((a, b) => b.ts - a.ts)
      .slice(0, 100);
    return ok({ logs });
  }),

  /* ---- Closure protection (POST /merchants/me/closure-protection) —
   *      one contract endpoint for apply (active:true) and cancel (active:false);
   *      GET /closure/status stays mock-only (status read is a proposed addition). ---- */
  h.post('/api/merchants/me/closure-protection', async ({ request }) => {
    const session = requireSession(request);
    requirePerm(session, 'store:manage');
    const body = await readJson(request);
    const store = storeForQuery(session, new URL(request.url));
    const active = body.active === true;
    if (!active) {
      const protection = db.table<ClosureProtection>('closureProtections').where((p) => p.storeId === store.id && p.status === 'active')[0];
      if (!protection) throw new ApiHttpError(404, 'NOT_FOUND', 'No active closure protection');
      db.table<ClosureProtection>('closureProtections').update(protection.id, { status: 'cancelled' });
      audit(session.merchantId, session.staffId, session.role, 'closure:cancel', 'closure', protection.id, `cancelled closure protection for ${store.name}`);
      logStoreOp(session, store.id, { action: 'closure:cancel', field: 'status', before: 'active', after: 'cancelled' });
      notify(session.merchantId, 'Closure protection cancelled', `The closure window ${fmtWindow(protection.from, protection.to)} was cancelled. The store stays closed until you reopen it.`, 'important');
      return ok({ cancelled: true });
    }
    const reason = String(body.reason ?? '').trim();
    if (!reason) throw new ApiHttpError(400, 'REASON_REQUIRED', 'A closure reason is required');
    const now = Date.now();
    const from = Number(body.from);
    const to = Number(body.to);
    if (!Number.isFinite(from) || !Number.isFinite(to)) {
      throw new ApiHttpError(400, 'INVALID_PERIOD', 'from and to must be valid timestamps');
    }
    if (from < now - 3600000 || from > now + 30 * DAY_MS) {
      throw new ApiHttpError(400, 'INVALID_PERIOD', 'from must be within the next 30 days');
    }
    if (to <= from) throw new ApiHttpError(400, 'INVALID_PERIOD', 'to must be after from');
    const activeProtections = db.table<ClosureProtection>('closureProtections').where((p) => p.storeId === store.id && p.status === 'active');
    if (activeProtections.length) throw new ApiHttpError(409, 'PROTECTION_ACTIVE', 'A closure protection is already active for this store');
    const days = protectionDays(from, to);
    if (usedProtectionDays(store.id, now) + days > 15) {
      throw new ApiHttpError(409, 'PROTECTION_QUOTA', 'Closure protection is capped at 15 days per year');
    }
    const protection: ClosureProtection = {
      id: uid('cp'),
      storeId: store.id,
      from,
      to,
      reason,
      status: 'active',
      createdAt: now,
    };
    db.table<ClosureProtection>('closureProtections').insert(protection);
    db.table<StoreServer>('stores').update(store.id, { open: false });
    audit(session.merchantId, session.staffId, session.role, 'closure:apply', 'closure', protection.id, `closed ${store.name} ${fmtWindow(from, to)} (${days} day(s)) — ${reason}`);
    logStoreOp(session, store.id, { action: 'closure:apply', after: { from, to } });
    notify(session.merchantId, 'Closure protection active', `Store closed ${fmtWindow(from, to)} (${days} day(s)). Reopen manually when ready.`, 'important');
    return ok({ protection });
  }),

  /* ---- Store update (PATCH /merchants/me) — merchant-scoped alias for the
   *      legacy PATCH /store settings update (ops.ts): same partial-patch merge,
   *      same {store} success shape. ---- */
  h.patch('/api/merchants/me', async ({ request }) => {
    const session = requireSession(request);
    requirePerm(session, 'store:manage');
    const body = await readJson(request);
    const store = db.table<StoreServer>('stores').find('s_demo');
    if (!store) throw new ApiHttpError(404, 'NOT_FOUND', 'Store not found');
    const patch: Record<string, unknown> = {};
    for (const key of [
      'name', 'category', 'phone', 'address', 'description', 'bannerColor',
      'featuredProductIds', 'open', 'hours', 'deliveryRadiusKm', 'deliveryFee',
      'minOrder', 'orderSettings', 'decoration', 'promotion',
      'announcement', 'coverImage', 'deliveryEtaMin', 'pickupReadyMinutes',
      'scheduledReopenAt', 'freeDeliveryThreshold', 'receiptTemplateId',
      'paymentMethods', 'dualScreen', 'qrOrdering',
    ] as const) {
      if (body[key] !== undefined) {
        const existing = (store as unknown as Record<string, unknown>)[key];
        if (typeof existing === 'object' && existing !== null && !Array.isArray(existing) && typeof body[key] === 'object') {
          patch[key] = { ...(existing as Record<string, unknown>), ...(body[key] as Record<string, unknown>) };
        } else {
          patch[key] = body[key];
        }
      }
    }
    if (patch.freeDeliveryThreshold !== undefined) patch.freeDeliveryThreshold = Math.max(0, Number(patch.freeDeliveryThreshold));
    const updated = db.table<StoreServer>('stores').update(store.id, patch as Partial<StoreServer>)!;
    audit(session.merchantId, session.staffId, session.role, 'store:update', 'store', store.id, `updated store settings (${Object.keys(patch).join(', ')})`);
    emit({ type: 'merchant.updated', store: updated, at: Date.now() });
    return ok({ store: updated });
  }),
];
