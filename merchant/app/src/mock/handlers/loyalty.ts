import { http } from 'msw';
import type {
  CustomerMembership,
  LoyaltyMember,
  LoyaltyMemberListItem,
  LoyaltyTransaction,
  MembershipTier,
  TopUpPaymentMethod,
  TopUpResult,
} from '@/api/types';
import { db, uid } from '@/mock/db';
import { emit } from '@/mock/events';
import { ApiHttpError, audit, json, maskPhone, ok, requirePerm, requireSession } from '@/mock/security';
import { h, idemGet, idemSet, readJson } from '@/mock/handlers/common';

const BASE = typeof location !== 'undefined' ? location.origin : 'http://localhost';

/** PUT wrapper — same error filter as the shared `h` helpers in handlers/common.ts. */
function put(
  path: string,
  fn: (args: { request: Request; params: Record<string, string> }) => Promise<Response> | Response,
) {
  return http.put(`${BASE}${path}`, async (info) => {
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

const TOP_UP_METHODS: readonly TopUpPaymentMethod[] = ['mpesa', 'tigo_pesa', 'airtel_money', 'card', 'cash'];
const PHONE_RE = /^\+?\d{9,15}$/;
const BIRTHDAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** PII mask for member list views: +2557… */
function maskMemberPhone(phone: string): string {
  return /^\+255\d+$/.test(phone) ? `+255${phone.slice(4, 5)}…` : maskPhone(phone);
}

function normalizePhone(phone: string): string {
  return phone.replace(/[\s-]/g, '');
}

function memberRows(merchantId: string): LoyaltyMember[] {
  return db.table<LoyaltyMember>('members').where((m) => m.merchantId === merchantId);
}

function findMember(merchantId: string, id: string): LoyaltyMember {
  const m = db.table<LoyaltyMember>('members').find(id);
  if (!m || m.merchantId !== merchantId) throw new ApiHttpError(404, 'MEMBER_NOT_FOUND', 'Member not found');
  return m;
}

function tierOf(merchantId: string, tierId: string | null): MembershipTier | null {
  if (!tierId) return null;
  const t = db.table<MembershipTier>('membershipTiers').find(tierId);
  return t && t.merchantId === merchantId ? t : null;
}

function sortedTiers(merchantId: string): MembershipTier[] {
  return db
    .table<MembershipTier>('membershipTiers')
    .where((t) => t.merchantId === merchantId)
    .sort((a, b) => a.thresholdTZS - b.thresholdTZS);
}

function toListItem(m: LoyaltyMember): LoyaltyMemberListItem {
  return {
    id: m.id,
    name: m.name,
    maskedPhone: m.maskedPhone,
    balanceTZS: m.balanceTZS,
    tierId: m.tierId,
    tierName: tierOf(m.merchantId, m.tierId)?.name ?? null,
    totalSpendTZS: m.totalSpendTZS,
    joinedAt: m.joinedAt,
  };
}

function memberDetail(m: LoyaltyMember): LoyaltyMember {
  return { ...m, tier: tierOf(m.merchantId, m.tierId) };
}

/** Entry tier = lowest threshold; null when no tiers configured. */
function entryTierId(merchantId: string): string | null {
  const tiers = sortedTiers(merchantId);
  return tiers.length ? tiers[0].id : null;
}

/** Append-only member balance ledger (not exposed — balanceTZS is the projection). */
function ledgerEntry(merchantId: string, memberId: string, type: 'top_up' | 'bonus' | 'redeem', amountTZS: number, balanceTZS: number) {
  db.table('loyaltyTransactions').insert({
    id: uid('ltx'),
    merchantId,
    memberId,
    type,
    amountTZS,
    balanceTZS,
    ts: Date.now(),
  });
}

/** Promote when totalSpendTZS crosses a higher tier threshold (never demote). */
function promoteIfEligible(m: LoyaltyMember): { member: LoyaltyMember; previousTierId: string | null } {
  const previousTierId = m.tierId;
  const tiers = sortedTiers(m.merchantId);
  const currentIdx = tiers.findIndex((t) => t.id === m.tierId);
  let best = m.tierId;
  for (let i = Math.max(currentIdx, 0); i < tiers.length; i++) {
    if (m.totalSpendTZS >= tiers[i].thresholdTZS) best = tiers[i].id;
  }
  if (best === previousTierId) return { member: m, previousTierId };
  const updated = db.table<LoyaltyMember>('members').update(m.id, { tierId: best, updatedAt: Date.now() })!;
  emit({ type: 'loyalty.tier_changed', member: memberDetail(updated), previousTierId, at: Date.now() });
  return { member: updated, previousTierId };
}

export const loyaltyHandlers = [
  /* ---- Member list (phone/name lookup via ?search=) ---- */
  h.get('/api/members', ({ request }) => {
    const session = requireSession(request);
    const url = new URL(request.url);
    const search = (url.searchParams.get('search') ?? '').trim().toLowerCase();
    let rows = memberRows(session.merchantId);
    if (search) {
      rows = rows.filter((m) => m.name.toLowerCase().includes(search) || m.phone.replace(/[\s-]/g, '').includes(search));
    }
    rows = rows.sort((a, b) => b.joinedAt - a.joinedAt);
    return ok({ members: rows.map(toListItem) });
  }),

  /* ---- Register a member ---- */
  h.post('/api/members', async ({ request }) => {
    const session = requireSession(request);
    requirePerm(session, 'redemption');
    const body = await readJson(request);
    const name = String(body.name ?? '').trim();
    if (!name) throw new ApiHttpError(400, 'NAME_REQUIRED', 'Member name is required');
    if (name.length > 120) throw new ApiHttpError(400, 'INVALID_NAME', 'Name must be at most 120 characters');
    const phone = normalizePhone(String(body.phone ?? ''));
    if (!PHONE_RE.test(phone)) throw new ApiHttpError(400, 'PHONE_REQUIRED', 'A valid phone number is required');
    if (memberRows(session.merchantId).some((m) => m.phone === phone)) {
      throw new ApiHttpError(409, 'MEMBER_PHONE_EXISTS', 'A member with this phone is already registered');
    }
    const birthday = body.birthday === undefined ? undefined : String(body.birthday);
    if (birthday !== undefined && !BIRTHDAY_RE.test(birthday)) {
      throw new ApiHttpError(400, 'INVALID_BIRTHDAY', 'Birthday must be YYYY-MM-DD');
    }
    const now = Date.now();
    const member: LoyaltyMember = {
      id: uid('m'),
      merchantId: session.merchantId,
      name,
      phone,
      maskedPhone: maskMemberPhone(phone),
      birthday,
      balanceTZS: 0,
      tierId: entryTierId(session.merchantId),
      tier: null,
      totalSpendTZS: 0,
      joinedAt: now,
      createdAt: now,
      updatedAt: now,
    };
    db.table<LoyaltyMember>('members').insert(member);
    emit({ type: 'loyalty.member_registered', member: memberDetail(member), at: now });
    audit(session.merchantId, session.staffId, session.role, 'loyalty:register', 'member', member.id, `registered "${member.name}"`);
    return json(201, { member: memberDetail(member) });
  }),

  /* ---- Member detail ---- */
  h.get('/api/members/:memberId', ({ request, params }) => {
    const session = requireSession(request);
    const member = findMember(session.merchantId, String(params.memberId));
    return ok({ member: memberDetail(member) });
  }),

  /* ---- Update member profile ---- */
  h.patch('/api/members/:memberId', async ({ request, params }) => {
    const session = requireSession(request);
    requirePerm(session, 'redemption');
    const member = findMember(session.merchantId, String(params.memberId));
    const body = await readJson(request);
    const patch: Partial<LoyaltyMember> = { updatedAt: Date.now() };
    if (body.name !== undefined) {
      const name = String(body.name).trim();
      if (!name) throw new ApiHttpError(400, 'NAME_REQUIRED', 'Member name is required');
      if (name.length > 120) throw new ApiHttpError(400, 'INVALID_NAME', 'Name must be at most 120 characters');
      patch.name = name;
    }
    if (body.phone !== undefined) {
      const phone = normalizePhone(String(body.phone));
      if (!PHONE_RE.test(phone)) throw new ApiHttpError(400, 'PHONE_REQUIRED', 'A valid phone number is required');
      if (phone !== member.phone && memberRows(session.merchantId).some((m) => m.phone === phone)) {
        throw new ApiHttpError(409, 'MEMBER_PHONE_EXISTS', 'A member with this phone is already registered');
      }
      patch.phone = phone;
      patch.maskedPhone = maskMemberPhone(phone);
    }
    if (body.birthday !== undefined) {
      const birthday = body.birthday === null ? undefined : String(body.birthday);
      if (birthday !== undefined && !BIRTHDAY_RE.test(birthday)) {
        throw new ApiHttpError(400, 'INVALID_BIRTHDAY', 'Birthday must be YYYY-MM-DD');
      }
      patch.birthday = birthday;
    }
    const updated = db.table<LoyaltyMember>('members').update(member.id, patch)!;
    audit(session.merchantId, session.staffId, session.role, 'loyalty:update', 'member', member.id, `updated "${updated.name}"`);
    return ok({ member: memberDetail(updated) });
  }),

  /* ---- Top-up: credit amount + tier bonus ---- */
  h.post('/api/members/:memberId/top-up', async ({ request, params }) => {
    const session = requireSession(request);
    requirePerm(session, 'redemption');
    const idem = request.headers.get('idempotency-key');
    const cached = idem ? idemGet('loyalty:topup', idem) : undefined;
    if (cached) return ok({ topUp: cached });
    const member = findMember(session.merchantId, String(params.memberId));
    const body = await readJson(request);
    const amountTZS = Number(body.amountTZS);
    if (!Number.isInteger(amountTZS) || amountTZS <= 0) {
      throw new ApiHttpError(400, 'INVALID_AMOUNT', 'amountTZS must be a positive integer');
    }
    const rawMethod = body.paymentMethod === undefined ? 'cash' : String(body.paymentMethod);
    if (!TOP_UP_METHODS.includes(rawMethod as TopUpPaymentMethod)) {
      throw new ApiHttpError(400, 'INVALID_PAYMENT_METHOD', 'paymentMethod must be one of: mpesa, tigo_pesa, airtel_money, card, cash');
    }
    const paymentMethod = rawMethod as TopUpPaymentMethod;
    const tier = tierOf(session.merchantId, member.tierId);
    if (tier && amountTZS < tier.thresholdTZS) {
      throw new ApiHttpError(422, 'TOP_UP_BELOW_THRESHOLD', `Top-ups of ${tier.thresholdTZS.toLocaleString('en-US')} TZS or more earn a bonus`, false, {
        thresholdTZS: tier.thresholdTZS,
        tierName: tier.name,
        gapTZS: tier.thresholdTZS - amountTZS,
      });
    }
    // Integer bps math only — no floats: floor(amount * rate / 10000).
    const bonusTZS = tier ? Math.floor((amountTZS * tier.bonusRateBps) / 10000) : 0;
    const now = Date.now();
    const balanceTZS = member.balanceTZS + amountTZS + bonusTZS;
    const totalSpendTZS = member.totalSpendTZS + amountTZS;
    const credited = db.table<LoyaltyMember>('members').update(member.id, { balanceTZS, totalSpendTZS, updatedAt: now })!;
    ledgerEntry(session.merchantId, member.id, 'top_up', amountTZS, balanceTZS);
    if (bonusTZS > 0) ledgerEntry(session.merchantId, member.id, 'bonus', bonusTZS, balanceTZS);
    const { member: promoted } = promoteIfEligible(credited);
    const topUp: TopUpResult = {
      id: uid('tu'),
      memberId: member.id,
      amountTZS,
      bonusTZS,
      totalTZS: amountTZS + bonusTZS,
      paymentMethod,
      member: memberDetail(promoted),
      ts: now,
    };
    emit({ type: 'loyalty.topup_credited', member: memberDetail(promoted), topUp, at: now });
    audit(session.merchantId, session.staffId, session.role, 'loyalty:topup', 'member', member.id, `credited ${amountTZS} TZS + ${bonusTZS} TZS bonus via ${paymentMethod}`);
    if (idem) idemSet('loyalty:topup', idem, topUp);
    return ok({ topUp });
  }),

  /* ---- Redeem / spend against the member balance (contract gap).
   * MEMBERSHIP-LOYALTY.md:56: "Spending/redeeming against a member balance
   * uses the same ledger; insufficient balance -> MEMBER_INSUFFICIENT_BALANCE."
   * The yaml has no POST /members/{memberId}/redeem — implemented as the
   * top-up inverse (debit + append-only ledger `redeem` entry). ---- */
  h.post('/api/members/:memberId/redeem', async ({ request, params }) => {
    const session = requireSession(request);
    requirePerm(session, 'redemption');
    const member = findMember(session.merchantId, String(params.memberId));
    const body = await readJson(request);
    const amountTZS = Number(body.amountTZS);
    if (!Number.isInteger(amountTZS) || amountTZS <= 0) {
      throw new ApiHttpError(400, 'INVALID_AMOUNT', 'amountTZS must be a positive integer');
    }
    if (member.balanceTZS < amountTZS) {
      throw new ApiHttpError(409, 'MEMBER_INSUFFICIENT_BALANCE', `Member balance is ${member.balanceTZS.toLocaleString('en-US')} TZS — below the ${amountTZS.toLocaleString('en-US')} TZS redemption`, false, {
        balanceTZS: member.balanceTZS,
        requestedTZS: amountTZS,
        gapTZS: amountTZS - member.balanceTZS,
      });
    }
    const now = Date.now();
    const balanceTZS = member.balanceTZS - amountTZS;
    const updated = db.table<LoyaltyMember>('members').update(member.id, { balanceTZS, updatedAt: now })!;
    ledgerEntry(session.merchantId, member.id, 'redeem', amountTZS, balanceTZS);
    emit({ type: 'loyalty.redeemed', member: memberDetail(updated), amountTZS, balanceTZS, at: now });
    audit(session.merchantId, session.staffId, session.role, 'loyalty:redeem', 'member', member.id, `redeemed ${amountTZS} TZS from the member balance`);
    return ok({ member: memberDetail(updated), amountTZS, balanceTZS });
  }),

  /* ---- Tier config: GET ---- */
  h.get('/api/membership-tiers', ({ request }) => {
    const session = requireSession(request);
    return ok({ tiers: sortedTiers(session.merchantId) });
  }),

  /* ---- Tier config: PUT (replace; server validates) ---- */
  put('/api/membership-tiers', async ({ request }) => {
    const session = requireSession(request);
    requirePerm(session, 'store:manage');
    const body = await readJson(request);
    const raw = body.tiers;
    if (!Array.isArray(raw) || raw.length === 0) {
      throw new ApiHttpError(422, 'INVALID_TIER_CONFIG', 'At least one tier is required');
    }
    // Contract body also carries optional topUpRewards: [{thresholdTZS, bonusTZS}]
    // — integer TZS validation only; the cashier screen reads it back via the
    // loyalty-transactions ledger, so the config is persisted for reference.
    const topUpRewards = Array.isArray(body.topUpRewards) ? (body.topUpRewards as { thresholdTZS?: unknown; bonusTZS?: unknown }[]) : [];
    for (const r of topUpRewards) {
      const thresholdTZS = Number(r.thresholdTZS);
      const bonusTZS = Number(r.bonusTZS);
      if (!Number.isInteger(thresholdTZS) || thresholdTZS < 1 || !Number.isInteger(bonusTZS) || bonusTZS < 0) {
        throw new ApiHttpError(422, 'INVALID_TIER_CONFIG', 'topUpRewards entries need integer thresholdTZS >= 1 and bonusTZS >= 0');
      }
    }
    const rewardsTable = db.table<{ id: string; merchantId: string; rewards: { thresholdTZS: number; bonusTZS: number }[] }>('topUpRewards');
    const existingRewards = rewardsTable.find(session.merchantId);
    if (existingRewards) {
      rewardsTable.update(session.merchantId, { rewards: topUpRewards as { thresholdTZS: number; bonusTZS: number }[] });
    } else {
      rewardsTable.insert({ id: session.merchantId, merchantId: session.merchantId, rewards: topUpRewards as { thresholdTZS: number; bonusTZS: number }[] });
    }
    const tiers: MembershipTier[] = [];
    const seen = new Set<string>();
    for (const r of raw) {
      const row = r as Record<string, unknown>;
      const name = String(row.name ?? '').trim();
      const thresholdTZS = Number(row.thresholdTZS);
      const bonusRateBps = Number(row.bonusRateBps);
      const discountBps = row.discountBps === undefined || row.discountBps === null ? undefined : Number(row.discountBps);
      const benefits = Array.isArray(row.benefits) ? (row.benefits as unknown[]).map((b) => String(b).trim()).filter(Boolean) : [];
      const key = name.toLowerCase();
      if (!name || name.length > 40 || seen.has(key)) {
        throw new ApiHttpError(422, 'INVALID_TIER_CONFIG', 'Each tier needs a unique name (max 40 characters)');
      }
      if (!Number.isInteger(thresholdTZS) || thresholdTZS < 1) {
        throw new ApiHttpError(422, 'INVALID_TIER_CONFIG', 'Tier thresholdTZS must be a positive integer');
      }
      if (!Number.isInteger(bonusRateBps) || bonusRateBps < 0 || bonusRateBps > 10000) {
        throw new ApiHttpError(422, 'INVALID_TIER_CONFIG', 'Tier bonusRateBps must be an integer between 0 and 10000');
      }
      if (discountBps !== undefined && (!Number.isInteger(discountBps) || discountBps < 0 || discountBps > 10000)) {
        throw new ApiHttpError(422, 'INVALID_TIER_CONFIG', 'Tier discountBps must be an integer between 0 and 10000');
      }
      seen.add(key);
      tiers.push({ id: uid('tier'), merchantId: session.merchantId, name, thresholdTZS, bonusRateBps, ...(discountBps !== undefined ? { discountBps } : {}), benefits });
    }
    const table = db.table<MembershipTier>('membershipTiers');
    table.where((t) => t.merchantId === session.merchantId).forEach((t) => table.remove(t.id));
    table.insertMany(tiers);
    // Re-assign members of deleted tiers to the new entry tier (docs: TIER_NOT_FOUND -> re-assignment).
    const entry = entryTierId(session.merchantId);
    for (const m of memberRows(session.merchantId)) {
      if (m.tierId && !tierOf(session.merchantId, m.tierId)) {
        db.table<LoyaltyMember>('members').update(m.id, { tierId: entry, updatedAt: Date.now() });
      }
    }
    audit(session.merchantId, session.staffId, session.role, 'loyalty:tiers:update', 'tiers', 'config', `replaced tier config (${tiers.length} tiers)`);
    return ok({ tiers });
  }),

  /* ---- Loyalty points ledger (GET /loyalty-transactions, contract) ----
   * Contract shape: bare array of {id, type, points (signed), balance,
   * reference?, at}, newest first. The internal top-up ledger stays separate
   * (loyaltyTransactions); this is the merchant view of the points ledger. */
  h.get('/api/loyalty-transactions', ({ request }) => {
    const session = requireSession(request);
    const url = new URL(request.url);
    const rawLimit = Number(url.searchParams.get('limit') ?? 50);
    const limit = Math.min(Math.max(Number.isInteger(rawLimit) ? rawLimit : 50, 1), 200);
    const rows = db
      .table<LoyaltyTransaction & { merchantId: string }>('loyaltyPointsLedger')
      .where((tx) => tx.merchantId === session.merchantId)
      .sort((a, b) => b.at - a.at)
      .slice(0, limit);
    return ok(rows.map(({ merchantId: _m, ...tx }) => tx));
  }),

  /* ---- Customer membership (GET /memberships/me, customer-side mock) ---- */
  h.get('/api/memberships/me', ({ request }) => {
    requireSession(request);
    const membership: CustomerMembership = {
      points: 320,
      level: 'gold',
      memberSince: '2024-03-12',
      benefits: ['Free delivery', 'Birthday bonus', 'Birthday bonus points'],
    };
    return ok(membership);
  }),
];
