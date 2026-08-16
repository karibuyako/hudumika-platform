import type {
  DineInOrder,
  HelpArticle,
  MerchantStaff,
  MerchantStaffRole,
  MerchantStaffStatus,
  NotificationDto,
  OrderDto,
  Payment,
  ProductPerformance,
  ProductRow,
  Redemption,
  ReviewAnalytics,
  ReviewDto,
  RiskEvent,
  Staff,
  SupportTicket,
  TicketMessage,
  TrafficAnalysis,
  TrafficChannel,
} from '@/api/types';
import { db, uid } from '@/mock/db';
import { emit } from '@/mock/events';
import { audit, json, ok, requirePerm, requireSession } from '@/mock/security';
import { ApiHttpError, h, readJson } from '@/mock/handlers/common';
import { COMMISSION_RATE } from '@/data/seed';
import { http } from 'msw';
import type { Session } from '@/mock/types-internal';


/* ================= Redemptions (coupon 核销) ================= */

export const redemptionHandlers = [
  h.get('/api/redemptions', ({ request }) => {
    const session = requireSession(request);
    requirePerm(session, 'redemption');
    const url = new URL(request.url);
    const status = url.searchParams.get('status');
    let rows = db.table<Redemption>('redemptions').where((r) => r.merchantId === session.merchantId);
    if (status) rows = rows.filter((r) => r.status === status);
    const redeemed = db.table('redemptions').where((r) => r.merchantId === session.merchantId && r.status === 'redeemed');
    const totalAmount = redeemed.reduce((s, r) => s + (r.amount ?? 0), 0);
    return ok({ redemptions: [...rows].sort((a, b) => b.ts - a.ts).slice(0, 200), stats: { count: redeemed.length, totalAmount } });
  }),

  h.post('/api/redemptions/validate', async ({ request }) => {
    const session = requireSession(request);
    requirePerm(session, 'redemption');
    const body = await readJson(request);
    const code = String(body.code ?? '').trim().toUpperCase();
    if (!code) throw new ApiHttpError(400, 'CODE_REQUIRED', 'Scan or enter a redemption code');
    const record = db.table<Redemption>('redemptions').where((r) => r.merchantId === session.merchantId && r.code === code)[0];
    if (!record) throw new ApiHttpError(404, 'INVALID_CODE', 'Invalid coupon code');
    if (record.status === 'redeemed') throw new ApiHttpError(409, 'ALREADY_REDEEMED', 'This coupon was already redeemed');
    if (record.status === 'expired') throw new ApiHttpError(410, 'EXPIRED', 'This coupon has expired');
    return ok({ valid: true, coupon: record });
  }),

  h.post('/api/redemptions', async ({ request }) => {
    const session = requireSession(request);
    requirePerm(session, 'redemption');
    const body = await readJson(request);
    const code = String(body.code ?? '').trim().toUpperCase();
    const record = db.table<Redemption>('redemptions').where((r) => r.merchantId === session.merchantId && r.code === code)[0];
    if (!record) throw new ApiHttpError(404, 'INVALID_CODE', 'Invalid coupon code');
    if (record.status === 'redeemed') throw new ApiHttpError(409, 'ALREADY_REDEEMED', 'This coupon was already redeemed');
    if (record.status === 'expired') throw new ApiHttpError(410, 'EXPIRED', 'This coupon has expired');
    const updated = db.table<Redemption>('redemptions').update(record.id, { status: 'redeemed', redeemedAt: Date.now(), redeemedBy: session.staffId })!;
    audit(session.merchantId, session.staffId, session.role, 'redemption:redeem', 'redemption', record.id, `redeemed ${code} (${record.amount} off)`);
    return ok({ redeemed: true, redemption: updated });
  }),
];

/* ================= Reviews ================= */

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

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Raw JSON body — the shared `ok()` spreads objects, so array responses go through here. */
const raw = (body: unknown, status = 200) => Response.json(body, { status });

