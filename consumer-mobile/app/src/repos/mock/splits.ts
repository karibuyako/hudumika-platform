/* In-memory split-payments repository — POST /splits, GET /splits/{id},
 * POST /splits/{id}/pay, POST /splits/{id}/complete.
 *
 * Mock-only until the contract ships a split-payment resource
 * (docs/CONTRACT-ADDITIONS.md #22): one order, multiple payers; each share is
 * paid through its OWN payment intent. The registry is module-local (same
 * pattern as mock/groupOrders.ts — mockState.ts stays untouched) and seeds
 * one demo split (SEED_SPLIT_ID) so the split summary screen renders on
 * first load and the share link is deep-linkable.
 *
 * Honest scope (mock-first): only the PAYER side ships — the initiator
 * defines the shares and pays their own share through the normal intent
 * lifecycle (create → confirm → webhook). The OTHER payers' flow (they would
 * need the app too) is out of scope: the mock seeds their shares as
 * PRE-PAID (simulated payers) so the split can complete in the demo. When
 * the last share is paid the split is 'paid'; completeSplit confirms it and
 * settles the order (webhook — the full total is covered by the shares). */
import { ApiError } from '@/api/client';
import { uid } from '@/lib/format';
import { clone, findOrder, getState, nowIso, type MockIntent } from './mockState';
import { PaymentIntentStatus as S } from '@hudumika/contract';
import type { PaymentIntentCreateMethod } from '@hudumika/contract';
import type { SplitPaymentsRepository, SplitPlan, SplitShareStatus, SplitStatus } from '../index';

/** Module-local demo split id — the splits screen can be deep-linked/rendered
 * without creating anything first (mirrors mock/groupOrders.ts seed ids). */
export const SEED_SPLIT_ID = 'spl_seed_001';

interface StoredShare {
  id: string;
  label: string;
  amountTZS: number;
  status: SplitShareStatus;
}

interface StoredSplit {
  id: string;
  orderId: string;
  totalTZS: number;
  shares: StoredShare[];
  myShareId: string;
  status: SplitStatus;
  createdAt: string;
  /** Pending/paid intent for MY share (created by payMyShare — the payer's
   * share rides the normal intent lifecycle). */
  intentId?: string;
}

/** Module-local registry + per-key replays (resetMockState() covers mockState
 * only; tests call resetMockSplitPaymentsState() between cases, same pattern
 * as mock/groupOrders.ts). */
const splits = new Map<string, StoredSplit>();
const createReplays = new Map<string, StoredSplit>();
const payReplays = new Map<string, SplitPlan>();
const completeReplays = new Map<string, SplitPlan>();

export function resetMockSplitPaymentsState(): void {
  splits.clear();
  createReplays.clear();
  payReplays.clear();
  completeReplays.clear();
}

/** Module-local seed (mockState.ts stays untouched): one open demo split for
 * the seeded rush order (ord_rush_008, total 21,300 TZS) — three equal shares
 * of 7,100 TZS. MY share is pending; the two co-payer shares are PRE-PAID
 * (simulated payers — honest mock scope, see the header comment). Idempotent
 * across resetMockSplitPaymentsState(). */
function ensureSeeds(): void {
  if (splits.has(SEED_SPLIT_ID)) return;
  const state = getState();
  const order = state.orders.find((o) => o.id === 'ord_rush_008');
  if (!order) return;
  const total = order.totals.totalTZS;
  const base = Math.floor(total / 3);
  const remainder = total - base * 3;
  const mine = base + remainder;
  const myId = uid('share');
  splits.set(SEED_SPLIT_ID, {
    id: SEED_SPLIT_ID,
    orderId: order.id,
    totalTZS: total,
    shares: [
      { id: myId, label: state.user.fullName ?? 'You', amountTZS: mine, status: 'pending' },
      { id: uid('share'), label: 'Amina', amountTZS: base, status: 'paid' },
      { id: uid('share'), label: 'Juma', amountTZS: base, status: 'paid' },
    ],
    myShareId: myId,
    status: 'open',
    createdAt: nowIso(),
  });
}

function requireSplit(splitId: string): StoredSplit {
  const split = splits.get(splitId);
  if (!split) throw new ApiError(404, 'NOT_FOUND', `Split ${splitId} not found`);
  return split;
}

function toDto(split: StoredSplit): SplitPlan {
  return clone({
    id: split.id,
    orderId: split.orderId,
    totalTZS: split.totalTZS,
    shares: split.shares.map((s) => ({ id: s.id, label: s.label, amountTZS: s.amountTZS, status: s.status })),
    myShareId: split.myShareId,
    status: split.status,
    createdAt: split.createdAt,
  });
}

