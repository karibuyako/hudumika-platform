/* Shared in-memory state for the mock repositories.
 *
 * Module-level singleton, seeded deterministically from @hudumika/contract
 * fixtures (setFixturesSeed(20260813) at load). Tests call resetMockState()
 * between cases to restore the pristine seed.
 *
 * Money is integer TZS everywhere. Totals always satisfy
 *   subtotal + delivery + platform + tax − discount = total.
 */
import {
  fixtureAddress,
  fixtureCompletedOrder,
  fixtureHomeFeed,
  fixtureMenu,
  fixtureOrderDetail,
  fixturePromotion,
  fixtureWallet,
  fixtureWalletTransactions,
  setFixturesSeed,
} from '@hudumika/contract/fixtures';
import type {
  BookingDetail,
  BookingQuote,
  Catalogue,
  CatalogueItem,
  ChatMessage,
  City,
  ConversationDetail,
  Coupon,
  CustomerMembership,
  DineInOrder,
  GetConsumerHome200,
  GroupBuyDeal,
  MerchantPublic,
  Notification,
  NotificationPreferences,
  OrderDetail,
  PaymentIntent,
  Promotion,
  ProviderPublic,
  Reservation,
  Review,
  RouteSegment,
  TicketDetail,
  TrackingEvent,
  TrackingPhase,
  User,
  Voucher,
  Wallet,
  WalletTransaction,
  WaybillEvent,
} from '@hudumika/contract';
import {
  ConversationStatus,
  CouponStatus,
  OrderStatus,
  PaymentIntentStatus,
  PromotionType,
  TicketStatus,
} from '@hudumika/contract';
import { ApiError } from '@/api/client';
import { eventBus } from '@/store/events';
import { uid } from '@/lib/format';
export const MOCK_SEED = 20260813;

export interface OtpRequest {
  code: string;
  destination: string;
  purpose: 'login' | 'signup';
  expiresAt: number;
  attempts: number;
}

export interface ConversationState extends ConversationDetail {
  messages: ChatMessage[];
}

/** Payment intent with the order→intent linkage the contract DTO omits
 * (surfaced through PaymentsRepository.getHistory for confirmation screens). */
export type MockIntent = PaymentIntent & { orderId?: string };

/** Mock-only delivery context riding the route payload (CONTRACT-ADDITIONS.md
 * #5): the contract RouteSegment/OrderDetail/TrackingPhase carry no
 * delivery-window or city fields, so the mock attaches
 * deliveryWindowFrom/To (ISO) + originCityName/destinationCityName to every
 * leg of an intercity route. Screens read them via
 * OrdersRepository.getDeliveryWindow/getRouteCities (the live repo returns
 * null until Team 6 ships the fields). */
export type MockRouteSegment = RouteSegment & {
  deliveryWindowFrom?: string;
  deliveryWindowTo?: string;
  originCityName?: string;
  destinationCityName?: string;
};

export interface MockState {
  user: User;
  cities: City[];
  home: GetConsumerHome200;
  merchants: MerchantPublic[];
  catalogues: Map<string, Catalogue>;
  promotions: Map<string, Promotion[]>;
  orders: OrderDetail[];
  intents: MockIntent[];
  intentForOrder: Map<string, PaymentIntent>;
  routes: Map<string, MockRouteSegment[]>;
  waybills: Map<string, { waybillNumber: string; events: WaybillEvent[] }>;
  wallet: Wallet;
  walletTransactions: WalletTransaction[];
  bookings: BookingDetail[];
  reviews: Review[];
  notifications: Notification[];
  preferences: NotificationPreferences;
  tickets: TicketDetail[];
  conversations: ConversationState[];
  coupons: Coupon[];
  favorites: MerchantPublic[];
  membership: CustomerMembership;
  groupBuys: GroupBuyDeal[];
  vouchers: Voucher[];
  dineInOrders: DineInOrder[];
  dineInTables: { tableId: string; merchantId: string; label: string }[];
  reservations: Reservation[];
  searchHistory: string[];
  otpRequests: Map<string, OtpRequest>;
  otpCounter: number;
  lastOtpRequestAt: Map<string, number>;
  customerLocation: { lat: number; lon: number };
  orderReplays: Map<string, OrderDetail>;
  intentReplays: Map<string, PaymentIntent>;
  /** Dev/test-only: next confirm() throws this provider error (PAYMENTS.md UX). */
  paymentFailure: { code: string; retryAfterSeconds?: number } | null;
}

export const MOCK_PHONE = '+255700000000';
export { fixtureAddress };
export const MOCK_CUSTOMER_ID = 'cus_0001';

/* ---------- deterministic catalogue content ---------- */

const DISHES: {
  name: string;
  description: string;
  category: string;
  priceTZS: number;
  options?: { name: string; choices: { label: string; priceTZS: number }[] }[];
  addons?: { name: string; priceTZS: number }[];
}[] = [
  { name: 'Chicken & Chips', description: 'Crispy fried chicken with golden chips and kachumbari', category: 'Popular', priceTZS: 12000, options: [{ name: 'Size', choices: [{ label: 'Regular', priceTZS: 0 }, { label: 'Large', priceTZS: 3000 }] }], addons: [{ name: 'Extra chips', priceTZS: 2000 }] },
  { name: 'Beef Pilau', description: 'Spiced rice with tender beef, cooked the Zanzibari way', category: 'Rice & Stews', priceTZS: 9000 },
  { name: 'Chapati + Beans', description: 'Two soft chapatis with maharage ya nazi', category: 'Popular', priceTZS: 4500 },
  { name: 'Fried Fish', description: 'Whole tilapia, deep fried, served with ugali', category: 'Grills', priceTZS: 15000, options: [{ name: 'Size', choices: [{ label: 'Medium', priceTZS: 0 }, { label: 'Large', priceTZS: 4000 }] }] },
  { name: 'Milk Tea', description: 'Sweet spiced chai', category: 'Drinks', priceTZS: 1500 },
  { name: 'Samaki wa Kupaka', description: 'Fish in coconut curry sauce', category: 'Rice & Stews', priceTZS: 13000 },
  { name: 'Nyama Choma Platter', description: 'Grilled goat meat with kachumbari and chips', category: 'Grills', priceTZS: 25000, addons: [{ name: 'Extra sauce', priceTZS: 1000 }] },
  { name: 'Mango Smoothie', description: 'Fresh blended mango, no sugar added', category: 'Drinks', priceTZS: 4000 },
  { name: 'Mandazi (4 pcs)', description: 'Sweet fried dough, best with chai', category: 'Popular', priceTZS: 2000 },
  { name: 'Coconut Rice', description: 'Wali wa nazi, pairs with any stew', category: 'Rice & Stews', priceTZS: 6000 },
];