export const reviewHandlers = [
  h.get('/api/reviews', ({ request }) => {
    const session = requireSession(request);
    const url = new URL(request.url);
    const rating = url.searchParams.get('rating');
    const unreplied = url.searchParams.get('unreplied') === '1';
    const platform = url.searchParams.get('platform');
    let rows = db.table<ReviewDto>('reviews').where((r) => r.merchantId === session.merchantId);
    if (rating) rows = rows.filter((r) => r.rating === Number(rating));
    if (unreplied) rows = rows.filter((r) => !r.reply);
    if (platform === 'meituan' || platform === 'dianping') rows = rows.filter((r) => r.platform === platform);
    const avg = rows.length ? rows.reduce((s, r) => s + r.rating, 0) / rows.length : 0;
    return ok({ reviews: [...rows].sort((a, b) => b.ts - a.ts).slice(0, 200), avgRating: round1(avg) });
  }),

  /* ---- Drift-D alias: contract GET /reviews/me ≡ GET /reviews (same list
   * payload; docs/CONTRACT-ADDITIONS.md "Resolution status"). ---- */
  h.get('/api/reviews/me', ({ request }) => {
    const session = requireSession(request);
    const url = new URL(request.url);
    const rating = url.searchParams.get('rating');
    const unreplied = url.searchParams.get('unreplied') === '1';
    const platform = url.searchParams.get('platform');
    let rows = db.table<ReviewDto>('reviews').where((r) => r.merchantId === session.merchantId);
    if (rating) rows = rows.filter((r) => r.rating === Number(rating));
    if (unreplied) rows = rows.filter((r) => !r.reply);
    if (platform === 'meituan' || platform === 'dianping') rows = rows.filter((r) => r.platform === platform);
    const avg = rows.length ? rows.reduce((s, r) => s + r.rating, 0) / rows.length : 0;
    return ok({ reviews: [...rows].sort((a, b) => b.ts - a.ts).slice(0, 200), avgRating: round1(avg) });
  }),

  h.post('/api/reviews/:id/reply', async ({ request, params }) => {
    const session = requireSession(request);
    requirePerm(session, 'reviews:reply');
    const review = db.table<ReviewDto>('reviews').find(String(params.id));
    if (!review || review.merchantId !== session.merchantId) throw new ApiHttpError(404, 'NOT_FOUND', 'Review not found');
    const body = await readJson(request);
    const text = String(body.text ?? '').trim();
    if (!text) throw new ApiHttpError(400, 'EMPTY_REPLY', 'Reply cannot be empty');
    const updated = db.table<ReviewDto>('reviews').update(review.id, { reply: text, repliedAt: Date.now(), repliedBy: session.staffId })!;
    audit(session.merchantId, session.staffId, session.role, 'reviews:reply', 'review', review.id, 'replied to a customer review');
    return ok({ review: updated });
  }),

  h.patch('/api/reviews/:id/reply', async ({ request, params }) => {
    const session = requireSession(request);
    requirePerm(session, 'reviews:reply');
    const review = db.table<ReviewDto>('reviews').find(String(params.id));
    if (!review || review.merchantId !== session.merchantId) throw new ApiHttpError(404, 'NOT_FOUND', 'Review not found');
    const body = await readJson(request);
    const text = String(body.text ?? '').trim();
    if (!text) throw new ApiHttpError(400, 'EMPTY_REPLY', 'Reply cannot be empty');
    const editing = !!review.reply;
    const updated = db.table<ReviewDto>('reviews').update(review.id, { reply: text, repliedAt: Date.now(), repliedBy: session.staffId })!;
    audit(
      session.merchantId,
      session.staffId,
      session.role,
      editing ? 'reviews:reply-edit' : 'reviews:reply',
      'review',
      review.id,
      editing ? 'edited a review reply' : 'replied to a customer review',
    );
    return ok({ review: updated });
  }),

  del('/api/reviews/:id/reply', ({ request, params }) => {
    const session = requireSession(request);
    requirePerm(session, 'reviews:reply');
    const review = db.table<ReviewDto>('reviews').find(String(params.id));
    if (!review || review.merchantId !== session.merchantId) throw new ApiHttpError(404, 'NOT_FOUND', 'Review not found');
    const updated = db.table<ReviewDto>('reviews').update(review.id, { reply: undefined, repliedAt: undefined, repliedBy: undefined })!;
    audit(session.merchantId, session.staffId, session.role, 'reviews:reply-delete', 'review', review.id, 'removed a review reply');
    return ok({ review: updated });
  }),

  h.get('/api/reviews/analytics', ({ request }) => {
    const session = requireSession(request);
    const rows = db.table<ReviewDto>('reviews').where((r) => r.merchantId === session.merchantId);
    const total = rows.length;
    const avgRating = total ? round1(rows.reduce((s, r) => s + r.rating, 0) / total) : 0;
    const praiseRate = total ? round1((rows.filter((r) => r.rating >= 4).length / total) * 100) : 0;
    const replyRate = total ? round1((rows.filter((r) => r.reply).length / total) * 100) : 0;
    const distribution = [1, 2, 3, 4, 5].map((rating) => ({ rating, count: rows.filter((r) => r.rating === rating).length }));
    const weeklyAvg: ReviewAnalytics['weeklyAvg'] = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000);
      const start = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
      const list = rows.filter((r) => r.ts >= start && r.ts < start + 86400000);
      weeklyAvg.push({
        label: i === 0 ? 'Today' : ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()],
        avg: list.length ? round1(list.reduce((s, r) => s + r.rating, 0) / list.length) : 0,
      });
    }
    const byPlatform: ReviewAnalytics['byPlatform'] = { meituan: { total: 0, avgRating: 0, praiseRate: 0 }, dianping: { total: 0, avgRating: 0, praiseRate: 0 } };
    for (const platform of ['meituan', 'dianping'] as const) {
      const list = rows.filter((r) => r.platform === platform);
      byPlatform[platform] = {
        total: list.length,
        avgRating: list.length ? round1(list.reduce((s, r) => s + r.rating, 0) / list.length) : 0,
        praiseRate: list.length ? round1((list.filter((r) => r.rating >= 4).length / list.length) * 100) : 0,
      };
    }
    return ok({ total, avgRating, praiseRate, replyRate, distribution, weeklyAvg, byPlatform });
  }),

  /* ---- P6: review moderation + customer-side actions (contract /reviews,
   * /reviews/{reviewId}, /reviews/{reviewId}/helpful, /reviews/{reviewId}/report).
   * The customer write/action endpoints are mock-only for the merchant demo. ---- */

  h.post('/api/reviews', async ({ request }) => {
    const session = requireSession(request);
    const body = await readJson(request);
    const targetType = String(body.targetType ?? 'merchant');
    const rating = Number(body.rating);
    const content = String(body.body ?? '').trim();
    if (!['merchant', 'provider', 'rider', 'customer'].includes(targetType)) {
      throw new ApiHttpError(422, 'VALIDATION_ERROR', 'targetType must be merchant, provider, rider or customer');
    }
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      throw new ApiHttpError(422, 'VALIDATION_ERROR', 'rating must be an integer between 1 and 5');
    }
    if (!content || content.length > 2000) {
      throw new ApiHttpError(422, 'VALIDATION_ERROR', 'body is required (max 2000 characters)');
    }
    const review: ReviewDto = {
      id: uid('rv'),
      merchantId: session.merchantId,
      orderNo: 'REVIEW-DEMO',
      customer: 'Demo customer',
      rating,
      content: content.slice(0, 2000),
      ts: Date.now(),
      platform: 'meituan',
      state: 'published',
      helpfulCount: 0,
      notHelpfulCount: 0,
      myVote: null,
    };
    db.table<ReviewDto>('reviews').insert(review);
    audit(session.merchantId, session.staffId, session.role, 'reviews:create', 'review', review.id, 'created a review (demo)');
    return json(201, review);
  }),

  h.patch('/api/reviews/:id', async ({ request, params }) => {
    const session = requireSession(request);
    const review = db.table<ReviewDto>('reviews').find(String(params.id));
    if (!review || review.merchantId !== session.merchantId) throw new ApiHttpError(404, 'NOT_FOUND', 'Review not found');
    const body = await readJson(request);
    const patch: Partial<ReviewDto> = {};
    if (body.rating !== undefined) {
      const rating = Number(body.rating);
      if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
        throw new ApiHttpError(400, 'INVALID_RATING', 'rating must be an integer between 1 and 5');
      }
      patch.rating = rating;
    }
    if (body.body !== undefined) {
      const content = String(body.body ?? '').trim();
      if (content.length > 2000) throw new ApiHttpError(400, 'INVALID_BODY', 'body must be at most 2000 characters');
      patch.content = content;
    }
    if (body.state !== undefined) {
      if (!['pending', 'published', 'hidden', 'deleted'].includes(String(body.state))) {
        throw new ApiHttpError(400, 'INVALID_STATE', 'state must be pending, published, hidden or deleted');
      }
      patch.state = body.state as ReviewDto['state'];
    }
    if (!Object.keys(patch).length) throw new ApiHttpError(400, 'EMPTY_UPDATE', 'Nothing to update');
    const updated = db.table<ReviewDto>('reviews').update(review.id, patch)!;
    audit(session.merchantId, session.staffId, session.role, 'reviews:update', 'review', review.id, `updated review (${Object.keys(patch).join(', ')})`);
    return ok({ review: updated });
  }),

  del('/api/reviews/:id', ({ request, params }) => {
    const session = requireSession(request);
    const review = db.table<ReviewDto>('reviews').find(String(params.id));
    if (!review || review.merchantId !== session.merchantId) throw new ApiHttpError(404, 'NOT_FOUND', 'Review not found');
    db.table<ReviewDto>('reviews').remove(review.id);
    audit(session.merchantId, session.staffId, session.role, 'reviews:delete', 'review', review.id, 'deleted a review');
    return new Response(null, { status: 204 });
  }),

  h.post('/api/reviews/:id/helpful', async ({ request, params }) => {
    const session = requireSession(request);
    const review = db.table<ReviewDto>('reviews').find(String(params.id));
    if (!review || review.merchantId !== session.merchantId) throw new ApiHttpError(404, 'NOT_FOUND', 'Review not found');
    const body = await readJson(request);
    if (typeof body.helpful !== 'boolean') throw new ApiHttpError(400, 'INVALID_VOTE', 'helpful must be a boolean');
    const myVote = review.myVote;
    const helpfulCount = review.helpfulCount ?? 0;
    const notHelpfulCount = review.notHelpfulCount ?? 0;
    const untoggle = myVote === body.helpful;
    const updated = db.table<ReviewDto>('reviews').update(review.id, {
      myVote: untoggle ? null : body.helpful,
      helpfulCount: untoggle && myVote ? helpfulCount - 1 : body.helpful ? helpfulCount + 1 : helpfulCount,
      notHelpfulCount: untoggle && myVote === false ? notHelpfulCount - 1 : !body.helpful ? notHelpfulCount + 1 : notHelpfulCount,
    })!;
    return ok({ helpfulCount: updated.helpfulCount, notHelpfulCount: updated.notHelpfulCount, myVote: updated.myVote });
  }),

  h.post('/api/reviews/:id/report', async ({ request, params }) => {
    const session = requireSession(request);
    const review = db.table<ReviewDto>('reviews').find(String(params.id));
    if (!review || review.merchantId !== session.merchantId) throw new ApiHttpError(404, 'NOT_FOUND', 'Review not found');
    const body = await readJson(request);
    const reason = String(body.reason ?? '').trim();
    if (!reason) throw new ApiHttpError(400, 'REPORT_REASON_REQUIRED', 'reason is required');
    const report = { id: uid('rp'), reviewId: review.id, reason: reason.slice(0, 300), state: 'open' as const };
    db.table<{ id: string; reviewId: string; reason: string; state: string }>('reviewReports').insert(report);
    return json(201, report);
  }),

  /* ---- Drift-D alias: contract GET /analytics/reviews ≡ GET /reviews/analytics
   * (same computed analytics payload; docs/CONTRACT-ADDITIONS.md
   * "Resolution status"). ---- */
  h.get('/api/analytics/reviews', ({ request }) => {
    const session = requireSession(request);
    const rows = db.table<ReviewDto>('reviews').where((r) => r.merchantId === session.merchantId);
    const total = rows.length;
    const avgRating = total ? round1(rows.reduce((s, r) => s + r.rating, 0) / total) : 0;
    const praiseRate = total ? round1((rows.filter((r) => r.rating >= 4).length / total) * 100) : 0;
    const replyRate = total ? round1((rows.filter((r) => r.reply).length / total) * 100) : 0;
    const distribution = [1, 2, 3, 4, 5].map((rating) => ({ rating, count: rows.filter((r) => r.rating === rating).length }));
    const weeklyAvg: ReviewAnalytics['weeklyAvg'] = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000);
      const start = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
      const list = rows.filter((r) => r.ts >= start && r.ts < start + 86400000);
      weeklyAvg.push({
        label: i === 0 ? 'Today' : ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()],
        avg: list.length ? round1(list.reduce((s, r) => s + r.rating, 0) / list.length) : 0,
      });
    }
    const byPlatform: ReviewAnalytics['byPlatform'] = { meituan: { total: 0, avgRating: 0, praiseRate: 0 }, dianping: { total: 0, avgRating: 0, praiseRate: 0 } };
    for (const platform of ['meituan', 'dianping'] as const) {
      const list = rows.filter((r) => r.platform === platform);
      byPlatform[platform] = {
        total: list.length,
        avgRating: list.length ? round1(list.reduce((s, r) => s + r.rating, 0) / list.length) : 0,
        praiseRate: list.length ? round1((list.filter((r) => r.rating >= 4).length / list.length) * 100) : 0,
      };
    }
    return ok({ total, avgRating, praiseRate, replyRate, distribution, weeklyAvg, byPlatform });
  }),
];

