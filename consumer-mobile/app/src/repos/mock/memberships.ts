/* In-memory memberships repository — GET /memberships/me, POST /check-in,
 * GET /loyalty-transactions, POST /loyalty/redemptions (mock-only path until
 * the contract ships the redemption mutation — docs/CONTRACT-ADDITIONS.md
 * #16).
 *
 * Check-in and the points ledger are module-local (mockState is shared seed
 * data owned by the app; this module owns the demo customer's daily
 * check-in state and ledger). resetMockState() re-seeds membership.points,
 * so tests pair it with resetMockMembershipsState() to re-seed this module.
 *
 * Streak rule (server-authoritative): consecutive UTC calendar days grow the
 * streak; a gap resets it to 1; checking in twice the same day is a 409
 * ConflictResponse (the contract defines no CHECK_IN_* code — ERROR-CODES.md
 * `CONFLICT` is the 409 contract code).
 *
 * Redemption (mock-only path POST /loyalty/redemptions — parity harness
 * allow-list): validates the reward against REDEMPTION_CATALOG and the
 * integer points cost (422 VALIDATION_FAILED), the balance (422
 * MEMBER_INSUFFICIENT_BALANCE — the Loyalty section code in
 * backend/ERROR-CODES.md), debits membership.points, appends a signed
 * `redeem` ledger row (the contract ListLoyaltyTransactions200ItemType
 * enum HAS a `redeem` value), and — for wallet-credit rewards only —
 * credits the wallet balance + appends a WalletTransaction exactly like
 * mock/wallet.ts topUp (contract type 'adjustment', referenceType
 * 'points_redeem' — the contract WalletTransactionType has no topup/redeem
 * value, so the row uses 'adjustment' contract-first). Idempotent per key:
 * the same key replays the SAME redemption, never a double debit.
 */
import { ApiError } from '@/api/client';
import { uid } from '@/lib/format';
import { clone, getState, nowIso } from './mockState';
import { REDEMPTION_CATALOG } from '../index';
import type { MembershipsRepository, RedeemPointsInput, RedemptionReward } from '../index';
import type { CustomerMembership, DailyCheckIn200, ListLoyaltyTransactions200Item, OrderDetail, Review } from '@hudumika/contract';
import { ListLoyaltyTransactions200ItemType, OrderStatus } from '@hudumika/contract';

const DAY_MS = 86_400_000;
const BASE_CHECK_IN_POINTS = 10;
const WEEKLY_STREAK_BONUS = 10;

interface CheckInState {
  lastCheckInAt: string | null;
  streakDays: number;
}

let checkInState: CheckInState = { lastCheckInAt: null, streakDays: 0 };
let ledger: ListLoyaltyTransactions200Item[] | null = null;

/** Per-idempotency-key replay ledger: same key → same redemption (the mock
 * is the server — a retried POST must never double-debit). */
const redemptionByIdempotencyKey = new Map<string, CustomerMembership>();

/** Per-order / per-review awards the accrual engine recorded this session
 * (orderId/reviewId → points). Backs the MembershipsRepository.earningsFor /
 * earningsForReview mock-only getters (docs/CONTRACT-ADDITIONS.md #28) that
 * the order-detail and review-success earn pills render from. */
const orderEarnings = new Map<string, number>();
const reviewEarnings = new Map<string, number>();

function dayKey(iso: string): string {
  const d = new Date(iso);
  return `${d.getUTCFullYear()}-${d.getUTCMonth() + 1}-${d.getUTCDate()}`;
}

const daysAgoIso = (days: number) => new Date(Date.now() - days * DAY_MS).toISOString();

/** Seeded ledger ending at the current membership balance. The top row is a
 * check-in from yesterday, so a fresh session can check in again today. */
function buildLedger(): ListLoyaltyTransactions200Item[] {
  const balance = getState().membership.points;
  return [
    { id: 'lt_0004', type: ListLoyaltyTransactions200ItemType.check_in, points: 10, balance, reference: null, at: daysAgoIso(1) },
    { id: 'lt_0003', type: ListLoyaltyTransactions200ItemType.earn, points: 50, balance: balance - 10, reference: 'order HD-OR-478901', at: daysAgoIso(2) },
    { id: 'lt_0002', type: ListLoyaltyTransactions200ItemType.bonus, points: 20, balance: balance - 60, reference: 'birthday bonus', at: daysAgoIso(6) },
    { id: 'lt_0001', type: ListLoyaltyTransactions200ItemType.redeem, points: -30, balance: balance - 80, reference: 'voucher', at: daysAgoIso(10) },
    { id: 'lt_0000', type: ListLoyaltyTransactions200ItemType.earn, points: 50, balance: balance - 50, reference: 'order HD-OR-475903', at: daysAgoIso(15) },
  ];
}

