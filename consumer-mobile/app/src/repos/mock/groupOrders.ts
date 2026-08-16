/* In-memory group-ordering repository (Meituan 拼单 parity) — POST
 * /group-orders, GET /group-orders/{id}, POST /group-orders/{id}/items,
 * DELETE /group-orders/{id}/items, POST /group-orders/{id}/finalize.
 *
 * Mock-only until the contract ships a shared-cart resource
 * (docs/CONTRACT-ADDITIONS.md #11). The registry is module-local (same
 * pattern as mock/reviews.ts seeds — mockState.ts stays untouched): the
 * session seeds two members — the local user (empty at create; they add their
 * own items) and an invited "Juma" with a couple of catalogue items
 * pre-added — so the demo shared cart feels real.
 *
 * Honest scope: NO realtime presence (that needs websockets). Members join
 * the shared cart by name; a session expires after expiresInMinutes and
 * rejects every mutation with 409 CONFLICT once it has (lazily marked
 * 'expired' on access). Item validation reuses mockState.validateOrderInput
 * (merchant closed / item unavailable / base price / options), and finalize
 * converts the shared cart into a real order through buildOrderFrom — one
 * payer; the per-member contributions ride a mock-only field. */
import { ApiError } from '@/api/client';
import { uid } from '@/lib/format';
import type { CatalogueItem, OrderDetail } from '@hudumika/contract';
import {
  buildOrderFrom,
  clone,
  findCatalogueItem,
  findMerchant,
  getState,
  nowIso,
  optionPriceFor,
  validateOrderInput,
} from './mockState';
import type { GroupOrder, GroupOrderFinalizedOrder, GroupOrdersRepository } from '../index';

const DEFAULT_EXPIRY_MINUTES = 60;
const INVITED_MEMBER_NAME = 'Juma';
/** Module-local demo session id — the group screen can be deep-linked/rendered
 * without creating anything first (mirrors mock/reviews.ts seed ids). */
export const SEED_GROUP_ORDER_ID = 'gor_seed_001';

interface StoredMemberItem {
  catalogueItemId: string;
  quantity: number;
  /** BASE catalogue price — validated against the catalogue at add time
   * (ORDER_PRICE_CHANGED otherwise); options are priced into the subtotal. */
  unitPriceTZS: number;
  options?: string[];
}

interface StoredMember {
  name: string;
  items: StoredMemberItem[];
}

interface StoredGroupOrder {
  id: string;
  merchantId: string;
  title: string;
  status: GroupOrder['status'];
  members: StoredMember[];
  expiresAt: string;
  createdAt: string;
  orderId?: string;
}

/** Module-local registry + per-key replays (resetMockState() covers mockState
 * only; tests call resetMockGroupOrdersState() between cases, same pattern as
 * mock/orders.ts pendingModifications). */
const groupOrders = new Map<string, StoredGroupOrder>();
const createReplays = new Map<string, StoredGroupOrder>();
const mutationReplays = new Map<string, GroupOrder>();
const finalizeReplays = new Map<string, OrderDetail>();

export function resetMockGroupOrdersState(): void {
  groupOrders.clear();
  createReplays.clear();
  mutationReplays.clear();
  finalizeReplays.clear();
}

/** Demo/test hook (module-local, mirrors mockState.simulatePaymentFailure):
 * expire an open session so every mutation rejects with CONFLICT. */
export function expireGroupOrder(groupOrderId: string): void {
  const session = groupOrders.get(groupOrderId);
  if (session) {
    session.status = 'expired';
    session.expiresAt = nowIso();
  }
}

function requireSession(groupOrderId: string): StoredGroupOrder {
  const session = groupOrders.get(groupOrderId);
  if (!session) throw new ApiError(404, 'NOT_FOUND', `Group order ${groupOrderId} not found`);
  return session;
}

/** Module-local seed (mockState.ts stays untouched, mirroring mock/reviews.ts
 * ensureSeeds): one open demo session for the first feed merchant — the local
 * user + invited Juma both with real catalogue lines — so the group-order
 * screen renders real content on first load and a share link is deep-linkable.
 * Idempotent across resetMockGroupOrdersState(). */
function ensureSeeds(): void {
  if (groupOrders.has(SEED_GROUP_ORDER_ID)) return;
  const state = getState();
  const merchant = state.merchants[0];
  const first = (state.catalogues.get(merchant.id)?.items ?? []).find((i) => i.available !== false && i.id);
  if (!first?.id) return;
  groupOrders.set(SEED_GROUP_ORDER_ID, {
    id: SEED_GROUP_ORDER_ID,
    merchantId: merchant.id,
    title: merchant.businessName,
    status: 'open',
    members: [
      { name: state.user.fullName ?? '', items: [{ catalogueItemId: first.id, quantity: 1, unitPriceTZS: first.priceTZS }] },
      { name: INVITED_MEMBER_NAME, items: invitedLines(merchant.id) },
    ],
    expiresAt: new Date(Date.now() + DEFAULT_EXPIRY_MINUTES * 60_000).toISOString(),
    createdAt: nowIso(),
  });
}