function buildCatalogue(merchant: MerchantPublic, index: number): Catalogue {
  // Section names come from the contract fixtureMenu (deterministic per seed);
  // items are priced menu content shaped like CatalogueItem.
  const menu = fixtureMenu();
  const sectionNames = (menu.sections ?? []).map((s) => s.name);
  const itemCount = 5 + (index % 3);
  const start = index * 3;
  const items: CatalogueItem[] = Array.from({ length: itemCount }, (_, i) => {
    const dish = DISHES[(start + i) % DISHES.length];
    return {
      id: `citem_${merchant.id.slice(-6)}_${i}`,
      name: dish.name,
      description: dish.description,
      priceTZS: dish.priceTZS,
      category: sectionNames[i % sectionNames.length],
      imageUrl: null,
      available: !(i === 3),
      options: dish.options?.map((o) => ({ name: o.name, choices: o.choices.map((c) => ({ label: c.label, priceTZS: c.priceTZS })) })),
      addons: dish.addons?.map((a) => ({ name: a.name, priceTZS: a.priceTZS })),
    };
  });
  return { merchantId: merchant.id, publishedAt: nowIso(), items };
}

function buildCities(): City[] {
  return [
    { id: 'city_dar', name: 'Dar es Salaam', country: 'TZ', serviceAreas: [{ id: 'area_kinondoni', name: 'Kinondoni' }, { id: 'area_ilala', name: 'Ilala' }, { id: 'area_ubungo', name: 'Ubungo' }] },
    { id: 'city_mwanza', name: 'Mwanza', country: 'TZ', serviceAreas: [{ id: 'area_nyamagana', name: 'Nyamagana' }] },
    { id: 'city_arusha', name: 'Arusha', country: 'TZ', serviceAreas: [{ id: 'area_arumeru', name: 'Arumeru' }] },
    { id: 'city_dodoma', name: 'Dodoma', country: 'TZ', serviceAreas: [{ id: 'area_chamwino', name: 'Chamwino' }] },
  ];
}

function buildPhases(overrides: Partial<TrackingPhase>[] = []): TrackingPhase[] {
  const base: TrackingPhase[] = [
    { phase: 'confirmed', label: 'Order confirmed', status: 'completed', at: nowIso(), eta: null },
    { phase: 'picked_up', label: 'Picked up', status: 'completed', at: nowIso(), eta: null },
    { phase: 'in_transit', label: 'Traveling', status: 'active', at: null, eta: new Date(Date.now() + 26 * 3600_000).toISOString() },
    { phase: 'arrived_city', label: 'Arrived in your city', status: 'pending', at: null, eta: null },
    { phase: 'out_for_delivery', label: 'Out for delivery', status: 'pending', at: null, eta: null },
    { phase: 'delivered', label: 'Delivered', status: 'pending', at: null, eta: null },
  ];
  return base.map((p, i) => ({ ...p, ...(overrides[i] ?? {}) }));
}

/** Intercity route — every leg carries the mock-only delivery-window and
 * city extras (CONTRACT-ADDITIONS.md #5): the window is the committed
 * promise from the server (tracking renders it verbatim), and the city names
 * label the origin → destination header line. */
function buildRoute(): MockRouteSegment[] {
  const now = nowIso();
  const windowFrom = new Date(Date.now() + 26 * 3600_000).toISOString();
  const windowTo = new Date(Date.now() + 30 * 3600_000).toISOString();
  return [
    { legId: 'leg_1', sequence: 1, type: 'first_mile', mode: 'motorcycle', status: 'completed', plannedStartAt: now, startedAt: now, completedAt: now, deliveryWindowFrom: windowFrom, deliveryWindowTo: windowTo, originCityName: 'Dar es Salaam', destinationCityName: 'Mwanza' },
    { legId: 'leg_2', sequence: 2, type: 'linehaul', mode: 'linehaul_bus', fromHubId: 'hub_dar', toHubId: 'hub_mwanza', status: 'in_progress', plannedStartAt: now, plannedEndAt: new Date(Date.now() + 24 * 3600_000).toISOString(), etaAt: new Date(Date.now() + 26 * 3600_000).toISOString(), deliveryWindowFrom: windowFrom, deliveryWindowTo: windowTo, originCityName: 'Dar es Salaam', destinationCityName: 'Mwanza' },
    { legId: 'leg_3', sequence: 3, type: 'hub_transfer', fromHubId: 'hub_mwanza', toHubId: 'hub_mwanza_b', status: 'pending', plannedStartAt: new Date(Date.now() + 26 * 3600_000).toISOString(), deliveryWindowFrom: windowFrom, deliveryWindowTo: windowTo, originCityName: 'Dar es Salaam', destinationCityName: 'Mwanza' },
    { legId: 'leg_4', sequence: 4, type: 'last_mile', mode: 'motorcycle', toHubId: 'hub_mwanza_b', status: 'pending', plannedStartAt: new Date(Date.now() + 27 * 3600_000).toISOString(), deliveryWindowFrom: windowFrom, deliveryWindowTo: windowTo, originCityName: 'Dar es Salaam', destinationCityName: 'Mwanza' },
  ];
}

function buildWaybill(): { waybillNumber: string; events: WaybillEvent[] } {
  return {
    waybillNumber: 'WB-1042-MWZ',
    events: [
      { at: nowIso(), type: 'scanned', location: 'Dar es Salaam hub', actor: 'hub staff', note: 'Package picked from merchant' },
      { at: nowIso(), type: 'departed', location: 'Dar es Salaam hub', actor: 'hub staff' },
      { at: new Date(Date.now() + 4 * 3600_000).toISOString(), type: 'scanned', location: 'En route — Tabora', actor: 'bus crew' },
    ],
  };
}

/** Relay orders (fulfillmentType 'relay') move through sequential rider
 * handoffs within a region — the route/waybill surfaces match intercity. */
function buildRelayRoute(): RouteSegment[] {
  return [
    { legId: 'leg_r1', sequence: 1, type: 'first_mile', mode: 'motorcycle', fromHubId: 'hub_dar_a', toHubId: 'hub_dar_b', status: 'completed', plannedStartAt: nowIso(), startedAt: nowIso(), completedAt: nowIso() },
    { legId: 'leg_r2', sequence: 2, type: 'hub_transfer', mode: 'motorcycle', fromHubId: 'hub_dar_b', toHubId: 'hub_dar_c', status: 'in_progress', plannedStartAt: nowIso(), plannedEndAt: new Date(Date.now() + 2 * 3600_000).toISOString(), etaAt: new Date(Date.now() + 2 * 3600_000).toISOString() },
    { legId: 'leg_r3', sequence: 3, type: 'last_mile', mode: 'motorcycle', fromHubId: 'hub_dar_c', status: 'pending', plannedStartAt: new Date(Date.now() + 2 * 3600_000).toISOString(), etaAt: new Date(Date.now() + 3 * 3600_000).toISOString() },
  ];
}