function ensureSeeded(): void {
  if (ledger !== null) return;
  ledger = buildLedger();
  // The seeded ledger's newest row is yesterday's check-in → streak of 1.
  checkInState = { lastCheckInAt: daysAgoIso(1), streakDays: 1 };
  // Seed one order-accrual record so the "You earned X points" pill on
  // completed orders is exercisable in the demo (ord_completed_004 total is
  // 27,300 → 27 pts; the ledger row already reflects a prior earn entry).
  orderEarnings.set('ord_completed_004', Math.floor(27300 / 1000));
}

export function resetMockMembershipsState(): void {
  ledger = null;
  checkInState = { lastCheckInAt: null, streakDays: 0 };
  redemptionByIdempotencyKey.clear();
  orderEarnings.clear();
  reviewEarnings.clear();
}

/** Dev/test-only: seed the daily check-in state (mock-only extension). */
export function setMockCheckInState(lastCheckInAt: string | null, streakDays: number): void {
  ensureSeeded();
  checkInState = { lastCheckInAt, streakDays };
}

/* ---------------- Points accrual engine (P6d, mock-first) ----------------
 *
 * MASTER-BLUEPRINT §17: points accrue on spend (orders) and engagement
 * (reviews). The mock IS the server — the orders mock calls earnOrderPoints
 * when an order reaches paid (on create for COD orders, mock/orders.ts) and
 * the reviews mock calls earnReviewPoints when a review is created
 * (mock/reviews.ts); a live backend awards at the same rule points. Every
 * award appends an `earn` ledger row (the contract
 * ListLoyaltyTransactions200ItemType HAS an `earn` value) and increments
 * membership.points. Accrual is idempotent per order/review (a replay never
 * double-awards) and the per-order/per-review maps feed the earningsFor /
 * earningsForReview mock-only getters (docs/CONTRACT-ADDITIONS.md #28). */

/** Accrual rule: 1 point per TZS 1,000 of the order total (integer floor). */
export const EARN_POINTS_PER_1000_TZS = 1;
/** Accrual rule: 50 points per published review. */
export const REVIEW_EARN_POINTS = 50;

/** An order accrues spend points from `paid` onward — never for unpaid or
 * money-held statuses (pending_payment, cancelled, refunded, failed,
 * disputed). */
const ORDER_ACCRUAL_ELIGIBLE: OrderStatus[] = [
  OrderStatus.paid,
  OrderStatus.merchant_accepted,
  OrderStatus.preparing,
  OrderStatus.rider_assigned,
  OrderStatus.picked_up,
  OrderStatus.delivering,
  OrderStatus.delivered,
  OrderStatus.completed,
];

/** Award spend points for an order that reached paid+: floor(totalTZS / 1000)
 * points. Appends an `earn` ledger row and increments membership.points;
 * records the award per order id. Idempotent per order (the same order
 * replays the same award). Orders below TZS 1,000 earn 0 points — no ledger
 * row, no record. */
export function earnOrderPoints(order: OrderDetail, membership: CustomerMembership): number {
  ensureSeeded();
  const recorded = orderEarnings.get(order.id);
  if (recorded !== undefined) return recorded;
  if (!ORDER_ACCRUAL_ELIGIBLE.includes(order.status)) return 0;
  const points = Math.floor(order.totals.totalTZS / 1000);
  if (points < 1) return 0;
  membership.points += points;
  ledger!.unshift({
    id: uid('lt'),
    type: ListLoyaltyTransactions200ItemType.earn,
    points,
    balance: membership.points,
    reference: `order ${order.no ?? order.id}`,
    at: nowIso(),
  });
  orderEarnings.set(order.id, points);
  return points;
}

/** Award engagement points for a review: REVIEW_EARN_POINTS per review.
 * Appends an `earn` ledger row and increments membership.points; records the
 * award per review id. Idempotent per review. The mock awards at create (the
 * demo has no moderation transition — REVIEWS.md pending → published is a
 * live-backend concern; the rule point is "published"). */
export function earnReviewPoints(review: Review): number {
  ensureSeeded();
  const recorded = reviewEarnings.get(review.id);
  if (recorded !== undefined) return recorded;
  const state = getState();
  state.membership.points += REVIEW_EARN_POINTS;
  ledger!.unshift({
    id: uid('lt'),
    type: ListLoyaltyTransactions200ItemType.earn,
    points: REVIEW_EARN_POINTS,
    balance: state.membership.points,
    reference: `review ${review.id}`,
    at: nowIso(),
  });
  reviewEarnings.set(review.id, REVIEW_EARN_POINTS);
  return REVIEW_EARN_POINTS;
}