export class MockSplitPaymentsRepository implements SplitPaymentsRepository {
  async createSplit(input: { orderId: string; shares: { label: string; amountTZS: number }[] }, idempotencyKey: string): Promise<SplitPlan> {
    ensureSeeds();
    const replay = createReplays.get(idempotencyKey);
    if (replay) return toDto(replay);
    const order = findOrder(input.orderId);
    // One split per order — a second create (e.g. a retry after a network
    // failure) replays the existing plan instead of duplicating it.
    const existing = [...splits.values()].find((s) => s.orderId === order.id);
    if (existing) return toDto(existing);
    if (!Array.isArray(input.shares) || input.shares.length < 2) {
      throw new ApiError(422, 'VALIDATION_FAILED', 'A split needs at least two shares');
    }
    let sum = 0;
    for (const share of input.shares) {
      if (!share || typeof share.label !== 'string' || share.label.trim().length === 0) {
        throw new ApiError(422, 'VALIDATION_FAILED', 'Every share needs a label');
      }
      if (!Number.isInteger(share.amountTZS) || share.amountTZS < 1) {
        throw new ApiError(422, 'VALIDATION_FAILED', 'Every share amount must be an integer of at least 1 TZS');
      }
      sum += share.amountTZS;
    }
    if (sum !== order.totals.totalTZS) {
      throw new ApiError(422, 'VALIDATION_FAILED', 'Shares must sum exactly to the order total');
    }
    const shareIds = input.shares.map(() => uid('share'));
    const split: StoredSplit = {
      id: uid('spl'),
      orderId: order.id,
      totalTZS: order.totals.totalTZS,
      shares: input.shares.map((share, i) => ({
        id: shareIds[i],
        label: share.label.trim(),
        amountTZS: share.amountTZS,
        // The initiator's share is the FIRST share of the client-built list
        // (the checkout sheet always puts "You" first). Every other share is
        // seeded PRE-PAID — simulated payers: the co-payer flow needs the
        // app too and is out of mock scope (docs/CONTRACT-ADDITIONS.md #22).
        status: i === 0 ? 'pending' : 'paid',
      })),
      myShareId: shareIds[0],
      status: 'open',
      createdAt: nowIso(),
    };
    splits.set(split.id, split);
    createReplays.set(idempotencyKey, split);
    return toDto(split);
  }

  async getSplit(splitId: string): Promise<SplitPlan> {
    ensureSeeds();
    return toDto(requireSplit(splitId));
  }

  async payMyShare(splitId: string, method: PaymentIntentCreateMethod, idempotencyKey: string): Promise<SplitPlan> {
    ensureSeeds();
    const replay = payReplays.get(idempotencyKey);
    if (replay) return clone(replay);
    const split = requireSplit(splitId);
    const order = findOrder(split.orderId);
    // Mirror the existing intent guards (mock/payments.ts createIntent order
    // branch): a terminal non-payable order rejects the pay.
    if (order.status === 'cancelled' || order.status === 'refunded' || order.status === 'failed') {
      throw new ApiError(409, 'ORDER_NOT_PAYABLE', 'This order is no longer payable');
    }
    if (split.status === 'completed') throw new ApiError(409, 'CONFLICT', 'This split is already completed');
    const mine = split.shares.find((s) => s.id === split.myShareId);
    if (mine?.status === 'paid') throw new ApiError(409, 'CONFLICT', 'Your share is already paid');
    const state = getState();
    if (state.paymentFailure) {
      const failure = state.paymentFailure;
      state.paymentFailure = null;
      throw new ApiError(429, failure.code, 'Payment provider unreachable', true, { retryAfterSeconds: failure.retryAfterSeconds });
    }
    split.status = 'paying';
    // The payer's share rides the NORMAL intent lifecycle (create → confirm →
    // "webhook"): a real intent for the share amount lands in the payments
    // history and settling it flips the share to paid — same machinery as
    // checkout's createIntent/confirm, just scoped to the share amount.
    let intent = split.intentId ? state.intents.find((i) => i.id === split.intentId) : undefined;
    if (!intent) {
      intent = { id: uid('intent'), status: S.created, amountTZS: mine?.amountTZS ?? 0, method, orderId: split.orderId } satisfies MockIntent;
      state.intents.push(intent);
      split.intentId = intent.id;
    }
    if (intent.status !== S.paid) {
      intent.status = S.paid;
      intent.providerReference = `PR-${Math.floor(100000 + Math.random() * 900000)}-${method.toUpperCase()}`;
      intent.paidAt = nowIso();
    }
    // Mock "webhook": the settled intent marks MY share paid; when every
    // share is covered the split is fully paid (completeSplit confirms it).
    if (mine) mine.status = 'paid';
    if (split.shares.every((s) => s.status === 'paid')) split.status = 'paid';
    const dto = toDto(split);
    payReplays.set(idempotencyKey, dto);
    return clone(dto);
  }

  async completeSplit(splitId: string, idempotencyKey: string): Promise<SplitPlan> {
    ensureSeeds();
    const replay = completeReplays.get(idempotencyKey);
    if (replay) return clone(replay);
    const split = requireSplit(splitId);
    if (split.status === 'completed') return toDto(split);
    if (split.shares.some((s) => s.status !== 'paid')) {
      throw new ApiError(409, 'CONFLICT', 'Every share must be paid before the split completes');
    }
    split.status = 'completed';
    // Mock "webhook": the order settles when the split completes — the full
    // total is covered by the collected shares (mirrors the intent webhook
    // that flips the order when an intent settles).
    const order = findOrder(split.orderId);
    if (order.status === 'pending_payment' || order.status === 'draft') order.status = 'paid';
    const dto = toDto(split);
    completeReplays.set(idempotencyKey, dto);
    return clone(dto);
  }
}
