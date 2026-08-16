import type {
  Coupon,
  CouponCampaign,
  CouponStats,
  DianjinCampaign,
  DianjinCampaignInput,
  FlashSale,
  FlashSaleInput,
  FlashSaleStatus,
  PrecisionCampaign,
  PrecisionCampaignInput,
  PrecisionOffer,
  PrecisionStatus,
  SegmentRow,
  SelfServicePromotion,
  SelfServicePackage,
} from '@/api/types';
import { db, uid } from '@/mock/db';
import { emit } from '@/mock/events';
import { ApiHttpError, audit, json, ok, requirePerm, requireSession } from '@/mock/security';
import { h, readJson } from '@/mock/handlers/common';

const FLASH_STATUSES: readonly FlashSaleStatus[] = ['draft', 'scheduled', 'live', 'ended', 'cancelled'];
const PRECISION_STATUSES: readonly PrecisionStatus[] = ['draft', 'sent', 'active', 'ended'];
const OFFER_TYPES: readonly PrecisionOffer['type'][] = ['coupon', 'discount', 'message'];
const SELF_SERVICE_PACKAGES: readonly SelfServicePackage[] = ['basic', 'premium', 'enterprise'];

/** Raw JSON body (no envelope) — contract endpoints with array bodies can't use
 *  `ok()` (it object-spreads its payload into an envelope). */
const jsonBody = (body: unknown) => Response.json(body);

/** Integer TZS guard — money is integer TZS only (no floats). */
function intField(body: Record<string, unknown>, key: string): number | null | undefined {
  if (body[key] === undefined || body[key] === null) return body[key] === null ? null : undefined;
  const n = Number(body[key]);
  if (!Number.isInteger(n) || n < 0) {
    throw new ApiHttpError(400, 'INVALID_AMOUNT', `${key} must be a non-negative integer (integer TZS, no floats)`);
  }
  return n;
}

function flashStatusOf(startsAt: number, endsAt: number, explicit?: FlashSaleStatus): FlashSaleStatus {
  if (explicit && FLASH_STATUSES.includes(explicit)) return explicit;
  const now = Date.now();
  if (now < startsAt) return 'scheduled';
  if (now <= endsAt) return 'live';
  return 'ended';
}

/* ---------------- Flash sales ---------------- */

function findFlashSale(merchantId: string, id: string): FlashSale {
  const f = db.table<FlashSale>('flashSales').find(id);
  if (!f || f.merchantId !== merchantId) throw new ApiHttpError(404, 'FLASH_SALE_NOT_FOUND', 'Flash sale not found');
  return f;
}

function validateFlashBody(body: FlashSaleInput) {
  if (!Array.isArray(body.itemIds) || body.itemIds.length === 0) {
    throw new ApiHttpError(400, 'ITEMS_REQUIRED', 'At least one item is required');
  }
  const bps = Number(body.discountBps);
  if (!Number.isInteger(bps) || bps < 1 || bps > 10000) {
    throw new ApiHttpError(400, 'INVALID_DISCOUNT', 'discountBps must be an integer between 1 and 10000');
  }
  if (body.quantityLimit !== undefined && body.quantityLimit !== null) {
    const q = Number(body.quantityLimit);
    if (!Number.isInteger(q) || q < 1) throw new ApiHttpError(400, 'INVALID_QUANTITY', 'quantityLimit must be a positive integer');
  }
  if (!Number.isFinite(Number(body.startsAt)) || !Number.isFinite(Number(body.endsAt)) || Number(body.endsAt) <= Number(body.startsAt)) {
    throw new ApiHttpError(400, 'INVALID_DATE_RANGE', 'endsAt must be after startsAt');
  }
}

/* ---------------- Precision campaigns ---------------- */

function findPrecision(merchantId: string, id: string): PrecisionCampaign {
  const c = db.table<PrecisionCampaign>('precisionCampaigns').find(id);
  if (!c || c.merchantId !== merchantId) throw new ApiHttpError(404, 'CAMPAIGN_NOT_FOUND', 'Precision campaign not found');
  return c;
}

