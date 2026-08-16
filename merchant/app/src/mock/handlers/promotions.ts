import type {
  BrandDisplayCampaign,
  BrandDisplayCampaignInput,
  NotificationDto,
  Promotion,
  PromotionInput,
  PromotionPerformance,
  PromotionStatus,
  PromotionType,
} from '@/api/types';
import { db, uid } from '@/mock/db';
import { emit } from '@/mock/events';
import { ApiHttpError, audit, json, ok, requirePerm, requireSession } from '@/mock/security';
import { h, readJson } from '@/mock/handlers/common';

const PROMOTION_TYPES: readonly PromotionType[] = [
  'discount',
  'spend_based',
  'full_reduction',
  'new_customer',
  'free_delivery',
  'instant_discount',
  'bargain',
  'haggle',
  'coupon',
  'flash',
  'featured',
  'traffic',
  'ppc',
  'brand',
  'group_buy',
];

/** Raw JSON body (no envelope) — contract endpoints with array/primitive bodies
 *  can't use `ok()` (it object-spreads its payload into an envelope). */
const jsonBody = (body: unknown) => Response.json(body);

const PROMOTION_STATUSES: readonly PromotionStatus[] = ['draft', 'pending_review', 'live', 'paused', 'rejected', 'ended'];

function promotionRows(merchantId: string): Promotion[] {
  return db.table<Promotion>('promotions').where((p) => p.merchantId === merchantId);
}

function findPromotion(merchantId: string, id: string): Promotion {
  const p = db.table<Promotion>('promotions').find(id);
  if (!p || p.merchantId !== merchantId) throw new ApiHttpError(404, 'PROMOTION_NOT_FOUND', 'Promotion not found');
  return p;
}

/** Integer TZS guard — money is integer TZS only (no floats). */
function intField(body: Record<string, unknown>, key: string): number | null | undefined {
  if (body[key] === undefined || body[key] === null) return body[key] === null ? null : undefined;
  const n = Number(body[key]);
  if (!Number.isInteger(n) || n < 0) {
    throw new ApiHttpError(400, 'INVALID_AMOUNT', `${key} must be a non-negative integer (integer TZS, no floats)`);
  }
  return n;
}

function validatePromotionBody(body: PromotionInput, partial: boolean) {
  if (body.type !== undefined) {
    if (!PROMOTION_TYPES.includes(body.type)) throw new ApiHttpError(400, 'INVALID_PROMOTION_TYPE', 'Unknown promotion type');
  } else if (!partial) {
    throw new ApiHttpError(400, 'TYPE_REQUIRED', 'Promotion type is required');
  }
  if (body.title !== undefined) {
    const title = String(body.title).trim();
    if (!title) throw new ApiHttpError(400, 'TITLE_REQUIRED', 'Promotion title is required');
    if (title.length > 160) throw new ApiHttpError(400, 'INVALID_TITLE', 'Promotion title must be at most 160 characters');
  } else if (!partial) {
    throw new ApiHttpError(400, 'TITLE_REQUIRED', 'Promotion title is required');
  }
  if (body.description !== undefined && String(body.description).length > 2000) {
    throw new ApiHttpError(400, 'INVALID_DESCRIPTION', 'Description must be at most 2000 characters');
  }
  if (body.status !== undefined && !PROMOTION_STATUSES.includes(body.status)) {
    throw new ApiHttpError(400, 'INVALID_STATUS', 'Unknown promotion status');
  }
  for (const key of ['couponAmountTZS', 'thresholdTZS', 'discountRateBps', 'cpcTZS', 'budgetTZS'] as const) {
    const v = intField(body as unknown as Record<string, unknown>, key);
    if (v !== undefined) (body as unknown as Record<string, unknown>)[key] = v;
  }
}

function perf(p: Promotion): PromotionPerformance {
  const spend = p.spendTZS;
  const revenue = p.attributedRevenueTZS;
  const roiPercent = spend > 0 ? Math.round(((revenue - spend) / spend) * 10000) / 100 : 0;
  return {
    promotionId: p.id,
    impressions: p.impressions,
    clicks: p.clicks,
    redeemCount: p.redeemCount,
    spendTZS: spend,
    attributedRevenueTZS: revenue,
    roiPercent,
  };
}

/** Promotion conflict rule (PROMOTIONS.md): only one live promotion may target
 *  the same discount dimension (same type, or overlapping item scope) within
 *  an overlapping window — no silent stacking. */
