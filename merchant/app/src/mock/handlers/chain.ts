import type {
  CatalogueExtEvent,
  ChainDashboard,
  ChainReportBody,
  ChainStorePerformance,
  OrderDto,
  ProductRow,
  ReportExport,
  ServerEvent,
} from '@/api/types';
import { db } from '@/mock/db';
import { emit } from '@/mock/events';
import { audit, ok, requirePerm, requireSession } from '@/mock/security';
import { ApiHttpError, h, readJson } from '@/mock/handlers/common';
import type { Session } from '@/mock/types-internal';

const DAY = 86400000;
const round = (n: number, dp = 2) => Math.round(n * 10 ** dp) / 10 ** dp;

const REPORT_TYPES = new Set(['financial', 'operational', 'orders', 'inventory']);

/* P8 event types are appended to types.ts only (shared with a parallel agent);
 * ServerEvent's union lives mid-file, so chain events cross the bus via the
 * common base event type. */
function p8Emit(event: CatalogueExtEvent) {
  emit(event as unknown as ServerEvent);
}

function isoDate(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function parseDate(value: unknown, label: string): number {
  const raw = String(value ?? '');
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!match) throw new ApiHttpError(400, 'INVALID_DATE', `${label} must be yyyy-mm-dd`);
  const ts = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (Number.isNaN(ts)) throw new ApiHttpError(400, 'INVALID_DATE', `${label} must be yyyy-mm-dd`);
  return ts;
}

function storePerformance(
  session: Session,
  store: { id: string; name: string; open: boolean; rating: number | null },
  fromTs: number,
  toTs: number,
): ChainStorePerformance {
  const orders = db
    .table<OrderDto>('orders')
    .where(
      (o) =>
        o.merchantId === session.merchantId &&
        o.storeId === store.id &&
        o.status === 'completed' &&
        (o.completedAt ?? 0) >= fromTs &&
        (o.completedAt ?? 0) <= toTs,
    );
  const revenueTZS = Math.round(orders.reduce((s, o) => s + o.total, 0));
  const visits = Math.round(orders.length / 0.11);
  const lowStockCount = db
    .table<ProductRow>('products')
    .where((p) => p.storeId === store.id && !p.deleted && p.visible && p.stock < 10).length;
  return {
    storeId: store.id,
    businessName: store.name,
    revenueTZS,
    orderCount: orders.length,
    conversionRate: visits ? round(orders.length / visits, 4) : 0,
    rating: store.rating,
    isOpen: store.open,
    lowStockCount,
  };
}

function chainStoreList(session: Session): { id: string; name: string; open: boolean; rating: number | null }[] {
  return db
    .table<{ merchantId: string; id: string; name: string; open?: boolean; rating?: number }>('stores')
    .where((s) => s.merchantId === session.merchantId)
    .map((s) => ({ id: s.id, name: s.name, open: s.open === true, rating: typeof s.rating === 'number' ? s.rating : null }));
}

export const chainHandlers = [
  h.get('/api/chain/dashboard', ({ request }) => {
    const session = requireSession(request);
    const to = Date.now();
    const from = to - 30 * DAY;
    const stores = chainStoreList(session).map((s) => storePerformance(session, s, from, to));
    const totals = stores.reduce(
      (acc, s) => ({
        orders: acc.orders + s.orderCount,
        revenueTZS: acc.revenueTZS + s.revenueTZS,
        activeOrders: acc.activeOrders,
        lowStockAlerts: acc.lowStockAlerts + s.lowStockCount,
      }),
      { orders: 0, revenueTZS: 0, activeOrders: 0, lowStockAlerts: 0 },
    );
    totals.activeOrders = db
      .table<OrderDto>('orders')
      .where((o) => o.merchantId === session.merchantId && (o.status === 'new' || o.status === 'preparing' || o.status === 'ready')).length;
    const dashboard: ChainDashboard = { date: isoDate(to), totals, stores };
    return ok(dashboard);
  }),

  h.post('/api/chain/reports', async ({ request }) => {
    const session = requireSession(request);
    requirePerm(session, 'store:manage');
    const body = (await readJson(request)) as Partial<ChainReportBody>;
    const reportType = String(body.reportType ?? '');
    if (!REPORT_TYPES.has(reportType)) {
      throw new ApiHttpError(400, 'INVALID_REPORT_TYPE', 'reportType must be financial, operational, orders or inventory');
    }
    const fromTs = parseDate(body.from, 'from');
    const toTs = parseDate(body.to, 'to');
    if (toTs < fromTs) throw new ApiHttpError(400, 'INVALID_DATE', 'to must not be before from');
    const stores = chainStoreList(session);
    let storeIds = stores.map((s) => s.id);
    if (body.storeIds !== undefined) {
      if (!Array.isArray(body.storeIds)) throw new ApiHttpError(400, 'INVALID_STORE_IDS', 'storeIds must be an array');
      storeIds = body.storeIds.map(String);
      for (const id of storeIds) {
        if (!stores.some((s) => s.id === id)) throw new ApiHttpError(400, 'INVALID_STORE_IDS', `Unknown store ${id}`);
      }
    }
    const rows = storeIds.map((id) => {
      const store = stores.find((s) => s.id === id)!;
      return storePerformance(session, store, fromTs, toTs + DAY - 1);
    });
    const payload = {
      reportType,
      from: body.from,
      to: body.to,
      storeIds,
      generatedAt: new Date().toISOString(),
      rows: rows.map((r) => ({
        storeId: r.storeId,
        businessName: r.businessName,
        revenueTZS: r.revenueTZS,
        orderCount: r.orderCount,
        lowStockCount: r.lowStockCount,
      })),
    };
    const result: ReportExport = {
      downloadUrl: `data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(payload))}`,
      expiresInSeconds: 900,
    };
    p8Emit({ type: 'chain.report_exported', reportType, at: Date.now() });
    audit(session.merchantId, session.staffId, session.role, 'store:update', 'chain-report', reportType, `exported ${reportType} report (${storeIds.length} store(s))`);
    return ok(result);
  }),
];
