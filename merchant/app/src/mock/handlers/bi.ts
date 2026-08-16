import type {
  AnalyticsDashboard,
  BenchmarkSummary,
  ChainStorePerformance,
  DineInOrder,
  ForecastPoint,
  Funnel,
  HourlyTrendPoint,
  MarketAnalysis,
  OrderAnalytics,
  OrderDto,
  Payment,
  ProductPerformance,
  ProductRow,
  ReportExport,
  ReviewAnalytics,
  ReviewAnalyticsContract,
  RevenueAnalysis,
  RevenueChannel,
  RevenueComposition,
  ReviewDto,
  TableRow,
} from '@/api/types';
import { db } from '@/mock/db';
import { audit, ok, requirePerm, requireSession } from '@/mock/security';
import { ApiHttpError, h, readJson } from '@/mock/handlers/common';

const round = (n: number, dp = 2) => Math.round(n * 10 ** dp) / 10 ** dp;
const DAY = 86400000;

/* The shared json() helper spreads bodies, which mangles top-level arrays —
 * contract responses that ARE arrays use Response.json directly. */
const okArray = (value: unknown[]) => Response.json(value);

/* ---- Legacy (mock-only) BI shapes — kept for the deferred-endpoint parity
 * (docs/CONTRACT-ADDITIONS.md). The contract-shaped responses live alongside
 * them; same-path endpoints dispatch on the query style the caller uses. ---- */

interface LegacyFunnelStep {
  label: string;
  value: number;
  rate: number;
}

interface LegacyBenchmark {
  peers: number;
  percentiles: { metric: string; label: string; value: string; betterThanPct: number }[];
  industry: { metric: string; store: number; industryAvg: number; deltaPct: number }[];
}

interface LegacyMarketAnalysis {
  categoryTrend: { category: string; demandDeltaPct: number }[];
  priceBands: { band: string; share: number }[];
  keywordTrends: { keyword: string; growthPct: number }[];
  opportunities: { title: string; detail: string }[];
}

interface LegacyProductRow {
  id: string;
  name: string;
  emoji: string;
  price: number;
  sold: number;
  revenue: number;
  orders: number;
  stock: number;
  stockOutEvents: number;
  share: number;
}

interface LegacyDiagnosticIssue {
  id: string;
  severity: 'high' | 'medium' | 'low';
  category: string;
  title: string;
  detail: string;
  action: string;
}

interface LegacyReportBundle {
  generatedAt: number;
  storeName: string;
  days: number;
  summary: { gmv: number; orders: number; aov: number; rating: number; praiseRate: number };
  dailySeries: { label: string; revenue: number; orders: number }[];
  topDishes: { name: string; sold: number; revenue: number }[];
  channels: { key: string; label: string; amount: number; orders: number }[];
  issues: LegacyDiagnosticIssue[];
}

interface LegacyMultiStoreStat {
  id: string;
  name: string;
  revenue: number;
  orders: number;
  aov: number;
  rating: number;
  score: number;
  flags: { severity: 'high' | 'medium' | 'low'; text: string }[];
}

function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Contract date-range query (`from`/`to`, default last `defaultDays` days). */
function range(url: URL, defaultDays: number): { from: string; to: string; fromTs: number; toTs: number } {
  const to = url.searchParams.get('to') ?? isoDate(new Date());
  const from = url.searchParams.get('from') ?? isoDate(new Date(Date.now() - (defaultDays - 1) * DAY));
  const fromTs = new Date(`${from}T00:00:00`).getTime();
  const toTs = new Date(`${to}T23:59:59`).getTime();
  return { from, to, fromTs, toTs };
}

function completedInWindow(merchantId: string, days: number, storeId?: string): OrderDto[] {
  const cutoff = Date.now() - days * DAY;
  let list = db.table<OrderDto>('orders').where((o) => o.merchantId === merchantId && o.status === 'completed' && (o.completedAt ?? 0) >= cutoff);
  if (storeId) list = list.filter((o) => o.storeId === storeId);
  return list;
}

function completedBetween(merchantId: string, fromTs: number, toTs: number): OrderDto[] {
  return db
    .table<OrderDto>('orders')
    .where((o) => o.merchantId === merchantId && o.status === 'completed' && (o.completedAt ?? 0) >= fromTs && (o.completedAt ?? 0) <= toTs);
}

function praiseRate(merchantId: string): number {
  const reviews = db.table<ReviewDto>('reviews').where((r) => r.merchantId === merchantId);
  if (!reviews.length) return 0;
  return round((reviews.filter((r) => r.rating >= 4).length / reviews.length) * 100, 1);
}

function repeatRate(orders: OrderDto[]): number {
  const phones = orders.map((o) => o.customer.phone);
  if (!phones.length) return 0;
  return round((phones.filter((c, i) => phones.indexOf(c) !== i).length / phones.length) * 100, 1);
}

interface StoreRow {
  id: string;
  merchantId: string;
  name: string;
  category?: string;
  rating?: number;
  open?: boolean;
  rank?: { current?: number; previous?: number; category?: string; score?: number };
}

function merchantStores(merchantId: string): StoreRow[] {
  return db.table('stores').where((s: any) => s.merchantId === merchantId) as StoreRow[];
}

function storeScore(store: { rating?: number }, ordersInWindow: number): number {
  return Math.round(Math.min(100, (store.rating ?? 0) * 12 + (Math.min(ordersInWindow, 200) / 200) * 20));
}