function buildRelayWaybill(): { waybillNumber: string; events: WaybillEvent[] } {
  return {
    waybillNumber: 'WB-2048-DAR',
    events: [
      { at: nowIso(), type: 'scanned', location: 'Dar es Salaam — rider 1 pickup', actor: 'relay rider' },
      { at: nowIso(), type: 'departed', location: 'Dar es Salaam — handoff point', actor: 'relay rider' },
    ],
  };
}

/** P8: simulate intercity.eta_updated — shifts the linehaul window and stamps
 * an exception event; the tracking screen renders the banner from this.
 * Also publishes the matching server events on the bus so live subscribers
 * (tracking screen refetch) fire — same path a real /events stream takes.
 * delivery.delayed is published alongside (guarded by the route existing) so
 * the full tracking subscription list gets an exercise path in the demo. */
export function simulateIntercityDelay(state: MockState, hours = 2) {
  const route = state.routes.get('ord_intercity_002');
  if (route) {
    const linehaul = route.find((l) => l.type === 'linehaul');
    if (linehaul?.etaAt) linehaul.etaAt = new Date(Date.parse(linehaul.etaAt) + hours * 3600_000).toISOString();
    // The delayed event posts a NEW delivery window (the mock-only extras on
    // the route, CONTRACT-ADDITIONS.md #5) — the tracking screen re-reads it
    // via getDeliveryWindow, so the promise card follows the server event.
    for (const leg of route) {
      if (leg.deliveryWindowFrom) leg.deliveryWindowFrom = new Date(Date.parse(leg.deliveryWindowFrom) + hours * 3600_000).toISOString();
      if (leg.deliveryWindowTo) leg.deliveryWindowTo = new Date(Date.parse(leg.deliveryWindowTo) + hours * 3600_000).toISOString();
    }
    eventBus.publish('delivery.delayed', { orderId: 'ord_intercity_002' });
  }
  const wb = state.waybills.get('ord_intercity_002');
  if (wb) {
    wb.events.push({ at: nowIso(), type: 'exception', location: 'En route — Tabora', actor: 'operations', note: 'Linehaul bus delayed — new window posted below' });
  }
  eventBus.publish('intercity.eta_updated', { orderId: 'ord_intercity_002' });
  eventBus.publish('waybill.updated', { orderId: 'ord_intercity_002' });
}