function conflictingActive(
  merchantId: string,
  selfId: string | null,
  type: PromotionType,
  productIds: string[],
  startsAt: number,
  endsAt: number,
): Promotion | undefined {
  return db
    .table<Promotion>('promotions')
    .where(
      (p) =>
        p.merchantId === merchantId &&
        p.id !== selfId &&
        p.status === 'live' &&
        (p.startsAt ?? 0) <= endsAt &&
        (p.endsAt ?? Number.MAX_SAFE_INTEGER) >= startsAt &&
        (p.type === type || (productIds.length > 0 && (p.productIds ?? []).some((id) => productIds.includes(id)))),
    )[0];
}

function throwConflict(conflict: Promotion): never {
  throw new ApiHttpError(409, 'PROMOTION_CONFLICT_ACTIVE', 'An overlapping promotion is already active on this discount dimension — edit it or keep it (no silent stacking)', false, {
    conflicting: {
      id: conflict.id,
      title: conflict.title,
      status: conflict.status,
      startsAt: conflict.startsAt ?? null,
      endsAt: conflict.endsAt ?? null,
    },
  });
}

function assertNoConflict(promotion: Promotion): void {
  const conflict = conflictingActive(promotion.merchantId, promotion.id, promotion.type, promotion.productIds ?? [], promotion.startsAt ?? 0, promotion.endsAt ?? Number.MAX_SAFE_INTEGER);
  if (conflict) throwConflict(conflict);
}

/** Simulated admin moderation (contract /admin/promotions/{promotionId}/decision).
 *  Mirrors group-buy's adminDecision() — the merchant app has no admin routes;
 *  the private admin web drives this in production. */
export function adminPromotionDecision(promotionId: string, decision: 'approved' | 'rejected' | 'paused', reason?: string): Promotion {
  const p = db.table<Promotion>('promotions').find(promotionId);
  if (!p) throw new ApiHttpError(404, 'PROMOTION_NOT_FOUND', 'Promotion not found');
  let updated: Promotion;
  if (decision === 'approved') {
    updated = db.table<Promotion>('promotions').update(p.id, { status: 'live', rejectReason: null })!;
  } else if (decision === 'rejected') {
    updated = db.table<Promotion>('promotions').update(p.id, { status: 'rejected', rejectReason: reason ?? 'Not approved' })!;
  } else {
    updated = db.table<Promotion>('promotions').update(p.id, { status: 'paused' })!;
  }
  emit({ type: 'promotion.moderated', promotion: updated, decision, at: Date.now() });
  const note: NotificationDto = {
    id: uid('n'),
    merchantId: updated.merchantId,
    type: 'system',
    category: 'campaign',
    title: 'Promotion moderated',
    body:
      decision === 'approved'
        ? `"${updated.title}" was approved and is now live.`
        : decision === 'rejected'
          ? `"${updated.title}" was rejected: ${reason ?? 'Not approved'}`
          : `"${updated.title}" was paused by the platform.`,
    ts: Date.now(),
    read: false,
  };
  db.table<NotificationDto>('notifications').insert(note);
  emit({ type: 'notification.created', notification: note, at: Date.now() });
  return updated;
}

