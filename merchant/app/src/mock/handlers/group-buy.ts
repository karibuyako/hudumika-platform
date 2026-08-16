/* Group-buy deals + vouchers (P6c) — contract paths:
 *   GET/POST /group-buys, GET/PATCH /group-buys/{dealId},
 *   POST /group-buys/{dealId}/extend|delist|relist,
 *   GET /group-buys/{dealId}/vouchers,
 *   GET /vouchers/me, POST /vouchers/{voucherCode}/verify, GET /vouchers/verify-history.
 * Shapes follow API-CONTRACT.yaml (GroupBuyDeal, Voucher, verify-history rows).
 * Deal lifecycle: draft -> pending_review -> live (admin approval) -> delisted/ended.
 * Moderation is simulated via exported adminDecision() — the merchant app has no
 * admin routes (the yaml keeps them under /admin/* for the private admin web).
 */
import type {
  GroupBuyDeal,
  GroupBuyDealInput,
  GroupBuyVoucher,
  NotificationDto,
  VerifyHistoryEntry,
} from '@/api/types';
import { db, uid } from '@/mock/db';
import { emit } from '@/mock/events';
import { audit, requirePerm, requireSession } from '@/mock/security';
import { ApiHttpError, h, idemGet, idemSet, idemKey, ok, readJson } from '@/mock/handlers/common';

const TZ_DAY = 86400000;

// The db store keys rows by id; voucher rows carry id === code.
type VoucherRow = GroupBuyVoucher & { id: string };

export function merchantDeals(merchantId: string): GroupBuyDeal[] {
  return db.table<GroupBuyDeal>('groupBuys').where((d) => d.merchantId === merchantId);
}

/** Look up a voucher by code across ALL merchants — the verify handler then
 *  enforces that the voucher's deal belongs to the redeeming merchant. */
function findVoucherByCode(code: string): VoucherRow | undefined {
  return db.table<VoucherRow>('vouchers').where((v) => v.code === code)[0];
}

/** Canonical voucher code shape (GB-XXXX-XXXX); codes outside it are rejected
 *  with VOUCHER_INVALID_CODE without touching the database. */
const VOUCHER_CODE_RE = /^[A-Z0-9]{2,6}-[A-Z0-9]{4,6}-[A-Z0-9]{4,6}$/;

function historyRow(voucherCode: string, verifiedBy: string, result: VerifyHistoryEntry['result']): VerifyHistoryEntry {
  const row: VerifyHistoryEntry & { id: string } = {
    id: uid('vh'),
    voucherCode,
    verifiedAt: Date.now(),
    verifiedBy,
    result,
  };
  db.table<VerifyHistoryEntry & { id: string }>('verifyHistory').insert(row);
  return row;
}

function ensureDeal(session: ReturnType<typeof requireSession>, dealId: string): GroupBuyDeal {
  const deal = db.table<GroupBuyDeal>('groupBuys').find(dealId);
  if (!deal || deal.merchantId !== session.merchantId) {
    throw new ApiHttpError(404, 'GROUP_BUY_NOT_FOUND', 'Group-buy deal not found');
  }
  return deal;
}

/** Auto-close live deals whose sales window has passed (lazy, idempotent). */
function maybeEnd(deal: GroupBuyDeal): GroupBuyDeal {
  if ((deal.status === 'live' || deal.status === 'extended') && deal.salesEndAt <= Date.now()) {
    const updated = db.table<GroupBuyDeal>('groupBuys').update(deal.id, { status: 'ended' })!;
    emit({ type: 'group_buy.deal_ended', deal: updated, at: Date.now() });
    return updated;
  }
  return deal;
}

/** GROUP-BUY.md §Rules: the merchant is notified by `group_buy.moderated`
 *  and sees `rejectReason` on the deal. Mirrors promotions' moderation note. */