/* ================= Staff & sessions ================= */

const STAFF_ROLES: readonly MerchantStaffRole[] = ['owner', 'manager', 'cashier', 'kitchen', 'waiter'];
const STAFF_STATUSES: readonly MerchantStaffStatus[] = ['invited', 'active', 'suspended'];

/** Contract-conformant rows are scoped to the merchant server-side. */
type MerchantStaffRow = MerchantStaff & { merchantId: string };

const STAFF_PERMS: Record<MerchantStaffRole, string[]> = {
  owner: ['*'],
  manager: ['orders:manage', 'orders:accept', 'menu:manage', 'finance:view', 'redemption', 'campaigns:manage', 'team:manage', 'audit:view', 'support', 'store:manage', 'reviews:reply'],
  cashier: ['redemption', 'dine_in:billing'],
  kitchen: ['dine_in:prep'],
  waiter: ['orders:view', 'dine_in:serve'],
};

function parseStaffInput(body: Record<string, unknown>, partial: boolean): { name?: string; phone?: string; role?: MerchantStaffRole; permissions?: string[] } {
  const out: { name?: string; phone?: string; role?: MerchantStaffRole; permissions?: string[] } = {};
  if (body.name !== undefined || !partial) {
    const name = String(body.name ?? '').trim();
    if (!name) throw new ApiHttpError(400, 'NAME_REQUIRED', 'name is required');
    out.name = name;
  }
  if (body.phone !== undefined || !partial) {
    const phone = String(body.phone ?? '').trim();
    if (!/^\+255[67]\d{8}$/.test(phone)) throw new ApiHttpError(400, 'INVALID_PHONE', 'A valid Tanzanian phone number (+255...) is required');
    out.phone = phone;
  }
  if (body.role !== undefined || !partial) {
    const role = STAFF_ROLES.find((r) => r === body.role);
    if (!role) throw new ApiHttpError(400, 'INVALID_ROLE', `role must be one of ${STAFF_ROLES.join(', ')}`);
    out.role = role;
  }
  if (body.permissions !== undefined) {
    if (!Array.isArray(body.permissions) || body.permissions.some((p) => typeof p !== 'string')) {
      throw new ApiHttpError(400, 'INVALID_PERMISSIONS', 'permissions must be an array of scope strings');
    }
    out.permissions = body.permissions as string[];
  }
  return out;
}