function buildState(): MockState {
  const home = fixtureHomeFeed();
  const merchants = home.merchants;
  // Deterministic demo/E2E happy path: the fixture can seed a closed merchant
  // (faker boolean 0.8) — force the first two feed merchants open so the
  // E2E's tapped cards (merchants[0] / merchants[1]) always carry orderable
  // catalogues and the merchant pill says Open.
  merchants.forEach((m, i) => {
    if (i > 1 || m.isOpen) return;
    m.isOpen = true;
    m.deliveryMinutes = m.deliveryMinutes ?? 30;
  });
  // Force one merchant closed so the closed-merchant gating path (banner +
  // disabled add-to-cart + Chat/Reserve) is exercisable in the demo.
  if (merchants.length > 3) merchants[3].isOpen = false;
  const catalogues = new Map<string, Catalogue>();
  merchants.forEach((m, i) => catalogues.set(m.id, buildCatalogue(m, i)));

  const promoList = [fixturePromotion(), fixturePromotion()];
  const promotions = new Map<string, Promotion[]>();
  merchants.forEach((m, i) => {
    if (i === 0) {
      // First offer on the demo merchant is claimable: link it to the seeded
      // available coupon (coup_002) so the merchant page Claim round-trips.
      promotions.set(m.id, [{ ...promoList[0], id: 'coup_002', type: PromotionType.coupon }, promoList[1]]);
    } else {
      promotions.set(m.id, []);
    }
  });

  const address = fixtureAddress();
  const orderBase = fixtureOrderDetail({ deliveryAddress: address, merchantId: merchants[0].id });

  const active: OrderDetail = {
    ...orderBase,
    id: 'ord_active_001',
    no: 'HD-OR-482913',
    status: 'delivering',
    fulfillmentType: 'local',
    dispatchStrategy: 'nearest',
    merchantId: merchants[0].id,
    version: 1,
    totals: {
      subtotalTZS: 24000,
      deliveryFeeTZS: 2500,
      platformFeeTZS: 800,
      taxTZS: 0,
      discountTZS: 0,
      totalTZS: 27300,
    },
    items: [
      { catalogueItemId: 'citem_000_0', name: 'Chicken & Chips', quantity: 1, unitPriceTZS: 12000 },
      { catalogueItemId: 'citem_000_1', name: 'Beef Pilau', quantity: 1, unitPriceTZS: 9000 },
      { catalogueItemId: 'citem_000_4', name: 'Milk Tea', quantity: 2, unitPriceTZS: 1500 },
    ],
    events: [
      { status: 'paid', at: nowIso(), by: 'system', note: 'Order paid via mobile money' },
      { status: 'merchant_accepted', at: nowIso(), by: 'merchant', note: undefined },
      { status: 'preparing', at: nowIso(), by: 'merchant', note: undefined },
      { status: 'rider_assigned', at: nowIso(), by: 'system', note: undefined },
      { status: 'picked_up', at: nowIso(), by: 'rider', note: undefined },
      { status: 'delivering', at: nowIso(), by: 'rider', note: 'On the way' },
    ],
    deliveryEtaMin: 18,
    updatedAt: nowIso(),
  };

  const intercity: OrderDetail = {
    ...fixtureOrderDetail({ merchantId: merchants[1].id, deliveryAddress: address }),
    id: 'ord_intercity_002',
    no: 'HD-OR-482914',
    status: 'paid',
    fulfillmentType: 'intercity',
    dispatchStrategy: 'multi_leg',
    waybillNumber: 'WB-1042-MWZ',
    totals: { subtotalTZS: 185000, deliveryFeeTZS: 45000, platformFeeTZS: 2000, taxTZS: 0, discountTZS: 0, totalTZS: 232000 },
    items: [{ catalogueItemId: 'citem_001_0', name: 'Nyama Choma Platter', quantity: 1, unitPriceTZS: 25000 }],
    events: [{ status: 'paid', at: nowIso(), by: 'system', note: 'Paid via card' }],
  };

  const warehouse: OrderDetail = {
    ...fixtureOrderDetail({ merchantId: merchants[2].id, deliveryAddress: address }),
    id: 'ord_warehouse_003',
    no: 'HD-OR-482915',
    status: 'picked_up',
    fulfillmentType: 'local',
    fulfillmentSource: 'warehouse',
    dispatchStrategy: 'warehouse',
    waybillNumber: 'WB-1107-DAR',
    totals: { subtotalTZS: 36000, deliveryFeeTZS: 2500, platformFeeTZS: 800, taxTZS: 0, discountTZS: 0, totalTZS: 39300 },
    items: [{ catalogueItemId: 'citem_002_1', name: 'Samaki wa Kupaka', quantity: 2, unitPriceTZS: 13000 }],
    events: [
      { status: 'paid', at: nowIso(), by: 'system', note: 'Paid via wallet' },
      { status: 'picked_up', at: nowIso(), by: 'system', note: 'Picked up at warehouse' },
    ],
  };

  const relay: OrderDetail = {
    ...fixtureOrderDetail({ merchantId: merchants[3].id, deliveryAddress: address }),
    id: 'ord_relay_005',
    no: 'HD-OR-482916',
    status: 'paid',
    fulfillmentType: 'relay',
    dispatchStrategy: 'relay',
    waybillNumber: 'WB-2048-DAR',
    totals: { subtotalTZS: 24000, deliveryFeeTZS: 2500, platformFeeTZS: 800, taxTZS: 0, discountTZS: 0, totalTZS: 27300 },
    items: [{ catalogueItemId: 'citem_003_0', name: 'Mango Smoothie', quantity: 2, unitPriceTZS: 4000 }],
    events: [{ status: 'paid', at: nowIso(), by: 'system', note: 'Paid via M-Pesa' }],
  };

  // Rushable seed: 'preparing' is the positive path for the "Hurry up" flow
  // (isRushable: merchant_accepted | preparing — src/lib/order.ts). The E2E
  // rush spec (reservation-rush.e2e.ts) and the order detail screen's rush
  // button render against this order.
  const rush: OrderDetail = {
    ...fixtureOrderDetail({ merchantId: merchants[0].id, deliveryAddress: address }),
    id: 'ord_rush_008',
    no: 'HD-OR-482917',
    status: 'preparing',
    totals: { subtotalTZS: 18000, deliveryFeeTZS: 2500, platformFeeTZS: 800, taxTZS: 0, discountTZS: 0, totalTZS: 21300 },
    items: [{ catalogueItemId: 'citem_000_1', name: 'Beef Pilau', quantity: 2, unitPriceTZS: 9000 }],
    events: [
      { status: 'paid', at: nowIso(), by: 'system', note: 'Paid via M-Pesa' },
      { status: 'merchant_accepted', at: nowIso(), by: 'merchant', note: undefined },
      { status: 'preparing', at: nowIso(), by: 'merchant', note: undefined },
    ],
    deliveryEtaMin: 25,
    updatedAt: nowIso(),
  };

  const completed = fixtureCompletedOrder({ merchantId: merchants[0].id, id: 'ord_completed_004', no: 'HD-OR-480112', deliveryAddress: address });
  const completed2 = fixtureCompletedOrder({ merchantId: merchants[0].id, id: 'ord_completed_005', no: 'HD-OR-478901', deliveryAddress: address, status: 'completed' });

  const refunded: OrderDetail = {
    ...fixtureOrderDetail({ merchantId: merchants[0].id, deliveryAddress: address }),
    id: 'ord_refunded_006',
    no: 'HD-OR-476120',
    status: 'refunded',
    cancelledAt: nowIso(),
    totals: { subtotalTZS: 24000, deliveryFeeTZS: 2500, platformFeeTZS: 800, taxTZS: 0, discountTZS: 0, totalTZS: 27300 },
    items: [
      { catalogueItemId: 'citem_000_0', name: 'Chicken & Chips', quantity: 1, unitPriceTZS: 12000 },
      { catalogueItemId: 'citem_000_1', name: 'Beef Pilau', quantity: 1, unitPriceTZS: 9000 },
      { catalogueItemId: 'citem_000_4', name: 'Milk Tea', quantity: 2, unitPriceTZS: 1500 },
    ],
    events: [
      { status: 'paid', at: nowIso(), by: 'system', note: 'Paid via M-Pesa' },
      { status: 'cancelled', at: nowIso(), by: 'customer', note: 'Changed my mind' },
      { status: 'refunded', at: nowIso(), by: 'system', note: 'Refund issued to M-Pesa' },
    ],
  };

  const disputed: OrderDetail = {
    ...fixtureOrderDetail({ merchantId: merchants[0].id, deliveryAddress: address }),
    id: 'ord_disputed_007',
    no: 'HD-OR-475903',
    status: 'disputed',
    totals: { subtotalTZS: 9000, deliveryFeeTZS: 2500, platformFeeTZS: 800, taxTZS: 0, discountTZS: 0, totalTZS: 12300 },
    items: [{ catalogueItemId: 'citem_000_1', name: 'Beef Pilau', quantity: 1, unitPriceTZS: 9000 }],
    events: [
      { status: 'paid', at: nowIso(), by: 'system', note: 'Paid via M-Pesa' },
      { status: 'delivered', at: nowIso(), by: 'rider', note: 'Handed to customer' },
      { status: 'disputed', at: nowIso(), by: 'customer', note: 'Missing item' },
    ],
  };

  const orders: OrderDetail[] = [active, intercity, warehouse, relay, rush, completed, completed2, refunded, disputed];

  const routes = new Map<string, RouteSegment[]>();
  routes.set(intercity.id, buildRoute());
  routes.set(relay.id, buildRelayRoute());

  const waybills = new Map<string, { waybillNumber: string; events: WaybillEvent[] }>();
  waybills.set(intercity.id, buildWaybill());
  waybills.set(relay.id, buildRelayWaybill());
  waybills.set(warehouse.id, {
    waybillNumber: warehouse.waybillNumber ?? 'WB-1107-DAR',
    events: [
      { at: nowIso(), type: 'scanned', location: 'Dar es Salaam warehouse', actor: 'warehouse staff', note: 'Picked and packed' },
      { at: nowIso(), type: 'scanned', location: 'Dar es Salaam warehouse', actor: 'rider' },
    ],
  });

  const wallet = fixtureWallet();
  const walletTransactions = fixtureWalletTransactions(8);

  const booking: BookingDetail = {
    id: 'bk_active_001',
    status: 'provider_accepted',
    providerId: 'prov_001',
    serviceId: 'svc_001',
    scheduledFor: new Date(Date.now() + 6 * 3600_000).toISOString(),
    address,
    description: 'Kitchen sink is leaking under the counter',
    price: { subtotalTZS: 60000, deliveryFeeTZS: 0, platformFeeTZS: 5000, taxTZS: 0, discountTZS: 0, totalTZS: 65000 },
    events: [
      { status: 'paid', at: nowIso(), by: 'system', note: 'Paid via M-Pesa' },
      { status: 'provider_accepted', at: nowIso(), by: 'provider', note: 'Rashid will arrive at the scheduled time' },
    ],
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };

  // Quote pending: provider submitted a final quote (labor + parts + trip) and
  // waits for the customer decision (quoteStatus quote_issued → decision flow).
  const quoteBooking: BookingDetail & { quote?: BookingQuote } = {
    id: 'bk_quote_002',
    status: 'quote_submitted',
    providerId: 'prov_001',
    serviceId: 'svc_001',
    scheduledFor: new Date(Date.now() + 5 * 3600_000).toISOString(),
    address,
    description: 'Bathroom mixer tap replacement',
    quoteStatus: 'quote_issued',
    quote: {
      laborTZS: 80000,
      tripFeeTZS: 15000,
      parts: [
        { name: 'Mixer tap', quantity: 1, unitCostTZS: 45000 },
        { name: 'Plumber tape', quantity: 2, unitCostTZS: 3000 },
      ],
      expiresAt: new Date(Date.now() + 48 * 3600_000).toISOString(),
      note: 'Quote includes labour, parts and trip fee. Valid for 48 hours.',
    },
    events: [
      { status: 'paid', at: nowIso(), by: 'system', note: 'Paid via M-Pesa' },
      { status: 'provider_accepted', at: nowIso(), by: 'provider', note: 'Rashid inspected the job on site' },
      { status: 'quote_submitted', at: nowIso(), by: 'provider', note: 'Final quote submitted — awaiting your decision' },
    ],
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };

  const declinedBooking: BookingDetail = {
    id: 'bk_declined_003',
    status: 'declined',
    providerId: 'prov_001',
    serviceId: 'svc_001',
    scheduledFor: new Date(Date.now() + 3 * 3600_000).toISOString(),
    address,
    description: 'Water heater stopped heating',
    price: { subtotalTZS: 60000, deliveryFeeTZS: 0, platformFeeTZS: 5000, taxTZS: 0, discountTZS: 0, totalTZS: 65000 },
    events: [
      { status: 'paid', at: nowIso(), by: 'system', note: 'Paid via M-Pesa' },
      { status: 'provider_requested', at: nowIso(), by: 'system', note: 'Looking for a provider' },
      { status: 'declined', at: nowIso(), by: 'provider', note: 'Provider could not take the job' },
    ],
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };

  const noShowBooking: BookingDetail = {
    id: 'bk_noshow_004',
    status: 'no_show',
    providerId: 'prov_001',
    serviceId: 'svc_003',
    scheduledFor: new Date(Date.now() + 2 * 3600_000).toISOString(),
    address,
    description: 'Deep clean of two bedrooms and the lounge',
    price: { subtotalTZS: 90000, deliveryFeeTZS: 0, platformFeeTZS: 5000, taxTZS: 0, discountTZS: 0, totalTZS: 95000 },
    events: [
      { status: 'paid', at: nowIso(), by: 'system', note: 'Paid via M-Pesa' },
      { status: 'scheduled', at: nowIso(), by: 'provider', note: 'Scheduled for the agreed window' },
      { status: 'no_show', at: nowIso(), by: 'provider', note: 'Provider did not arrive' },
    ],
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };

  // Completion-confirmation seed: 'awaiting_customer_confirmation' is the
  // positive path for the booking "Confirm completion" flow — the booking
  // detail renders t('booking.complete') for this status and the mock
  // complete() 204s. The E2E completion spec (booking-flow.e2e.ts) and the
  // activity center's active bookings scope cover this state.
  const confirmBooking: BookingDetail = {
    id: 'bk_confirm_005',
    status: 'awaiting_customer_confirmation',
    providerId: 'prov_001',
    serviceId: 'svc_001',
    scheduledFor: new Date(Date.now() - 3600_000).toISOString(),
    address,
    description: 'Kitchen sink fixed — confirm the job is done',
    price: { subtotalTZS: 60000, deliveryFeeTZS: 0, platformFeeTZS: 5000, taxTZS: 0, discountTZS: 0, totalTZS: 65000 },
    events: [
      { status: 'paid', at: nowIso(), by: 'system', note: 'Paid via M-Pesa' },
      { status: 'provider_accepted', at: nowIso(), by: 'provider', note: 'Rashid arrived on time' },
      { status: 'in_progress', at: nowIso(), by: 'provider', note: 'Work done — awaiting your confirmation' },
    ],
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };

  const reviewDone: Review = {
    id: 'rev_001',
    targetType: 'merchant',
    targetId: merchants[0].id,
    rating: 4,
    body: 'Delicious pilau, arrived hot. Asante!',
    state: 'published',
    createdAt: nowIso(),
  };

  const notifications: Notification[] = [
    { id: 'ntf_1', type: 'order.delivering', title: 'Order on the way', body: 'Your rider is delivering HD-OR-482913', deepLink: 'order/ord_active_001', read: false, createdAt: nowIso() },
    { id: 'ntf_2', type: 'payment.success', title: 'Payment received', body: 'TZS 27,300 paid for order HD-OR-482913', deepLink: 'order/ord_active_001', read: false, createdAt: nowIso() },
    { id: 'ntf_3', type: 'promotion', title: 'Weekend offer', body: 'Free delivery on orders above TZS 30,000', deepLink: null, read: true, createdAt: nowIso() },
  ];

  const openConversation: ConversationState = {
    id: 'conv_001',
    merchantId: merchants[0].id,
    orderId: 'ord_active_001',
    subject: 'Order #HD-OR-482913 help',
    status: ConversationStatus.open,
    unreadCount: 2,
    lastMessagePreview: 'Asante! Your rider is 5 minutes away.',
    participants: [
      { role: 'customer', displayName: 'You', maskedPhone: MOCK_PHONE },
      { role: 'merchant_staff', displayName: 'Sunrise Kitchen', maskedPhone: '+2557******01' },
    ],
    createdAt: nowIso(),
    updatedAt: nowIso(),
    messages: [
      { id: 'msg_1', conversationId: 'conv_001', authorRole: 'customer', body: 'Hi, is my order ready?', createdAt: nowIso(), readAt: nowIso() },
      { id: 'msg_2', conversationId: 'conv_001', authorRole: 'merchant_staff', body: 'Almost! The rider is at the restaurant now.', createdAt: nowIso(), readAt: null },
      { id: 'msg_3', conversationId: 'conv_001', authorRole: 'merchant_staff', body: 'Asante! Your rider is 5 minutes away.', createdAt: nowIso(), readAt: null },
    ],
  };

  const blockedConversation: ConversationState = {
    id: 'conv_002',
    merchantId: merchants[1].id,
    subject: 'General',
    status: ConversationStatus.blocked,
    unreadCount: 0,
    lastMessagePreview: 'This conversation was closed by support',
    participants: [
      { role: 'customer', displayName: 'You', maskedPhone: MOCK_PHONE },
      { role: 'merchant_staff', displayName: 'Mama Nne Foods', maskedPhone: '+2557******02' },
    ],
    createdAt: nowIso(),
    updatedAt: nowIso(),
    messages: [
      { id: 'msg_4', conversationId: 'conv_002', authorRole: 'customer', body: 'Do you have coconut rice today?', createdAt: nowIso(), readAt: nowIso() },
      { id: 'msg_5', conversationId: 'conv_002', authorRole: 'system', body: 'This conversation was closed by HUDumika support', createdAt: nowIso(), readAt: null },
    ],
  };

  const ticket: TicketDetail = {
    id: 'ticket_001',
    subject: 'Missing item from order HD-OR-480112',
    status: TicketStatus.assigned,
    priority: 'normal',
    createdAt: nowIso(),
    updatedAt: nowIso(),
    messages: [
      { id: 'tmsg_1', authorRole: 'customer', body: 'The milk tea was missing from my order.', createdAt: nowIso() },
      { id: 'tmsg_2', authorRole: 'agent', body: 'Asante kwa taarifa — we are checking with the merchant.', createdAt: nowIso() },
    ],
  };

  const coupons: Coupon[] = [
    { id: 'coup_001', campaignId: 'camp_001', code: 'WELCOME20', title: '20% off your first order', discountTZS: 5000, minimumSpendTZS: 20000, status: CouponStatus.claimed, claimedAt: nowIso(), expiresAt: new Date(Date.now() + 14 * 86400_000).toISOString() },
    { id: 'coup_002', campaignId: 'camp_002', code: 'FREEDEL', title: 'Free delivery tonight', discountTZS: 2500, minimumSpendTZS: 15000, status: CouponStatus.available, expiresAt: new Date(Date.now() + 7 * 86400_000).toISOString() },
    { id: 'coup_003', campaignId: 'camp_003', code: 'SUMMER25', title: 'TZS 2,500 off rice dishes', discountTZS: 2500, minimumSpendTZS: 12000, status: CouponStatus.used, claimedAt: nowIso(), usedAt: nowIso(), expiresAt: new Date(Date.now() + 3 * 86400_000).toISOString() },
    { id: 'coup_004', campaignId: 'camp_004', code: 'OLD50', title: 'TZS 5,000 off', discountTZS: 5000, minimumSpendTZS: 30000, status: CouponStatus.expired, claimedAt: nowIso(), expiresAt: new Date(Date.now() - 86400_000).toISOString() },
  ];

  const groupBuys: GroupBuyDeal[] = [
    {
      id: 'gb_001', merchantId: merchants[0].id, title: '2-for-1 Chicken & Chips', description: 'Buy two platters, pay for one', priceTZS: 12000, originalPriceTZS: 24000, quantity: 100, soldCount: 42, validityDays: 90, salesStartAt: nowIso(), salesEndAt: new Date(Date.now() + 30 * 86400_000).toISOString(), status: 'live',
    },
    {
      id: 'gb_002', merchantId: merchants[1].id, title: 'Pilau bucket for 4', description: 'Family-size beef pilau bucket', priceTZS: 30000, originalPriceTZS: 45000, quantity: 60, soldCount: 18, validityDays: 60, salesStartAt: nowIso(), salesEndAt: new Date(Date.now() + 21 * 86400_000).toISOString(), status: 'live',
    },
  ];

  const vouchers: Voucher[] = [
    { code: 'GB-8F3K-4D2A', groupBuyId: 'gb_001', title: '2-for-1 Chicken & Chips', priceTZS: 12000, status: 'unused', purchasedAt: nowIso(), expiresAt: new Date(Date.now() + 90 * 86400_000).toISOString() },
    { code: 'GB-77QW-2Z9P', groupBuyId: 'gb_001', title: '2-for-1 Chicken & Chips', priceTZS: 12000, status: 'redeemed', purchasedAt: nowIso(), redeemedAt: nowIso(), redeemedByMerchantId: merchants[0].id },
    { code: 'GB-M4RT-6X3C', groupBuyId: 'gb_002', title: 'Pilau bucket for 4', priceTZS: 30000, status: 'expired', purchasedAt: new Date(Date.now() - 100 * 86400_000).toISOString(), expiresAt: new Date(Date.now() - 10 * 86400_000).toISOString() },
    { code: 'GB-K2VL-8N5E', groupBuyId: 'gb_002', title: 'Pilau bucket for 4', priceTZS: 30000, status: 'refunded', purchasedAt: new Date(Date.now() - 60 * 86400_000).toISOString(), redeemedAt: null },
    { code: 'GB-Q7JA-1H8U', groupBuyId: 'gb_001', title: '2-for-1 Chicken & Chips', priceTZS: 12000, status: 'void', purchasedAt: nowIso(), redeemedAt: null },
  ];

  // Dine-in tables map a tableId → merchant (the server owns this registry;
  // the customer app resolves it via GET /dine-in/tables/{tableId}/qr).
  const dineInTables = merchants.map((m, i) => ({ tableId: `table_${i}`, merchantId: m.id, label: `Table ${i + 1}` }));
  const dineInOrders: DineInOrder[] = [
    {
      id: 'dine_open_001',
      merchantId: merchants[0].id,
      tableId: 'table_0',
      status: 'open',
      items: [
        { catalogueItemId: `citem_${merchants[0].id.slice(-6)}_0`, name: 'Chicken & Chips', quantity: 2, unitPriceTZS: 12000 },
        { catalogueItemId: `citem_${merchants[0].id.slice(-6)}_1`, name: 'Beef Pilau', quantity: 1, unitPriceTZS: 9000 },
      ],
      totals: { subtotalTZS: 33000, deliveryFeeTZS: 0, platformFeeTZS: 0, taxTZS: 0, discountTZS: 0, totalTZS: 33000 },
      createdAt: nowIso(),
    },
    {
      id: 'dine_paid_002',
      merchantId: merchants[2].id,
      tableId: 'table_2',
      status: 'paid',
      items: [{ catalogueItemId: `citem_${merchants[2].id.slice(-6)}_2`, name: 'Mandazi (4 pcs)', quantity: 2, unitPriceTZS: 2000 }],
      totals: { subtotalTZS: 4000, deliveryFeeTZS: 0, platformFeeTZS: 0, taxTZS: 0, discountTZS: 0, totalTZS: 4000 },
      createdAt: nowIso(),
      paidAt: nowIso(),
    },
  ];

  const providers: ProviderPublic[] = home.providers.length ? home.providers : [];

  return {
    user: {
      id: MOCK_CUSTOMER_ID,
      phone: MOCK_PHONE,
      fullName: 'Demo Customer',
      email: null,
      activeRole: 'customer',
      roles: [{ role: 'customer' }],
      locale: 'en',
      createdAt: nowIso(),
    },
    cities: buildCities(),
    home: { ...home, providers, generatedAt: nowIso() },
    merchants,
    catalogues,
    promotions,
    orders,
    intents: [
      { id: 'intent_active', status: PaymentIntentStatus.paid, amountTZS: 27300, method: 'mpesa', orderId: 'ord_active_001', providerReference: 'PR-88213-MPESA', paidAt: nowIso() },
      { id: 'intent_refunded', status: PaymentIntentStatus.refunded, amountTZS: 27300, method: 'mpesa', orderId: 'ord_refunded_006', providerReference: 'PR-88122-MPESA', paidAt: nowIso() },
    ],
    intentForOrder: new Map([
      ['ord_active_001', { id: 'intent_active', status: PaymentIntentStatus.paid, amountTZS: 27300, method: 'mpesa', providerReference: 'PR-88213-MPESA', paidAt: nowIso() }],
      ['ord_refunded_006', { id: 'intent_refunded', status: PaymentIntentStatus.refunded, amountTZS: 27300, method: 'mpesa', providerReference: 'PR-88122-MPESA', paidAt: nowIso() }],
    ]),
    routes,
    waybills,
    wallet,
    walletTransactions,
    bookings: [booking, quoteBooking, declinedBooking, noShowBooking, confirmBooking],
    reviews: [reviewDone],
    notifications,
    preferences: {
      push: { 'order.status': true, 'payment': true, 'promotion': false, 'security': true },
      sms: { 'order.status': false, 'payment': true },
      email: { 'order.status': false },
      inApp: { 'order.status': true, 'payment': true, 'promotion': true },
    },
    tickets: [ticket],
    conversations: [openConversation, blockedConversation],
    coupons,
    favorites: [],
    membership: { points: 240, level: 'bronze', memberSince: nowIso(), benefits: ['Priority support', 'Member-only offers', 'Birthday reward'] },
    groupBuys,
    vouchers,
    dineInOrders,
    dineInTables,
    reservations: [],
    searchHistory: ['chicken and chips', 'plumber', 'mango smoothie'],
    otpRequests: new Map(),
    otpCounter: 0,
    lastOtpRequestAt: new Map(),
    customerLocation: { lat: -6.7924, lon: 39.2083 },
    orderReplays: new Map(),
    intentReplays: new Map(),
    paymentFailure: null,
  };
}