function notifyModerated(deal: GroupBuyDeal, decision: 'approved' | 'rejected' | 'delisted', reason?: string) {
  const note: NotificationDto = {
    id: uid('n'),
    merchantId: deal.merchantId,
    type: 'system',
    category: 'campaign',
    title: 'Group-buy deal moderated',
    body:
      decision === 'approved'
        ? `"${deal.title}" was approved and is now live.`
        : decision === 'rejected'
          ? `"${deal.title}" was rejected: ${reason ?? 'Not approved'}`
          : `"${deal.title}" was delisted by the platform.`,
    ts: Date.now(),
    read: false,
    deepLink: `/marketing/deal/${deal.id}`,
  };
  db.table<NotificationDto>('notifications').insert(note);
  emit({ type: 'notification.created', notification: note, at: Date.now() });
}

/** Simulated admin moderation queue (private admin web in production). */
export function adminDecision(dealId: string, decision: 'approved' | 'rejected' | 'delisted', reason?: string): GroupBuyDeal {
  const deal = db.table<GroupBuyDeal>('groupBuys').find(dealId);
  if (!deal) throw new ApiHttpError(404, 'GROUP_BUY_NOT_FOUND', 'Group-buy deal not found');
  let updated: GroupBuyDeal;
  if (decision === 'approved') {
    if (deal.status === 'live' || deal.status === 'extended') return deal;
    updated = db.table<GroupBuyDeal>('groupBuys').update(deal.id, {
      status: 'live',
      rejectReason: undefined,
    })!;
    emit({ type: 'group_buy.deal_live', deal: updated, at: Date.now() });
  } else if (decision === 'rejected') {
    updated = db.table<GroupBuyDeal>('groupBuys').update(deal.id, { status: 'rejected', rejectReason: reason ?? 'Not approved' })!;
  } else {
    updated = db.table<GroupBuyDeal>('groupBuys').update(deal.id, { status: 'delisted' })!;
    emit({ type: 'group_buy.deal_delisted', deal: updated, at: Date.now() });
  }
  emit({ type: 'group_buy.moderated', deal: updated, decision, at: Date.now() });
  notifyModerated(updated, decision, reason);
  return updated;
}

function assertPriceRange(body: { priceTZS?: unknown; originalPriceTZS?: unknown }) {
  const price = Number(body.priceTZS);
  const original = Number(body.originalPriceTZS);
  if (!Number.isInteger(price) || price <= 0 || !Number.isInteger(original) || original <= 0 || price >= original) {
    throw new ApiHttpError(400, 'GROUP_BUY_PRICE_RANGE_INVALID', 'Deal price must be a positive integer below the original price (TZS)');
  }
}

function parseInput(body: Record<string, unknown>): GroupBuyDealInput {
  const title = String(body.title ?? '').trim();
  if (!title) throw new ApiHttpError(400, 'GROUP_BUY_TITLE_REQUIRED', 'A deal title is required');
  if (title.length > 160) throw new ApiHttpError(400, 'GROUP_BUY_TITLE_REQUIRED', 'Deal title is too long (max 160 characters)');
  assertPriceRange(body);
  const quantity = Number(body.quantity);
  const validityDays = Number(body.validityDays ?? 90);
  const start = Number(body.salesStartAt ?? Date.now());
  const end = Number(body.salesEndAt ?? start + 7 * TZ_DAY);
  if (!Number.isInteger(quantity) || quantity < 1) {
    throw new ApiHttpError(400, 'GROUP_BUY_PRICE_RANGE_INVALID', 'Quantity must be a positive integer');
  }
  if (!Number.isFinite(validityDays) || validityDays < 1) {
    throw new ApiHttpError(400, 'GROUP_BUY_PRICE_RANGE_INVALID', 'Voucher validity must be at least 1 day');
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    throw new ApiHttpError(400, 'GROUP_BUY_PRICE_RANGE_INVALID', 'Sales window must end after it starts');
  }
  let imageUrl: string | null | undefined;
  if (body.imageUrl === null) {
    imageUrl = null;
  } else if (body.imageUrl !== undefined) {
    const url = String(body.imageUrl).trim();
    if (!/^https?:\/\/\S+$/.test(url)) {
      throw new ApiHttpError(400, 'GROUP_BUY_IMAGE_URL_INVALID', 'imageUrl must be a valid http(s) URL');
    }
    imageUrl = url;
  }
  return {
    title,
    description: body.description !== undefined ? String(body.description).slice(0, 2000) : undefined,
    imageUrl,
    priceTZS: Math.round(Number(body.priceTZS)),
    originalPriceTZS: Math.round(Number(body.originalPriceTZS)),
    quantity,
    validityDays,
    salesStartAt: start,
    salesEndAt: end,
  };
}