function staffOfRow(session: Session, id: string): MerchantStaffRow {
  const row = db.table<MerchantStaffRow>('merchantStaff').find(id);
  if (!row || row.merchantId !== session.merchantId) throw new ApiHttpError(404, 'STAFF_NOT_FOUND', 'Staff member not found');
  return row;
}

export const staffHandlers = [
  /* ---- Merchant staff (P6d, contract /merchants/me/staff) ---- */
  h.get('/api/merchants/me/staff', ({ request }) => {
    const session = requireSession(request);
    requirePerm(session, 'team:manage');
    const list = db.table<MerchantStaffRow>('merchantStaff').where((s) => s.merchantId === session.merchantId).sort((a, b) => a.createdAt - b.createdAt);
    return raw(list.map(({ merchantId: _m, ...s }) => s));
  }),

  h.post('/api/merchants/me/staff', async ({ request }) => {
    const session = requireSession(request);
    requirePerm(session, 'team:manage');
    const body = await readJson(request);
    const input = parseStaffInput(body, false);
    const duplicate = db.table<MerchantStaffRow>('merchantStaff').where((s) => s.merchantId === session.merchantId && s.phone === input.phone);
    if (duplicate.length) throw new ApiHttpError(409, 'STAFF_EXISTS', 'A staff member with this phone already exists');
    const staff: MerchantStaffRow = {
      id: uid('s'),
      merchantId: session.merchantId,
      storeId: 's_demo',
      name: input.name!,
      phone: input.phone!,
      role: input.role ?? 'cashier',
      permissions: input.permissions ?? STAFF_PERMS[input.role ?? 'cashier'],
      status: 'invited',
      createdAt: Date.now(),
    };
    db.table<MerchantStaffRow>('merchantStaff').insert(staff);
    const note: NotificationDto = {
      id: uid('n'),
      merchantId: session.merchantId,
      type: 'system',
      category: 'important',
      title: `${staff.name} invited`,
      body: `${staff.name} (${staff.role}) can activate their account with their phone via SMS code.`,
      ts: Date.now(),
      read: false,
    };
    db.table<NotificationDto>('notifications').insert(note);
    emit({ type: 'notification.created', notification: note, at: Date.now() });
    emit({ type: 'staff.invited', staff, at: Date.now() });
    audit(session.merchantId, session.staffId, session.role, 'team:invite', 'staff', staff.id, `invited ${staff.name} as ${staff.role}`);
    return json(201, { id: staff.id, name: staff.name, phone: staff.phone, role: staff.role, storeId: staff.storeId, permissions: staff.permissions, status: staff.status, createdAt: staff.createdAt });
  }),

  h.patch('/api/merchants/me/staff/:id', async ({ request, params }) => {
    const session = requireSession(request);
    requirePerm(session, 'team:manage');
    const row = staffOfRow(session, String(params.id));
    const body = await readJson(request);
    const input = parseStaffInput(body, true);
    const patch: Partial<MerchantStaffRow> = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.phone !== undefined) patch.phone = input.phone;
    if (input.role !== undefined) {
      if (row.role === 'owner' && input.role !== 'owner') {
        const activeOwners = db.table<MerchantStaffRow>('merchantStaff').where((s) => s.merchantId === session.merchantId && s.role === 'owner' && s.status !== 'suspended');
        if (activeOwners.length <= 1) throw new ApiHttpError(409, 'STAFF_LAST_OWNER', 'Cannot demote the last active owner');
        patch.role = input.role;
      } else if (row.role !== 'owner') {
        patch.role = input.role;
      }
      if (input.role !== row.role) patch.permissions = STAFF_PERMS[input.role];
    }
    if (input.permissions !== undefined && row.role !== 'owner') patch.permissions = input.permissions;
    if (body.status !== undefined) {
      const status = STAFF_STATUSES.find((s) => s === body.status);
      if (!status) throw new ApiHttpError(400, 'INVALID_STATUS', `status must be one of ${STAFF_STATUSES.join(', ')}`);
      if (row.role === 'owner' && status === 'suspended') {
        const activeOwners = db.table<MerchantStaffRow>('merchantStaff').where((s) => s.merchantId === session.merchantId && s.role === 'owner' && s.status !== 'suspended');
        if (activeOwners.length <= 1) throw new ApiHttpError(409, 'STAFF_LAST_OWNER', 'Cannot suspend the last active owner');
      }
      patch.status = status;
    }
    if (!Object.keys(patch).length) throw new ApiHttpError(400, 'EMPTY_UPDATE', 'Nothing to update');
    const updated = db.table<MerchantStaffRow>('merchantStaff').update(row.id, patch)!;
    if (patch.status === 'suspended') {
      /* Suspended staff lose all actions immediately (STAFF-AND-DEVICES.md
       * §27): the authorization layer rejects every request with 403
       * STAFF_SUSPENDED (no separate session revocation — the gate blocks
       * the account wholesale, including sign-in). */
      emit({ type: 'staff.suspended', staff: updated, at: Date.now() });
    } else {
      emit({ type: 'staff.updated', staff: updated, at: Date.now() });
    }
    audit(session.merchantId, session.staffId, session.role, 'team:update', 'staff', updated.id, `updated ${updated.name} (${Object.keys(patch).join(', ')})`);
    return ok({ id: updated.id, name: updated.name, phone: updated.phone, role: updated.role, storeId: updated.storeId, permissions: updated.permissions, status: updated.status, createdAt: updated.createdAt });
  }),

  del('/api/merchants/me/staff/:id', ({ request, params }) => {
    const session = requireSession(request);
    requirePerm(session, 'team:manage');
    const row = staffOfRow(session, String(params.id));
    if (row.role === 'owner') {
      const activeOwners = db.table<MerchantStaffRow>('merchantStaff').where((s) => s.merchantId === session.merchantId && s.role === 'owner' && s.status !== 'suspended');
      if (activeOwners.length <= 1) throw new ApiHttpError(409, 'STAFF_LAST_OWNER', 'Cannot remove the last active owner');
    }
    db.table<MerchantStaffRow>('merchantStaff').remove(row.id);
    emit({ type: 'staff.removed', staffId: row.id, at: Date.now() });
    audit(session.merchantId, session.staffId, session.role, 'team:remove', 'staff', row.id, `removed ${row.name}`);
    return new Response(null, { status: 204 });
  }),

  h.get('/api/staff', ({ request }) => {
    const session = requireSession(request);
    requirePerm(session, 'team:manage');
    const rows = db.table<Staff>('staff').where((s) => s.merchantId === session.merchantId);
    return ok({ staff: rows.map((s) => ({ ...s, phone: s.phone.slice(0, 3) + '****' + s.phone.slice(-4) })) });
  }),

  h.post('/api/staff', async ({ request }) => {
    const session = requireSession(request);
    requirePerm(session, 'team:manage');
    const body = await readJson(request);
    const name = String(body.name ?? '').trim();
    const phone = String(body.phone ?? '').trim();
    const role = body.role === 'manager' || body.role === 'staff' ? body.role : 'staff';
    if (!name || !/^\+255[67]\d{8}$/.test(phone)) throw new ApiHttpError(400, 'INVALID_INPUT', 'Name and a valid Tanzanian phone number (+255...) are required');
    const existing = db.table<Staff>('staff').where((s) => s.merchantId === session.merchantId && s.phone === phone);
    if (existing.length) throw new ApiHttpError(409, 'STAFF_EXISTS', 'A staff member with this phone already exists');
    const staff: Staff = {
      id: uid('s'),
      merchantId: session.merchantId,
      storeId: 's_demo',
      name,
      role,
      phone,
      permissions: role === 'manager' ? ['orders:manage', 'orders:accept', 'menu:manage', 'finance:view', 'redemption', 'campaigns:manage', 'team:manage', 'audit:view', 'support', 'store:manage', 'reviews:reply'] : ['orders:accept', 'redemption'],
      active: true,
    };
    db.table<Staff>('staff').insert(staff);
    const note: NotificationDto = {
      id: uid('n'),
      merchantId: session.merchantId,
      type: 'system',
      category: 'important',
      title: 'New team member',
      body: `${name} was added as ${role}. They can sign in with their phone via SMS code.`,
      ts: Date.now(),
      read: false,
    };
    db.table<NotificationDto>('notifications').insert(note);
    emit({ type: 'notification.created', notification: note, at: Date.now() });
    audit(session.merchantId, session.staffId, session.role, 'team:invite', 'staff', staff.id, `invited ${name} as ${role}`);
    return ok({ staff: { ...staff, phone: staff.phone.slice(0, 3) + '****' + staff.phone.slice(-4) } });
  }),

  h.patch('/api/staff/:id', async ({ request, params }) => {
    const session = requireSession(request);
    requirePerm(session, 'team:manage');
    const s = db.table<Staff>('staff').find(String(params.id));
    if (!s || s.merchantId !== session.merchantId) throw new ApiHttpError(404, 'NOT_FOUND', 'Staff member not found');
    if (s.role === 'owner') throw new ApiHttpError(403, 'FORBIDDEN', 'The owner account cannot be modified');
    const body = await readJson(request);
    const patch: Partial<Staff> = {};
    if (body.role === 'manager' || body.role === 'staff') {
      patch.role = body.role;
      patch.permissions = body.role === 'manager'
        ? ['orders:manage', 'orders:accept', 'menu:manage', 'finance:view', 'redemption', 'campaigns:manage', 'team:manage', 'audit:view', 'support', 'store:manage', 'reviews:reply']
        : ['orders:accept', 'redemption'];
    }
    if (body.active !== undefined) patch.active = body.active === true;
    const updated = db.table<Staff>('staff').update(s.id, patch)!;
    audit(session.merchantId, session.staffId, session.role, 'team:update', 'staff', s.id, `updated ${s.name} (${Object.keys(patch).join(', ')})`);
    return ok({ staff: { ...updated, phone: updated.phone.slice(0, 3) + '****' + updated.phone.slice(-4) } });
  }),

  /* ---- Active sessions (login history / device management) ---- */
  h.get('/api/sessions', ({ request }) => {
    const session = requireSession(request);
    requirePerm(session, 'audit:view');
    const staffIds = db.table<Staff>('staff').where((s) => s.merchantId === session.merchantId).map((s) => s.id);
    const rows = db.table('sessions')
      .where((s) => staffIds.includes(s.staffId))
      .map((s) => ({
        token: s.token,
        staffId: s.staffId,
        role: s.role,
        createdAt: s.createdAt,
        expiresAt: s.expiresAt,
        revoked: s.revoked,
        device: 'Merchant Pro App',
        ip: `203.0.113.${Math.floor(Math.random() * 200) + 1}`,
      }))
      .sort((a, b) => b.createdAt - a.createdAt);
    return ok({ sessions: rows });
  }),

  h.post('/api/sessions/:token/revoke', async ({ request, params }) => {
    const session = requireSession(request);
    requirePerm(session, 'audit:view');
    const token = String(params.token);
    if (token === session.token) throw new ApiHttpError(400, 'SELF_REVOKE', 'Use sign-out to end your own session');
    const s = db.table('sessions').find(token);
    if (!s) throw new ApiHttpError(404, 'NOT_FOUND', 'Session not found');
    db.table('sessions').update(token, { revoked: true });
    audit(session.merchantId, session.staffId, session.role, 'auth:revoke-session', 'session', token, 'revoked another device session');
    return ok({ revoked: true });
  }),
];