export class MockMembershipsRepository implements MembershipsRepository {
  async get(): Promise<CustomerMembership> {
    return clone(getState().membership);
  }

  async checkIn(_idempotencyKey: string): Promise<DailyCheckIn200> {
    ensureSeeded();
    const state = getState();
    const now = nowIso();
    const today = dayKey(now);
    if (checkInState.lastCheckInAt && dayKey(checkInState.lastCheckInAt) === today) {
      throw new ApiError(409, 'CONFLICT', 'You have already checked in today');
    }
    const streakDays =
      checkInState.lastCheckInAt && dayKey(checkInState.lastCheckInAt) === dayKey(daysAgoIso(1))
        ? checkInState.streakDays + 1
        : 1;
    const bonusPoints = streakDays % 7 === 0 ? WEEKLY_STREAK_BONUS : 0;
    const pointsEarned = BASE_CHECK_IN_POINTS + bonusPoints;
    state.membership.points += pointsEarned;
    checkInState = { lastCheckInAt: now, streakDays };
    ledger!.unshift({
      id: uid('lt'),
      type: ListLoyaltyTransactions200ItemType.check_in,
      points: pointsEarned,
      balance: state.membership.points,
      reference: null,
      at: now,
    });
    return { pointsEarned, streakDays, ...(bonusPoints ? { bonusPoints } : {}) };
  }

  async listLoyaltyTransactions(params?: { cursor?: string; limit?: number }): Promise<ListLoyaltyTransactions200Item[]> {
    ensureSeeded();
    const offset = params?.cursor ? Number(params.cursor) : 0;
    const limit = params?.limit ?? 50;
    return clone(ledger!.slice(offset, offset + limit));
  }

  async getRedemptionCatalog(): Promise<RedemptionReward[]> {
    return clone(REDEMPTION_CATALOG);
  }

  /** Mock-only until the contract carries per-order earnings on the loyalty
   * surface (docs/CONTRACT-ADDITIONS.md #28): the live repo returns null. The
   * order-detail earn pill renders on this (delivered/completed orders). */
  async earningsFor(orderId: string): Promise<{ points: number } | null> {
    ensureSeeded();
    const points = orderEarnings.get(orderId);
    return points === undefined ? null : { points };
  }

  /** Mock-only until the contract carries per-review earnings
   * (docs/CONTRACT-ADDITIONS.md #28): the live repo returns null. The review
   * success pill renders on this. */
  async earningsForReview(reviewId: string): Promise<{ points: number } | null> {
    const points = reviewEarnings.get(reviewId);
    return points === undefined ? null : { points };
  }

  async redeemPoints(input: RedeemPointsInput, idempotencyKey: string): Promise<CustomerMembership> {
    ensureSeeded();
    const replay = redemptionByIdempotencyKey.get(idempotencyKey);
    if (replay) return clone(replay);
    const reward = REDEMPTION_CATALOG.find((r) => r.reward === input.reward);
    if (!reward) {
      throw new ApiError(422, 'VALIDATION_FAILED', `Unknown reward ${input.reward}`);
    }
    if (!Number.isInteger(input.points) || input.points < 1 || input.points !== reward.points) {
      throw new ApiError(422, 'VALIDATION_FAILED', `Redemption cost must match the ${reward.reward} reward (${reward.points} points)`);
    }
    const state = getState();
    if (input.points > state.membership.points) {
      throw new ApiError(422, 'MEMBER_INSUFFICIENT_BALANCE', 'You do not have enough points for this reward');
    }
    state.membership.points -= input.points;
    const row: ListLoyaltyTransactions200Item = {
      id: uid('lt'),
      type: ListLoyaltyTransactions200ItemType.redeem,
      points: -input.points,
      balance: state.membership.points,
      reference: reward.reward,
      at: nowIso(),
    };
    ledger!.unshift(row);
    if (reward.valueTZS !== null) {
      state.wallet.totalTZS += reward.valueTZS;
      state.wallet.withdrawableTZS += reward.valueTZS;
      state.walletTransactions.unshift({
        id: uid('wtx'),
        type: 'adjustment',
        amountTZS: reward.valueTZS,
        balanceTZS: state.wallet.totalTZS,
        referenceType: 'points_redeem',
        referenceId: row.id,
        createdAt: nowIso(),
      });
    }
    const result = clone(state.membership);
    redemptionByIdempotencyKey.set(idempotencyKey, result);
    return result;
  }
}