export const nowIso = () => new Date().toISOString();

let state: MockState = buildState();

export function getState(): MockState {
  return state;
}

export function resetMockState(): void {
  setFixturesSeed(MOCK_SEED);
  state = buildState();
}

/** Deep-clone a plain contract object so consumers can't mutate mock state. */
export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function findMerchant(merchantId: string): MerchantPublic {
  const merchant = state.merchants.find((m) => m.id === merchantId);
  if (!merchant) throw new ApiError(404, 'NOT_FOUND', `Merchant ${merchantId} not found`);
  return merchant;
}

export function findOrder(orderId: string): OrderDetail {
  const order = state.orders.find((o) => o.id === orderId);
  if (!order) throw new ApiError(404, 'ORDER_NOT_FOUND', `Order ${orderId} not found`);
  return order;
}

export function findCatalogueItem(merchantId: string, itemId: string): CatalogueItem {
  const item = state.catalogues.get(merchantId)?.items.find((i) => i.id === itemId);
  if (!item) throw new ApiError(404, 'ITEM_NOT_FOUND', `Catalogue item ${itemId} not found`);
  return item;
}

export function trackFor(order: OrderDetail): TrackingEvent {
  return {
    status: order.status,
    riderLocation: order.status === 'picked_up' || order.status === 'delivering' || order.status === 'rider_arrived_dropoff'
      ? { lat: state.customerLocation.lat + 0.004, lon: state.customerLocation.lon - 0.003 }
      : undefined,
    updatedAt: order.updatedAt ?? order.createdAt,
    estimateMinutes: order.deliveryEtaMin ?? 20,
  };
}