/* ================= Reconciliation ================= */

export const financeExtraHandlers = [
  h.get('/api/finance/reconciliation', ({ request }) => {
    const session = requireSession(request);
    requirePerm(session, 'finance:view');
    const url = new URL(request.url);
    const days = Math.min(30, Number(url.searchParams.get('days') ?? 7));
    const out: {
      day: string;
      ledgerGross: number;
      settlementGross: number;
      commission: number;
      diff: number;
      ok: boolean;
    }[] = [];
    for (let i = days - 1; i >= 0; i--) {
      const start = new Date();
      start.setHours(0, 0, 0, 0);
      const dayStart = start.getTime() - i * 86400000;
      const dayEnd = dayStart + 86400000;
      const orders = db.table<OrderDto>('orders').where((o) => o.merchantId === session.merchantId && o.status === 'completed' && (o.completedAt ?? 0) >= dayStart && (o.completedAt ?? 0) < dayEnd);
      const ledgerGross = orders.reduce((s, o) => s + o.total, 0);
      const settlement = db.table('settlements').where((s) => s.merchantId === session.merchantId && s.periodStart === dayStart)[0];
      const settlementGross = settlement?.gross ?? 0;
      const commission = Math.round(ledgerGross * COMMISSION_RATE * 100) / 100;
      const diff = Math.round((ledgerGross - settlementGross) * 100) / 100;
      out.push({
        day: new Date(dayStart).toISOString().slice(0, 10),
        ledgerGross: Math.round(ledgerGross * 100) / 100,
        settlementGross,
        commission,
        diff,
        ok: Math.abs(diff) < 0.01 || !settlement,
      });
    }
    return ok({ days: out });
  }),

  /* ---- Payment method breakdown for settlements ---- */
  h.get('/api/finance/methods', ({ request }) => {
    const session = requireSession(request);
    requirePerm(session, 'finance:view');
    const payments = db.table<Payment>('payments').where((p) => p.merchantId === session.merchantId && p.status === 'captured');
    const byMethod = new Map<string, { count: number; amount: number }>();
    for (const p of payments) {
      const cur = byMethod.get(p.method) ?? { count: 0, amount: 0 };
      cur.count += 1;
      cur.amount += p.amount;
      byMethod.set(p.method, cur);
    }
    return ok({
      methods: [...byMethod.entries()].map(([method, v]) => ({ method, count: v.count, amount: Math.round(v.amount * 100) / 100 })),
    });
  }),
];