function channelsOf(merchantId: string, days: number, orders: OrderDto[]): RevenueComposition['channels'] {
  const byKey = new Map<string, { label: string; amount: number; orders: number }>();
  for (const o of orders) {
    const key = o.scheduledAt ? 'preorder' : o.deliveryType;
    const cur = byKey.get(key) ?? { label: key === 'preorder' ? 'Pre-order' : key === 'pickup' ? 'Pickup' : 'Delivery', amount: 0, orders: 0 };
    cur.amount += o.total;
    cur.orders += 1;
    byKey.set(key, cur);
  }
  /* Dine-in bills and redeemed group-buy vouchers are part of the same
   * revenue-composition story (finance view includes them) — keep the totals
   * in parity across both surfaces. */
  const cutoff = Date.now() - days * DAY;
  const dineIn = db.table<DineInOrder>('dineInOrders').where((b) => b.merchantId === merchantId && b.status === 'paid' && (b.paidAt ?? 0) >= cutoff);
  for (const b of dineIn) {
    const cur = byKey.get('dine_in') ?? { label: 'Dine-in', amount: 0, orders: 0 };
    cur.amount += b.totals.totalTZS;
    cur.orders += 1;
    byKey.set('dine_in', cur);
  }
  const vouchers = db.table<{ id: string; status: string; redeemedByMerchantId?: string | null; redeemedAt?: number | null; priceTZS: number }>('vouchers').where(
    (v) => v.status === 'redeemed' && v.redeemedByMerchantId === merchantId && (v.redeemedAt ?? 0) >= cutoff,
  );
  for (const v of vouchers) {
    const cur = byKey.get('group_buy') ?? { label: 'Group buy', amount: 0, orders: 0 };
    cur.amount += v.priceTZS;
    cur.orders += 1;
    byKey.set('group_buy', cur);
  }
  const total = [...byKey.values()].reduce((s, c) => s + c.amount, 0) || 1;
  return [...byKey.entries()].map(([key, c]) => ({
    key,
    label: c.label,
    amount: round(c.amount),
    orders: c.orders,
    share: round((c.amount / total) * 100, 1),
  }));
}

function methodsOf(merchantId: string, days: number): RevenueComposition['methods'] {
  const cutoff = Date.now() - days * DAY;
  const byMethod = new Map<string, number>();
  for (const p of db.table<Payment>('payments').where((p) => p.merchantId === merchantId && (p.capturedAt ?? 0) >= cutoff)) {
    byMethod.set(p.method, (byMethod.get(p.method) ?? 0) + p.amount);
  }
  const total = [...byMethod.values()].reduce((s, v) => s + v, 0) || 1;
  const labels: Record<string, string> = { mpesa: 'M-Pesa', tigo_pesa: 'Tigo Pesa', airtel_money: 'Airtel Money', ezy_pesa: 'Ezy Pesa', halotel: 'Halotel' };
  return [...byMethod.entries()].map(([method, amount]) => ({
    method,
    label: labels[method] ?? method,
    amount: round(amount),
    share: round((amount / total) * 100, 1),
  }));
}

function productPerformance(merchantId: string, fromTs: number, toTs: number, storeId?: string): ProductPerformance[] {
  let orders = completedBetween(merchantId, fromTs, toTs);
  if (storeId) orders = orders.filter((o) => o.storeId === storeId);
  let products = db.table<ProductRow>('products').where((p) => p.merchantId === merchantId && !p.deleted);
  if (storeId) products = products.filter((p) => p.storeId === storeId);
  const rows = products.map((p) => {
    let unitsSold = 0;
    let revenue = 0;
    let ordersCount = 0;
    for (const o of orders) {
      for (const it of o.items) {
        if (it.productId === p.id) {
          unitsSold += it.qty;
          revenue += it.price * it.qty;
          ordersCount += 1;
        }
      }
    }
    return {
      catalogueItemId: p.id,
      name: p.name,
      unitsSold,
      revenueTZS: Math.round(revenue),
      ordersCount,
      availabilityRate: !p.visible || p.stock === 0 ? 0 : 1,
    };
  });
  return rows;
}