export function orderTimelinePhases(order: OrderDetail): TrackingPhase[] {
  const ORDER_FLOW = [
    'draft', 'pending_payment', 'paid', 'merchant_accepted', 'preparing', 'rider_assigned',
    'picked_up', 'delivering', 'delivered', 'completed',
  ] as const;
  const idx = ORDER_FLOW.indexOf(order.status as (typeof ORDER_FLOW)[number]);
  const PHASES = [
    { phase: 'confirmed' as const, label: 'Order confirmed' },
    { phase: 'picked_up' as const, label: 'Picked up' },
    { phase: 'in_transit' as const, label: 'Traveling' },
    { phase: 'arrived_city' as const, label: 'Arrived in your city' },
    { phase: 'out_for_delivery' as const, label: 'Out for delivery' },
    { phase: 'delivered' as const, label: 'Delivered' },
  ];
  const phaseIdx = idx >= 6 ? 5 : Math.max(0, idx - 1);
  return PHASES.map((p, i) => ({
    ...p,
    status: i < phaseIdx ? 'completed' : i === phaseIdx ? 'active' : 'pending',
    at: i < phaseIdx ? nowIso() : null,
    eta: i === phaseIdx && idx < 6 ? new Date(Date.now() + 25 * 60_000).toISOString() : null,
  }));
}