/* ================= Risk & fraud ================= */

export const riskHandlers = [
  h.get('/api/risk/events', ({ request }) => {
    const session = requireSession(request);
    requirePerm(session, 'audit:view');
    const url = new URL(request.url);
    const status = url.searchParams.get('status');
    let rows = db.table<RiskEvent>('riskEvents').where((r) => r.merchantId === session.merchantId);
    if (status) rows = rows.filter((r) => r.status === status);
    const open = rows.filter((r) => r.status === 'open').length;
    return ok({ events: [...rows].sort((a, b) => b.ts - a.ts).slice(0, 100), openCount: open });
  }),

  h.post('/api/risk/:id/review', async ({ request, params }) => {
    const session = requireSession(request);
    requirePerm(session, 'audit:view');
    const e = db.table<RiskEvent>('riskEvents').find(String(params.id));
    if (!e || e.merchantId !== session.merchantId) throw new ApiHttpError(404, 'NOT_FOUND', 'Risk event not found');
    if (e.status !== 'open') {
      throw new ApiHttpError(409, 'RISK_ALREADY_REVIEWED', 'This risk event was already reviewed', false, {
        status: e.status,
        decision: e.decision ?? null,
        reviewedBy: e.reviewedBy ?? null,
        reviewedAt: e.reviewedAt ?? null,
      });
    }
    const body = await readJson(request);
    const decision = body.decision;
    if (decision !== 'resolved' && decision !== 'dismissed') {
      throw new ApiHttpError(400, 'INVALID_DECISION', 'decision must be resolved or dismissed');
    }
    const reason = String(body.reason ?? '').trim();
    if (!reason) throw new ApiHttpError(400, 'RISK_REASON_REQUIRED', 'A reason is required with the review decision');
    if (reason.length > 500) throw new ApiHttpError(400, 'REASON_TOO_LONG', 'reason must be at most 500 characters');
    const updated = db.table<RiskEvent>('riskEvents').update(e.id, {
      status: decision === 'resolved' ? 'resolved' : 'reviewed',
      decision,
      reason: reason.slice(0, 500),
      reviewedBy: session.staffId,
      reviewedAt: Date.now(),
    })!;
    audit(session.merchantId, session.staffId, session.role, 'risk:review', 'riskEvent', e.id, `${decision} risk flag — ${reason}`);
    return ok({ event: updated });
  }),
];

