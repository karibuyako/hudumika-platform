
import type { CampaignDto, CampaignPerformance, CouponCampaign, CouponCampaignKind, NotificationDto, SegmentRow } from '@/api/types';
import { db, uid } from '@/mock/db';
import { emit } from '@/mock/events';
import { audit, ok, requirePerm, requireSession } from '@/mock/security';
import { ApiHttpError, h, readJson } from '@/mock/handlers/common';

interface CustomerCouponRow {
  id: string;
  merchantId: string;
  code: string;
  amountTZS: number;
  status: 'unused' | 'claimed' | 'used' | 'expired';
  expiresAt: number;
  createdAt: number;
  claimedAt?: number;
}

/* Traffic (advertising) campaigns are phased (PROMOTIONS.md) — rows stay in the
 * store for sweeper attribution but never leave the API (UI doesn't expose ads). */
const HIDDEN_CAMPAIGN_TYPES: readonly string[] = ['ads'];

/** Campaign rows visible on the marketing surface (traffic rows excluded). */
function visibleCampaigns(merchantId: string): CampaignDto[] {
  return db
    .table<CampaignDto>('campaigns')
    .where((c) => c.merchantId === merchantId && !HIDDEN_CAMPAIGN_TYPES.includes(c.type))
    .sort((a, b) => b.createdAt - a.createdAt);
}

/** Contract CustomerSegment rules (CRM.md) — rule keys the rule-builder offers. */
const SEGMENT_RULE_KEYS = ['minSpendTZS', 'maxSpendTZS', 'minOrders', 'maxOrders', 'recencyDays', 'priceTag', 'lastOrderDaysAgo'] as const;