function segmentOf(merchantId: string, segmentId: string): SegmentRow | undefined {
  return db.table<SegmentRow>('segments').where((s) => s.merchantId === merchantId && s.id === segmentId)[0];
}

/** Contract memberCount (computed server-side) with legacy count fallback. */
function segmentSize(seg: SegmentRow): number {
  return seg.memberCount ?? seg.count ?? 0;
}

function validatePrecisionBody(body: PrecisionCampaignInput) {
  const name = String(body.name ?? '').trim();
  if (!name) throw new ApiHttpError(400, 'NAME_REQUIRED', 'Campaign name is required');
  if (name.length > 80) throw new ApiHttpError(400, 'INVALID_NAME', 'Campaign name must be at most 80 characters');
  if (!body.offer || !OFFER_TYPES.includes(body.offer.type)) {
    throw new ApiHttpError(400, 'INVALID_OFFER', 'offer.type must be coupon, discount or message');
  }
}

/* ---------------- Self-service ---------------- */

/** Stored rows need an entity id (the db table is keyed by id); the contract
 *  SelfServicePromotion has none, so the merchantId doubles as the row key and
 *  is stripped from responses. */
type SelfServiceRow = SelfServicePromotion & { id: string };

function selfServiceRow(merchantId: string): SelfServiceRow | undefined {
  return db.table<SelfServiceRow>('selfServicePromotions').where((s) => s.merchantId === merchantId)[0];
}

function toSelfService(row: SelfServiceRow): SelfServicePromotion {
  const { id: _id, ...rest } = row;
  return rest;
}

/* ---------------- Coupons ---------------- */

function findCouponCampaign(merchantId: string, couponId: string): CouponCampaign {
  const c = db.table<CouponCampaign>('couponCampaigns').find(couponId);
  if (!c || c.merchantId !== merchantId) throw new ApiHttpError(404, 'COUPON_NOT_FOUND', 'Coupon campaign not found');
  return c;
}

function couponStatsOf(campaignId: string): CouponStats {
  const all = db.table<Coupon>('marketingCoupons').where((c) => c.campaignId === campaignId);
  const claimed = all.length;
  const used = all.filter((c) => c.status === 'used').length;
  const conversionRate = claimed > 0 ? Math.round((used / claimed) * 10000) / 100 : 0;
  return { couponId: campaignId, claimed, used, conversionRate };
}