/** A session is a state machine: 'ordered' (already finalized) and 'expired'
 * (clock ran out — lazily marked on access) both reject every mutation. */
function assertOpen(session: StoredGroupOrder): void {
  if (session.status === 'expired') throw new ApiError(409, 'CONFLICT', 'This group order has expired');
  if (session.status === 'ordered') throw new ApiError(409, 'CONFLICT', 'This group order has already been finalized');
  if (Date.parse(session.expiresAt) < Date.now()) {
    session.status = 'expired';
    throw new ApiError(409, 'CONFLICT', 'This group order has expired');
  }
}

function memberItemTZS(merchantId: string, item: StoredMemberItem): number {
  const current = findCatalogueItem(merchantId, item.catalogueItemId);
  const extraTZS = (item.options ?? []).reduce((acc, opt) => acc + (optionPriceFor(current, opt) ?? 0), 0);
  return (item.unitPriceTZS + extraTZS) * item.quantity;
}

/** Server-style pricing mirroring buildOrderFrom (delivery 2500 / platform
 * 800 / no tax or discount): the session totals are what the finalized order
 * will total. Money is integer TZS and the sum rule holds. */
function totalsFor(merchantId: string, members: StoredMember[]): GroupOrder['totals'] {
  const subtotalTZS = members.reduce((acc, m) => acc + m.items.reduce((a, i) => a + memberItemTZS(merchantId, i), 0), 0);
  const deliveryFeeTZS = 2500;
  const platformFeeTZS = 800;
  const taxTZS = 0;
  const discountTZS = 0;
  return {
    subtotalTZS,
    deliveryFeeTZS,
    platformFeeTZS,
    taxTZS,
    discountTZS,
    totalTZS: subtotalTZS + deliveryFeeTZS + platformFeeTZS + taxTZS - discountTZS,
  };
}

function toDto(session: StoredGroupOrder): GroupOrder {
  return clone({
    id: session.id,
    merchantId: session.merchantId,
    title: session.title,
    status: session.status,
    members: session.members.map((m) => ({
      name: m.name,
      items: clone(m.items),
      subtotalTZS: m.items.reduce((acc, i) => acc + memberItemTZS(session.merchantId, i), 0),
    })),
    totals: totalsFor(session.merchantId, session.members),
    expiresAt: session.expiresAt,
    createdAt: session.createdAt,
    orderId: session.orderId,
  });
}

/** The invited member's pre-added lines: the first couple of AVAILABLE
 * catalogue items at their current prices (the server is the price
 * authority) — deterministic per merchant, so the demo always renders. */
function invitedLines(merchantId: string): StoredMemberItem[] {
  const available = (getState().catalogues.get(merchantId)?.items ?? []).filter(
    (i): i is CatalogueItem & { id: string } => i.available !== false && !!i.id,
  );
  if (available.length === 0) return [];
  const first = available[0];
  const second = available[1] ?? available[0];
  return [
    { catalogueItemId: first.id, quantity: 2, unitPriceTZS: first.priceTZS },
    { catalogueItemId: second.id, quantity: 1, unitPriceTZS: second.priceTZS },
  ];
}

function lineKey(i: StoredMemberItem): string {
  return `${i.catalogueItemId}|${JSON.stringify(i.options ?? [])}`;
}

export class MockGroupOrdersRepository implements GroupOrdersRepository {
  async create(input: { merchantId: string; title?: string; expiresInMinutes?: number }, idempotencyKey: string): Promise<GroupOrder> {
    ensureSeeds();
    const replay = createReplays.get(idempotencyKey);
    if (replay) return toDto(replay);
    const merchant = findMerchant(input.merchantId);
    const minutes = input.expiresInMinutes ?? DEFAULT_EXPIRY_MINUTES;
    if (!Number.isInteger(minutes) || minutes < 1) {
      throw new ApiError(422, 'VALIDATION_FAILED', 'expiresInMinutes must be a positive integer');
    }
    const state = getState();
    const session: StoredGroupOrder = {
      id: uid('gor'),
      merchantId: merchant.id,
      title: input.title ?? merchant.businessName,
      status: 'open',
      members: [
        // The local user's member is seeded empty — they add their own items
        // through addItem (the cart screen copies its lines in at start).
        { name: state.user.fullName ?? '', items: [] },
        { name: INVITED_MEMBER_NAME, items: invitedLines(merchant.id) },
      ],
      expiresAt: new Date(Date.now() + minutes * 60_000).toISOString(),
      createdAt: nowIso(),
    };
    groupOrders.set(session.id, session);
    createReplays.set(idempotencyKey, session);
    return toDto(session);
  }

  async get(groupOrderId: string): Promise<GroupOrder> {
    ensureSeeds();
    const session = requireSession(groupOrderId);
    if (session.status === 'open' && Date.parse(session.expiresAt) < Date.now()) session.status = 'expired';
    return toDto(session);
  }

