/* In-memory dine-in repository — GET /dine-in/tables/{tableId}/qr,
 * GET /dine-in/orders/me, GET /dine-in/orders/{id}, POST /dine-in/orders
 * from a table QR payload (P6b surface), plus the mock-only split-bill
 * surface (POST/GET /dine-in/orders/{id}/splits — splitBill / getSplit /
 * payMyShare). The table → merchant registry lives in mockState
 * (server-side); the app never guesses the merchant from the id.
 *
 * Split-bill (docs/CONTRACT-ADDITIONS.md #25, mock-first): ONE bill, multiple
 * diners; the initiator defines the shares and pays their own share. The
 * split registry is module-local (same pattern as mock/splits.ts — mockState
 * stays untouched). Honest scope: only the PAYER side ships — the co-diners'
 * flow needs the app too, so the mock SIMULATES their shares as PRE-PAID. My
 * share is pending; payMyShare runs the intent lifecycle scoped to MY share
 * amount (create → confirm → "webhook", same machinery as mock/splits.ts),
 * and when every share is covered the split completes and the bill settles
 * (webhook — the full total is covered by the collected shares). */
import { ApiError } from '@/api/client';
import { uid } from '@/lib/format';
import { clone, getState, nowIso, type MockIntent } from './mockState';
import { PaymentIntentStatus as S } from '@hudumika/contract';
import type { DineInRepository, DineInSplit, DineInSplitStatus, DineInTableQrContext } from '../index';
import type { DineInOrder } from '@hudumika/contract';

const OPEN_STATUSES = ['open', 'billing'];

function findTable(tableId: string): { tableId: string; merchantId: string; label: string } {
  const table = getState().dineInTables.find((t) => t.tableId === tableId);
  if (!table) throw new ApiError(404, 'DINE_IN_TABLE_NOT_FOUND', 'Table not found');
  return table;
}

/* ---------- module-local split registry (mock-only, #25) ---------- */

interface StoredShare {
  id: string;
  label: string;
  amountTZS: number;
  status: 'pending' | 'paid';
}

interface StoredSplit {
  id: string;
  dineInOrderId: string;
  totalTZS: number;
  shares: StoredShare[];
  myShareId: string;
  status: DineInSplitStatus;
  createdAt: string;
}

/** Module-local registry + per-key replays (resetMockState() covers mockState
 * only; tests call resetMockDineInSplitState() between cases, same pattern as
 * mock/splits.ts). */
const splits = new Map<string, StoredSplit>();
const createReplays = new Map<string, StoredSplit>();
const payReplays = new Map<string, DineInSplit>();

export function resetMockDineInSplitState(): void {
  splits.clear();
  createReplays.clear();
  payReplays.clear();
}

function requireOrder(dineInOrderId: string): DineInOrder {
  const order = getState().dineInOrders.find((o) => o.id === dineInOrderId);
  if (!order) throw new ApiError(404, 'DINE_IN_ORDER_NOT_FOUND', 'Bill not found');
  return order;
}

function requireSplit(dineInOrderId: string): StoredSplit {
  const split = splits.get(dineInOrderId);
  if (!split) throw new ApiError(404, 'NOT_FOUND', `No split for bill ${dineInOrderId}`);
  return split;
}

function toDto(split: StoredSplit): DineInSplit {
  return clone({
    id: split.id,
    dineInOrderId: split.dineInOrderId,
    totalTZS: split.totalTZS,
    shares: split.shares.map((s) => ({ id: s.id, label: s.label, amountTZS: s.amountTZS, status: s.status })),
    myShareId: split.myShareId,
    status: split.status,
    createdAt: split.createdAt,
  });
}

export class MockDineInRepository implements DineInRepository {
  async listMyOrders(): Promise<DineInOrder[]> {
    return clone(getState().dineInOrders);
  }

  async resolveTable(tableId: string): Promise<DineInTableQrContext> {
    const state = getState();
    const table = findTable(tableId);
    const inUse = state.dineInOrders.some((o) => o.tableId === tableId && OPEN_STATUSES.includes(o.status));
    if (inUse) throw new ApiError(409, 'DINE_IN_TABLE_IN_USE', 'This table already has an open bill');
    return {
      qrPayload: `hudumika:dinein:table:${tableId}`,
      menuUrl: `https://menu.hudumika.tz/${table.merchantId}/${tableId}`,
      merchantId: table.merchantId,
    };
  }

  async getOrder(dineInOrderId: string): Promise<DineInOrder> {
    const order = getState().dineInOrders.find((o) => o.id === dineInOrderId);
    if (!order) throw new ApiError(404, 'DINE_IN_ORDER_NOT_FOUND', 'Bill not found');
    return clone(order);
  }