export const promotionHandlers = [
  /* ---- Promotion list (contract GET /promotions; ?merchantId= required in contract,
   * defaults to the session merchant for the app, ?status= / ?type= filter) ---- */
  h.get('/api/promotions', ({ request }) => {
    const session = requireSession(request);
    const url = new URL(request.url);
    const merchantId = url.searchParams.get('merchantId') ?? session.merchantId;
    const status = url.searchParams.get('status');
    const type = url.searchParams.get('type');
    let rows = promotionRows(merchantId);
    if (status) rows = rows.filter((p) => p.status === status);
    if (type) rows = rows.filter((p) => p.type === type);
    return jsonBody(rows.sort((a, b) => b.createdAt - a.createdAt));
  }),

  /* ---- Create a promotion (contract POST /promotions) — lands in draft/pending_review ---- */
  h.post('/api/promotions', async ({ request }) => {
    const session = requireSession(request);
    requirePerm(session, 'campaigns:manage');
    const body = (await readJson(request)) as unknown as PromotionInput;
    validatePromotionBody(body, false);
    const now = Date.now();
    const promotion: Promotion = {
      id: uid('promo'),
      merchantId: session.merchantId,
      type: body.type!,
      title: String(body.title).trim(),
      description: body.description,
      status: body.status === 'pending_review' ? 'pending_review' : 'draft',
      couponAmountTZS: body.couponAmountTZS ?? null,
      thresholdTZS: body.thresholdTZS ?? null,
      discountRateBps: body.discountRateBps ?? null,
      target: body.target ?? 'all',
      productIds: body.productIds ?? [],
      haggleEnabled: body.haggleEnabled ?? false,
      cpcTZS: body.cpcTZS ?? null,
      budgetTZS: body.budgetTZS ?? null,
      startsAt: body.startsAt ?? now,
      endsAt: body.endsAt ?? now + 7 * 86400000,
      redeemCount: 0,
      spendTZS: 0,
      impressions: 0,
      clicks: 0,
      attributedOrders: 0,
      attributedRevenueTZS: 0,
      createdAt: now,
    };
    const conflict = conflictingActive(session.merchantId, null, promotion.type, promotion.productIds ?? [], promotion.startsAt ?? 0, promotion.endsAt ?? Number.MAX_SAFE_INTEGER);
    if (conflict) throwConflict(conflict);
    db.table<Promotion>('promotions').insert(promotion);
    emit({ type: 'promotion.created', promotion, at: now });
    audit(session.merchantId, session.staffId, session.role, 'promotions:create', 'promotion', promotion.id, `created "${promotion.title}" (${promotion.type})`);
    return json(201, promotion);
  }),

  /* ---- Update own promotion (contract PATCH /promotions/{promotionId}) ---- */
  h.patch('/api/promotions/:promotionId', async ({ request, params }) => {
    const session = requireSession(request);
    requirePerm(session, 'campaigns:manage');
    const promotion = findPromotion(session.merchantId, String(params.promotionId));
    const body = (await readJson(request)) as unknown as PromotionInput;
    validatePromotionBody(body, true);
    const patch: Partial<Promotion> = {};
    if (body.title !== undefined) patch.title = String(body.title).trim();
    if (body.description !== undefined) patch.description = body.description;
    if (body.status !== undefined) patch.status = body.status;
    if (body.type !== undefined) patch.type = body.type;
    if (body.couponAmountTZS !== undefined) patch.couponAmountTZS = body.couponAmountTZS;
    if (body.thresholdTZS !== undefined) patch.thresholdTZS = body.thresholdTZS;
    if (body.discountRateBps !== undefined) patch.discountRateBps = body.discountRateBps;
    if (body.target !== undefined) patch.target = body.target;
    if (body.productIds !== undefined) patch.productIds = body.productIds;
    if (body.haggleEnabled !== undefined) patch.haggleEnabled = body.haggleEnabled;
    if (body.cpcTZS !== undefined) patch.cpcTZS = body.cpcTZS;
    if (body.budgetTZS !== undefined) patch.budgetTZS = body.budgetTZS;
    if (body.startsAt !== undefined) patch.startsAt = body.startsAt;
    if (body.endsAt !== undefined) patch.endsAt = body.endsAt;
    const updated = db.table<Promotion>('promotions').update(promotion.id, patch)!;
    if (updated.status === 'live') assertNoConflict(updated);
    emit({ type: 'promotion.updated', promotion: updated, at: Date.now() });
    audit(session.merchantId, session.staffId, session.role, 'promotions:update', 'promotion', updated.id, `updated "${updated.title}"`);
    return ok(updated);
  }),

  /* ---- Pause / resume (contract POST /promotions/{promotionId}/pause) ---- */
  h.post('/api/promotions/:promotionId/pause', async ({ request, params }) => {
    const session = requireSession(request);
    requirePerm(session, 'campaigns:manage');
    const promotion = findPromotion(session.merchantId, String(params.promotionId));
    const body = await readJson(request);
    if (typeof body.paused !== 'boolean') {
      throw new ApiHttpError(400, 'PAUSED_REQUIRED', 'Body must include paused: true | false');
    }
    /* Contract code (PROMOTIONS.md): wrong-state pause/resume is
     * PROMOTION_STATUS_CONFLICT, not a generic status error. */
    if (body.paused && promotion.status !== 'live') {
      throw new ApiHttpError(409, 'PROMOTION_STATUS_CONFLICT', `Cannot pause a ${promotion.status} promotion`);
    }
    if (!body.paused && promotion.status !== 'paused') {
      throw new ApiHttpError(409, 'PROMOTION_STATUS_CONFLICT', `Cannot resume a ${promotion.status} promotion`);
    }
    if (!body.paused) assertNoConflict(promotion);
    const updated = db.table<Promotion>('promotions').update(promotion.id, { status: body.paused ? 'paused' : 'live' })!;
    emit({ type: 'promotion.paused', promotion: updated, at: Date.now() });
    audit(session.merchantId, session.staffId, session.role, 'promotions:pause', 'promotion', updated.id, `${body.paused ? 'paused' : 'resumed'} "${updated.title}"`);
    return ok(updated);
  }),

  /* ---- Admin moderation (contract POST /admin/promotions/{promotionId}/decision) ---- */
  h.post('/api/admin/promotions/:promotionId/decision', async ({ request, params }) => {
    const session = requireSession(request);
    requirePerm(session, 'campaigns:manage');
    const body = await readJson(request);
    const decision = String(body.decision ?? '');
    if (decision !== 'approved' && decision !== 'rejected' && decision !== 'paused') {
      throw new ApiHttpError(400, 'INVALID_DECISION', 'decision must be approved, rejected or paused');
    }
    const updated = adminPromotionDecision(String(params.promotionId), decision, body.reason !== undefined ? String(body.reason) : undefined);
    audit(session.merchantId, session.staffId, session.role, 'promotions:moderate', 'promotion', updated.id, `${decision} "${updated.title}"`);
    return ok(updated);
  }),

  /* ---- Performance (contract GET /promotions/{promotionId}/performance) ---- */
  h.get('/api/promotions/:promotionId/performance', ({ request, params }) => {
    const session = requireSession(request);
    const promotion = findPromotion(session.merchantId, String(params.promotionId));
    return ok(perf(promotion));
  }),

  /* ---- Brand display (contract GET /marketing/brand-display) ---- */
  h.get('/api/marketing/brand-display', ({ request }) => {
    const session = requireSession(request);
    const campaign = db.table<BrandDisplayCampaign>('brandDisplays').where((b) => b.merchantId === session.merchantId)[0];
    if (!campaign) throw new ApiHttpError(404, 'NOT_FOUND', 'No brand display campaign configured yet');
    return ok(campaign);
  }),

  /* ---- Brand display upsert (contract POST /marketing/brand-display) ---- */
  h.post('/api/marketing/brand-display', async ({ request }) => {
    const session = requireSession(request);
    requirePerm(session, 'campaigns:manage');
    const body = (await readJson(request)) as unknown as BrandDisplayCampaignInput;
    const name = String(body.name ?? '').trim();
    if (!name) throw new ApiHttpError(400, 'NAME_REQUIRED', 'Campaign name is required');
    if (name.length > 120) throw new ApiHttpError(400, 'INVALID_NAME', 'Campaign name must be at most 120 characters');
    const budgetTZS = intField(body as unknown as Record<string, unknown>, 'budgetTZS');
    if (budgetTZS === undefined || budgetTZS === null || budgetTZS <= 0) {
      throw new ApiHttpError(400, 'INVALID_BUDGET', 'budgetTZS must be a positive integer');
    }
    const startsAt = Number(body.startsAt ?? Date.now());
    const endsAt = Number(body.endsAt ?? startsAt + 7 * 86400000);
    if (!Number.isFinite(startsAt) || !Number.isFinite(endsAt) || endsAt <= startsAt) {
      throw new ApiHttpError(400, 'INVALID_DATE_RANGE', 'endsAt must be after startsAt');
    }
    const table = db.table<BrandDisplayCampaign>('brandDisplays');
    const existing = table.where((b) => b.merchantId === session.merchantId)[0];
    const now = Date.now();
    const campaign: BrandDisplayCampaign = existing
      ? table.update(existing.id, {
          name,
          budgetTZS,
          startsAt,
          endsAt,
          active: body.active ?? existing.active,
        })!
      : {
          id: uid('bd'),
          merchantId: session.merchantId,
          name,
          budgetTZS,
          startsAt,
          endsAt,
          active: body.active ?? false,
          impressions: 0,
          createdAt: now,
        };
    if (!existing) table.insert(campaign);
    emit({ type: 'marketing.brand_display_updated', campaign, at: now });
    audit(session.merchantId, session.staffId, session.role, 'marketing:brand-display', 'brandDisplay', campaign.id, `${existing ? 'updated' : 'created'} "${campaign.name}"`);
    return ok(campaign);
  }),
];
