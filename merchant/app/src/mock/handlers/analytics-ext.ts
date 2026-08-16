import type {
  BrandDisplayCampaign,
  CouponCampaign,
  CustomerDistributionRow,
  CustomerInsights,
  DianjinCampaign,
  MarketingAnalytics,
  OrderDto,
  Promotion,
  ReviewDto,
  StoreScore,
} from '@/api/types';
import { db } from '@/mock/db';
import { ok, requireSession } from '@/mock/security';
import { h } from '@/mock/handlers/common';

/* P8c analytics extensions (contract /analytics/store-score, /analytics/customers,
 * /analytics/customer-distribution, /analytics/marketing).
 * Every value is derived from the seeded db rows (orders, reviews, promotions,
 * dianjin campaigns) — nothing fabricated; money is integer TZS. */

const DAY = 86400000;
const round = (n: number, dp = 2) => Math.round(n * 10 ** dp) / 10 ** dp;

function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Contract date-range query (`from`/`to`, default last 30 days). */
function range(url: URL): { from: string; to: string; fromTs: number; toTs: number } {
  const to = url.searchParams.get('to') ?? isoDate(new Date());
  const from = url.searchParams.get('from') ?? isoDate(new Date(Date.now() - 29 * DAY));
  const fromTs = new Date(`${from}T00:00:00`).getTime();
  const toTs = new Date(`${to}T23:59:59`).getTime();
  return { from, to, fromTs, toTs };
}

interface StoreRow {
  id: string;
  merchantId: string;
  rating?: number;
}

function merchantStores(merchantId: string): StoreRow[] {
  return db.table<StoreRow>('stores').where((s) => s.merchantId === merchantId);
}

function merchantOrders(merchantId: string): OrderDto[] {
  return db.table<OrderDto>('orders').where((o) => o.merchantId === merchantId);
}

function praiseRate(merchantId: string): number {
  const reviews = db.table<ReviewDto>('reviews').where((r) => r.merchantId === merchantId);
  if (!reviews.length) return 0;
  return (reviews.filter((r) => r.rating >= 4).length / reviews.length) * 100;
}

/** Share of orders the merchant accepted (never cancelled pre-accept). */
function serviceRate(merchantId: string): number {
  const orders = merchantOrders(merchantId);
  if (!orders.length) return 0;
  const accepted = orders.filter((o) => o.acceptedAt !== undefined).length;
  return (accepted / orders.length) * 100;
}

/** Average delivery leg duration (acceptedAt → completedAt), mapped 0–100:
 *  ≤15 min = 100, ≥60 min = 0. */
function deliverySpeedScore(merchantId: string): number {
  const orders = merchantOrders(merchantId).filter((o) => o.acceptedAt !== undefined && o.completedAt !== undefined);
  if (!orders.length) return 0;
  const avgMin = orders.reduce((s, o) => s + (o.completedAt! - o.acceptedAt!) / 60000, 0) / orders.length;
  return Math.round(Math.min(100, Math.max(0, 100 - ((avgMin - 15) / 45) * 100)));
}

/** Repeat-purchase share among completed orders, 0–100. */
function repeatRate(orders: OrderDto[]): number {
  const phones = orders.map((o) => o.customer.phone);
  if (!phones.length) return 0;
  return (phones.filter((c, i) => phones.indexOf(c) !== i).length / phones.length) * 100;
}

function aovTZS(orders: OrderDto[]): number {
  return orders.length ? Math.round(orders.reduce((s, o) => s + o.total, 0) / orders.length) : 0;
}