export const groupBuyHandlers = [
  /* ---- Deals ---- */
  h.get('/api/group-buys', ({ request }) => {
    const session = requireSession(request);
    requirePerm(session, 'campaigns:manage');
    const url = new URL(request.url);
    const status = url.searchParams.get('status');
    let rows = merchantDeals(session.merchantId).map(maybeEnd);
    if (status) rows = rows.filter((d) => d.status === status);
    return ok({ deals: [...rows].sort((a, b) => b.salesEndAt - a.salesEndAt) });
  }),

  h.post('/api/group-buys', async ({ request }) => {
    const session = requireSession(request);
    requirePerm(session, 'campaigns:manage');
    const key = idemKey(request);
    const cached = idemGet('group-buy:create', key);
    if (cached) return ok(cached, { status: 201 });
    const body = await readJson(request);
    if (body.status === 'live' || body.status === 'extended') {
      throw new ApiHttpError(409, 'GROUP_BUY_ALREADY_LIVE', 'Deals go live only after platform review');
    }
    const input = parseInput(body);
    const deal: GroupBuyDeal = {
      id: uid('gb'),
      merchantId: session.merchantId,
      title: input.title,
      description: input.description,
      imageUrl: input.imageUrl,
      priceTZS: input.priceTZS,
      originalPriceTZS: input.originalPriceTZS,
      quantity: input.quantity,
      soldCount: 0,
      validityDays: input.validityDays,
      salesStartAt: input.salesStartAt,
      salesEndAt: input.salesEndAt,
      status: 'draft',
    };
    db.table<GroupBuyDeal>('groupBuys').insert(deal);
    emit({ type: 'group_buy.deal_created', deal, at: Date.now() });
    audit(session.merchantId, session.staffId, session.role, 'group-buy:create', 'groupBuy', deal.id, `created deal "${deal.title}" (draft)`);
    idemSet('group-buy:create', key, { deal });
    return ok({ deal }, { status: 201 });
  }),

  h.get('/api/group-buys/:dealId', ({ request, params }) => {
    const session = requireSession(request);
    requirePerm(session, 'campaigns:manage');
    const deal = maybeEnd(ensureDeal(session, String(params.dealId)));
    return ok({ deal });
  }),

  h.patch('/api/group-buys/:dealId', async ({ request, params }) => {
    const session = requireSession(request);
    requirePerm(session, 'campaigns:manage');
    const deal = maybeEnd(ensureDeal(session, String(params.dealId)));
    if (deal.status === 'live' || deal.status === 'extended' || deal.status === 'delisted' || deal.status === 'ended') {
      throw new ApiHttpError(409, 'GROUP_BUY_STATUS_CONFLICT', 'Only draft, pending-review or rejected deals can be edited');
    }
    const body = await readJson(request);
    const input = parseInput({ ...deal, ...body });
    const updated = db.table<GroupBuyDeal>('groupBuys').update(deal.id, {
      ...input,
      status: 'pending_review',
      rejectReason: undefined,
    })!;
    audit(session.merchantId, session.staffId, session.role, 'group-buy:submit', 'groupBuy', deal.id, `submitted "${deal.title}" for review`);
    return ok({ deal: updated });
  }),

  h.post('/api/group-buys/:dealId/extend', async ({ request, params }) => {
    const session = requireSession(request);
    requirePerm(session, 'campaigns:manage');
    const deal = maybeEnd(ensureDeal(session, String(params.dealId)));
    if (deal.status !== 'live' && deal.status !== 'extended') {
      throw new ApiHttpError(409, 'GROUP_BUY_STATUS_CONFLICT', 'Only live deals can be extended');
    }
    const body = await readJson(request);
    const newEndsAt = Number(body.newEndsAt);
    if (!Number.isFinite(newEndsAt) || newEndsAt <= deal.salesEndAt) {
      throw new ApiHttpError(400, 'GROUP_BUY_EXTEND_INVALID', 'newEndsAt must be after the current end date');
    }
    const updated = db.table<GroupBuyDeal>('groupBuys').update(deal.id, { salesEndAt: newEndsAt, status: 'extended' })!;
    audit(session.merchantId, session.staffId, session.role, 'group-buy:extend', 'groupBuy', deal.id, `extended "${deal.title}" to ${new Date(newEndsAt).toISOString()}`);
    return ok({ deal: updated });
  }),

  h.post('/api/group-buys/:dealId/delist', ({ request, params }) => {
    const session = requireSession(request);
    requirePerm(session, 'campaigns:manage');
    const deal = maybeEnd(ensureDeal(session, String(params.dealId)));
    if (deal.status !== 'live' && deal.status !== 'extended') {
      throw new ApiHttpError(409, 'GROUP_BUY_STATUS_CONFLICT', 'Only live deals can be delisted');
    }
    const updated = db.table<GroupBuyDeal>('groupBuys').update(deal.id, { status: 'delisted' })!;
    emit({ type: 'group_buy.deal_delisted', deal: updated, at: Date.now() });
    audit(session.merchantId, session.staffId, session.role, 'group-buy:delist', 'groupBuy', deal.id, `delisted "${deal.title}"`);
    return ok({ deal: updated });
  }),

  h.post('/api/group-buys/:dealId/relist', ({ request, params }) => {
    const session = requireSession(request);
    requirePerm(session, 'campaigns:manage');
    const deal = ensureDeal(session, String(params.dealId));
    if (deal.status !== 'delisted') {
      throw new ApiHttpError(409, 'GROUP_BUY_STATUS_CONFLICT', 'Only delisted deals can apply for re-listing');
    }
    const updated = db.table<GroupBuyDeal>('groupBuys').update(deal.id, { status: 'pending_review' })!;
    audit(session.merchantId, session.staffId, session.role, 'group-buy:relist', 'groupBuy', deal.id, `applied to re-list "${deal.title}"`);
    return ok({ deal: updated });
  }),

  /* ---- Vouchers ---- */
  h.get('/api/group-buys/:dealId/vouchers', ({ request, params }) => {
    const session = requireSession(request);
    requirePerm(session, 'campaigns:manage');
    const deal = ensureDeal(session, String(params.dealId));
    const url = new URL(request.url);
    const status = url.searchParams.get('status');
    let rows = db.table<VoucherRow>('vouchers').where((v) => v.groupBuyId === deal.id);
    if (status) rows = rows.filter((v) => v.status === status);
    return ok({ vouchers: [...rows].sort((a, b) => b.purchasedAt - a.purchasedAt) });
  }),

  h.get('/api/vouchers/me', ({ request }) => {
    const session = requireSession(request);
    requirePerm(session, 'redemption');
    const url = new URL(request.url);
    const status = url.searchParams.get('status');
    const dealIds = new Set(merchantDeals(session.merchantId).map((d) => d.id));
    let rows = db.table<VoucherRow>('vouchers').where((v) => dealIds.has(v.groupBuyId));
    if (status) rows = rows.filter((v) => v.status === status);
    return ok({ vouchers: [...rows].sort((a, b) => b.purchasedAt - a.purchasedAt) });
  }),

  h.post('/api/vouchers/:voucherCode/verify', async ({ request, params }) => {
    const session = requireSession(request);
    requirePerm(session, 'redemption');
    const code = String(params.voucherCode).trim().toUpperCase();
    const body = await readJson(request);
    const merchantId = String(body.merchantId ?? session.merchantId);
    if (!code) throw new ApiHttpError(400, 'CODE_REQUIRED', 'Scan or enter a voucher code');

    if (!VOUCHER_CODE_RE.test(code)) {
      historyRow(code, session.staffId, 'invalid');
      throw new ApiHttpError(409, 'VOUCHER_INVALID_CODE', 'Code not recognized — check it and try again');
    }

    const voucher = findVoucherByCode(code);
    if (!voucher) {
      historyRow(code, session.staffId, 'invalid');
      throw new ApiHttpError(409, 'VOUCHER_INVALID_CODE', 'Voucher code not recognized');
    }

    const deal = db.table<GroupBuyDeal>('groupBuys').find(voucher.groupBuyId);
    if (!deal || deal.merchantId !== merchantId) {
      historyRow(code, session.staffId, 'invalid');
      throw new ApiHttpError(409, 'VOUCHER_NOT_REDEEMABLE_AT_MERCHANT', 'This deal is not valid at this store');
    }

    const expired = voucher.status === 'expired' || voucher.expiresAt <= Date.now();
    if (expired) {
      if (voucher.status === 'unused') {
        db.table<VoucherRow>('vouchers').update(voucher.code, { status: 'expired' });
      }
      historyRow(code, session.staffId, 'expired');
      throw new ApiHttpError(409, 'VOUCHER_EXPIRED', 'This voucher has expired');
    }

    if (voucher.status === 'redeemed') {
      historyRow(code, session.staffId, 'already_used');
      throw new ApiHttpError(409, 'VOUCHER_ALREADY_USED', 'This voucher was already redeemed');
    }

    if (voucher.status === 'refunded' && voucher.refundPendingAt) {
      historyRow(code, session.staffId, 'invalid');
      throw new ApiHttpError(409, 'VOUCHER_REFUND_PENDING', 'A refund is in progress for this voucher — try again later');
    }

    if (voucher.status !== 'unused') {
      historyRow(code, session.staffId, 'invalid');
      throw new ApiHttpError(409, 'VOUCHER_INVALID_CODE', 'Voucher is not redeemable');
    }

    const updated = db.table<VoucherRow>('vouchers').update(voucher.code, {
      status: 'redeemed',
      redeemedAt: Date.now(),
      redeemedByMerchantId: merchantId,
    })!;
    historyRow(code, session.staffId, 'redeemed');
    emit({ type: 'group_buy.voucher_verified', voucher: updated, at: Date.now() });
    audit(session.merchantId, session.staffId, session.role, 'voucher:verify', 'voucher', code, `redeemed voucher ${code}`);
    return ok({ voucher: updated });
  }),

  h.get('/api/vouchers/verify-history', ({ request }) => {
    const session = requireSession(request);
    requirePerm(session, 'redemption');
    const rows = db
      .table<VerifyHistoryEntry & { id: string }>('verifyHistory')
      .all()
      .sort((a, b) => b.verifiedAt - a.verifiedAt);
    return ok({ history: rows });
  }),

  /* ---- Customer purchase (demo surface: merchant auth can simulate a sale) ---- */
  h.post('/api/group-buys/:groupId/purchase', async ({ request, params }) => {
    const session = requireSession(request);
    const deal = db.table<GroupBuyDeal & { id: string }>('groupBuys').find(String(params.groupId));
    if (!deal) throw new ApiHttpError(404, 'GROUP_BUY_NOT_FOUND', 'Deal not found');
    /* Contract codes (ERROR-CODES.md): GROUP_BUY_ENDED / GROUP_BUY_QUANTITY_EXCEEDED. */
    if (deal.status === 'ended') throw new ApiHttpError(409, 'GROUP_BUY_ENDED', 'Deal has ended');
    if (deal.status !== 'live') throw new ApiHttpError(409, 'GROUP_BUY_STATUS_CONFLICT', 'Deal is not live');
    if (deal.soldCount >= deal.quantity) throw new ApiHttpError(409, 'GROUP_BUY_QUANTITY_EXCEEDED', 'Deal is sold out');
    const body = await readJson(request);
    /* Contract max 20 (purchaseGroupBuyBody quantity 1–20). */
    const count = Math.max(1, Math.min(Number(body.count ?? 1), 20));
    if (deal.soldCount + count > deal.quantity) throw new ApiHttpError(409, 'GROUP_BUY_QUANTITY_EXCEEDED', 'Not enough inventory');
    const updated = db.table<GroupBuyDeal & { id: string }>('groupBuys').update(deal.id, {
      soldCount: deal.soldCount + count,
    })!;
    emit({ type: 'group_buy.purchase', dealId: deal.id, count, at: Date.now() });
    audit(session.merchantId, session.staffId, session.role, 'group-buy:purchase', 'group-buy', deal.id, `purchased ${count} × ${deal.title}`);
    return ok({ purchaseId: uid('gbp'), deal: updated, count });
  }),
];