  async addItem(groupOrderId: string, memberName: string, item: { catalogueItemId: string; quantity: number; unitPriceTZS?: number; options?: string[] }, idempotencyKey: string): Promise<GroupOrder> {
    const replay = mutationReplays.get(idempotencyKey);
    if (replay) return clone(replay);
    const session = requireSession(groupOrderId);
    assertOpen(session);
    if (!Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 99) {
      throw new ApiError(422, 'VALIDATION_FAILED', 'Quantity must be between 1 and 99');
    }
    // Same validation as order create (mockState.validateOrderInput): merchant
    // open, item available, base price matches the catalogue
    // (ORDER_ITEM_UNAVAILABLE / ORDER_PRICE_CHANGED), options resolvable.
    const basePriceTZS = findCatalogueItem(session.merchantId, item.catalogueItemId).priceTZS;
    validateOrderInput(findMerchant(session.merchantId), [
      { catalogueItemId: item.catalogueItemId, quantity: item.quantity, unitPriceTZS: item.unitPriceTZS ?? basePriceTZS, options: item.options },
    ]);
    const member = session.members.find((m) => m.name === memberName);
    if (!member) throw new ApiError(404, 'NOT_FOUND', `Member ${memberName} is not part of this group order`);
    const line: StoredMemberItem = { catalogueItemId: item.catalogueItemId, quantity: item.quantity, unitPriceTZS: item.unitPriceTZS ?? basePriceTZS, options: item.options };
    const existing = member.items.find((i) => lineKey(i) === lineKey(line));
    if (existing) existing.quantity = Math.min(99, existing.quantity + item.quantity);
    else member.items.push(line);
    const dto = toDto(session);
    mutationReplays.set(idempotencyKey, dto);
    return clone(dto);
  }

  async removeItem(groupOrderId: string, memberName: string, catalogueItemId: string, idempotencyKey: string): Promise<GroupOrder> {
    const replay = mutationReplays.get(idempotencyKey);
    if (replay) return clone(replay);
    const session = requireSession(groupOrderId);
    assertOpen(session);
    const member = session.members.find((m) => m.name === memberName);
    if (!member) throw new ApiError(404, 'NOT_FOUND', `Member ${memberName} is not part of this group order`);
    const before = member.items.length;
    member.items = member.items.filter((i) => i.catalogueItemId !== catalogueItemId);
    if (member.items.length === before) {
      throw new ApiError(404, 'NOT_FOUND', `No item ${catalogueItemId} in ${memberName}'s lines`);
    }
    const dto = toDto(session);
    mutationReplays.set(idempotencyKey, dto);
    return clone(dto);
  }

  async finalize(groupOrderId: string, paymentMethod: string, deliveryAddress: OrderDetail['deliveryAddress'], idempotencyKey: string): Promise<GroupOrderFinalizedOrder> {
    const replay = finalizeReplays.get(idempotencyKey);
    if (replay) return clone(replay as GroupOrderFinalizedOrder);
    const session = requireSession(groupOrderId);
    assertOpen(session);
    if (session.members.every((m) => m.items.length === 0)) {
      throw new ApiError(422, 'ORDER_EMPTY', 'Group order has no items');
    }
    // Re-validate everything before converting (the merchant may have closed
    // or an item gone stale since the add) — same rules as order create.
    const merchant = findMerchant(session.merchantId);
    const items = session.members.flatMap((m) =>
      m.items.map((i) => ({ catalogueItemId: i.catalogueItemId, quantity: i.quantity, unitPriceTZS: i.unitPriceTZS, options: i.options })),
    );
    validateOrderInput(merchant, items);
    const cod = paymentMethod === 'cod';
    const order = buildOrderFrom({ merchantId: session.merchantId, items, deliveryAddress }, cod) as GroupOrderFinalizedOrder;
    // Mock-only member-contribution ledger (CONTRACT-ADDITIONS.md #11): what
    // each member added and its share of the subtotal — the live wire can
    // never carry it until Team 6 ships the field.
    order.groupOrderContributions = session.members
      .filter((m) => m.items.length > 0)
      .map((m) => ({
        memberName: m.name,
        subtotalTZS: m.items.reduce((acc, i) => acc + memberItemTZS(session.merchantId, i), 0),
        items: m.items.map((i) => ({ catalogueItemId: i.catalogueItemId, quantity: i.quantity, unitPriceTZS: i.unitPriceTZS })),
      }));
    const state = getState();
    state.orders.unshift(order);
    if (cod) {
      const intent = {
        id: uid('intent'),
        status: 'paid' as const,
        amountTZS: order.totals.totalTZS,
        method: 'cod' as const,
        orderId: order.id,
        providerReference: `PR-COD-${Math.floor(100000 + Math.random() * 900000)}`,
        paidAt: nowIso(),
      };
      state.intents.push(intent);
      state.intentForOrder.set(order.id, intent);
    }
    session.status = 'ordered';
    session.orderId = order.id;
    finalizeReplays.set(idempotencyKey, order);
    return clone(order);
  }
}