function intRule(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/** Server-side segment rules validation — SEGMENT_RULES_INVALID (422 with field errors). */
function validateSegmentRules(rules: unknown): Record<string, unknown> {
  const errors: Record<string, string> = {};
  if (typeof rules !== 'object' || rules === null || Array.isArray(rules)) {
    errors.rules = 'rules must be an object of accepted predicates';
    throw new ApiHttpError(422, 'SEGMENT_RULES_INVALID', 'Invalid segment rules', false, errors);
  }
  for (const [key, value] of Object.entries(rules as Record<string, unknown>)) {
    if (!SEGMENT_RULE_KEYS.includes(key as (typeof SEGMENT_RULE_KEYS)[number])) {
      errors[key] = `unsupported rule key "${key}"`;
    } else if (key === 'priceTag') {
      if (typeof value !== 'string' || !value.trim()) errors[key] = 'priceTag must be a non-empty string';
    } else if (key === 'recencyDays') {
      if (intRule(value) === null) errors[key] = 'recencyDays must be a non-negative integer';
    } else if (intRule(value) === null) {
      errors[key] = `${key} must be a non-negative integer (integer TZS, no floats)`;
    }
  }
  const minSpend = intRule((rules as Record<string, unknown>).minSpendTZS);
  const maxSpend = intRule((rules as Record<string, unknown>).maxSpendTZS);
  if (minSpend !== null && maxSpend !== null && maxSpend < minSpend) {
    errors.maxSpendTZS = 'maxSpendTZS must be >= minSpendTZS';
  }
  if (Object.keys(errors).length) {
    throw new ApiHttpError(422, 'SEGMENT_RULES_INVALID', 'Segment rules failed validation', false, errors);
  }
  return rules as Record<string, unknown>;
}

/** Deterministic server-side segment evaluation for the mock — memberCount is
 *  computed, never client-estimated (CRM.md). */
function memberCountFor(rules: Record<string, unknown>): number {
  const minSpend = intRule(rules.minSpendTZS) ?? 0;
  const minOrders = intRule(rules.minOrders) ?? 0;
  const maxOrders = intRule(rules.maxOrders);
  const recency = intRule(rules.recencyDays) ?? 365;
  let count = 48;
  if (minSpend >= 150000) count -= 26;
  else if (minSpend >= 50000) count -= 12;
  else if (minSpend >= 10000) count -= 5;
  if (minOrders >= 5) count -= 12;
  else if (minOrders >= 2) count -= 5;
  if (maxOrders !== null && maxOrders < 2) count += 8;
  if (recency <= 30) count -= 8;
  if (typeof rules.priceTag === 'string' && rules.priceTag.trim()) count -= 4;
  return Math.max(0, count);
}

function perf(c: CampaignDto): CampaignPerformance {
  const impressions = c.impressions ?? 0;
  const clicks = c.clicks ?? 0;
  const revenue = c.attributedRevenue ?? 0;
  return {
    id: c.id,
    title: c.title,
    type: c.type,
    status: c.status,
    budget: c.budget,
    spent: c.spent,
    impressions,
    clicks,
    orders: c.attributedOrders ?? 0,
    revenue,
    ctr: impressions > 0 ? Math.round((clicks / impressions) * 10000) / 10000 : 0,
    roas: c.spent > 0 ? Math.round((revenue / c.spent) * 100) / 100 : 0,
  };
}

export const campaignHandlers = [
  /* ---- My campaigns (traffic/advertising rows hidden — phased per PROMOTIONS.md) ---- */
  h.get('/api/campaigns', ({ request }) => {
    const session = requireSession(request);
    const list = visibleCampaigns(session.merchantId);
    return ok({ campaigns: list });
  }),

  h.post('/api/campaigns', async ({ request }) => {
    const session = requireSession(request);
    requirePerm(session, 'campaigns:manage');
    const body = await readJson(request);
    const start = Number(body.start ?? Date.now());
    const end = Number(body.end ?? Date.now() + 86400000);
    const type = body.type as CampaignDto['type'];
    let groupBuyTargets: { buyers: number; discountRate: number }[] | undefined;
    if (type === 'group_buy' && body.groupBuyTargets !== undefined) {
      if (!Array.isArray(body.groupBuyTargets) || body.groupBuyTargets.length < 1) {
        throw new ApiHttpError(400, 'INVALID_GROUP_BUY', 'Group-buy targets must be a non-empty list');
      }
      groupBuyTargets = [];
      for (const raw of body.groupBuyTargets) {
        const tier = raw as { buyers?: unknown; discountRate?: unknown };
        if (!Number.isInteger(tier.buyers) || (tier.buyers as number) < 5 || typeof tier.discountRate !== 'number' || tier.discountRate < 0.05 || tier.discountRate > 0.9) {
          throw new ApiHttpError(400, 'INVALID_GROUP_BUY', 'Each group-buy tier needs at least 5 buyers and a discount rate between 5% and 90%');
        }
        groupBuyTargets.push({ buyers: tier.buyers as number, discountRate: tier.discountRate });
      }
    }
    if (type === 'instant_discount' && body.discountRate !== undefined) {
      const dr = Number(body.discountRate);
      if (!Number.isFinite(dr) || dr < 0.05 || dr > 0.95) {
        throw new ApiHttpError(400, 'INVALID_DISCOUNT', 'Instant discount rate must be between 5% and 95%');
      }
    }
    let cpc: number | undefined;
    if (type === 'ppc' && body.cpc !== undefined) {
      cpc = Number(body.cpc);
      if (!Number.isFinite(cpc) || cpc < 0.5) throw new ApiHttpError(400, 'INVALID_CPC', 'Cost-per-click must be at least 0.5');
    }
    const campaign: CampaignDto = {
      id: uid('cp'),
      merchantId: session.merchantId,
      type,
      status: start <= Date.now() && end > Date.now() ? 'active' : 'scheduled',
      title: String(body.title ?? 'Untitled campaign'),
      budget: Math.round(Number(body.budget ?? 0) * 100) / 100,
      spent: 0,
      start,
      end,
      discountRate: body.discountRate !== undefined ? Number(body.discountRate) : undefined,
      couponAmount: body.couponAmount !== undefined ? Number(body.couponAmount) : undefined,
      threshold: body.threshold !== undefined ? Number(body.threshold) : undefined,
      target: String(body.target ?? 'All customers'),
      productIds: Array.isArray(body.productIds) ? (body.productIds as string[]) : [],
      groupBuyTargets,
      haggleEnabled: type === 'haggle' ? body.haggleEnabled === undefined ? true : body.haggleEnabled === true : undefined,
      cpc,
      impressions: 0,
      clicks: 0,
      attributedOrders: 0,
      attributedRevenue: 0,
      createdAt: Date.now(),
      version: 1,
    };
    if (!campaign.budget || campaign.budget <= 0) throw new ApiHttpError(400, 'BUDGET_REQUIRED', 'A positive budget is required');
    db.table<CampaignDto>('campaigns').insert(campaign);
    emit({ type: 'campaign.updated', campaign, at: Date.now() });
    audit(session.merchantId, session.staffId, session.role, 'campaigns:create', 'campaign', campaign.id, `created "${campaign.title}"`);
    return ok({ campaign });
  }),

  h.get('/api/campaigns/:id/performance', ({ request, params }) => {
    const session = requireSession(request);
    const c = db.table<CampaignDto>('campaigns').find(String(params.id));
    if (!c || c.merchantId !== session.merchantId) throw new ApiHttpError(404, 'NOT_FOUND', 'Campaign not found');
    return ok({ performance: perf(c) });
  }),

  h.get('/api/analytics/promotions', ({ request }) => {
    const session = requireSession(request);
    const list = db.table<CampaignDto>('campaigns').where((c) => c.merchantId === session.merchantId);
    const perCampaign = list.map(perf);
    const totalSpend = Math.round(list.reduce((s, c) => s + c.spent, 0) * 100) / 100;
    const attributedRevenue = Math.round(list.reduce((s, c) => s + (c.attributedRevenue ?? 0), 0) * 100) / 100;
    return ok({
      totalSpend,
      attributedRevenue,
      roas: totalSpend > 0 ? Math.round((attributedRevenue / totalSpend) * 100) / 100 : 0,
      perCampaign,
    });
  }),

  h.post('/api/campaigns/:id/stop', async ({ request, params }) => {
    const session = requireSession(request);
    requirePerm(session, 'campaigns:manage');
    const c = db.table<CampaignDto>('campaigns').find(String(params.id));
    if (!c || c.merchantId !== session.merchantId) throw new ApiHttpError(404, 'NOT_FOUND', 'Campaign not found');
    if (c.status === 'expired') return ok({ campaign: c });
    const refund = Math.round((c.budget - c.spent) * 100) / 100;
    const updated = db.table<CampaignDto>('campaigns').update(c.id, { status: 'expired', end: Date.now(), version: c.version + 1 })!;
    if (refund > 0) {
      db.table('ledger').insert({
        id: uid('l'),
        merchantId: session.merchantId,
        type: 'adjustment',
        amount: refund,
        title: `Unused budget refund · ${c.title}`,
        ts: Date.now(),
        status: 'completed',
        refType: 'campaign',
        refId: c.id,
      });
    }
    audit(session.merchantId, session.staffId, session.role, 'campaigns:stop', 'campaign', c.id, `stopped "${c.title}" (refund ${refund.toFixed(2)})`);
    emit({ type: 'campaign.updated', campaign: updated, at: Date.now() });
    return ok({ campaign: updated, refund });
  }),

  /* ---- Platform campaigns ---- */
  h.get('/api/campaigns/platform', ({ request }) => {
    requireSession(request);
    return ok({ campaigns: db.table('platformCampaigns').all() });
  }),

  h.post('/api/campaigns/platform/:id/signup', async ({ request, params }) => {
    const session = requireSession(request);
    requirePerm(session, 'campaigns:manage');
    const p = db.table('platformCampaigns').find(String(params.id));
    if (!p) throw new ApiHttpError(404, 'PLATFORM_EVENT_NOT_FOUND', 'Platform campaign not found');
    /* Contract statuses open -> enrolling -> active -> ended (PROMOTIONS.md);
     * legacy 'signed' stays the app vocabulary — the enrolled flag is the
     * contract signal. Closed events reject with PLATFORM_EVENT_CLOSED. */
    if (p.status !== 'open' && p.status !== 'enrolling') {
      throw new ApiHttpError(409, 'PLATFORM_EVENT_CLOSED', 'Platform campaign is not open for signup');
    }
    const updated = db.table('platformCampaigns').update(p.id, { status: 'signed', enrolled: true })!;
    const note: NotificationDto = {
      id: uid('n'),
      merchantId: session.merchantId,
      type: 'system',
      category: 'campaign',
      title: 'Platform campaign joined',
      body: `Your store is listed in "${p.title}". Traffic boost starts on the launch date.`,
      ts: Date.now(),
      read: false,
    };
    db.table<NotificationDto>('notifications').insert(note);
    emit({ type: 'notification.created', notification: note, at: Date.now() });
    audit(session.merchantId, session.staffId, session.role, 'campaigns:platform-signup', 'platformCampaign', p.id, `joined "${p.title}"`);
    return ok({ campaign: updated });
  }),

  /* ---- Customer segments & precision coupons ---- */
  h.get('/api/customers/segments', ({ request }) => {
    const session = requireSession(request);
    return ok({ segments: db.table<SegmentRow>('segments').where((s) => s.merchantId === session.merchantId) });
  }),

  h.post('/api/customers/segments/:id/coupons', async ({ request, params }) => {
    const session = requireSession(request);
    requirePerm(session, 'campaigns:manage');
    const seg = db.table<SegmentRow>('segments').find(String(params.id));
    if (!seg || seg.merchantId !== session.merchantId) throw new ApiHttpError(404, 'NOT_FOUND', 'Segment not found');
    const body = await readJson(request);
    const amount = Math.round(Number(body.amount ?? 15));
    if (!Number.isInteger(amount) || amount <= 0) throw new ApiHttpError(400, 'INVALID_AMOUNT', 'amount must be a positive integer (TZS)');
    const est = Math.ceil((seg.memberCount ?? seg.count) * 0.4);
    const campaign: CampaignDto = {
      id: uid('cp'),
      merchantId: session.merchantId,
      type: 'coupon',
      status: 'scheduled',
      title: `TZS ${amount.toLocaleString('en-US')} off · ${seg.label} segment`,
      budget: est * amount,
      spent: 0,
      start: Date.now(),
      end: Date.now() + 7 * 86400000,
      couponAmount: amount,
      target: `${seg.label} customers`,
      productIds: [],
      createdAt: Date.now(),
      version: 1,
    };
    db.table<CampaignDto>('campaigns').insert(campaign);
    emit({ type: 'campaign.updated', campaign, at: Date.now() });
    audit(session.merchantId, session.staffId, session.role, 'campaigns:segment-coupon', 'segment', seg.id, `sent a TZS ${amount} coupon to ${seg.label} (~${est} customers)`);
    return ok({ sent: est, campaign });
  }),

  /* POST /coupons ≡ contract createCouponCampaign when the body is campaign-shaped
   * (title + quantity + discount), else the legacy single-coupon demo path. */
  h.post('/api/coupons', async ({ request }) => {
    const session = requireSession(request);
    const body = await readJson(request);
    const isCampaign = typeof body.title === 'string' && body.quantity !== undefined;
    if (isCampaign) {
      requirePerm(session, 'campaigns:manage');
      const title = String(body.title).trim();
      if (!title) throw new ApiHttpError(400, 'TITLE_REQUIRED', 'Coupon campaign title is required');
      if (title.length > 160) throw new ApiHttpError(400, 'INVALID_TITLE', 'Coupon campaign title must be at most 160 characters');
      const quantity = Number(body.quantity);
      if (!Number.isInteger(quantity) || quantity < 1) {
        throw new ApiHttpError(422, 'INVALID_QUANTITY', 'quantity must be a positive integer');
      }
      const kind = body.kind !== undefined ? String(body.kind) : 'fixed';
      if (!['percentage', 'fixed', 'shipping'].includes(kind)) {
        throw new ApiHttpError(422, 'INVALID_COUPON_KIND', 'kind must be percentage, fixed or shipping');
      }
      const int = (key: string): number => {
        const n = Number(body[key]);
        if (!Number.isInteger(n) || n < 0) throw new ApiHttpError(422, 'INVALID_AMOUNT', `${key} must be a non-negative integer (TZS)`);
        return n;
      };
      const discountTZS = int('discountTZS');
      const minimumSpendTZS = int('minimumSpendTZS');
      const validUntil = Number(body.validUntil ?? Date.now() + 14 * 86400000);
      if (!Number.isFinite(validUntil) || validUntil <= Date.now()) {
        throw new ApiHttpError(422, 'INVALID_DATE', 'validUntil must be in the future');
      }
      const discountRateBps = body.discountRateBps !== undefined ? int('discountRateBps') : kind === 'percentage' ? 1000 : undefined;
      const maxDiscountTZS = body.maxDiscountTZS !== undefined ? int('maxDiscountTZS') : null;
      const couponCampaign: CouponCampaign = {
        id: uid('cc'),
        merchantId: session.merchantId,
        title,
        kind: kind as CouponCampaignKind,
        discountTZS,
        discountRateBps,
        minimumSpendTZS,
        maxDiscountTZS,
        quantity,
        claimedCount: 0,
        validUntil,
        status: 'live',
      };
      db.table<CouponCampaign>('couponCampaigns').insert(couponCampaign);
      emit({ type: 'marketing.coupon_campaign_created', couponCampaign, at: Date.now() });
      audit(session.merchantId, session.staffId, session.role, 'marketing:coupon-campaign:create', 'couponCampaign', couponCampaign.id, `created "${couponCampaign.title}" (${couponCampaign.quantity} coupons)`);
      return ok({ couponCampaign });
    }
    const amount = Math.round(Number(body.amountTZS ?? 0));
    if (!amount || amount <= 0) throw new ApiHttpError(400, 'COUPON_AMOUNT_INVALID', 'amountTZS must be a positive integer');
    const coupon: CustomerCouponRow = {
      id: uid('cu'),
      merchantId: session.merchantId,
      code: typeof body.code === 'string' && body.code ? body.code : `C-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
      amountTZS: amount,
      status: 'unused',
      expiresAt: body.expiresAt ? Number(body.expiresAt) : Date.now() + 14 * 86400000,
      createdAt: Date.now(),
    };
    db.table<CustomerCouponRow>('customerCoupons').insert(coupon);
    return ok({ coupon });
  }),

  h.get('/api/coupons/me', ({ request }) => {
    requireSession(request);
    const rows = db.table<CustomerCouponRow>('customerCoupons').all();
    return ok({ coupons: rows });
  }),

  h.post('/api/coupons/:couponId/claim', async ({ request, params }) => {
    const session = requireSession(request);
    const coupon = db.table<CustomerCouponRow>('customerCoupons').find(String(params.couponId));
    if (!coupon) throw new ApiHttpError(404, 'COUPON_NOT_FOUND', 'Coupon not found');
    if (coupon.status !== 'unused') throw new ApiHttpError(409, 'COUPON_ALREADY_CLAIMED', 'Coupon already claimed');
    const updated = db.table<CustomerCouponRow>('customerCoupons').update(coupon.id, { status: 'claimed', claimedAt: Date.now() })!;
    emit({ type: 'coupons.claimed', couponId: coupon.id, at: Date.now() });
    audit(session.merchantId, session.staffId, session.role, 'campaigns:segment-coupon', 'coupon', coupon.id, 'claimed');
    return ok({ coupon: updated });
  }),

  /* ---- Drift-D aliases: contract paths (API-CONTRACT.yaml) serve the SAME
   * behavior as their legacy siblings so the app can call the contract path
   * unchanged (docs/CONTRACT-ADDITIONS.md "Resolution status"). ---- */

  /* GET /coupon-campaigns ≡ GET /campaigns */
  h.get('/api/coupon-campaigns', ({ request }) => {
    const session = requireSession(request);
    const list = visibleCampaigns(session.merchantId);
    return ok({ campaigns: list });
  }),

  /* POST /coupon-campaigns ≡ POST /campaigns */
  h.post('/api/coupon-campaigns', async ({ request }) => {
    const session = requireSession(request);
    requirePerm(session, 'campaigns:manage');
    const body = await readJson(request);
    const start = Number(body.start ?? Date.now());
    const end = Number(body.end ?? Date.now() + 86400000);
    const type = body.type as CampaignDto['type'];
    let groupBuyTargets: { buyers: number; discountRate: number }[] | undefined;
    if (type === 'group_buy' && body.groupBuyTargets !== undefined) {
      if (!Array.isArray(body.groupBuyTargets) || body.groupBuyTargets.length < 1) {
        throw new ApiHttpError(400, 'INVALID_GROUP_BUY', 'Group-buy targets must be a non-empty list');
      }
      groupBuyTargets = [];
      for (const raw of body.groupBuyTargets) {
        const tier = raw as { buyers?: unknown; discountRate?: unknown };
        if (!Number.isInteger(tier.buyers) || (tier.buyers as number) < 5 || typeof tier.discountRate !== 'number' || tier.discountRate < 0.05 || tier.discountRate > 0.9) {
          throw new ApiHttpError(400, 'INVALID_GROUP_BUY', 'Each group-buy tier needs at least 5 buyers and a discount rate between 5% and 90%');
        }
        groupBuyTargets.push({ buyers: tier.buyers as number, discountRate: tier.discountRate });
      }
    }
    if (type === 'instant_discount' && body.discountRate !== undefined) {
      const dr = Number(body.discountRate);
      if (!Number.isFinite(dr) || dr < 0.05 || dr > 0.95) {
        throw new ApiHttpError(400, 'INVALID_DISCOUNT', 'Instant discount rate must be between 5% and 95%');
      }
    }
    let cpc: number | undefined;
    if (type === 'ppc' && body.cpc !== undefined) {
      cpc = Number(body.cpc);
      if (!Number.isFinite(cpc) || cpc < 0.5) throw new ApiHttpError(400, 'INVALID_CPC', 'Cost-per-click must be at least 0.5');
    }
    const campaign: CampaignDto = {
      id: uid('cp'),
      merchantId: session.merchantId,
      type,
      status: start <= Date.now() && end > Date.now() ? 'active' : 'scheduled',
      title: String(body.title ?? 'Untitled campaign'),
      budget: Math.round(Number(body.budget ?? 0) * 100) / 100,
      spent: 0,
      start,
      end,
      discountRate: body.discountRate !== undefined ? Number(body.discountRate) : undefined,
      couponAmount: body.couponAmount !== undefined ? Number(body.couponAmount) : undefined,
      threshold: body.threshold !== undefined ? Number(body.threshold) : undefined,
      target: String(body.target ?? 'All customers'),
      productIds: Array.isArray(body.productIds) ? (body.productIds as string[]) : [],
      groupBuyTargets,
      haggleEnabled: type === 'haggle' ? body.haggleEnabled === undefined ? true : body.haggleEnabled === true : undefined,
      cpc,
      impressions: 0,
      clicks: 0,
      attributedOrders: 0,
      attributedRevenue: 0,
      createdAt: Date.now(),
      version: 1,
    };
    if (!campaign.budget || campaign.budget <= 0) throw new ApiHttpError(400, 'BUDGET_REQUIRED', 'A positive budget is required');
    db.table<CampaignDto>('campaigns').insert(campaign);
    emit({ type: 'campaign.updated', campaign, at: Date.now() });
    audit(session.merchantId, session.staffId, session.role, 'campaigns:create', 'campaign', campaign.id, `created "${campaign.title}"`);
    return ok({ campaign });
  }),

  /* GET /marketing/platform-events ≡ GET /campaigns/platform */
  h.get('/api/marketing/platform-events', ({ request }) => {
    requireSession(request);
    return ok({ campaigns: db.table('platformCampaigns').all() });
  }),

  /* POST /marketing/platform-events/{eventId}/enroll ≡ POST /campaigns/platform/:id/signup */
  h.post('/api/marketing/platform-events/:eventId/enroll', async ({ request, params }) => {
    const session = requireSession(request);
    requirePerm(session, 'campaigns:manage');
    const p = db.table('platformCampaigns').find(String(params.eventId));
    if (!p) throw new ApiHttpError(404, 'PLATFORM_EVENT_NOT_FOUND', 'Platform campaign not found');
    if (p.status !== 'open' && p.status !== 'enrolling') {
      throw new ApiHttpError(409, 'PLATFORM_EVENT_CLOSED', 'Platform campaign is not open for signup');
    }
    const updated = db.table('platformCampaigns').update(p.id, { status: 'signed', enrolled: true })!;
    const note: NotificationDto = {
      id: uid('n'),
      merchantId: session.merchantId,
      type: 'system',
      category: 'campaign',
      title: 'Platform campaign joined',
      body: `Your store is listed in "${p.title}". Traffic boost starts on the launch date.`,
      ts: Date.now(),
      read: false,
    };
    db.table<NotificationDto>('notifications').insert(note);
    emit({ type: 'notification.created', notification: note, at: Date.now() });
    audit(session.merchantId, session.staffId, session.role, 'campaigns:platform-signup', 'platformCampaign', p.id, `joined "${p.title}"`);
    return ok({ campaign: updated });
  }),

  /* GET /segments ≡ GET /customers/segments */
  h.get('/api/segments', ({ request }) => {
    const session = requireSession(request);
    return ok({ segments: db.table<SegmentRow>('segments').where((s) => s.merchantId === session.merchantId) });
  }),

  /* POST /segments — contract createSegment when the body carries name + rules;
   * the legacy coupon-send path (segmentId + amount) stays for drift parity. */
  h.post('/api/segments', async ({ request }) => {
    const session = requireSession(request);
    requirePerm(session, 'campaigns:manage');
    const body = await readJson(request);
    if (body.name !== undefined || body.rules !== undefined) {
      const name = String(body.name ?? '').trim();
      if (!name) throw new ApiHttpError(400, 'NAME_REQUIRED', 'Segment name is required');
      if (name.length > 80) throw new ApiHttpError(422, 'SEGMENT_RULES_INVALID', 'Segment name must be at most 80 characters', false, { name: 'max 80 characters' });
      const rules = validateSegmentRules(body.rules);
      const now = Date.now();
      const row: SegmentRow = {
        id: uid('seg'),
        merchantId: session.merchantId,
        segment: 'new',
        label: name,
        count: memberCountFor(rules),
        avgSpend: 0,
        lastOrderDaysAgo: 0,
        color: '#7B61FF',
        name,
        rules,
        memberCount: memberCountFor(rules),
        createdAt: now,
      };
      db.table<SegmentRow>('segments').insert(row);
      audit(session.merchantId, session.staffId, session.role, 'segments:create', 'segment', row.id, `created segment "${name}" (${row.memberCount} members)`);
      return ok({ segment: row });
    }
    const id = String(body.segmentId ?? '');
    const label = String(body.segment ?? '');
    const seg = id
      ? db.table<SegmentRow>('segments').find(id)
      : db.table<SegmentRow>('segments').where((s) => s.merchantId === session.merchantId && s.label === label)[0];
    if (!seg || seg.merchantId !== session.merchantId) throw new ApiHttpError(404, 'NOT_FOUND', 'Segment not found');
    const amount = Math.round(Number(body.amount ?? 15));
    if (!Number.isInteger(amount) || amount <= 0) throw new ApiHttpError(400, 'INVALID_AMOUNT', 'amount must be a positive integer (TZS)');
    const est = Math.ceil((seg.memberCount ?? seg.count) * 0.4);
    const campaign: CampaignDto = {
      id: uid('cp'),
      merchantId: session.merchantId,
      type: 'coupon',
      status: 'scheduled',
      title: `TZS ${amount.toLocaleString('en-US')} off · ${seg.label} segment`,
      budget: est * amount,
      spent: 0,
      start: Date.now(),
      end: Date.now() + 7 * 86400000,
      couponAmount: amount,
      target: `${seg.label} customers`,
      productIds: [],
      createdAt: Date.now(),
      version: 1,
    };
    db.table<CampaignDto>('campaigns').insert(campaign);
    emit({ type: 'campaign.updated', campaign, at: Date.now() });
    audit(session.merchantId, session.staffId, session.role, 'campaigns:segment-coupon', 'segment', seg.id, `sent a TZS ${amount} coupon to ${seg.label} (~${est} customers)`);
    return ok({ sent: est, campaign });
  }),
];