  async openOrder(merchantId: string, tableId: string, items: { catalogueItemId: string; quantity: number; options?: string[] }[], _idempotencyKey: string): Promise<DineInOrder> {
    const state = getState();
    const table = findTable(tableId);
    if (table.merchantId !== merchantId) {
      throw new ApiError(404, 'DINE_IN_TABLE_NOT_FOUND', 'Table does not belong to this restaurant');
    }
    if (state.dineInOrders.some((o) => o.tableId === tableId && OPEN_STATUSES.includes(o.status))) {
      throw new ApiError(409, 'DINE_IN_TABLE_IN_USE', 'This table already has an open bill');
    }
    if (!items.length) throw new ApiError(422, 'VALIDATION_FAILED', 'Open the bill with at least one item');
    const catalogue = state.catalogues.get(table.merchantId);
    const subtotal = items.reduce((acc, item) => {
      const line = catalogue?.items.find((i) => i.id === item.catalogueItemId);
      if (!line) throw new ApiError(422, 'VALIDATION_FAILED', `Unknown item ${item.catalogueItemId}`);
      if (!Number.isInteger(item.quantity) || item.quantity < 1) throw new ApiError(422, 'VALIDATION_FAILED', 'Quantity must be at least 1');
      return acc + line.priceTZS * item.quantity;
    }, 0);
    const order: DineInOrder = {
      id: uid('dine'),
      merchantId: table.merchantId,
      tableId,
      status: 'open',
      items: items.map((item) => {
        const line = catalogue!.items.find((i) => i.id === item.catalogueItemId)!;
        return { catalogueItemId: line.id!, name: line.name, quantity: item.quantity, unitPriceTZS: line.priceTZS };
      }),
      totals: { subtotalTZS: subtotal, deliveryFeeTZS: 0, platformFeeTZS: 0, taxTZS: 0, discountTZS: 0, totalTZS: subtotal },
      createdAt: nowIso(),
    };
    state.dineInOrders.unshift(order);
    return clone(order);
  }

  async splitBill(dineInOrderId: string, input: { shares: { label: string; amountTZS: number }[] }, idempotencyKey: string): Promise<DineInSplit> {
    const replay = createReplays.get(idempotencyKey);
    if (replay) return toDto(replay);
    const order = requireOrder(dineInOrderId);
    // A split only makes sense on a payable bill (DINE-IN.md: open →
    // billing → paid → closed); a settled bill cannot be split afterwards.
    if (!OPEN_STATUSES.includes(order.status)) {
      throw new ApiError(409, 'DINE_IN_ORDER_STATUS_CONFLICT', 'This bill can no longer be split');
    }
    // One split per bill (DINE-IN.md: one open dine-in order per table).
    if (splits.has(dineInOrderId)) throw new ApiError(409, 'CONFLICT', 'This bill already has a split');
    if (!Array.isArray(input.shares) || input.shares.length < 2 || input.shares.length > 8) {
      throw new ApiError(422, 'VALIDATION_FAILED', 'A split needs between 2 and 8 diners');
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
      throw new ApiError(422, 'VALIDATION_FAILED', 'Shares must sum exactly to the bill total');
    }
    const shareIds = input.shares.map(() => uid('share'));
    const split: StoredSplit = {
      id: uid('dins'),
      dineInOrderId,
      totalTZS: order.totals.totalTZS,
      shares: input.shares.map((share, i) => ({
        id: shareIds[i],
        label: share.label.trim(),
        amountTZS: share.amountTZS,
        // The initiator's share is the FIRST share of the client-built list
        // (the split sheet always puts "You" first). Every other share is
        // seeded PRE-PAID — simulated diners: the co-diner flow needs the
        // app too and is out of mock scope (docs/CONTRACT-ADDITIONS.md #25).
        status: i === 0 ? 'pending' : 'paid',
      })),
      myShareId: shareIds[0],
      status: 'open',
      createdAt: nowIso(),
    };
    splits.set(dineInOrderId, split);
    createReplays.set(idempotencyKey, split);
    return toDto(split);
  }

  async getSplit(dineInOrderId: string): Promise<DineInSplit> {
    requireOrder(dineInOrderId);
    return toDto(requireSplit(dineInOrderId));
  }

  async payMyShare(dineInOrderId: string, idempotencyKey: string): Promise<DineInSplit> {
    const replay = payReplays.get(idempotencyKey);
    if (replay) return clone(replay);
    const order = requireOrder(dineInOrderId);
    const split = requireSplit(dineInOrderId);
    if (split.status === 'completed') throw new ApiError(409, 'CONFLICT', 'This split is already completed');
    const mine = split.shares.find((s) => s.id === split.myShareId);
    if (mine?.status === 'paid') throw new ApiError(409, 'CONFLICT', 'Your share is already paid');
    const state = getState();
    if (state.paymentFailure) {
      const failure = state.paymentFailure;
      state.paymentFailure = null;
      throw new ApiError(429, failure.code, 'Payment provider unreachable', true, { retryAfterSeconds: failure.retryAfterSeconds });
    }
    // My share rides the NORMAL intent lifecycle (create → confirm →
    // "webhook"): a real intent for the SHARE amount lands in the payments
    // history and settling it flips the share to paid — same machinery as
    // mock/splits.ts payMyShare, scoped to the share amount.
    const intent: MockIntent = {
      id: uid('intent'),
      status: S.paid,
      amountTZS: mine?.amountTZS ?? split.totalTZS,
      method: 'mpesa',
      orderId: dineInOrderId,
      providerReference: `PR-${Math.floor(100000 + Math.random() * 900000)}-MPESA`,
      paidAt: nowIso(),
    };
    state.intents.push(intent);
    if (mine) mine.status = 'paid';
    if (split.shares.every((s) => s.status === 'paid')) {
      split.status = 'completed';
      // Mock "webhook": every share is covered — the full total is paid, so
      // the bill settles exactly like the merchant's confirm-payment would
      // (DINE-IN.md billing → paid); a later full-bill pay is refused by
      // DINE_IN_BILL_NOT_PAYABLE.
      order.status = 'paid';
      order.paidAt = nowIso();
    } else {
      split.status = 'paid';
    }
    const dto = toDto(split);
    payReplays.set(idempotencyKey, dto);
    return clone(dto);
  }
}