export function phaseForOrder(order: OrderDetail): TrackingPhase[] {
  if (order.id === 'ord_intercity_002' || order.id === 'ord_relay_005') return buildPhases();
  if (order.id === 'ord_warehouse_003') {
    return buildPhases([
      { phase: 'confirmed', status: 'completed', at: nowIso() },
      { phase: 'picked_up', status: 'completed', at: nowIso() },
      { phase: 'in_transit', status: 'completed', at: nowIso(), eta: null },
      { phase: 'arrived_city', status: 'completed', at: nowIso(), eta: null },
      { phase: 'out_for_delivery', status: 'active', at: null, eta: new Date(Date.now() + 45 * 60_000).toISOString() },
      { phase: 'delivered', status: 'pending', at: null, eta: null },
    ]);
  }
  if (order.id === 'ord_active_001') {
    return buildPhases([
      { phase: 'confirmed', status: 'completed', at: nowIso() },
      { phase: 'picked_up', status: 'completed', at: nowIso() },
      { phase: 'in_transit', status: 'completed', at: nowIso(), eta: null },
      { phase: 'arrived_city', status: 'completed', at: nowIso(), eta: null },
      { phase: 'out_for_delivery', status: 'active', at: null, eta: new Date(Date.now() + 18 * 60_000).toISOString() },
      { phase: 'delivered', status: 'pending', at: null, eta: null },
    ]);
  }
  return orderTimelinePhases(order);
}