/* ================= Analytics (server aggregates) ================= */

const BI_DAY = 86400000;

function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function biRange(url: URL, defaultDays: number): { from: string; to: string; fromTs: number; toTs: number } {
  const to = url.searchParams.get('to') ?? isoDate(new Date());
  const from = url.searchParams.get('from') ?? isoDate(new Date(Date.now() - (defaultDays - 1) * BI_DAY));
  const fromTs = new Date(`${from}T00:00:00`).getTime();
  const toTs = new Date(`${to}T23:59:59`).getTime();
  return { from, to, fromTs, toTs };
}

export const analyticsHandlers = [
  h.get('/api/analytics/overview', ({ request }) => {
    const session = requireSession(request);
    const url = new URL(request.url);
    const storeId = url.searchParams.get('storeId');
    const m = session.merchantId;
    let orders = db.table<OrderDto>('orders').where((o) => o.merchantId === m);
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
    const reviews = db.table<ReviewDto>('reviews').where((r) => r.merchantId === m);
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
  }),

  h.get('/api/analytics/trend', ({ request }) => {
    const session = requireSession(request);
    const url = new URL(request.url);
    const days = Math.min(30, Number(url.searchParams.get('days') ?? 7));
    const orders = db.table<OrderDto>('orders').where((o) => o.merchantId === session.merchantId && o.status === 'completed');
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
  }),

  h.get('/api/analytics/top-dishes', ({ request }) => {
    const session = requireSession(request);
    const url = new URL(request.url);
    const m = session.merchantId;
    if (url.searchParams.has('from') || url.searchParams.has('to')) {
      const { fromTs, toTs } = biRange(url, 7);
      const limit = Math.min(20, Math.max(1, Number(url.searchParams.get('limit') ?? 10)));
      const orders = db
        .table<OrderDto>('orders')
        .where((o) => o.merchantId === m && o.status === 'completed' && (o.completedAt ?? 0) >= fromTs && (o.completedAt ?? 0) <= toTs);
      const soldMap = new Map<string, { name: string; unitsSold: number; revenue: number; orders: number }>();
      orders.forEach((o) => {
        o.items.forEach((it) => {
          const cur = soldMap.get(it.productId) ?? { name: it.name, unitsSold: 0, revenue: 0, orders: 0 };
          cur.unitsSold += it.qty;
          cur.revenue += it.price * it.qty;
          cur.orders += 1;
          soldMap.set(it.productId, cur);
        });
      });
      const rows: ProductPerformance[] = [...soldMap.entries()].map(([productId, s]) => {
        const p = db.table<ProductRow>('products').find(productId);
        return {
          catalogueItemId: productId,
          name: s.name,
          unitsSold: s.unitsSold,
          revenueTZS: Math.round(s.revenue),
          ordersCount: s.orders,
          availabilityRate: p && p.visible && p.stock > 0 ? 1 : 0,
        };
      });
      rows.sort((a, b) => b.unitsSold - a.unitsSold);
      return ok({ top: rows.slice(0, limit), bottom: rows.slice(-limit).reverse() });
    }
    const days = Math.min(30, Number(url.searchParams.get('days') ?? 7));
    const cutoff = Date.now() - days * BI_DAY;
    const soldMap = new Map<string, { name: string; emoji: string; sold: number; revenue: number }>();
    db.table<OrderDto>('orders').where((o) => o.merchantId === m && o.status === 'completed' && (o.completedAt ?? 0) >= cutoff).forEach((o) => {
      o.items.forEach((it) => {
        const cur = soldMap.get(it.productId) ?? { name: it.name, emoji: it.emoji, sold: 0, revenue: 0 };
        cur.sold += it.qty;
        cur.revenue += it.price * it.qty;
        soldMap.set(it.productId, cur);
      });
    });
    const list = [...soldMap.values()].sort((a, b) => b.sold - a.sold).slice(0, 10);
    return ok({ dishes: list });
  }),

  h.get('/api/analytics/traffic', ({ request }) => {
    const session = requireSession(request);
    const url = new URL(request.url);
    const { from, to, fromTs, toTs } = biRange(url, 7);
    const m = session.merchantId;
    const orders = db
      .table<OrderDto>('orders')
      .where((o) => o.merchantId === m && o.status === 'completed' && (o.completedAt ?? 0) >= fromTs && (o.completedAt ?? 0) <= toTs);
    const direct = orders.filter((o) => o.deliveryType === 'delivery' || o.deliveryType === 'pickup').length;
    const dineInQr = db
      .table<DineInOrder>('dineInOrders')
      .where((b) => b.merchantId === m && (b.paidAt ?? 0) >= fromTs && (b.paidAt ?? 0) <= toTs).length;
    const gbIds = new Set(db.table('groupBuys').where((g: any) => g.merchantId === m).map((g: any) => g.id));
    const groupBuy = db
      .table('vouchers')
      .where((v: any) => gbIds.has(v.groupBuyId) && v.purchasedAt >= fromTs && v.purchasedAt <= toTs).length;
    const counts: Record<TrafficChannel['channel'], number> = {
      search: 0,
      category: 0,
      promotion: 0,
      group_buy: groupBuy,
      dine_in_qr: dineInQr,
      direct,
      referral: 0,
    };
    const totalOrders = Object.values(counts).reduce((s, c) => s + c, 0);
    const totalVisits = Math.max(1, Math.round(totalOrders / 0.11));
    const byChannel: TrafficChannel[] = (Object.keys(counts) as TrafficChannel['channel'][]).map((channel) => {
      const ordersIn = counts[channel];
      const visits = ordersIn ? Math.max(1, Math.round(ordersIn / 0.11)) : 0;
      return {
        channel,
        visits,
        orders: ordersIn,
        conversionRate: visits ? Math.round((ordersIn / visits) * 10000) / 10000 : 0,
      };
    });
    const analysis: TrafficAnalysis = {
      from,
      to,
      totals: { visits: totalVisits, orders: totalOrders, conversionRate: Math.round((totalOrders / totalVisits) * 10000) / 10000 },
      byChannel,
    };
    return ok(analysis);
  }),

  /* ---- Demand forecast (legacy mock-only shape). Deterministic and derived
   * from the seeded order history — the forecast never claims weather effects
   * and tips stay advisory-only (docs/AI-AUTOMATION.md). ---- */
  h.get('/api/analytics/forecast', ({ request }) => {
    const session = requireSession(request);
    const m = session.merchantId;
    const weekAgo = Date.now() - 7 * BI_DAY;
    const prevWeek = Date.now() - 14 * BI_DAY;
    const week = db.table<OrderDto>('orders').where((o) => o.merchantId === m && o.status === 'completed' && (o.completedAt ?? 0) >= weekAgo).length;
    const prev = db.table<OrderDto>('orders').where((o) => o.merchantId === m && o.status === 'completed' && (o.completedAt ?? 0) >= prevWeek && (o.completedAt ?? 0) < weekAgo).length;
    const delta = prev ? Math.round(((week - prev) / prev) * 100) : 0;
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
];

/* ================= Announcements ================= */

export const announcementHandlers = [
  h.get('/api/announcements', ({ request }) => {
    requireSession(request);
    return ok({
      announcements: [
        { id: 'an1', title: 'New: refund policy dashboard', body: 'See refund requests and dispute outcomes in one place under Orders.', ts: Date.now() - 3 * 86400000, read: true },
        { id: 'an2', title: 'Summer campaign slots closing', body: '"Summer Night BBQ Festival" closes Aug 16 — sign up under Store > Platform campaigns.', ts: Date.now() - 86400000, read: false },
        { id: 'an3', title: 'Settlement upgrades', body: 'Daily settlements now include VAT e-invoices automatically. Reconciliation is available in Finance.', ts: Date.now() - 3600000, read: false },
      ],
    });
  }),
];

/* ================= P6: Support ticket detail/reply + help center (contract
 * /support/tickets/{ticketId}, /support/tickets/{ticketId}/messages,
 * /help/articles — API-CONTRACT.yaml). The legacy SupportTicket store keeps its
 * shape (status open|replied|resolved + replies[]); responses map onto the
 * contract TicketDetail statuses (open|assigned|in_progress|resolved|closed). */

function toTicketDetail(t: SupportTicket): {
  id: string;
  subject: string;
  status: 'open' | 'assigned' | 'in_progress' | 'resolved' | 'closed';
  priority: 'low' | 'normal' | 'high' | 'critical';
  assignedAgentId: string | null;
  createdAt: number;
  updatedAt: number;
  messages: { id: string; authorRole: 'customer' | 'merchant' | 'provider' | 'rider' | 'agent'; body: string; createdAt: number }[];
} {
  const status = t.statusOverride ?? (t.status === 'open' ? 'open' : t.status === 'replied' ? 'in_progress' : 'resolved');
  return {
    id: t.id,
    subject: t.subject,
    status,
    priority: t.priority ?? 'normal',
    assignedAgentId: t.status === 'replied' || t.statusOverride === 'assigned' ? 'agent_demo' : null,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    messages: [
      { id: `${t.id}_opening`, authorRole: 'merchant' as const, body: t.body, createdAt: t.createdAt },
      ...t.replies.map((r): TicketMessage => ({ id: `${t.id}_${r.ts}`, authorRole: r.from === 'agent' ? 'agent' : 'merchant', body: r.text, createdAt: r.ts })),
    ],
  };
}

export const supportExtraHandlers = [
  /* ---- Drift-D alias: contract GET /support/tickets/me ≡ GET /support/tickets
   * (same list payload; docs/CONTRACT-ADDITIONS.md "Resolution status").
   * Registered before /support/tickets/:ticketId so MSW exact-first matching
   * routes "me" here. ---- */
  h.get('/api/support/tickets/me', ({ request }) => {
    const session = requireSession(request);
    const list = db.table<SupportTicket>('supportTickets').where((t) => t.merchantId === session.merchantId).sort((a, b) => b.updatedAt - a.updatedAt);
    return ok({ tickets: list });
  }),

  h.get('/api/support/tickets/:ticketId', ({ request, params }) => {
    const session = requireSession(request);
    const t = db.table<SupportTicket>('supportTickets').find(String(params.ticketId));
    if (!t || t.merchantId !== session.merchantId) throw new ApiHttpError(404, 'TICKET_NOT_FOUND', 'Ticket not found');
    return ok({ ticket: toTicketDetail(t) });
  }),

  h.post('/api/support/tickets/:ticketId/messages', async ({ request, params }) => {
    const session = requireSession(request);
    const t = db.table<SupportTicket>('supportTickets').find(String(params.ticketId));
    if (!t || t.merchantId !== session.merchantId) throw new ApiHttpError(404, 'TICKET_NOT_FOUND', 'Ticket not found');
    const body = await readJson(request);
    const text = String(body.body ?? '').trim();
    if (!text) throw new ApiHttpError(400, 'EMPTY_MESSAGE', 'Reply body cannot be empty');
    if (text.length > 4000) throw new ApiHttpError(400, 'MESSAGE_TOO_LONG', 'Reply body must be at most 4000 characters');
    const updated = db.table<SupportTicket>('supportTickets').update(t.id, {
      replies: [...t.replies, { from: 'merchant', text: text.slice(0, 4000), ts: Date.now() }],
      status: t.status === 'resolved' ? 'resolved' : 'replied',
      updatedAt: Date.now(),
    })!;
    audit(session.merchantId, session.staffId, session.role, 'support:reply', 'ticket', updated.id, 'replied on a support ticket');
    return json(201, { ticket: toTicketDetail(updated) });
  }),

  h.get('/api/help/articles', ({ request }) => {
    requireSession(request);
    const url = new URL(request.url);
    const q = (url.searchParams.get('q') ?? '').toLowerCase();
    const category = url.searchParams.get('category');
    let rows = db.table<HelpArticle>('helpArticles').all();
    if (category) rows = rows.filter((a) => a.category === category);
    if (q) rows = rows.filter((a) => a.title.toLowerCase().includes(q) || a.body.toLowerCase().includes(q));
    return raw(rows);
  }),
];