export const marketingHandlers = [
  /* ---------------- Flash sales (contract /marketing/flash-sales) ---------------- */

  h.get('/api/marketing/flash-sales', ({ request }) => {
    const session = requireSession(request);
    const rows = db.table<FlashSale>('flashSales').where((f) => f.merchantId === session.merchantId);
    return jsonBody(rows.sort((a, b) => b.createdAt - a.createdAt));
  }),

  h.post('/api/marketing/flash-sales', async ({ request }) => {
    const session = requireSession(request);
    requirePerm(session, 'campaigns:manage');
    const body = (await readJson(request)) as unknown as FlashSaleInput;
    validateFlashBody(body);
    const now = Date.now();
    const flashSale: FlashSale = {
      id: uid('fs'),
      merchantId: session.merchantId,
      itemIds: body.itemIds.map(String),
      discountBps: Number(body.discountBps),
      quantityLimit: body.quantityLimit ?? null,
      soldCount: 0,
      startsAt: Number(body.startsAt),
      endsAt: Number(body.endsAt),
      status: flashStatusOf(Number(body.startsAt), Number(body.endsAt), body.status),
      createdAt: now,
    };
    db.table<FlashSale>('flashSales').insert(flashSale);
    emit({ type: 'marketing.flash_sale_created', flashSale, at: now });
    audit(session.merchantId, session.staffId, session.role, 'marketing:flash-sale:create', 'flashSale', flashSale.id, `created flash sale (${flashSale.discountBps} bps off ${flashSale.itemIds.length} items)`);
    return json(201, flashSale);
  }),

  h.patch('/api/marketing/flash-sales/:flashSaleId', async ({ request, params }) => {
    const session = requireSession(request);
    requirePerm(session, 'campaigns:manage');
    const flashSale = findFlashSale(session.merchantId, String(params.flashSaleId));
    const body = (await readJson(request)) as Partial<FlashSaleInput>;
    if (body.itemIds !== undefined) validateFlashBody(body as unknown as FlashSaleInput);
    const patch: Partial<FlashSale> = {};
    if (body.itemIds !== undefined) patch.itemIds = body.itemIds.map(String);
    if (body.discountBps !== undefined) patch.discountBps = Number(body.discountBps);
    if (body.quantityLimit !== undefined) patch.quantityLimit = body.quantityLimit;
    if (body.startsAt !== undefined) patch.startsAt = Number(body.startsAt);
    if (body.endsAt !== undefined) patch.endsAt = Number(body.endsAt);
    if (body.status !== undefined) patch.status = body.status;
    if (patch.startsAt !== undefined || patch.endsAt !== undefined) {
      const starts = patch.startsAt ?? flashSale.startsAt;
      const ends = patch.endsAt ?? flashSale.endsAt;
      if (ends <= starts) throw new ApiHttpError(400, 'INVALID_DATE_RANGE', 'endsAt must be after startsAt');
      patch.status = flashStatusOf(starts, ends, body.status);
    }
    const updated = db.table<FlashSale>('flashSales').update(flashSale.id, patch)!;
    emit({ type: 'marketing.flash_sale_updated', flashSale: updated, at: Date.now() });
    audit(session.merchantId, session.staffId, session.role, 'marketing:flash-sale:update', 'flashSale', updated.id, `updated flash sale (${updated.discountBps} bps)`);
    return ok(updated);
  }),

  /* ---------------- DianJin (PPC) campaigns (contract /marketing/dianjin) ---------------- */

  h.get('/api/marketing/dianjin', ({ request }) => {
    const session = requireSession(request);
    const rows = db.table<DianjinCampaign>('dianjinCampaigns').where((c) => c.merchantId === session.merchantId);
    return jsonBody(rows.sort((a, b) => b.createdAt - a.createdAt));
  }),

  h.post('/api/marketing/dianjin', async ({ request }) => {
    const session = requireSession(request);
    requirePerm(session, 'campaigns:manage');
    const body = (await readJson(request)) as unknown as DianjinCampaignInput;
    const name = String(body.name ?? '').trim();
    if (!name) throw new ApiHttpError(400, 'NAME_REQUIRED', 'Campaign name is required');
    if (name.length > 120) throw new ApiHttpError(400, 'INVALID_NAME', 'Campaign name must be at most 120 characters');
    const budgetTZS = intField(body as unknown as Record<string, unknown>, 'budgetTZS');
    if (budgetTZS === undefined || budgetTZS === null || budgetTZS <= 0) {
      throw new ApiHttpError(400, 'INVALID_BUDGET', 'budgetTZS must be a positive integer');
    }
    const bidBps = intField(body as unknown as Record<string, unknown>, 'bidBps');
    if (bidBps === undefined || bidBps === null || bidBps < 1 || bidBps > 10000) {
      throw new ApiHttpError(400, 'INVALID_BID', 'bidBps must be an integer between 1 and 10000');
    }
    const campaign: DianjinCampaign = {
      id: uid('dj'),
      merchantId: session.merchantId,
      name,
      budgetTZS,
      bidBps,
      active: body.active === true,
      spendTZS: 0,
      clicks: 0,
      createdAt: Date.now(),
    };
    db.table<DianjinCampaign>('dianjinCampaigns').insert(campaign);
    emit({ type: 'marketing.dianjin_created', campaign, at: Date.now() });
    audit(session.merchantId, session.staffId, session.role, 'marketing:dianjin:create', 'dianjinCampaign', campaign.id, `created "${campaign.name}" (budget ${campaign.budgetTZS} TZS)`);
    return json(201, campaign);
  }),

  h.patch('/api/marketing/dianjin/:campaignId/toggle', async ({ request, params }) => {
    const session = requireSession(request);
    requirePerm(session, 'campaigns:manage');
    const campaign = db.table<DianjinCampaign>('dianjinCampaigns').find(String(params.campaignId));
    if (!campaign || campaign.merchantId !== session.merchantId) {
      throw new ApiHttpError(404, 'CAMPAIGN_NOT_FOUND', 'DianJin campaign not found');
    }
    const body = await readJson(request);
    if (typeof body.active !== 'boolean') {
      throw new ApiHttpError(400, 'ACTIVE_REQUIRED', 'Body must include active: true | false');
    }
    /* Re-activating after a budget stop clears the stop reason — delivery
     * resumes once the merchant raised the budget (DIANJIN_BUDGET_EXCEEDED). */
    const updated = db.table<DianjinCampaign>('dianjinCampaigns').update(campaign.id, {
      active: body.active,
      stoppedReason: body.active ? null : campaign.stoppedReason,
    })!;
    emit({ type: 'marketing.dianjin_toggled', campaign: updated, at: Date.now() });
    audit(session.merchantId, session.staffId, session.role, 'marketing:dianjin:toggle', 'dianjinCampaign', updated.id, `${body.active ? 'activated' : 'paused'} "${updated.name}"`);
    return ok(updated);
  }),

  /* ---------------- Precision campaigns (contract /marketing/precision) ---------------- */

  h.get('/api/marketing/precision', ({ request }) => {
    const session = requireSession(request);
    const rows = db.table<PrecisionCampaign>('precisionCampaigns').where((c) => c.merchantId === session.merchantId);
    return jsonBody(rows.sort((a, b) => b.createdAt - a.createdAt));
  }),

  h.post('/api/marketing/precision', async ({ request }) => {
    const session = requireSession(request);
    requirePerm(session, 'campaigns:manage');
    const body = (await readJson(request)) as unknown as PrecisionCampaignInput;
    validatePrecisionBody(body);
    const name = String(body.name).trim();
    const segment = segmentOf(session.merchantId, String(body.segmentId ?? ''));
    if (!segment) throw new ApiHttpError(400, 'INVALID_SEGMENT', 'Segment not found for this merchant');
    const campaign: PrecisionCampaign = {
      id: uid('pc'),
      merchantId: session.merchantId,
      name,
      segmentId: segment.id,
      segmentLabel: segment.label,
      offer: { type: body.offer!.type, value: body.offer!.value },
      status: body.status && PRECISION_STATUSES.includes(body.status) ? body.status : 'draft',
      sentCount: 0,
      createdAt: Date.now(),
    };
    db.table<PrecisionCampaign>('precisionCampaigns').insert(campaign);
    emit({ type: 'marketing.precision_created', campaign, at: Date.now() });
    audit(session.merchantId, session.staffId, session.role, 'marketing:precision:create', 'precisionCampaign', campaign.id, `created "${campaign.name}" for segment ${segment.label}`);
    return json(201, campaign);
  }),

  h.post('/api/marketing/precision/:campaignId/send', async ({ request, params }) => {
    const session = requireSession(request);
    requirePerm(session, 'campaigns:manage');
    const campaign = findPrecision(session.merchantId, String(params.campaignId));
    if (campaign.status !== 'draft') {
      throw new ApiHttpError(409, 'ALREADY_SENT', `Campaign already ${campaign.status}`);
    }
    const segment = segmentOf(session.merchantId, campaign.segmentId);
    const size = segment ? segmentSize(segment) : 0;
    if (!segment || size === 0) {
      throw new ApiHttpError(409, 'PRECISION_SEGMENT_EMPTY', 'The target segment is empty — add members or choose another segment');
    }
    const updated = db.table<PrecisionCampaign>('precisionCampaigns').update(campaign.id, { status: 'sent', sentCount: size })!;
    emit({ type: 'marketing.precision_sent', campaign: updated, at: Date.now() });
    audit(session.merchantId, session.staffId, session.role, 'marketing:precision:send', 'precisionCampaign', updated.id, `sent "${updated.name}" to ${size} customers`);
    return ok(updated);
  }),

  /* ---------------- Self-service promotion (contract /marketing/self-service) ---------------- */

  h.get('/api/marketing/self-service', ({ request }) => {
    const session = requireSession(request);
    const row = selfServiceRow(session.merchantId);
    if (!row) throw new ApiHttpError(404, 'NOT_FOUND', 'Self-service promotion not configured');
    return ok(toSelfService(row));
  }),

  h.post('/api/marketing/self-service', async ({ request }) => {
    const session = requireSession(request);
    requirePerm(session, 'campaigns:manage');
    const body = await readJson(request);
    if (typeof body.active !== 'boolean') {
      throw new ApiHttpError(400, 'ACTIVE_REQUIRED', 'Body must include active: true | false');
    }
    const existing = selfServiceRow(session.merchantId);
    const pkg = body.package !== undefined && SELF_SERVICE_PACKAGES.includes(String(body.package) as SelfServicePackage)
      ? (String(body.package) as SelfServicePackage)
      : (existing?.package ?? 'basic');
    const now = Date.now();
    const row: SelfServiceRow = {
      id: session.merchantId,
      merchantId: session.merchantId,
      active: body.active,
      designUrl: body.designUrl !== undefined ? String(body.designUrl) : (existing?.designUrl ?? null),
      homepageExposure: body.homepageExposure !== undefined ? body.homepageExposure === true : (existing?.homepageExposure ?? false),
      package: pkg,
      packagePriceTZS: existing?.packagePriceTZS ?? null,
      startedAt: body.active ? (existing?.startedAt ?? now) : existing?.startedAt ?? null,
    };
    const table = db.table<SelfServiceRow>('selfServicePromotions');
    if (existing) table.update(existing.id, row);
    else table.insert(row);
    emit({ type: 'marketing.self_service_updated', promotion: toSelfService(row), at: now });
    audit(session.merchantId, session.staffId, session.role, 'marketing:self-service', 'selfServicePromotion', session.merchantId, `${body.active ? 'enabled' : 'disabled'} self-service promotion (${pkg})`);
    return ok(toSelfService(row));
  }),

  /* ---------------- Coupons (contract /marketing/coupons/verify + /marketing/coupons/{couponId}/stats) ---------------- */

  /* Merchant coupon-campaign list (app extension — the yaml GET /coupon-campaigns
   * is the customer claimable list; the merchant list has no contract path). */
  h.get('/api/marketing/coupons', ({ request }) => {
    const session = requireSession(request);
    const rows = db
      .table<CouponCampaign>('couponCampaigns')
      .where((c) => c.merchantId === session.merchantId)
      .sort((a, b) => b.validUntil - a.validUntil);
    return ok({ coupons: rows });
  }),

  h.post('/api/marketing/coupons/verify', async ({ request }) => {
    const session = requireSession(request);
    requirePerm(session, 'redemption');
    const body = await readJson(request);
    const code = String(body.code ?? '').trim().toUpperCase();
    if (!code) throw new ApiHttpError(400, 'CODE_REQUIRED', 'Enter a coupon code to verify');
    const coupon = db.table<Coupon>('marketingCoupons').where((c) => c.code === code)[0];
    if (!coupon) {
      throw new ApiHttpError(409, 'INVALID_CODE', 'Coupon code not found');
    }
    const campaign = db.table<CouponCampaign>('couponCampaigns').find(coupon.campaignId);
    if (!campaign || campaign.merchantId !== session.merchantId) {
      throw new ApiHttpError(409, 'INVALID_CODE', 'Coupon code not found');
    }
    if (coupon.status === 'used') throw new ApiHttpError(409, 'ALREADY_USED', 'This coupon was already used');
    if (coupon.status === 'expired') throw new ApiHttpError(409, 'EXPIRED', 'This coupon has expired');
    if (coupon.status === 'void') throw new ApiHttpError(409, 'VOIDED', 'This coupon has been voided');
    if (coupon.expiresAt < Date.now()) throw new ApiHttpError(409, 'EXPIRED', 'This coupon has expired');
    emit({ type: 'marketing.coupon_verified', coupon, at: Date.now() });
    audit(session.merchantId, session.staffId, session.role, 'marketing:coupon:verify', 'coupon', coupon.id, `verified ${code}`);
    return ok(coupon);
  }),

  h.get('/api/marketing/coupons/:couponId/stats', ({ request, params }) => {
    const session = requireSession(request);
    const campaign = findCouponCampaign(session.merchantId, String(params.couponId));
    return ok(couponStatsOf(campaign.id));
  }),
];