export const analyticsExtHandlers = [
  /* ---- Contract: Store score (GET /analytics/store-score) ---- */
  h.get('/api/analytics/store-score', ({ request }) => {
    const session = requireSession(request);
    const m = session.merchantId;
    const stores = merchantStores(m);
    const ratingAverage = stores.length ? round(stores.reduce((s, st) => s + (st.rating ?? 0), 0) / stores.length, 1) : 0;
    const completed = merchantOrders(m).filter((o) => o.status === 'completed');
    const praise = praiseRate(m);
    const score = Math.round(
      Math.min(
        100,
        Math.max(0, ratingAverage * 12 + (Math.min(completed.length, 200) / 200) * 20 + (praise > 0 ? praise * 0.1 : 0)),
      ),
    );
    const service = serviceRate(m);
    const speed = deliverySpeedScore(m);
    const distribution: StoreScore = {
      score,
      ratingAverage,
      breakdown: [
        { factor: 'delivery_speed', score: speed },
        { factor: 'food_quality', score: Math.round(praise) },
        { factor: 'service', score: Math.round(service) },
        { factor: 'repeat_rate', score: Math.round(repeatRate(completed)) },
        { factor: 'average_order_value', score: Math.min(100, Math.round(aovTZS(completed) / 1000)) },
      ],
    };
    return ok(distribution);
  }),

  /* ---- Contract: Customer insights (GET /analytics/customers?from&to) ---- */
  h.get('/api/analytics/customers', ({ request }) => {
    const session = requireSession(request);
    const url = new URL(request.url);
    const { fromTs, toTs } = range(url);
    const m = session.merchantId;
    const all = merchantOrders(m);
    const window = all.filter((o) => o.createdAt >= fromTs && o.createdAt <= toTs);
    const windowPhones = new Set(window.map((o) => o.customer.phone));
    let newCustomers = 0;
    for (const phone of windowPhones) {
      const first = all.filter((o) => o.customer.phone === phone).sort((a, b) => a.createdAt - b.createdAt)[0];
      if (first && first.createdAt >= fromTs && first.createdAt <= toTs) newCustomers += 1;
    }
    const returningCustomers = windowPhones.size - newCustomers;
    const retentionRate = windowPhones.size ? round((returningCustomers / windowPhones.size) * 100, 1) : 0;
    const avgOrderFrequency = windowPhones.size ? round(window.length / windowPhones.size, 1) : 0;
    const lifetimeSpend = windowPhones.size
      ? Math.round(
          all
            .filter((o) => windowPhones.has(o.customer.phone))
            .reduce((s, o) => s + o.total, 0) / windowPhones.size,
        )
      : 0;
    const monthlyTrend: CustomerInsights['monthlyTrend'] = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date();
      d.setDate(1);
      d.setMonth(d.getMonth() - i);
      const monthStart = d.getTime();
      const monthEnd = monthStart + 32 * DAY;
      const monthOrders = all.filter((o) => o.createdAt >= monthStart && o.createdAt < monthEnd);
      const monthPhones = new Set(monthOrders.map((o) => o.customer.phone));
      let monthNew = 0;
      for (const phone of monthPhones) {
        const first = all.filter((o) => o.customer.phone === phone).sort((a, b) => a.createdAt - b.createdAt)[0];
        if (first && first.createdAt >= monthStart && first.createdAt < monthEnd) monthNew += 1;
      }
      monthlyTrend.push({
        month: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
        newCustomers: monthNew,
        returningCustomers: monthPhones.size - monthNew,
      });
    }
    const insights: CustomerInsights = {
      newCustomers,
      returningCustomers,
      retentionRate,
      avgOrderFrequency,
      avgLifetimeValueTZS: lifetimeSpend,
      churnRate: round(100 - retentionRate, 1),
      monthlyTrend,
    };
    return ok(insights);
  }),

  /* ---- Contract: Customer distribution (GET /analytics/customer-distribution) ---- */
  h.get('/api/analytics/customer-distribution', ({ request }) => {
    const session = requireSession(request);
    const m = session.merchantId;
    const areas = new Map<string, number>();
    const seen = new Set<string>();
    const addCustomer = (phone: string, address: string) => {
      if (seen.has(phone)) return;
      seen.add(phone);
      const area = areaOf(address);
      areas.set(area, (areas.get(area) ?? 0) + 1);
    };
    for (const c of db.table<{ id: string; phone: string; address: string }>('customers').all()) {
      addCustomer(c.phone, c.address);
    }
    for (const o of merchantOrders(m)) {
      addCustomer(o.customer.phone, o.customer.address);
    }
    const rows: CustomerDistributionRow[] = [...areas.entries()]
      .map(([area, customerCount]) => ({ area, customerCount }))
      .sort((a, b) => b.customerCount - a.customerCount);
    return Response.json(rows);
  }),

  /* ---- Contract: Marketing analytics (GET /analytics/marketing?from&to) ---- */
  h.get('/api/analytics/marketing', ({ request }) => {
    const session = requireSession(request);
    const url = new URL(request.url);
    const { fromTs, toTs } = range(url);
    const m = session.merchantId;
    const promos = db.table<Promotion>('promotions').where((p) => p.merchantId === m);
    const dianjin = db.table<DianjinCampaign>('dianjinCampaigns').where((c) => c.merchantId === m);
    const brandDisplays = db.table<BrandDisplayCampaign & { merchantId: string }>('brandDisplays').where((c) => c.merchantId === m);
    const couponCampaigns = db.table<CouponCampaign>('couponCampaigns').where((c) => c.merchantId === m);
    const inWindow = (ts: number | undefined) => ts !== undefined && ts >= fromTs && ts <= toTs;
    const spendFromPromos = promos.filter((p) => inWindow(p.createdAt)).reduce((s, p) => s + (p.spendTZS ?? 0), 0);
    const spendFromDianjin = dianjin.filter((c) => inWindow(c.createdAt)).reduce((s, c) => s + c.spendTZS, 0);
    const totalSpendTZS = spendFromPromos + spendFromDianjin;
    const attributedRevenueTZS = promos.filter((p) => inWindow(p.createdAt)).reduce((s, p) => s + (p.attributedRevenueTZS ?? 0), 0);
    const activeCampaigns =
      promos.filter((p) => p.status === 'live').length +
      dianjin.filter((c) => c.active).length +
      brandDisplays.filter((c) => c.active).length +
      couponCampaigns.filter((c) => c.status === 'live').length;
    const analytics: MarketingAnalytics = {
      totalSpendTZS: Math.round(totalSpendTZS),
      attributedRevenueTZS: Math.round(attributedRevenueTZS),
      roiPercent: totalSpendTZS ? round((attributedRevenueTZS / totalSpendTZS) * 100, 1) : 0,
      activeCampaigns,
    };
    return ok(analytics);
  }),
];

/** Map an address string to a known service-area label (derived, never PII). */
function areaOf(address: string): string {
  const a = address.toLowerCase();
  const known: [string, string][] = [
    ['wangjing', 'Wangjing'],
    ['zhongguancun', 'Zhongguancun'],
    ['wudaokou', 'Wudaokou'],
    ['taiyanggong', 'Taiyanggong'],
    ['jiuxianqiao', 'Jiuxianqiao'],
    ['haidian', 'Haidian'],
    ['dongcheng', 'Dongcheng'],
    ['chaoyang', 'Chaoyang'],
    ['kariakoo', 'Kariakoo'],
    ['dar es salaam', 'Dar es Salaam'],
    ['dodoma', 'Dodoma'],
  ];
  for (const [needle, label] of known) {
    if (a.includes(needle)) return label;
  }
  return 'Other';
}