export const biHandlers = [
  /* ---- Order-level data (granular BI view, mock-only until adopted) ---- */
  h.get('/api/analytics/orders', ({ request }) => {
    const session = requireSession(request);
    const url = new URL(request.url);
    const days = Math.min(30, Math.max(1, Number(url.searchParams.get('days') ?? 7)));
    const limit = Math.min(100, Number(url.searchParams.get('limit') ?? 20));
    const cutoff = Date.now() - days * DAY;
    const rows = db
      .table<OrderDto>('orders')
      .where((o) => o.merchantId === session.merchantId && o.createdAt >= cutoff)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit)
      .map((o) => ({
        id: o.id,
        no: o.no,
        ts: o.createdAt,
        status: o.status,
        total: o.total,
        deliveryType: o.deliveryType,
        itemsCount: o.items.reduce((s, i) => s + i.qty, 0),
        channel: o.scheduledAt ? 'preorder' : o.deliveryType,
      }));
    return ok({ orders: rows, total: rows.length });
  }),

  /* ---- Contract: AnalyticsDashboard (GET /analytics/dashboard) ---- */
  h.get('/api/analytics/dashboard', ({ request }) => {
    const session = requireSession(request);
    const url = new URL(request.url);
    const storeId = url.searchParams.get('storeId') ?? undefined;
    /* Drift-D dual dispatch: ?storeId= (without &live=1) serves the legacy
     * /analytics/overview payload the home dashboard consumes; the contract
     * AnalyticsDashboard shape is served on the plain call and on
     * ?live=1&storeId= (store-scoped live strip). */
    if (url.searchParams.has('storeId') && !url.searchParams.has('live')) {
      const m2 = session.merchantId;
      let orders = db.table<OrderDto>('orders').where((o) => o.merchantId === m2);
      if (storeId) orders = orders.filter((o) => o.storeId === storeId);
      const completed = orders.filter((o) => o.status === 'completed');
      const gmv = completed.reduce((s, o) => s + o.total, 0);
      const dayStart = new Date().setHours(0, 0, 0, 0);
      const prevDayStart = dayStart - 86400000;
      const today = completed.filter((o) => (o.completedAt ?? 0) >= dayStart);
      const yesterday = completed.filter((o) => (o.completedAt ?? 0) >= prevDayStart && (o.completedAt ?? 0) < dayStart);
      const todayRevenue = Math.round(today.reduce((s, o) => s + o.total, 0) * 100) / 100;
      const prevRevenue = Math.round(yesterday.reduce((s, o) => s + o.total, 0) * 100) / 100;
      const todayOrders = today.length;
      const prevOrders = yesterday.length;
      const aov = completed.length ? gmv / completed.length : 0;
      const customers = completed.map((o) => o.customer.phone);
      const repeatRate = customers.length ? (customers.filter((c, i) => customers.indexOf(c) !== i).length / customers.length) * 100 : 0;
      const reviews = db.table<ReviewDto>('reviews').where((r) => r.merchantId === m2);
      const praiseRate = reviews.length ? (reviews.filter((r) => r.rating >= 4).length / reviews.length) * 100 : 0;
      return ok({
        gmv: Math.round(gmv * 100) / 100,
        todayRevenue,
        prevRevenue,
        todayOrders,
        prevOrders,
        aov: Math.round(aov * 100) / 100,
        conversion: 3.7,
        repeatRate: Math.round(repeatRate * 10) / 10,
        praiseRate: Math.round(praiseRate * 10) / 10,
      });
    }
    const m = session.merchantId;
    const dayStart = new Date().setHours(0, 0, 0, 0);
    const storeIds = new Set(merchantStores(m).map((s: any) => s.id));
    let today = db.table<OrderDto>('orders').where((o) => o.merchantId === m && o.status === 'completed' && (o.completedAt ?? 0) >= dayStart);
    if (storeId) today = today.filter((o) => o.storeId === storeId);
    const revenueTZS = Math.round(today.reduce((s, o) => s + o.total, 0));
    const orderCount = today.length;
    /* Dine-in bills carry no storeId — scope them through their table's store. */
    let dineInBills = db
      .table<DineInOrder>('dineInOrders')
      .where((b) => b.merchantId === m && b.createdAt >= dayStart);
    if (storeId) {
      const tableIds = new Set(db.table<TableRow>('tables').where((t) => t.storeId === storeId).map((t) => t.id));
      dineInBills = dineInBills.filter((b) => tableIds.has(b.tableId));
    }
    const dineInCount = dineInBills.length;
    const gbIds = new Set(db.table('groupBuys').where((g: any) => g.merchantId === m).map((g: any) => g.id));
    const groupBuyCount = db
      .table('vouchers')
      .where((v: any) => gbIds.has(v.groupBuyId) && v.purchasedAt >= dayStart).length;
    let activeOrders = db
      .table<OrderDto>('orders')
      .where((o) => o.merchantId === m && (o.status === 'new' || o.status === 'preparing' || o.status === 'ready'));
    if (storeId) activeOrders = activeOrders.filter((o) => o.storeId === storeId);
    const activeDineInTables = db
      .table<TableRow>('tables')
      .where((t) => storeIds.has(t.storeId) && t.status === 'occupied' && (!storeId || t.storeId === storeId)).length;
    const openAlerts =
      db.table('riskEvents').where((r: any) => r.merchantId === m && r.status === 'open').length +
      db.table('tasks').where((t: any) => t.merchantId === m && !t.done).length;
    const dashboard: AnalyticsDashboard = {
      date: isoDate(new Date()),
      today: {
        orderCount,
        dineInCount,
        groupBuyCount,
        revenueTZS,
        newCustomers: new Set(today.map((o) => o.customer.phone)).size,
        averageOrderValueTZS: orderCount ? Math.round(revenueTZS / orderCount) : 0,
      },
      live: { activeOrders: activeOrders.length, activeDineInTables, openAlerts },
    };
    return ok(dashboard);
  }),

  /* ---- Contract: Hourly trends (GET /analytics/hourly-trends?date=) ---- */
  h.get('/api/analytics/hourly-trends', ({ request }) => {
    const session = requireSession(request);
    const url = new URL(request.url);
    const storeId = url.searchParams.get('storeId') ?? undefined;
    /* Drift-D dual dispatch: without ?date= the legacy /analytics/trend
     * payload ({days}) is served for the app's peak-hours strip. */
    if (!url.searchParams.has('date')) {
      const days = Math.min(30, Number(url.searchParams.get('days') ?? 7));
      let orders = db.table<OrderDto>('orders').where((o) => o.merchantId === session.merchantId && o.status === 'completed');
      if (storeId) orders = orders.filter((o) => o.storeId === storeId);
      const out: { label: string; revenue: number; orders: number }[] = [];
      for (let i = days - 1; i >= 0; i--) {
        const d = new Date(Date.now() - i * 86400000);
        const start = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
        const list = orders.filter((o) => (o.completedAt ?? 0) >= start && (o.completedAt ?? 0) < start + 86400000);
        out.push({
          label: i === 0 ? 'Today' : ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()],
          revenue: Math.round(list.reduce((s, o) => s + o.total, 0) * 100) / 100,
          orders: list.length,
        });
      }
      return ok({ days: out });
    }
    const date = url.searchParams.get('date') ?? isoDate(new Date());
    const start = new Date(`${date}T00:00:00`).getTime();
    let orders = db
      .table<OrderDto>('orders')
      .where((o) => o.merchantId === session.merchantId && o.status === 'completed' && (o.completedAt ?? 0) >= start && (o.completedAt ?? 0) < start + DAY);
    if (storeId) orders = orders.filter((o) => o.storeId === storeId);
    const hours: HourlyTrendPoint[] = [];
    for (let hour = 0; hour < 24; hour++) {
      const list = orders.filter((o) => new Date(o.completedAt ?? 0).getHours() === hour);
      hours.push({ hour, revenueTZS: Math.round(list.reduce((s, o) => s + o.total, 0)), orderCount: list.length });
    }
    return okArray(hours);
  }),

  /* ---- Conversion funnel: legacy shape (days=) or contract shape (from/to) ---- */
  h.get('/api/analytics/funnel', ({ request }) => {
    const session = requireSession(request);
    const url = new URL(request.url);
    const storeId = url.searchParams.get('storeId') ?? undefined;
    const hasRange = url.searchParams.has('from') || url.searchParams.has('to');
    if (hasRange) {
      const { fromTs, toTs } = range(url, 7);
      let window = db
        .table<OrderDto>('orders')
        .where((o) => o.merchantId === session.merchantId && o.createdAt >= fromTs && o.createdAt <= toTs);
      if (storeId) window = window.filter((o) => o.storeId === storeId);
      const orders = window.length;
      const completed = window.filter((o) => o.status === 'completed').length;
      const carts = Math.max(completed, Math.round(orders / 0.55));
      const menuViews = Math.max(carts, Math.round(orders / 0.16));
      const storeVisits = Math.max(menuViews, Math.round(orders / 0.11));
      const impressions = Math.max(storeVisits, Math.round(orders / 0.032));
      const steps: Funnel['steps'] = [
        { name: 'impressions', count: impressions },
        { name: 'store_visits', count: storeVisits },
        { name: 'menu_views', count: menuViews },
        { name: 'carts', count: carts },
        { name: 'orders', count: orders },
        { name: 'completed', count: completed },
      ];
      return ok({ steps });
    }
    const days = Math.min(90, Math.max(1, Number(url.searchParams.get('days') ?? 7)));
    const orders = completedInWindow(session.merchantId, days).length;
    const impressions = Math.round(orders / 0.032);
    const storeViews = Math.round(orders / 0.11);
    const menuViews = Math.round(orders / 0.16);
    const carts = Math.round(orders / 0.55);
    const vals = [impressions, storeViews, menuViews, carts, orders];
    const labels = ['Impressions', 'Store views', 'Menu views', 'Carts', 'Orders'];
    const steps: LegacyFunnelStep[] = labels.map((label, i) => ({
      label,
      value: vals[i],
      rate: i === 0 ? 100 : round((vals[i] / Math.max(vals[i - 1], 1)) * 100, 1),
    }));
    return ok({ impressions, storeViews, menuViews, carts, orders, steps });
  }),

  /* ---- Industry benchmark: legacy (GET /analytics/benchmark) + contract
   * (GET /analytics/benchmarks) ---- */
  h.get('/api/analytics/benchmark', ({ request }) => {
    const session = requireSession(request);
    const m = session.merchantId;
    const completed = completedInWindow(m, 30);
    const orders = completed.length;
    const gmv = completed.reduce((s, o) => s + o.total, 0);
    const aov = orders ? round(gmv / orders) : 0;
    const store = db.table('stores').find('s_demo')!;
    const rating = store.rating ?? 4.7;
    const praise = praiseRate(m);
    const pct = (better: number) => ({ betterThanPct: better });
    const percentiles: LegacyBenchmark['percentiles'] = [
      { metric: 'orderVolume', label: 'Order volume', value: orders > 90 ? 'top 12%' : orders > 40 ? 'top 30%' : 'top 55%', ...pct(orders > 90 ? 88 : orders > 40 ? 70 : 45) },
      { metric: 'aov', label: 'Average order value', value: aov > 40 ? 'top 8%' : aov > 30 ? 'top 25%' : 'top 50%', ...pct(aov > 40 ? 92 : aov > 30 ? 75 : 50) },
      { metric: 'rating', label: 'Store rating', value: rating >= 4.5 ? 'top 5%' : rating >= 4.2 ? 'top 20%' : 'top 45%', ...pct(rating >= 4.5 ? 95 : rating >= 4.2 ? 80 : 55) },
      { metric: 'conversion', label: 'Order conversion', value: 'top 20%', ...pct(80) },
    ];
    const industry: LegacyBenchmark['industry'] = [
      { metric: 'AOV', store: aov, industryAvg: 36.5, deltaPct: round(((aov - 36.5) / 36.5) * 100, 1) },
      { metric: 'Repeat purchase rate', store: 28.6, industryAvg: 24.0, deltaPct: 19.2 },
      { metric: 'Praise rate', store: praise, industryAvg: 91.0, deltaPct: round(((praise - 91) / 91) * 100, 1) },
      { metric: 'Acceptance rate', store: 96.0, industryAvg: 94.5, deltaPct: 1.6 },
    ];
    return ok({ peers: 214, percentiles, industry });
  }),

  h.get('/api/analytics/benchmarks', ({ request }) => {
    const session = requireSession(request);
    const m = session.merchantId;
    const stores = merchantStores(m);
    const primary = stores[0] ?? (db.table('stores').find('s_demo') as StoreRow | undefined)!;
    const category = primary.rank?.category ?? primary.category ?? 'BBQ & Grill';
    const completed = completedInWindow(m, 30);
    const aov = completed.length ? Math.round(completed.reduce((s, o) => s + o.total, 0) / completed.length) : 0;
    const scores = stores.map((s) => storeScore(s, completedInWindow(m, 30, s.id).length));
    const own = storeScore(primary, completed.length);
    const industryAverage = Math.round(scores.reduce((a, b) => a + b, 0) / Math.max(scores.length, 1));
    const below = scores.filter((s) => s < own).length;
    const percentileRank = scores.length > 1 ? Math.round((below / (scores.length - 1)) * 100) : own >= industryAverage ? 100 : 0;
    const peers = stores.map((s) => ({
      aov: completedInWindow(m, 30, s.id).length ? Math.round(completedInWindow(m, 30, s.id).reduce((x: number, o: OrderDto) => x + o.total, 0) / completedInWindow(m, 30, s.id).length) : 0,
      praise: praiseRate(m),
      repeat: repeatRate(completedInWindow(m, 30, s.id)),
      rating: s.rating ?? 0,
    }));
    const avg = (pick: (p: (typeof peers)[number]) => number) => Math.round((peers.reduce((a, p) => a + pick(p), 0) / Math.max(peers.length, 1)) * 10) / 10;
    const summary: BenchmarkSummary = {
      category,
      merchantScore: own,
      industryAverage,
      percentileRank,
      metrics: [
        { metric: 'Average order value', merchant: aov, average: avg((p) => p.aov) },
        { metric: 'Praise rate', merchant: praiseRate(m), average: avg((p) => p.praise) },
        { metric: 'Repeat purchase rate', merchant: repeatRate(completed), average: avg((p) => p.repeat) },
        { metric: 'Store rating', merchant: primary.rating ?? 0, average: avg((p) => p.rating) },
      ],
    };
    return ok(summary);
  }),

  /* ---- Market analysis: legacy (no params) or contract (category=) ---- */
  h.get('/api/analytics/market', ({ request }) => {
    const session = requireSession(request);
    const url = new URL(request.url);
    const category = url.searchParams.get('category');
    if (category) {
      const m = session.merchantId;
      const weekAgo = Date.now() - 7 * DAY;
      const prevWeek = Date.now() - 14 * DAY;
      const week = completedInWindow(m, 7).length;
      const prev = db
        .table<OrderDto>('orders')
        .where((o) => o.merchantId === m && o.status === 'completed' && (o.completedAt ?? 0) >= prevWeek && (o.completedAt ?? 0) < weekAgo).length;
      const growth = prev ? week / prev : 1;
      const demandIndex = Math.min(100, Math.max(1, Math.round(growth * 50)));
      const trend: MarketAnalysis['trend'] = growth > 1.1 ? 'growing' : growth < 0.9 ? 'declining' : 'stable';
      const soldMap = new Map<string, number>();
      for (const o of completedInWindow(m, 7)) {
        for (const it of o.items) soldMap.set(it.name, (soldMap.get(it.name) ?? 0) + it.qty);
      }
      const topSearches = [...soldMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name]) => name);
      const competitorCount = Math.max(0, db.table('stores').all().length - 1);
      const prices = db
        .table<ProductRow>('products')
        .where((p) => p.merchantId === m && !p.deleted)
        .map((p) => p.price)
        .sort((a, b) => a - b);
      const low = prices.length ? prices[Math.floor(prices.length / 4)] : 0;
      const high = prices.length ? prices[Math.floor((prices.length * 3) / 4)] : 0;
      const analysis: MarketAnalysis = {
        category,
        demandIndex,
        trend,
        topSearches,
        competitorCount,
        suggestedPriceBandTZS: { low, high },
      };
      return ok(analysis);
    }
    const store = db.table('stores').find('s_demo')!;
    const lowPriceHot = db.table<ProductRow>('products').where((p) => p.storeId === 's_demo' && !p.deleted && p.price <= 15).some((p) => p.sold > 20);
    const topSeller = db.table<ProductRow>('products').where((p) => p.storeId === 's_demo' && !p.deleted).sort((a, b) => b.sold - a.sold)[0];
    const opportunities: LegacyMarketAnalysis['opportunities'] = [];
    if (lowPriceHot) opportunities.push({ title: 'Price point working', detail: 'Your low-price items drive volume — consider a bundle to lift AOV.' });
    if ((store.rating ?? 0) >= 4.5) opportunities.push({ title: 'Strong rating', detail: 'You qualify for homepage campaign slots — claim one under Store > Platform campaigns.' });
    if (topSeller && topSeller.stock < 20) opportunities.push({ title: 'Top seller at risk', detail: `${topSeller.name} stock is low — restock before the weekend rush.` });
    opportunities.push({ title: 'Late-night demand rising', detail: 'BBQ searches between 21:00–00:00 grew 18% — extend your peak prep window.' });
    const legacy: LegacyMarketAnalysis = {
      categoryTrend: [
        { category: 'BBQ & Grill', demandDeltaPct: 18 },
        { category: 'Hotpot', demandDeltaPct: 12 },
        { category: 'Fast food', demandDeltaPct: 6 },
        { category: 'Milk tea', demandDeltaPct: 4 },
      ],
      priceBands: [
        { band: 'Under ¥20', share: 22 },
        { band: '¥20–40', share: 41 },
        { band: '¥40–70', share: 26 },
        { band: 'Over ¥70', share: 11 },
      ],
      keywordTrends: [
        { keyword: 'lamb skewer', growthPct: 34 },
        { keyword: 'bbq platter', growthPct: 22 },
        { keyword: 'late-night bbq', growthPct: 18 },
      ],
      opportunities,
    };
    return ok(legacy);
  }),

  /* ---- Product analytics: legacy (sort/limit) or contract (from/to) ---- */
  h.get('/api/analytics/products', ({ request }) => {
    const session = requireSession(request);
    const url = new URL(request.url);
    if (url.searchParams.has('from') || url.searchParams.has('to')) {
      const { fromTs, toTs } = range(url, 7);
      const storeId = url.searchParams.get('storeId') ?? undefined;
      const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit') ?? 20)));
      const rows = productPerformance(session.merchantId, fromTs, toTs, storeId);
      rows.sort((a, b) => b.unitsSold - a.unitsSold || b.revenueTZS - a.revenueTZS);
      return okArray(rows.slice(0, limit));
    }
    const sort = url.searchParams.get('sort') ?? 'revenue';
    const limit = Math.min(50, Number(url.searchParams.get('limit') ?? 10));
    const products = db.table<ProductRow>('products').where((p) => p.merchantId === session.merchantId && !p.deleted);
    const stockLogs = db.table('productLogs').where((l: any) => l.action === 'product:stock' && l.after === 0);
    const rows: LegacyProductRow[] = products.map((p) => {
      let sold = 0;
      let revenue = 0;
      let orders = 0;
      for (const o of db.table<OrderDto>('orders').where((o) => o.merchantId === session.merchantId && o.status === 'completed')) {
        for (const it of o.items) {
          if (it.productId === p.id) {
            sold += it.qty;
            revenue += it.price * it.qty;
            orders += 1;
          }
        }
      }
      return {
        id: p.id,
        name: p.name,
        emoji: p.emoji,
        price: p.price,
        sold,
        revenue: round(revenue),
        orders,
        stock: p.stock,
        stockOutEvents: stockLogs.filter((l: any) => l.productId === p.id).length,
        share: 0,
      };
    });
    const totalSold = rows.reduce((s, r) => s + r.sold, 0) || 1;
    for (const r of rows) r.share = round((r.sold / totalSold) * 100, 1);
    rows.sort((a, b) =>
      sort === 'sold' ? b.sold - a.sold : sort === 'stockout' ? b.stockOutEvents - a.stockOutEvents || a.stock - b.stock : b.revenue - a.revenue,
    );
    return ok({ products: rows.slice(0, limit) });
  }),

  /* ---- Revenue composition: legacy BI view (mock-only until adopted) ---- */
  h.get('/api/analytics/revenue-composition', ({ request }) => {
    const session = requireSession(request);
    const url = new URL(request.url);
    const days = Math.min(90, Math.max(1, Number(url.searchParams.get('days') ?? 7)));
    return ok({
      channels: channelsOf(session.merchantId, days, completedInWindow(session.merchantId, days)),
      methods: methodsOf(session.merchantId, days),
    });
  }),

  /* ---- Contract: Revenue analysis (GET /analytics/revenue?from&to) ---- */
  h.get('/api/analytics/revenue', ({ request }) => {
    const session = requireSession(request);
    const url = new URL(request.url);
    const { from, to, fromTs, toTs } = range(url, 7);
    const storeId = url.searchParams.get('storeId') ?? undefined;
    const m = session.merchantId;
    let orders = completedBetween(m, fromTs, toTs);
    if (storeId) orders = orders.filter((o) => o.storeId === storeId);
    const delivery = Math.round(orders.filter((o) => o.deliveryType === 'delivery').reduce((s, o) => s + o.total, 0));
    const pickup = Math.round(orders.filter((o) => o.deliveryType === 'pickup').reduce((s, o) => s + o.total, 0));
    /* Dine-in bills carry no storeId — scope them through their table's store. */
    let dineInBills = db
      .table<DineInOrder>('dineInOrders')
      .where((b) => b.merchantId === m && (b.paidAt ?? 0) >= fromTs && (b.paidAt ?? 0) <= toTs);
    if (storeId) {
      const tableIds = new Set(db.table<TableRow>('tables').where((t) => t.storeId === storeId).map((t) => t.id));
      dineInBills = dineInBills.filter((b) => tableIds.has(b.tableId));
    }
    const dineIn = Math.round(dineInBills.reduce((s, b) => s + b.totals.totalTZS, 0));
    const byChannel: RevenueChannel[] = [
      { channel: 'delivery', amountTZS: delivery },
      { channel: 'dine_in', amountTZS: dineIn },
      { channel: 'group_buy', amountTZS: 0 },
      { channel: 'pickup', amountTZS: pickup },
    ];
    const analysis: RevenueAnalysis = { from, to, totalTZS: delivery + dineIn + pickup, byChannel };
    return ok(analysis);
  }),

  /* ---- Diagnostics (GET /analytics/diagnostics) — phased backend M7e.
   * Honest placeholder: no insight content is fabricated until the milestone
   * ships (docs/AI-AUTOMATION.md); the single highlight is the gate note. ---- */
  h.get('/api/analytics/diagnostics', ({ request }) => {
    requireSession(request);
    return ok({
      generatedAt: Date.now(),
      issues: [] as LegacyDiagnosticIssue[],
      highlights: [{ title: 'Diagnostics', detail: 'AI diagnostics are not available yet — coming in a later release.' }],
    });
  }),

  /* ---- Contract: Order analytics (GET /analytics/order-analytics?from&to) ---- */
  h.get('/api/analytics/order-analytics', ({ request }) => {
    const session = requireSession(request);
    const url = new URL(request.url);
    const { fromTs, toTs } = range(url, 7);
    const storeId = url.searchParams.get('storeId') ?? undefined;
    let orders = db.table<OrderDto>('orders').where((o) => o.merchantId === session.merchantId && o.createdAt >= fromTs && o.createdAt <= toTs);
    if (storeId) orders = orders.filter((o) => o.storeId === storeId);
    const totalOrders = orders.length;
    const byHour: { hour: number; count: number }[] = [];
    for (let hour = 0; hour < 24; hour++) {
      byHour.push({ hour, count: orders.filter((o) => new Date(o.createdAt).getHours() === hour).length });
    }
    const bandEdges = [0, 15, 30, 60];
    const byPriceBand = bandEdges.map((low, i) => {
      const high = i === bandEdges.length - 1 ? Infinity : bandEdges[i + 1];
      return { band: i === bandEdges.length - 1 ? `${low}+` : `${low}-${high}`, count: orders.filter((o) => o.total >= low && o.total < high).length };
    });
    const analysis: OrderAnalytics = {
      totalOrders,
      byHour,
      byPriceBand,
      avgOrderValueTZS: totalOrders ? Math.round(orders.reduce((s, o) => s + o.total, 0) / totalOrders) : 0,
    };
    return ok(analysis);
  }),

  /* ---- Report bundle (mock-only until adopted) ---- */
  h.get('/api/analytics/report', ({ request }) => {
    const session = requireSession(request);
    const url = new URL(request.url);
    const days = Math.min(90, Math.max(1, Number(url.searchParams.get('days') ?? 30)));
    const m = session.merchantId;
    const orders = completedInWindow(m, days);
    const gmv = round(orders.reduce((s, o) => s + o.total, 0));
    const aov = orders.length ? round(gmv / orders.length) : 0;
    const store = db.table('stores').find('s_demo')!;
    const dishes = db.table<ProductRow>('products').where((p) => p.storeId === 's_demo' && !p.deleted).sort((a, b) => b.sold - a.sold).slice(0, 5).map((p) => ({ name: p.name, sold: p.sold, revenue: round(p.sold * p.price) }));
    const dailySeries: LegacyReportBundle['dailySeries'] = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * DAY);
      const start = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
      const list = orders.filter((o) => (o.completedAt ?? 0) >= start && (o.completedAt ?? 0) < start + DAY);
      dailySeries.push({ label: i === 0 ? 'Today' : ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()], revenue: round(list.reduce((s, o) => s + o.total, 0)), orders: list.length });
    }
    const report: LegacyReportBundle = {
      generatedAt: Date.now(),
      storeName: store.name,
      days,
      summary: { gmv, orders: orders.length, aov, rating: store.rating ?? 4.7, praiseRate: praiseRate(m) },
      dailySeries,
      topDishes: dishes,
      channels: channelsOf(m, days, orders).map((c) => ({ key: c.key, label: c.label, amount: c.amount, orders: c.orders })),
      issues: [],
    };
    return ok(report);
  }),

  /* ---- Contract: Report export (POST /analytics/reports/export) ---- */
  h.post('/api/analytics/reports/export', async ({ request }) => {
    const session = requireSession(request);
    requirePerm(session, 'store:manage');
    const body = await readJson(request);
    const reportType = String(body.reportType ?? '');
    if (!['revenue', 'products', 'traffic', 'orders'].includes(reportType)) {
      throw new ApiHttpError(422, 'REPORT_TYPE_INVALID', 'reportType must be one of revenue, products, traffic, orders');
    }
    const from = String(body.from ?? isoDate(new Date(Date.now() - 29 * DAY)));
    const to = String(body.to ?? isoDate(new Date()));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      throw new ApiHttpError(422, 'ANALYTICS_RANGE_INVALID', 'from/to must be yyyy-mm-dd');
    }
    if (from > to) throw new ApiHttpError(422, 'ANALYTICS_RANGE_INVALID', 'from must not be after to');
    const days = Math.round((new Date(`${to}T23:59:59`).getTime() - new Date(`${from}T00:00:00`).getTime()) / DAY);
    if (days > 90) {
      throw new ApiHttpError(400, 'ANALYTICS_REPORT_EXCEEDS_LIMIT', 'Range too large — exports cover at most 90 days');
    }
    /* Async-ready semantics: ranges over 60 days are generated as a job;
     * the first request (and any request before the job finishes) gets
     * ANALYTICS_EXPORT_NOT_READY (503, retriable) — the client polls with
     * backoff and receives the downloadUrl once ready (ANALYTICS.md:83). */
    const key = `${reportType}:${from}:${to}`;
    if (days > 60) {
      const readyAt = exportJobs.get(key) ?? Date.now() + 60;
      exportJobs.set(key, readyAt);
      if (Date.now() < readyAt) {
        throw new ApiHttpError(503, 'ANALYTICS_EXPORT_NOT_READY', 'Report is still generating — retry in a moment', true);
      }
    }
    const payload = {
      reportType,
      from,
      to,
      generatedAt: new Date().toISOString(),
      rows: reportType === 'revenue' ? { totalTZS: 0, byChannel: [] } : [],
    };
    const downloadUrl = `data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(payload))}`;
    const result: ReportExport = { downloadUrl, expiresInSeconds: 900 };
    audit(session.merchantId, session.staffId, session.role, 'report:export', 'analytics-report', reportType, `exported ${reportType} report (${from} → ${to})`);
    return ok(result);
  }),

  /* ---- Multi-store inspection (mock-only until adopted) ---- */
  h.get('/api/analytics/multi-store', ({ request }) => {
    const session = requireSession(request);
    const stores = db.table('stores').where((s: any) => s.merchantId === session.merchantId);
    const stats: LegacyMultiStoreStat[] = stores.map((st: any) => {
      const orders = db.table<OrderDto>('orders').where((o) => o.merchantId === session.merchantId && o.storeId === st.id && o.status === 'completed');
      const revenue = round(orders.reduce((s, o) => s + o.total, 0));
      const aov = orders.length ? round(revenue / orders.length) : 0;
      const score = Math.round(Math.min(100, (st.rating ?? 0) * 12 + (Math.min(orders.length, 200) / 200) * 20));
      return { id: st.id, name: st.name, revenue, orders: orders.length, aov, rating: st.rating ?? 0, score, flags: [] as LegacyMultiStoreStat['flags'] };
    });
    stats.sort((a, b) => b.revenue - a.revenue);
    const best = stats[0]?.revenue ?? 0;
    for (const s of stats) {
      if (best && s.revenue < best * 0.6) s.flags.push({ severity: 'high', text: 'Revenue gap vs top store' });
      const lowStock = db.table<ProductRow>('products').where((p) => p.storeId === s.id && !p.deleted && p.sold > 10 && p.stock < 10).length;
      if (lowStock) s.flags.push({ severity: 'medium', text: `${lowStock} top product(s) low on stock` });
      const st = db.table('stores').find(s.id);
      if (st && !st.open) s.flags.push({ severity: 'medium', text: 'Store currently closed' });
    }
    return ok({ stores: stats });
  }),

  /* ---- Contract: Chain analytics (GET /chain/analytics?from&to) ---- */
  h.get('/api/chain/analytics', ({ request }) => {
    const session = requireSession(request);
    const url = new URL(request.url);
    const { fromTs, toTs } = range(url, 7);
    /* Append-only (I8): range guard — ANALYTICS_RANGE_INVALID for malformed
     * or inverted ranges (EF L22, same code family as single-store). */
    const fromRaw = url.searchParams.get('from');
    const toRaw = url.searchParams.get('to');
    if (fromRaw !== null && !/^\d{4}-\d{2}-\d{2}$/.test(fromRaw)) {
      throw new ApiHttpError(400, 'ANALYTICS_RANGE_INVALID', 'from must be yyyy-mm-dd');
    }
    if (toRaw !== null && !/^\d{4}-\d{2}-\d{2}$/.test(toRaw)) {
      throw new ApiHttpError(400, 'ANALYTICS_RANGE_INVALID', 'to must be yyyy-mm-dd');
    }
    if (toTs < fromTs) {
      throw new ApiHttpError(400, 'ANALYTICS_RANGE_INVALID', 'to must not be before from');
    }
    const m = session.merchantId;
    const storeId = url.searchParams.get('storeId') ?? undefined;
    let stores = merchantStores(m);
    if (storeId) stores = stores.filter((st: any) => st.id === storeId);
    const chain: ChainStorePerformance[] = stores.map((st: any) => {
      const orders = db
        .table<OrderDto>('orders')
        .where((o) => o.merchantId === m && o.storeId === st.id && o.status === 'completed' && (o.completedAt ?? 0) >= fromTs && (o.completedAt ?? 0) <= toTs);
      const revenueTZS = Math.round(orders.reduce((s, o) => s + o.total, 0));
      const visits = Math.round((orders.length / 0.11) || 0);
      const lowStockCount = db
        .table<ProductRow>('products')
        .where((p) => p.storeId === st.id && !p.deleted && p.visible && p.stock < 10).length;
      return {
        storeId: st.id,
        businessName: st.name,
        revenueTZS,
        orderCount: orders.length,
        conversionRate: visits ? round(orders.length / visits, 4) : 0,
        rating: st.rating ?? null,
        isOpen: st.open === true,
        lowStockCount,
      };
    });
    return okArray(chain);
  }),

  /* ---- Contract: Sales forecast (GET /analytics/forecast?horizonDays=).
   * Reconciles ANALYTICS.md:112-115 (contract shape, labeled "prediction")
   * with AI-AUTOMATION.md ("no AI forecast") — the forecast is a rule-based
   * derivation from the merchant's own completed-order history, never an AI
   * claim and never weather-based (weather: null). Without ?horizonDays= the
   * legacy {tomorrow} advisory shape is served (p6e parity). ---- */
  h.get('/api/analytics/forecast', ({ request }) => {
    const session = requireSession(request);
    const url = new URL(request.url);
    const storeId = url.searchParams.get('storeId') ?? undefined;
    if (url.searchParams.has('horizonDays')) {
      const horizon = Math.min(30, Math.max(1, Number(url.searchParams.get('horizonDays') ?? 7)));
      const m = session.merchantId;
      const dayStart = new Date().setHours(0, 0, 0, 0);
      const history = new Array(14).fill(0).map((_, i) => {
        const start = dayStart - (14 - i) * DAY;
        let list = db
          .table<OrderDto>('orders')
          .where((o) => o.merchantId === m && o.status === 'completed' && (o.completedAt ?? 0) >= start && (o.completedAt ?? 0) < start + DAY);
        if (storeId) list = list.filter((o) => o.storeId === storeId);
        return list.reduce((s, o) => s + o.total, 0);
      });
      const base = Math.round(history.reduce((s, v) => s + v, 0) / Math.max(history.length, 1));
      const points: ForecastPoint[] = [];
      for (let i = 1; i <= horizon; i++) {
        const d = new Date(Date.now() + i * DAY);
        points.push({
          date: isoDate(d),
          predictedRevenueTZS: Math.round(base * (1 + (i - 1) * 0.02)),
          confidence: Math.max(0.2, Math.min(0.9, round(0.9 - (i - 1) * 0.1))),
          weather: null,
        });
      }
      return okArray(points);
    }
    const m = session.merchantId;
    const weekAgo = Date.now() - 7 * DAY;
    const prevWeek = Date.now() - 14 * DAY;
    let week = db.table<OrderDto>('orders').where((o) => o.merchantId === m && o.status === 'completed' && (o.completedAt ?? 0) >= weekAgo);
    let prev = db.table<OrderDto>('orders').where((o) => o.merchantId === m && o.status === 'completed' && (o.completedAt ?? 0) >= prevWeek && (o.completedAt ?? 0) < weekAgo);
    if (storeId) {
      week = week.filter((o) => o.storeId === storeId);
      prev = prev.filter((o) => o.storeId === storeId);
    }
    const delta = prev.length ? Math.round(((week.length - prev.length) / prev.length) * 100) : 0;
    return ok({
      tomorrow: {
        rainExpected: false,
        temp: 26,
        orderDeltaPct: Math.min(20, Math.max(-20, delta)),
        tips: [
          `Based on your last 7 days of completed orders, demand is ${delta >= 0 ? 'trending up' : 'trending down'} — this forecast is advisory only.`,
        ],
      },
    });
  }),

  /* ---- Contract: Review analytics (GET /analytics/reviews?from&to).
   * With a date range the contract ReviewAnalytics shape is served
   * ({from,to,ratingAverage,reviewCount,replyRate,trendByDay[]},
   * ANALYTICS.md:55-60); without, the legacy payload stays byte-identical
   * to GET /reviews/analytics (drift parity test). Values are computed from
   * the seeded reviews — never client-derived. ---- */
  h.get('/api/analytics/reviews', ({ request }) => {
    const session = requireSession(request);
    const url = new URL(request.url);
    const hasRange = url.searchParams.has('from') || url.searchParams.has('to');
    if (hasRange) {
      const { from, to, fromTs, toTs } = range(url, 30);
      const rows = db.table<ReviewDto>('reviews').where((r) => r.merchantId === session.merchantId && r.ts >= fromTs && r.ts <= toTs);
      const total = rows.length;
      const ratingAverage = total ? round(rows.reduce((s, r) => s + r.rating, 0) / total, 2) : 0;
      const replyRate = total ? round((rows.filter((r) => r.reply).length / total) * 100, 2) : 0;
      const trendByDay: ReviewAnalyticsContract['trendByDay'] = [];
      const dayStart = new Date(fromTs).getTime();
      const dayEnd = new Date(toTs).getTime();
      for (let ts = dayStart; ts <= dayEnd; ts += DAY) {
        const list = rows.filter((r) => r.ts >= ts && r.ts < ts + DAY);
        trendByDay.push({
          date: isoDate(new Date(ts)),
          count: list.length,
          avgRating: list.length ? round(list.reduce((s, r) => s + r.rating, 0) / list.length, 2) : 0,
        });
      }
      const analysis: ReviewAnalyticsContract = { from, to, ratingAverage, reviewCount: total, replyRate, trendByDay };
      return ok(analysis);
    }
    const rows = db.table<ReviewDto>('reviews').where((r) => r.merchantId === session.merchantId);
    const total = rows.length;
    const avgRating = total ? Math.round((rows.reduce((s, r) => s + r.rating, 0) / total) * 10) / 10 : 0;
    const praiseRate = total ? Math.round((rows.filter((r) => r.rating >= 4).length / total) * 1000) / 10 : 0;
    const replyRate = total ? Math.round((rows.filter((r) => r.reply).length / total) * 1000) / 10 : 0;
    const distribution = [1, 2, 3, 4, 5].map((rating) => ({ rating, count: rows.filter((r) => r.rating === rating).length }));
    const weeklyAvg: ReviewAnalytics['weeklyAvg'] = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(Date.now() - i * DAY);
      const start = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
      const list = rows.filter((r) => r.ts >= start && r.ts < start + DAY);
      weeklyAvg.push({
        label: i === 0 ? 'Today' : ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()],
        avg: list.length ? Math.round((list.reduce((s, r) => s + r.rating, 0) / list.length) * 10) / 10 : 0,
      });
    }
    const byPlatform: ReviewAnalytics['byPlatform'] = { meituan: { total: 0, avgRating: 0, praiseRate: 0 }, dianping: { total: 0, avgRating: 0, praiseRate: 0 } };
    for (const platform of ['meituan', 'dianping'] as const) {
      const list = rows.filter((r) => r.platform === platform);
      byPlatform[platform] = {
        total: list.length,
        avgRating: list.length ? Math.round((list.reduce((s, r) => s + r.rating, 0) / list.length) * 10) / 10 : 0,
        praiseRate: list.length ? Math.round((list.filter((r) => r.rating >= 4).length / list.length) * 1000) / 10 : 0,
      };
    }
    return ok({ total, avgRating, praiseRate, replyRate, distribution, weeklyAvg, byPlatform });
  }),
];

/* Async export jobs (POST /analytics/reports/export): key → readyAt ts.
 * Module-level so the NOT_READY lifecycle survives across requests. */
const exportJobs = new Map<string, number>();