export function buildOrderFrom(input: {
  merchantId: string;
  items: { catalogueItemId: string; quantity: number; unitPriceTZS: number; options?: string[] }[];
  deliveryAddress: OrderDetail['deliveryAddress'];
  note?: string;
  scheduledAt?: string | null;
}, cod: boolean, couponDiscountTZS = 0): OrderDetail {
  // The server is the price authority: line unit price = catalogue base
  // (validated) + the price of every resolved option/addon. Clients only send
  // the base price and the option keys — anything else is ORDER_PRICE_CHANGED.
  const lines = input.items.map((i) => {
    const current = findCatalogueItem(input.merchantId, i.catalogueItemId);
    const extraTZS = (i.options ?? []).reduce((acc, opt) => acc + (optionPriceFor(current, opt) ?? 0), 0);
    return { catalogueItemId: i.catalogueItemId, name: current.name, quantity: i.quantity, unitPriceTZS: i.unitPriceTZS + extraTZS };
  });
  const subtotalTZS = lines.reduce((acc, i) => acc + i.unitPriceTZS * i.quantity, 0);
  const deliveryFeeTZS = 2500;
  const platformFeeTZS = 800;
  const taxTZS = 0;
  // Coupon discount (CONTRACT-ADDITIONS.md #10, mock-only until the contract
  // ships couponId on OrderCreate): the caller validated the coupon and the
  // discount rides totals.discountTZS — the sum rule
  // (subtotal + delivery + platform + tax − discount = total) holds.
  const discountTZS = couponDiscountTZS;
  const merchant = findMerchant(input.merchantId);
  const order: OrderDetail = {
    id: uid('ord'),
    no: `HD-OR-${String(900000 + Math.floor(Math.random() * 90000))}`,
    status: cod ? 'paid' : 'pending_payment',
    merchantId: input.merchantId,
    source: 'app',
    fulfillmentType: 'local',
    dispatchStrategy: 'nearest',
    totals: { subtotalTZS, deliveryFeeTZS, platformFeeTZS, taxTZS, discountTZS, totalTZS: subtotalTZS + deliveryFeeTZS + platformFeeTZS + taxTZS - discountTZS },
    items: lines,
    deliveryAddress: input.deliveryAddress ?? fixtureAddress(),
    events: [{ status: cod ? 'paid' : 'draft', at: nowIso(), by: 'customer', note: input.note }],
    createdAt: nowIso(),
    scheduledAt: input.scheduledAt ?? null,
    deliveryEtaMin: merchant.deliveryMinutes ?? 30,
  };
  return order;
}

/** Resolve an option key (choice label or addon name) against the catalogue
 * item. Returns null when the key does not exist — the server rejects it. */
export function optionPriceFor(item: CatalogueItem, option: string): number | null {
  const choice = (item.options ?? []).flatMap((g) => g.choices).find((c) => c.label === option);
  if (choice) return choice.priceTZS;
  const addon = (item.addons ?? []).find((a) => a.name === option);
  if (addon) return addon.priceTZS;
  return null;
}

export function validateOrderInput(merchant: MerchantPublic, items: { catalogueItemId: string; quantity: number; unitPriceTZS: number; options?: string[] }[], scheduledAt?: string | null) {
  if (!merchant.isOpen) throw new ApiError(422, 'ORDER_MERCHANT_CLOSED', 'This merchant is currently closed');
  if (!items.length) throw new ApiError(422, 'ORDER_EMPTY', 'Order has no items');
  if (scheduledAt && new Date(scheduledAt).getTime() < Date.now()) {
    throw new ApiError(422, 'ORDER_SCHEDULED_IN_PAST', 'Scheduled time is in the past');
  }
  for (const item of items) {
    const current = findCatalogueItem(merchant.id, item.catalogueItemId);
    if (current.available === false) {
      throw new ApiError(422, 'ORDER_ITEM_UNAVAILABLE', `${current.name} is no longer available`);
    }
    // unitPriceTZS is the BASE price — paid options must never be folded in
    // client-side (that would trip ORDER_PRICE_CHANGED); the server prices them.
    if (current.priceTZS !== item.unitPriceTZS) {
      throw new ApiError(422, 'ORDER_PRICE_CHANGED', `Price changed for ${current.name}`, false, { itemId: current.id, expectedPriceTZS: current.priceTZS });
    }
    for (const opt of item.options ?? []) {
      if (optionPriceFor(current, opt) === null) {
        throw new ApiError(422, 'VALIDATION_FAILED', `${opt} is not a valid option for ${current.name}`, false, { itemId: current.id, option: opt });
      }
    }
  }
}

export const ACTIVE_ORDER_STATUSES: OrderStatus[] = ['pending_payment', 'paid', 'merchant_accepted', 'preparing', 'rider_assigned', 'picked_up', 'delivering'];
export const TERMINAL_ORDER_STATUSES: OrderStatus[] = ['delivered', 'completed', 'cancelled', 'refunded', 'failed', 'disputed'];

export function createNotification(state: MockState, n: Omit<Notification, 'id' | 'read' | 'createdAt'>): void {
  state.notifications.unshift({ ...n, id: uid('ntf'), read: false, createdAt: nowIso() });
}

/** Demo/test hook: make the next payment confirm() fail like a provider outage. */
export function simulatePaymentFailure(code: string, retryAfterSeconds?: number): void {
  getState().paymentFailure = { code, retryAfterSeconds };
}
