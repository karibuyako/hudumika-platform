/* Repository interfaces — the ONLY thing screens import from the API layer.
 *
 * House pattern (docs/MOBILE-MOCK-PATTERN.md): screens depend on these
 * interfaces, never on mocks or the HTTP client directly. Swap mock → live in
 * one place: src/repos/factories.ts (EXPO_PUBLIC_MOCK_* env switches, default on).
 *
 * All DTOs come from @hudumika/contract (generated from backend/API-CONTRACT.yaml).
 * Money is integer minor units of TZS everywhere. Never add endpoints here —
 * the contract is the single source of truth.
 */
import type {
  AssistantReply,
  BirthdayReward,
  Booking,
  BookingCreate,
  BookingDetail,
  BookingEstimate,
  Catalogue,
  ChatMessage,
  ChatMessageCreateAttachmentsItem,
  City,
  Conversation,
  ConversationCreate,
  ConversationDetail,
  Coupon,
  CustomerMembership,
  DailyCheckIn200,
  DecideBookingQuoteBodyDecision,
  DineInOrder,
  DownloadInvoice200,
  EventDetail,
  EventListing,
  EventTicket,
  GetConsumerHome200,
  GetOrderWaybill200,
  GroupBuyDeal,
  Hotel,
  HotelBooking,
  HotelDetail,
  ImageSearchBody,
  Invoice,
  ListHelpArticles200Item,
  ListLoyaltyTransactions200Item,
  LiveDealSession,
  MerchantPublic,
  MaskedCallSession,
  Notification,
  NotificationPreferences,
  Order,
  OrderCreate,
  OrderCreateItemsItem,
  OrderDetail,
  PaymentIntent,
  PaymentIntentCreateMethod,
  Promotion,
  ProviderPublic,
  ReportTransactionIssueBody,
  RequestOrderModification202,
  RequestOrderModificationBodyType,
  RequestPrivacyExport202,
  ReferralReward,
  ReferralSummary,
  Reservation,
  RequestOtpBodyChannel,
  RequestOtpBodyPurpose,
  Review,
  ReviewCreate,
  ReviewReport,
  RoleSummary,
  RouteSegment,
  SearchResults,
  ServiceCategoryConfig,
  ServiceQuestion,
  SessionInfo,
  Shipment,
  Ticket,
  TicketCreate,
  TicketDetail,
  TicketDetailMessagesItem,
  TipRiderBodyMethod,
  TopUpMyWalletBodyMethod,
  TrackingEvent,
  TrackingPhase,
  TravelBooking,
  TravelOption,
  User,
  UserUpdate,
  VoteReviewHelpful200,
  Voucher,
  Wallet,
  WalletTransaction,
  WaybillEvent,
  Withdrawal,
} from '@hudumika/contract';
import type { CuratedList } from '@/lib/lists';

/* ---------------- Auth ---------------- */

/** Contract RequestOtpBodyPurpose — login | signup | password_reset | verify_role. */
export type OtpPurpose = RequestOtpBodyPurpose;
/** Contract RequestOtpBodyChannel — phone | email. */
export type OtpChannel = RequestOtpBodyChannel;

export interface OtpRequestResult {
  requestId: string;
  expiresInSeconds: number;
  /** Contract OtpDelivery.resendInSeconds — server cooldown before resend. */
  resendInSeconds?: number;
  /** Mock-only extension: the dev code shown in the UI. Never present live. */
  debugCode?: string;
  demo?: boolean;
}

export interface AuthSession {
  accessToken: string;
  refreshToken?: string;
  user: User;
}

/** Social-login provider — mock-only until the contract ships the social
 * surface (docs/CONTRACT-ADDITIONS.md #19; OPERATIONS-COVERAGE #10 tracked
 * PLANNED with no OAuth endpoints in the generated contract — grep of the
 * endpoints under /auth finds only request-otp | verify-otp | refresh |
 * logout | change-password). A real Google/Apple OAuth redirect is a
 * native-phase concern (no expo-auth-session dependency); the mock-first
 * flow simulates the exchange server-side. */
export type SocialProvider = 'google' | 'apple';

/** POST /auth/social body — {provider, code}. `code` is the OAuth
 * authorization code from the provider redirect; the mock-first demo may
 * omit it (the exchange is simulated, mirroring the OTP debugCode demo) —
 * a live backend validates it like any credential check. */
export interface SocialLoginInput {
  provider: SocialProvider;
  /** OAuth authorization code — any non-empty value succeeds in the mock
   * (the exchange is simulated); an empty one → 422 VALIDATION_FAILED. */
  code?: string;
}

/** Two-factor status (mock-only-until-adopted, docs/CONTRACT-ADDITIONS.md
 * #23): `method` is 'otp' when enabled — the demo TOTP code. */
export interface TwoFactorStatus {
  enabled: boolean;
  method: 'otp' | null;
}

export interface AuthRepository {
  /** POST /auth/request-otp — purpose/channel are contract enums (defaults login/phone). */
  requestOtp(destination: string, purpose?: OtpPurpose, channel?: OtpChannel): Promise<OtpRequestResult>;
  verifyOtp(requestId: string, code: string, purpose?: 'login' | 'signup' | 'verify_role'): Promise<AuthSession>;
  /** POST /auth/social — social login. Mock-only-until-adopted
   * (docs/CONTRACT-ADDITIONS.md #19): the generated contract exposes no
   * OAuth endpoints, so the api repo calls the not-yet-contract path (parity
   * harness allow-list) and the mock simulates the exchange — any non-empty
   * code signs in the demo user (idempotent per key), an empty code →
   * 422 VALIDATION_FAILED. A real Google/Apple SDK is a native-phase concern. */
  socialLogin(input: SocialLoginInput, idempotencyKey: string): Promise<AuthSession>;
  me(): Promise<User>;
  listRoles(): Promise<RoleSummary[]>;
  updateProfile(patch: UserUpdate): Promise<User>;
  /** POST /privacy/delete — account deletion, then the app clears the session. */
  deleteAccount(): Promise<void>;
  /** POST /privacy/export — personal data export; contract returns {jobId, status}. */
  exportData(): Promise<RequestPrivacyExport202>;
  /** GET /sessions — active sessions for the user. */
  listSessions(): Promise<SessionInfo[]>;
  /** POST /sessions/{token}/revoke — revoke a session by its id/token. */
  revokeSession(token: string): Promise<void>;
  /** POST /auth/change-password — currentPassword + newPassword (contract:
   * newPassword minLength 8, maxLength 128; 204 on success). Idempotency so a
   * retry never double-processes the change. */
  changePassword(currentPassword: string, newPassword: string, idempotencyKey: string): Promise<void>;
  /** POST /push/tokens — register the device push token for the signed-in
   * user. Mock-only until the contract ships the consumer push-token endpoint
   * (docs/CONTRACT-ADDITIONS.md #2); register is idempotent (same token twice
   * succeeds) and rejects malformed tokens with PUSH_TOKEN_INVALID. */
  registerPushToken(token: string, idempotencyKey: string): Promise<void>;
  /** DELETE /push/tokens/{token} — unregister/revoke the token. Mock-only
   * until the contract ships the endpoint (docs/CONTRACT-ADDITIONS.md #2);
   * removing an unknown token is a no-op. */
  unregisterPushToken(token: string, idempotencyKey: string): Promise<void>;
  /** GET /users/me/2fa — two-factor status. Mock-only-until-adopted
   * (docs/CONTRACT-ADDITIONS.md #23): the consumer contract exposes no 2FA
   * surface (OPERATIONS-COVERAGE #9 PLANNED), so the api repo calls the
   * not-yet-contract path (parity harness allow-list) and the mock is the
   * server. */
  getTwoFactorStatus(): Promise<TwoFactorStatus>;
  /** POST /users/me/2fa — enable two-factor auth (OTP). Mock-only-until-
   * adopted path (#23); idempotent per key. `demoCode` is a mock-only
   * extension (same pattern as OtpRequestResult.debugCode) — never present
   * live. */
  enableTwoFactor(idempotencyKey: string): Promise<{ enabled: true; demoCode?: string }>;
  /** DELETE /users/me/2fa — disable two-factor auth; requires the current
   * code (a wrong one answers the contract's 401 UNAUTHORIZED). Mock-only-
   * until-adopted path (#23); idempotent per key. */
  disableTwoFactor(code: string, idempotencyKey: string): Promise<{ enabled: false }>;
  /** POST /auth/2fa/verify — verify a two-factor code for a sensitive action
   * (MASTER-BLUEPRINT §21 gates). Mock-only-until-adopted path (#23). */
  verifyTwoFactor(code: string): Promise<{ valid: boolean }>;
  logout(): Promise<void>;
}

/* ---------------- Assistant (Xiaomei-lite) ---------------- */

/** POST /assistant/chat — the AI assistant (contract AssistantChatBody →
 * AssistantReply). Replies and suggestions are SERVER text: the screen
 * renders them verbatim, never through i18n (a live model owns that copy).
 * `context` is an optional app-local bag (user id/name/role, city, …) that
 * the server may use to personalize; contract allows any object. */
export interface AssistantRepository {
  chat(message: string, context?: Record<string, unknown>): Promise<AssistantReply>;
}

/* ---------------- Home ---------------- */

/** One personalized recommendation card (mock-only-until-adopted,
 * docs/CONTRACT-ADDITIONS.md #25 — MASTER-BLUEPRINT §5 personalization,
 * PLANNED v3): the generated GetConsumerHome200 has NO recommendations field
 * (verified — it carries generatedAt/location/categories/merchants/providers/
 * promotions/groupBuys/recentOrders/unreadCount/membership only), so the
 * whole surface is app-layer until Team 6 ships it. `reason` is SERVER copy
 * (e.g. "Because you ordered from them" / "Top rated in your city") — screens
 * render it verbatim, never through i18n. */
export interface RecommendedMerchant {
  merchantId: string;
  businessName: string;
  rating: number;
  reviewCount: number;
  /** Server-owned recommendation explanation — mock-as-server copy. */
  reason: string;
  deliveryMinutes?: number;
}

/** Consent gate for the home recommendations section (MASTER-BLUEPRINT §5:
 * personalization runs only after the user grants consent). Pure so tests
 * pin it: no consent → the section renders nothing (honest), with consent →
 * the repo drives it. */
export function canShowRecommendations(consentGranted: boolean): boolean {
  return consentGranted;
}

export interface HomeRepository {
  getHomeFeed(): Promise<GetConsumerHome200>;
  listCities(): Promise<City[]>;
  /** GET /home/recommendations — mock-only-until-adopted path
   * (docs/CONTRACT-ADDITIONS.md #25, parity harness allow-list): the consumer
   * contract exposes no recommendations surface, so the api repo calls the
   * not-yet-contract path and the mock is the server. The screen gates this
   * on the 'personalization' consent purpose — the repo itself never checks
   * consent (server-side concern on adoption). */
  getRecommendations(): Promise<RecommendedMerchant[]>;
}

/* ---------------- Search ---------------- */

/** Sort keys for search results — same vocabulary the contract backlog
 * proposes for UnifiedSearchParams (docs/CONTRACT-ADDITIONS.md #3).
 * 'relevance' is the server default (result order as returned). */
export type SearchSort = 'relevance' | 'rating' | 'price_asc' | 'price_desc' | 'distance';

export interface SearchQueryOptions {
  category?: string;
  entityType?: string;
  cursor?: string;
  limit?: number;
  /** Mock-only until the contract ships price/rating/distance/sort on
   * UnifiedSearchParams (docs/CONTRACT-ADDITIONS.md #3): the live repo
   * appends these to the query string, but the generated contract does not
   * accept them yet. The mock implements them server-side. */
  priceMaxTZS?: number;
  minRating?: number;
  maxDistanceKm?: number;
  sort?: SearchSort;
}

export interface SearchRepository {
  search(query: string, opts?: SearchQueryOptions): Promise<SearchResults>;
  /** POST /search/voice — voice-search transcript; contract VoiceSearchBody
   * ({query}, maxLength 200) → SearchResults. Results mirror /search. */
  voiceSearch(query: string): Promise<SearchResults>;
  /** POST /search/image — visual search; contract ImageSearchBody
   * ({imageUrl}) → SearchResults. */
  imageSearch(input: ImageSearchBody): Promise<SearchResults>;
  suggest(query: string): Promise<string[]>;
  history(): Promise<string[]>;
  addToHistory(query: string): Promise<void>;
  clearHistory(): Promise<void>;
}

/* ---------------- Merchants / catalogues ---------------- */

export interface MerchantsRepository {
  list(params?: { cityId?: string; category?: string; cursor?: string; limit?: number }): Promise<MerchantPublic[]>;
  get(merchantId: string): Promise<MerchantPublic>;
  getCatalogue(merchantId: string): Promise<Catalogue>;
  getPromotions(merchantId: string): Promise<Promotion[]>;
}

/* ---------------- Providers / services ---------------- */

export interface ProvidersRepository {
  listServices(params?: { cityId?: string; category?: string }): Promise<ServiceCategoryConfig[]>;
  getQuestions(serviceCategoryId: string): Promise<ServiceQuestion[]>;
  list(params?: { cityId?: string; trade?: string; cursor?: string; limit?: number }): Promise<ProviderPublic[]>;
  get(providerId: string): Promise<ProviderPublic>;
  /** GET /providers/me/preferred — my preferred providers. Mock-only-until-
   * adopted (OPERATIONS-COVERAGE #140 "Set preferred providers" PLANNED,
   * docs/CONTRACT-ADDITIONS.md #22): the consumer contract exposes no
   * preference surface, so the api repo calls the not-yet-contract path
   * (parity allow-list) and the mock serves the module-local registry. */
  listPreferred(): Promise<ProviderPublic[]>;
  /** PUT /providers/{providerId}/preference — body {preferred: boolean};
   * returns the provider with the updated preference. Mock-only-until-adopted
   * path (#19): unknown provider → 404 NOT_FOUND, and the mutation is
   * idempotent per key (replaying a key never double-applies). */
  setPreferred(providerId: string, preferred: boolean, idempotencyKey: string): Promise<ProviderPublic>;
}

/* ---------------- Orders ---------------- */

export interface OrderCreateInput {
  merchantId: string;
  items: (OrderCreateItemsItem & { unitPriceTZS?: number })[];
  paymentMethod: OrderCreate['paymentMethod'];
  deliveryAddress?: OrderCreate['deliveryAddress'];
  note?: string;
  scheduledAt?: string | null;
  /** Mock-only until the contract adds couponId to OrderCreate
   * (docs/CONTRACT-ADDITIONS.md #10): the live repo passes it through in the
   * body (a backend that has not shipped the field ignores it); the mock
   * validates it server-side and applies the discount. */
  couponId?: string;
}

export interface Waybill {
  waybillNumber: string;
  events: WaybillEvent[];
}

/** POST /orders/{id}/modify-request body — type is the contract enum
 * (change_address | change_time | add_item | remove_item | other); note is
 * contract field `note`, maxLength 500. */
export interface OrderModificationInput {
  type: RequestOrderModificationBodyType;
  note?: string;
}

/** POST /orders/{id}/tip method — contract TipRiderBodyMethod
 * (mpesa | tigo_pesa | airtel_money | ezy_pesa | halotel | card | cod | wallet). */
export type OrderTipMethod = TipRiderBodyMethod;

/** POST /orders/{id}/tip body — contract TipRiderBody {amountTZS ≥ 1,
 * method, note maxLength 200}. Money is integer TZS. */
export interface OrderTipInput {
  amountTZS: number;
  method: OrderTipMethod;
  note?: string;
}

export interface OrdersRepository {
  create(input: OrderCreateInput, idempotencyKey: string): Promise<Order>;
  list(params?: { status?: string; cursor?: string; limit?: number }): Promise<Order[]>;
  get(orderId: string): Promise<OrderDetail>;
  cancel(orderId: string, reason: string, idempotencyKey: string): Promise<Order>;
  rush(orderId: string, idempotencyKey: string): Promise<void>;
  /** POST /orders/{id}/modify-request — request a change to an active order
   * (202 {requestId, status: pending_approval}); 409 ORDER_MODIFICATION_NOT_ALLOWED
   * outside the modifiable window / ORDER_MODIFICATION_PENDING while one is open. */
  modifyRequest(orderId: string, input: OrderModificationInput, idempotencyKey: string): Promise<RequestOrderModification202>;
  /** POST /orders/{id}/tip — tip the rider after delivery (contract
   * TipRiderBody; returns the updated order with tipTZS set). 409
   * TIP_NOT_ALLOWED before delivery/completion, 422 VALIDATION_FAILED for
   * amount < 1 or an unknown method. Idempotent per key. */
  tip(orderId: string, input: OrderTipInput, idempotencyKey: string): Promise<OrderDetail>;
  track(orderId: string): Promise<TrackingEvent>;
  getRoute(orderId: string): Promise<RouteSegment[]>;
  getWaybill(orderId: string): Promise<Waybill>;
  getTrackingPhases(orderId: string): Promise<TrackingPhase[]>;
  /** POST /orders/{id}/masked-call — number privacy (blueprint §19). */
  createMaskedCall(orderId: string, idempotencyKey: string): Promise<MaskedCallSession>;
  /** Mock-only until the contract carries deliveryWindowFrom/To on the order
   * and tracking payloads (docs/CONTRACT-ADDITIONS.md #5): the live repo
   * returns null; the mock returns the seeded window for the intercity order. */
  getDeliveryWindow(orderId: string): Promise<DeliveryWindow | null>;
  /** Mock-only until the contract carries originCityName/destinationCityName
   * on the tracking payload (docs/CONTRACT-ADDITIONS.md #5): the live repo
   * returns null; the mock returns the seeded cities for the intercity order. */
  getRouteCities(orderId: string): Promise<RouteCities | null>;
  /** POST /orders/{id}/tracking-share — create a view-only tracking share
   * link (OPERATIONS-COVERAGE #77 "Share live location — trip-share pattern",
   * docs/CONTRACT-ADDITIONS.md #27): sharing your live order tracking with a
   * friend/family member via a link with a short-lived token. Mock-only-until-
   * adopted: the consumer contract exposes no tracking-share surface, so the
   * api repo calls the not-yet-contract path (parity harness allow-list) and
   * the mock generates + validates the token (ts_{order}_{randoms}, expiresAt
   * now+2h — expiry rule in #27). Unknown order → 404 ORDER_NOT_FOUND.
   * Idempotent per key (a replay returns the stored token). */
  createTrackingShare(orderId: string, idempotencyKey: string): Promise<TrackingShare>;
  /** GET /tracking-share/{token} — resolve a share token to its order id.
   * Mock-only-until-adopted path (#27): the api repo maps 404 → null (a live
   * backend that has not shipped the path keeps the recipient screen in its
   * unavailable state, same pattern as the booking document GETs); the mock
   * throws 404 NOT_FOUND for an unknown token and 410 TRIP_SHARE_EXPIRED
   * (the ERROR-CODES.md trip-share code) once expired. */
  resolveTrackingShare(token: string): Promise<{ orderId: string } | null>;
}

/** Mock-only delivery-window value (CONTRACT-ADDITIONS.md #5) — ISO timestamps. */
export interface DeliveryWindow {
  from: string;
  to: string;
}

/** Mock-only route city names (CONTRACT-ADDITIONS.md #5). */
export interface RouteCities {
  origin: string;
  destination: string;
}

/** A view-only tracking share (mock-only until the contract ships the
 * surface — docs/CONTRACT-ADDITIONS.md #27, OPERATIONS-COVERAGE #77). The
 * token rides the share link (hudumika://track-share/{token}); `expiresAt`
 * is the ISO UTC moment after which the link stops resolving. */
export interface TrackingShare {
  token: string;
  expiresAt: string;
}

/* ---------------- Group ordering (拼单) ---------------- */

/** Meituan-style shared-cart session (docs/CONTRACT-ADDITIONS.md #11). The
 * consumer contract exposes NO shared-cart surface yet, so this whole
 * resource is mock-only-until-adopted: the api repo calls the not-yet-contract
 * paths (parity harness allow-list) and the mock is the server. Money is
 * integer TZS. */
export type GroupOrderStatus = 'open' | 'ordered' | 'expired';

export interface GroupOrderMemberItem {
  catalogueItemId: string;
  quantity: number;
  /** BASE catalogue price — validated against the catalogue at add time
   * (ORDER_PRICE_CHANGED otherwise); option prices are folded into the member
   * subtotal server-side, mirroring buildOrderFrom pricing. */
  unitPriceTZS: number;
  /** Option keys (choice labels + addon names) — the server prices them. */
  options?: string[];
}

export interface GroupOrderMember {
  name: string;
  items: GroupOrderMemberItem[];
  subtotalTZS: number;
}

export interface GroupOrder {
  id: string;
  merchantId: string;
  title: string;
  status: GroupOrderStatus;
  members: GroupOrderMember[];
  totals: {
    subtotalTZS: number;
    deliveryFeeTZS: number;
    platformFeeTZS: number;
    taxTZS: number;
    discountTZS: number;
    totalTZS: number;
  };
  expiresAt: string;
  createdAt: string;
  /** Set once the session was finalized into a real order. */
  orderId?: string;
}

/** One member's share of a finalized group order (mock-only display data —
 * the UI shows who added what; the live wire cannot carry it until Team 6
 * ships the field, docs/CONTRACT-ADDITIONS.md #11). */
export interface GroupOrderContribution {
  memberName: string;
  subtotalTZS: number;
  items: { catalogueItemId: string; quantity: number; unitPriceTZS: number }[];
}

/** The finalized order from a group session — contract OrderDetail plus the
 * mock-only member-contribution ledger (CONTRACT-ADDITIONS.md #11). */
export type GroupOrderFinalizedOrder = OrderDetail & {
  groupOrderContributions?: GroupOrderContribution[];
};

export interface GroupOrdersRepository {
  /** POST /group-orders — create a shared cart session. Mock-only until the
   * contract ships group-ordering endpoints (docs/CONTRACT-ADDITIONS.md #11):
   * the api repo calls the not-yet-contract paths (parity allow-list). */
  create(input: { merchantId: string; title?: string; expiresInMinutes?: number }, idempotencyKey: string): Promise<GroupOrder>;
  /** GET /group-orders/{id} — the session with members + items. */
  get(groupOrderId: string): Promise<GroupOrder>;
  /** POST /group-orders/{id}/items — a member adds items; the server validates
   * against the catalogue like order create does (ORDER_ITEM_UNAVAILABLE /
   * ORDER_PRICE_CHANGED). `unitPriceTZS` is the client-sent base price — the
   * server re-prices from the catalogue either way (same rule as
   * OrderCreateInput.items). */
  addItem(groupOrderId: string, memberName: string, item: { catalogueItemId: string; quantity: number; unitPriceTZS?: number; options?: string[] }, idempotencyKey: string): Promise<GroupOrder>;
  /** DELETE /group-orders/{id}/items — remove one of the member's lines. */
  removeItem(groupOrderId: string, memberName: string, catalogueItemId: string, idempotencyKey: string): Promise<GroupOrder>;
  /** POST /group-orders/{id}/finalize — one payer converts the shared cart
   * into a real order (reuses the order build path); the member contributions
   * ride a mock-only field. */
  finalize(groupOrderId: string, paymentMethod: OrderCreate['paymentMethod'], deliveryAddress: OrderDetail['deliveryAddress'], idempotencyKey: string): Promise<GroupOrderFinalizedOrder>;
}

/* ---------------- Shipments ---------------- */

/** App-layer shipment detail: the contract `Shipment` carries the logistics
 * envelope only (id, shipmentNumber, orderId, packages, status — generated
 * `getShipment`, READ-ONLY), so the consumer shipment surface (waybill trail,
 * tracking phases, route legs) is a mock-only extension until Team 6 ships it
 * on the payload (docs/CONTRACT-ADDITIONS.md #8): the live repo returns null
 * for the extras; the mock serves the seeded values from the order's
 * tracking surfaces. */
export interface ShipmentDetail extends Shipment {
  /** Mock-only until the contract carries the waybill trail on the shipment
   * payload (CONTRACT-ADDITIONS.md #8): waybillNumber + scan/event trail. */
  waybill?: GetOrderWaybill200 | null;
  /** Mock-only until the contract carries tracking phases on the shipment
   * payload (CONTRACT-ADDITIONS.md #8): the six-phase journey strip. */
  phases?: TrackingPhase[] | null;
  /** Mock-only until the contract carries route legs on the shipment payload
   * (CONTRACT-ADDITIONS.md #8): the leg-by-leg route timeline. */
  route?: RouteSegment[] | null;
}

export interface ShipmentsRepository {
  /** GET /shipments — my shipments (contract ListShipmentsParams:
   * status/limit/cursor). */
  listMine(params?: { status?: string; cursor?: string; limit?: number }): Promise<Shipment[]>;
  /** GET /shipments/{shipmentId} — shipment detail; 404 → SHIPMENT_NOT_FOUND.
   * The shipment route is reached with an order id today, so the mock also
   * resolves records by their orderId. */
  get(shipmentId: string): Promise<ShipmentDetail>;
}

/* ---------------- Payments ---------------- */

export interface PaymentMethodRecord {
  id: string;
  method: string;
  label: string;
  last4?: string;
  isDefault?: boolean;
  /** Contract ListPaymentMethods200Item.available — undefined ⇒ assumed available. */
  available?: boolean;
}

/** Payment intent as surfaced to screens — the contract DTO omits orderId,
 * so the app layer carries the order→intent linkage (the mock maps it via
 * intentForOrder; the live API fills it once the contract exposes orderId). */
export interface OrderPaymentIntent extends PaymentIntent {
  orderId?: string;
}

export interface PaymentsRepository {
  createIntent(orderId: string, method: PaymentIntentCreateMethod, idempotencyKey: string): Promise<PaymentIntent>;
  confirm(intentId: string, idempotencyKey: string): Promise<PaymentIntent>;
  getPaymentMethods(): Promise<PaymentMethodRecord[]>;
  getHistory(): Promise<OrderPaymentIntent[]>;
  /** POST /payments/methods — add a payment method. Mock-only until the
   * contract ships the mutation (docs/CONTRACT-ADDITIONS.md #7); the method
   * is validated against the contract PaymentIntentCreateMethod enum values
   * (422 VALIDATION_FAILED for anything else). Same key replays the add. */
  addPaymentMethod(method: PaymentMethodRecord['method'] | string, idempotencyKey: string): Promise<PaymentMethodRecord>;
  /** DELETE /payments/methods/{methodId} — mock-only until the contract ships
   * the mutation (docs/CONTRACT-ADDITIONS.md #7); 404 NOT_FOUND for an
   * unknown method. Removing the default promotes the next available method. */
  removePaymentMethod(methodId: string, idempotencyKey: string): Promise<void>;
  /** PUT /payments/methods/{methodId}/default — mock-only until the contract
   * ships the mutation (docs/CONTRACT-ADDITIONS.md #7); marks one default and
   * un-marks the rest. */
  setDefaultPaymentMethod(methodId: string, idempotencyKey: string): Promise<PaymentMethodRecord>;
}

/* ---------------- Split payments (group orders, shared services) ---------------- */

/** One payer's share of a split order. App-layer, mock-only until the
 * contract ships a split-payment resource (docs/CONTRACT-ADDITIONS.md #22) —
 * the blueprint marks split payments PLANNED. Money is integer TZS. */
export type SplitShareStatus = 'pending' | 'paid';

/** Split lifecycle: open (shares defined) → paying (my share's intent
 * pending) → paid (every share covered) → completed (confirmed). */
export type SplitStatus = 'open' | 'paying' | 'paid' | 'completed';

export interface SplitShare {
  id: string;
  label: string;
  amountTZS: number;
  status: SplitShareStatus;
}

/** A split plan as surfaced to screens: ONE order, multiple payers; each
 * share is paid through its own payment intent. `myShareId` is the
 * initiator's share — the FIRST share of the client-built list (mock rule,
 * the checkout sheet always puts "You" first). */
export interface SplitPlan {
  id: string;
  orderId: string;
  totalTZS: number;
  shares: SplitShare[];
  myShareId: string;
  status: SplitStatus;
  createdAt: string;
}

export interface SplitPaymentsRepository {
  /** POST /splits — create a split plan for an order. Mock-only-until-adopted
   * path (docs/CONTRACT-ADDITIONS.md #22): the contract has no /splits
   * surface, so the api repo calls the not-yet-contract path (parity
   * allow-list) and the mock is the server. Server rules: order must exist
   * (404), at least two shares, every amount an integer ≥ 1, labels
   * non-empty, and the shares must sum EXACTLY to the order total (422
   * VALIDATION_FAILED otherwise). Idempotent per key; an order carries one
   * split — a second create for the same order returns the existing plan. */
  createSplit(input: { orderId: string; shares: { label: string; amountTZS: number }[] }, idempotencyKey: string): Promise<SplitPlan>;
  /** GET /splits/{id} — the split with live share statuses. */
  getSplit(splitId: string): Promise<SplitPlan>;
  /** POST /splits/{id}/pay — pay MY share through the normal intent flow
   * (create → confirm → mock webhook, same lifecycle as PaymentsRepository
   * createIntent/confirm). Guards mirror the intent flow: a cancelled/
   * refunded/failed order → 409 ORDER_NOT_PAYABLE; an already-paid share →
   * 409 CONFLICT. Idempotent per key. */
  payMyShare(splitId: string, method: PaymentIntentCreateMethod, idempotencyKey: string): Promise<SplitPlan>;
  /** POST /splits/{id}/complete — finalize the split; requires EVERY share
   * paid (409 CONFLICT otherwise). On completion the mock settles the order
   * (webhook — the full total is covered by the collected shares). Idempotent
   * per key. */
  completeSplit(splitId: string, idempotencyKey: string): Promise<SplitPlan>;
}

/* ---------------- Wallet ---------------- */

/** The linked payout account withdrawals are paid to (mock-only until the
 * contract ships a payout-account endpoint — the Withdrawal.method field
 * exists, but there is no GET to read the linked destination): the live repo
 * returns null; the mock serves the seeded destination. */
export interface WalletPayoutDestination {
  /** Contract TopUpMyWalletBodyMethod vocabulary (same mobile-money set). */
  method: string;
  /** Masked account reference, e.g. '2557**0000' (display only). */
  maskedAccount: string;
}

/** POST /wallet/withdrawals body as surfaced to screens — the contract
 * RequestWithdrawalBody carries ONLY {amountTZS}; `destination` (the M-Pesa
 * number / bank account the funds go to) and `method` are mock-only
 * extensions until Team 6 ships them on the body (the live repo sends them
 * anyway — a backend that has not shipped the fields ignores them, so the
 * contract-live parity path is unchanged). Money is integer TZS. */
export interface WalletWithdrawInput {
  amountTZS: number;
  destination?: string;
  method?: string;
}

/** The contract Withdrawal plus the mock-only destination extension. A live
 * payout system echoes the payout account MASKED (same rule as
 * WalletPayoutDestination.maskedAccount), so the mock stores the masked
 * reference on the record and the live repo never carries it — the generated
 * Withdrawal model has no destination field. */
export type WithdrawalRecord = Withdrawal & {
  /** Masked payout reference, e.g. '****1234' (display only). */
  destination?: string;
};

export interface WalletRepository {
  getWallet(): Promise<Wallet>;
  getTransactions(params?: { cursor?: string; limit?: number }): Promise<WalletTransaction[]>;
  topUp(input: { amountTZS: number; method: TopUpMyWalletBodyMethod }, idempotencyKey: string): Promise<Wallet>;
  reportIssue(transactionId: string, input: ReportTransactionIssueBody, idempotencyKey: string): Promise<void>;
  /** POST /wallet/withdrawals (contract requestWithdrawal; body {amountTZS,
   * minimum 1} → Withdrawal). Money is integer TZS. Idempotent per key —
   * retrying the same key replays the same withdrawal, never a double debit.
   * `destination`/`method` are mock-only extensions (WalletWithdrawInput). */
  withdraw(input: WalletWithdrawInput, idempotencyKey: string): Promise<WithdrawalRecord>;
  /** GET /wallet/withdrawals (contract listWithdrawals) — my withdrawal
   * history, newest first. */
  listWithdrawals(): Promise<WithdrawalRecord[]>;
  /** Mock-only until the contract ships the payout-account endpoint: the live
   * repo returns null; the mock serves the seeded destination. */
  getPayoutDestination(): Promise<WalletPayoutDestination | null>;
}

/* ---------------- Finance (invoices & receipts) ---------------- */

/** GET /finance/invoices, /finance/invoices/{id}, /finance/invoices/{id}/download
 * (contract listInvoices / getInvoice / downloadInvoice — generated, READ-ONLY).
 * The Invoice model carries no orderId/bookingId: the reference to the
 * originating order/booking rides the contract's free-form buyerDetails map
 * (mock-only until the contract ships a reference field); the screens render
 * it as the card's reference label. downloadInvoice returns the contract
 * DownloadInvoice200 {downloadUrl, expiresInSeconds} — production serves a
 * signed PDF URL. */
export interface FinanceRepository {
  listInvoices(): Promise<Invoice[]>;
  /** 404 → INVOICE_NOT_FOUND (not visible to the caller). */
  getInvoice(invoiceId: string): Promise<Invoice>;
  /** 404 → INVOICE_NOT_FOUND. The UI gates the action on issued/paid invoices. */
  downloadInvoice(invoiceId: string): Promise<DownloadInvoice200>;
}

/* ---------------- Bookings ---------------- */

/** Customer booking documents — the contract exposes POST-only issue
 * endpoints (issueServiceInvoice / submitProofOfService / warranty issue) and
 * NO customer GET (docs/CONTRACT-ADDITIONS.md #9). These GET shapes are
 * mock-only until Team 6 ships them; money is integer TZS. */
export interface BookingInvoice {
  lineItems: { name: string; quantity: number; unitPriceTZS: number }[];
  subtotalTZS: number;
  feesTZS: number;
  totalTZS: number;
  issuedAt: string;
}

export interface BookingWarranty {
  coverage: string;
  expiresAt: string;
}

export interface BookingProof {
  photos: string[];
  signatureStatus: 'signed' | 'unsigned';
  completedAt: string;
}

export interface BookingsRepository {
  estimate(input: { serviceId: string; cityId?: string }): Promise<BookingEstimate>;
  create(input: BookingCreate, idempotencyKey: string): Promise<Booking>;
  list(params?: { status?: string; cursor?: string; limit?: number }): Promise<Booking[]>;
  get(bookingId: string): Promise<BookingDetail>;
  cancel(bookingId: string, reason: string, idempotencyKey: string): Promise<Booking>;
  complete(bookingId: string, idempotencyKey: string): Promise<Booking>;
  decideQuote(bookingId: string, decision: DecideBookingQuoteBodyDecision, note: string | undefined, idempotencyKey: string): Promise<Booking>;
  /** Mock-only until the contract ships the customer document GETs
   * (GET /bookings/{id}/invoice etc., CONTRACT-ADDITIONS.md #9): the live
   * repo calls the not-yet-contract paths (parity allow-list) and returns
   * null on 404; the mock serves seeded documents for completed bookings. */
  getInvoice(bookingId: string): Promise<BookingInvoice | null>;
  getWarranty(bookingId: string): Promise<BookingWarranty | null>;
  getProofOfService(bookingId: string): Promise<BookingProof | null>;
}

/* ---------------- Reviews ---------------- */

/** PATCH /reviews/{id} body — rating/body/dimensions are all optional
 * (contract EditMyReviewBody); dimensions share the ReviewCreate shape. */
export type ReviewUpdate = {
  rating?: number;
  body?: string;
  dimensions?: ReviewCreate['dimensions'];
};

export interface ReviewsRepository {
  /** POST /reviews — targetType is the contract enum (merchant|provider|rider|customer). */
  create(input: ReviewCreate, idempotencyKey: string): Promise<Review>;
  /** PATCH /reviews/{id} — edit own review (rating, body, dimensions). */
  update(reviewId: string, input: ReviewUpdate, idempotencyKey: string): Promise<Review>;
  /** DELETE /reviews/{id} — delete own review (server marks it deleted). */
  remove(reviewId: string, idempotencyKey: string): Promise<void>;
  /** POST /reviews/{id}/helpful — toggle whether a review was helpful. */
  helpful(reviewId: string, helpful: boolean, idempotencyKey: string): Promise<VoteReviewHelpful200>;
  listMine(): Promise<Review[]>;
  /** Mock-only: the contract exposes no public target-scoped review listing
   * (GET /reviews?targetType=&targetId= does not exist yet — op #105 lists it
   * as LIVE but no consumer endpoint shipped), so this filters the mock store
   * only; the live repo rejects it until the contract adds the endpoint. */
  listFor(targetType: string, targetId: string): Promise<Review[]>;
  report(reviewId: string, reason: string, idempotencyKey: string): Promise<ReviewReport>;
}

/* ---------------- Notifications ---------------- */

export interface NotificationsRepository {
  list(params?: { unreadOnly?: boolean; cursor?: string; limit?: number }): Promise<Notification[]>;
  markRead(notificationId: string): Promise<void>;
  markAllRead(): Promise<void>;
  getPreferences(): Promise<NotificationPreferences>;
  putPreferences(prefs: NotificationPreferences, idempotencyKey: string): Promise<NotificationPreferences>;
}

/* ---------------- Support ---------------- */

/** Contract ListHelpArticles200Item — help center knowledge-base article
 * (GET /help/articles; the contract exposes no per-article endpoint). */
export type HelpArticle = ListHelpArticles200Item;

export interface SupportRepository {
  createTicket(input: TicketCreate, idempotencyKey: string): Promise<Ticket>;
  listTickets(): Promise<Ticket[]>;
  getTicket(ticketId: string): Promise<TicketDetail>;
  reply(ticketId: string, body: string, idempotencyKey: string): Promise<TicketDetailMessagesItem>;
  /** GET /help/articles — knowledge-base search (q, category). */
  listArticles(query?: string): Promise<HelpArticle[]>;
}

/* ---------------- Disputes ---------------- */

/** Mock-only dispute status vocabulary — the consumer contract exposes NO
 * dispute types (verified against the generated model: only admin
 * voucher-dispute tooling under /admin/vouchers/verify exists), so the
 * statuses below are mock-only until Team 6 ships customer dispute endpoints
 * (docs/CONTRACT-ADDITIONS.md #8). */
export type DisputeStatus = 'open' | 'resolving' | 'resolved' | 'dismissed';

/** A consumer dispute as surfaced to the disputes screen (mock-only until
 * the contract ships GET /disputes/me + POST /disputes —
 * docs/CONTRACT-ADDITIONS.md #8). */
export interface DisputeRecord {
  id: string;
  referenceType: 'order' | 'booking';
  referenceId: string;
  status: DisputeStatus;
  reason: string;
  description: string;
  evidenceUrls?: string[];
  createdAt: string;
  updatedAt: string;
  /** Set when the dispute reached a terminal state (resolved/dismissed). */
  resolution?: { outcome: string; at: string; note?: string };
}

export interface DisputeRaiseInput {
  /** Exactly one of orderId/bookingId must be set (422 otherwise). */
  orderId?: string;
  bookingId?: string;
  reason: string;
  description: string;
  evidenceUrls?: string[];
}

export interface DisputesRepository {
  /** Mock-only until the contract ships the consumer dispute list
   * (CONTRACT-ADDITIONS.md #8): the live repo calls the not-yet-contract
   * path /disputes/me (parity allow-list). */
  list(): Promise<DisputeRecord[]>;
  /** Mock-only until the contract ships consumer dispute creation
   * (CONTRACT-ADDITIONS.md #8): the live repo calls the not-yet-contract
   * path POST /disputes (parity allow-list). Idempotent per key. */
  raise(input: DisputeRaiseInput, idempotencyKey: string): Promise<DisputeRecord>;
}

/* ---------------- Conversations ---------------- */

export interface ConversationsRepository {
  list(status?: 'open' | 'archived' | 'blocked', cursor?: string): Promise<Conversation[]>;
  create(input: ConversationCreate, idempotencyKey: string): Promise<Conversation>;
  get(conversationId: string): Promise<ConversationDetail>;
  listMessages(conversationId: string, cursor?: string): Promise<ChatMessage[]>;
  /** Send a message; attachments follow the ChatMessageCreate contract shape (max 4). */
  send(conversationId: string, body: string, idempotencyKey: string, attachments?: ChatMessageCreateAttachmentsItem[]): Promise<ChatMessage>;
  markRead(conversationId: string): Promise<void>;
  archive(conversationId: string): Promise<void>;
  unreadCount(): Promise<number>;
}

/* ---------------- Coupons ---------------- */

/** Input for the smart-coupon suggestion (POST /coupons/suggest, mock-only
 * until the contract ships the endpoint — docs/CONTRACT-ADDITIONS.md #26):
 * the wallet coupon ids the user holds for the merchant, and the cart
 * subtotal the suggested coupon must cover. Money is integer TZS. */
export interface CouponSuggestionInput {
  merchantId: string;
  subtotalTZS: number;
  couponIds: string[];
}

export interface CouponsRepository {
  list(status?: string): Promise<Coupon[]>;
  claim(couponId: string, idempotencyKey: string): Promise<Coupon>;
  /** POST /coupons/suggest — the best applicable coupon from the user's
   * wallet for a cart (MASTER-BLUEPRINT §16 smart coupons, mock-first until
   * the contract ships the endpoint — docs/CONTRACT-ADDITIONS.md #26): the
   * api repo calls the not-yet-contract path (parity harness allow-list) and
   * the mock ranks the provided wallet coupon ids by largest discountTZS
   * among those whose minimumSpendTZS <= subtotalTZS, status
   * claimed/available and not past expiresAt. Returns null when nothing
   * applies. READ-ONLY — the server decides; the app only suggests. */
  suggestForCart(input: CouponSuggestionInput): Promise<Coupon | null>;
}

/* ---------------- Red packets (P6c) ---------------- */

/** A received/shareable red packet as surfaced to the app (mock-only until
 * the contract ships the red-packet resource — docs/CONTRACT-ADDITIONS.md
 * #12). Money is integer TZS. Red packets are PROMOTIONAL: the platform
 * funds the packet (marketing budget), it is never debited from the
 * recipient's wallet. */
export interface RedPacket {
  id: string;
  title: string;
  totalTZS: number;
  claimedCount: number;
  count: number;
  claimed: boolean;
  expiresAt: string;
  /** Set on packets this user created to share (hudumika://red-packet/{shareCode}). */
  shareCode?: string;
}

/** Result of claiming a red packet — the wallet credit the claim granted. */
export interface RedPacketClaim {
  id: string;
  creditedTZS: number;
}

/** POST /red-packets/me/share body (mock-only until adopted, #12): the demo
 * packets are promotional, so amountTZS/count/expiry are the campaign
 * parameters, not a wallet debit. */
export interface RedPacketCreateInput {
  title?: string;
  amountTZS: number;
  count: number;
  expiresInHours: number;
}

export interface RedPacketRepository {
  /** GET /red-packets/me/received — packets sent to me (claimable or not).
   * Mock-only-until-adopted path (docs/CONTRACT-ADDITIONS.md #12). */
  listReceived(): Promise<RedPacket[]>;
  /** POST /red-packets/{packetId}/claim — claim a received packet; the
   * credit lands in the wallet balance (promotional credit, same shape as a
   * top-up transaction). Mock-only-until-adopted path (#12). Idempotent per
   * key; a packet can be claimed once per user (second claim → 409
   * CONFLICT). */
  claim(packetId: string, idempotencyKey: string): Promise<RedPacketClaim>;
  /** POST /red-packets/me/share — create a promotional shareable packet
   * (marketing-funded — never wallet-funded). Mock-only-until-adopted path
   * (#12); idempotent per key. */
  createSharePacket(input: RedPacketCreateInput, idempotencyKey: string): Promise<RedPacket>;
}

/* ---------------- Favorites ---------------- */

/** A user-organized favorites list (OPERATIONS-COVERAGE #120 "Organize
 * favorites", docs/CONTRACT-ADDITIONS.md #14). Mock-only until the contract
 * ships the favorites-lists resource: the api repo calls the not-yet-contract
 * paths (parity harness allow-list) and the mock is the server. */
export interface FavoriteList {
  id: string;
  name: string;
  /** Favorited merchant ids, in the order they were added. */
  merchantIds: string[];
  createdAt: string;
}

/** POST /favorites/lists body — {name, merchantIds?}. `merchantIds` is
 * optional: the UI creates an empty list and adds merchants afterwards. */
export interface FavoriteListCreateInput {
  name: string;
  merchantIds?: string[];
}

export interface FavoritesRepository {
  list(): Promise<MerchantPublic[]>;
  add(merchantId: string, idempotencyKey: string): Promise<void>;
  remove(merchantId: string, idempotencyKey: string): Promise<void>;
  /** GET /favorites/lists — my organized favorites lists. Mock-only-until-
   * adopted paths (CONTRACT-ADDITIONS.md #14): a live backend that has not
   * shipped them errors the lists surface into its retry state. */
  listLists(): Promise<FavoriteList[]>;
  /** POST /favorites/lists — create a list ({name, merchantIds?}); an empty
   * name → 422 VALIDATION_FAILED. Idempotent per key: a repeated key with the
   * same body replays the stored list, a key reuse with a different name →
   * 422. */
  createList(input: FavoriteListCreateInput, idempotencyKey: string): Promise<FavoriteList>;
  /** POST /favorites/lists/{id}/merchants — add a favorite merchant to a
   * list. Unknown list or unknown merchant → 404 NOT_FOUND; adding a merchant
   * already in the list is a no-op. Idempotent per key. */
  addToList(listId: string, merchantId: string, idempotencyKey: string): Promise<FavoriteList>;
  /** DELETE /favorites/lists/{id}/merchants/{merchantId} — remove a merchant
   * from a list. Unknown list or unknown merchant → 404 NOT_FOUND; removing a
   * merchant not in the list is a no-op. Idempotent per key. */
  removeFromList(listId: string, merchantId: string, idempotencyKey: string): Promise<FavoriteList>;
  /** DELETE /favorites/lists/{id} — delete a list; unknown list →
   * 404 NOT_FOUND. Idempotent per key. */
  deleteList(listId: string, idempotencyKey: string): Promise<void>;
}

/* ---------------- Curated lists (必吃榜-lite) ---------------- */

/** Curated merchant lists (Meituan 必吃榜-lite) — GET /lists + GET /lists/{id}.
 * Mock-only-until-adopted (docs/CONTRACT-ADDITIONS.md #14): the consumer
 * contract exposes NO Lists resource, so the api repo calls the not-yet-
 * contract paths (parity harness allow-list) and the mock serves the seed
 * that previously rendered app-side. The CuratedList shape (i18n-keyed
 * titles, ranked merchant ids) lives in src/lib/lists.ts — the pure helpers
 * there resolve the ids against the merchants repo; the mock mirrors the
 * same constant. */
export interface ListsRepository {
  /** GET /lists — all curated lists (seed rank order). */
  listCurated(): Promise<CuratedList[]>;
  /** GET /lists/{listId} — one curated list; unknown id → 404 NOT_FOUND. */
  getCurated(listId: string): Promise<CuratedList>;
}

/* ---------------- Memberships ---------------- */

/** A redeemable points reward (mock-only catalog until the contract ships the
 * redemption mutation + reward listing — docs/CONTRACT-ADDITIONS.md #16).
 * `points` is the integer cost; `valueTZS` is the wallet credit for
 * wallet-credit rewards and null for non-credit rewards (e.g. free delivery —
 * those never touch the wallet). Money is integer TZS. */
export interface RedemptionReward {
  /** Stable server-side key — sent as `reward` in the redemption body. */
  reward: string;
  /** Integer points cost. */
  points: number;
  /** Wallet credit when the reward is wallet-credit, else null. */
  valueTZS: number | null;
}

/** The redemption catalog — single source of truth shared by the screen
 * (renders it) and the mock (validates against it). Mock-only until the
 * contract ships the redemption surface (docs/CONTRACT-ADDITIONS.md #16);
 * the live backend must ship the same mapping before the mutation lands. */
export const REDEMPTION_CATALOG: RedemptionReward[] = [
  { reward: 'wallet_credit', points: 500, valueTZS: 5000 },
  { reward: 'delivery_discount', points: 250, valueTZS: 2500 },
  { reward: 'free_delivery', points: 300, valueTZS: null },
];

/** POST /loyalty/redemptions body — `points` must be the integer catalog
 * cost for `reward` (the server re-validates both). */
export interface RedeemPointsInput {
  points: number;
  reward: string;
}

export interface MembershipsRepository {
  get(): Promise<CustomerMembership>;
  /** POST /check-in — contract DailyCheckIn200 (pointsEarned, streakDays,
   * bonusPoints); 409 ConflictResponse when already checked in today. */
  checkIn(idempotencyKey: string): Promise<DailyCheckIn200>;
  /** GET /loyalty-transactions — signed points ledger (earn/check_in/bonus/
   * redeem/expire/adjust), cursor-paginated. */
  listLoyaltyTransactions(params?: { cursor?: string; limit?: number }): Promise<ListLoyaltyTransactions200Item[]>;
  /** POST /loyalty/redemptions — redeem points for a reward from
   * REDEMPTION_CATALOG. Mock-only until the contract ships the redemption
   * mutation (docs/CONTRACT-ADDITIONS.md #16): the api repo calls the
   * not-yet-contract path (parity harness allow-list). 422 VALIDATION_FAILED
   * for an unknown reward or a points cost that does not match the catalog,
   * 422 MEMBER_INSUFFICIENT_BALANCE (ERROR-CODES.md Loyalty section) when
   * the balance cannot cover the cost. Wallet-credit rewards credit the
   * wallet balance (integer TZS) and append a WalletTransaction; every
   * redemption appends a signed `redeem` ledger row. Idempotent per key. */
  redeemPoints(input: RedeemPointsInput, idempotencyKey: string): Promise<CustomerMembership>;
  /** Mock-only until the contract exposes per-order points accrual on the
   * loyalty surface (docs/CONTRACT-ADDITIONS.md #28): the live repo returns
   * null (no wire path — the order-detail earn pill hides); the mock reports
   * what the accrual engine awarded for this order (1 pt per TZS 1,000 on
   * paid orders). */
  earningsFor(orderId: string): Promise<{ points: number } | null>;
  /** Mock-only until the contract exposes per-review points accrual
   * (docs/CONTRACT-ADDITIONS.md #28): the live repo returns null; the mock
   * reports what the accrual engine awarded for this review (50 pts per
   * published review). */
  earningsForReview(reviewId: string): Promise<{ points: number } | null>;
}

/* ---------------- Rewards (referral + birthday, M16f) ---------------- */

/** GET /referrals/me, POST /referrals/claim, GET /rewards/birthday and
 * POST /rewards/birthday/claim — all four contract surfaces shipped in the
 * regenerated spec (backend/API-CONTRACT.yaml). Money is integer TZS. Claims
 * are idempotent per key: the server replays the stored reward for a
 * repeated key (same code), and rejects a key reused with a different body. */
export interface RewardsRepository {
  /** GET /referrals/me — my referral code + invite stats (ReferralSummary:
   * code, invitedCount, rewardStatus pending|paid, totalRewardTZS). */
  getMyReferral(): Promise<ReferralSummary>;
  /** POST /referrals/claim — body {code} (ClaimReferralBody, maxLength 20).
   * Returns a pending ReferralReward (status pending, creditedAt null) that
   * is credited later. 422 VALIDATION_FAILED on a malformed code, 409
   * CONFLICT for your own code or an already-claimed code, 404 NOT_FOUND for
   * an unknown code. */
  claimReferral(code: string, idempotencyKey: string): Promise<ReferralReward>;
  /** GET /rewards/birthday — availability (BirthdayReward: available,
   * claimed, rewardTitle, rewardTZS, expiresAt). */
  getBirthdayReward(): Promise<BirthdayReward>;
  /** POST /rewards/birthday/claim — claims the birthday reward (same
   * BirthdayReward shape with claimed: true); a second claim → 409
   * CONFLICT. Idempotent per key. */
  claimBirthdayReward(idempotencyKey: string): Promise<BirthdayReward>;
}

/* ---------------- Marketing (LIVE DEALS ZONE) ---------------- */

/** GET /marketing/live-deals payload — normalized from the contract
 * ListLiveDeals200 (the contract lets both fields be absent; the repos
 * surface them as always-present: sessions [] and nextCursor null). */
export interface LiveDealsResult {
  sessions: LiveDealSession[];
  nextCursor: string | null;
}

/** A live-deals broadcast chat message (mock-only until the contract ships a
 * live-chat surface — docs/CONTRACT-ADDITIONS.md #22). `at` is UTC ISO and
 * renders via clockISO() like every other timestamp. */
export interface LiveChatMessage {
  id: string;
  authorName: string;
  body: string;
  at: string;
}

export interface MarketingRepository {
  /** GET /marketing/live-deals — the live deals zone (神抢手-lite): scheduled
   * flash-sale sessions with countdowns. Session status is server-derived
   * (scheduled | live | ended) from startsAt/endsAt. NOTE: this is the
   * sessions zone — video livestreaming has no contract surface yet and is a
   * native-phase concern (documented in src/app/live-deals.tsx). */
  listLiveDeals(): Promise<LiveDealsResult>;
  /** GET /marketing/live-deals/{id}/chat — the session's live chat (viewer
   * messages about the deals, oldest first). Mock-only-until-adopted path
   * (docs/CONTRACT-ADDITIONS.md #22, parity harness allow-list): the contract
   * has no live-chat surface; a live backend that has not shipped it errors
   * the broadcast screen into its retry state. */
  fetchLiveChat(sessionId: string): Promise<LiveChatMessage[]>;
  /** POST /marketing/live-deals/{id}/chat — post a chat message. Mock-only-
   * until-adopted path (#19, parity harness allow-list); idempotent per key
   * (the same key replays the same message, never a double post). Unknown
   * session → 404 NOT_FOUND; empty body → 422 VALIDATION_FAILED. */
  postLiveChat(sessionId: string, message: string, idempotencyKey: string): Promise<LiveChatMessage>;
}

/* ---------------- Group buy / vouchers / dine-in / reservations (P6b–P6c) ---------------- */


export interface GroupBuyRepository {
  list(params?: { cityId?: string; cursor?: string; limit?: number }): Promise<GroupBuyDeal[]>;
  /** GET /group-buys/{groupId} — deal detail incl. terminal states (404 → GROUP_BUY_NOT_FOUND). */
  get(groupId: string): Promise<GroupBuyDeal>;
  /** POST /group-buys/{id}/purchase — idempotent (same key never double-charges). */
  purchase(groupId: string, quantity: number, idempotencyKey: string): Promise<Voucher[]>;
}

export interface VouchersRepository {
  list(status?: string): Promise<Voucher[]>;
}

/** GET /dine-in/tables/{tableId}/qr — the contract response ({qrPayload,
 * menuUrl}) omits the merchant linkage, so the app layer carries it (same
 * pattern as OrderPaymentIntent.orderId). The mock resolves it from the
 * table registry; the live repo derives it from the server-provided menuUrl. */
export interface DineInTableQrContext {
  qrPayload: string;
  menuUrl: string;
  merchantId: string;
}

/** One diner's share of a split dine-in bill. Money is integer TZS. */
export interface DineInSplitShare {
  id: string;
  label: string;
  amountTZS: number;
  status: 'pending' | 'paid';
}

/** Split lifecycle: open (shares defined, my share pending) → paid (my share
 * covered) → completed (EVERY share covered — co-diners are simulated
 * pre-paid in the mock, so my pay completes the split). */
export type DineInSplitStatus = 'open' | 'paid' | 'completed';

/** A split dine-in bill as surfaced to screens. App-layer, mock-only until
 * the contract ships a dine-in split surface (docs/CONTRACT-ADDITIONS.md
 * #25): ONE bill, multiple diners; each share is paid through its own
 * payment. `myShareId` is the initiator's share — the FIRST share of the
 * client-built list (the split sheet always puts "You" first). */
export interface DineInSplit {
  id: string;
  dineInOrderId: string;
  totalTZS: number;
  shares: DineInSplitShare[];
  myShareId?: string;
  status: DineInSplitStatus;
  createdAt: string;
}

export interface DineInRepository {
  listMyOrders(): Promise<DineInOrder[]>;
  /** GET /dine-in/tables/{tableId}/qr — resolve a scanned/pasted table QR
   * payload (hudumika:dinein:table:{tableId}). 404 → DINE_IN_TABLE_NOT_FOUND,
   * 409 → DINE_IN_TABLE_IN_USE (the table already has an open bill). */
  resolveTable(tableId: string): Promise<DineInTableQrContext>;
  /** GET /dine-in/orders/{dineInOrderId} — bill detail (parties only). */
  getOrder(dineInOrderId: string): Promise<DineInOrder>;
  /** POST /dine-in/orders — opened from a table QR (hudumika:dinein:table:{id}). */
  openOrder(merchantId: string, tableId: string, items: { catalogueItemId: string; quantity: number; options?: string[] }[], idempotencyKey: string): Promise<DineInOrder>;
  /** POST /dine-in/orders/{dineInOrderId}/splits — split the bill between
   * diners. Mock-only-until-adopted path (docs/CONTRACT-ADDITIONS.md #25):
   * the contract exposes no dine-in split surface (DINE-IN.md marks
   * split-bill PLANNED), so the api repo calls the not-yet-contract path
   * (parity harness allow-list) and the mock is the server. Server rules:
   * bill must exist (404 DINE_IN_ORDER_NOT_FOUND) and be payable (open/
   * billing — 409 DINE_IN_ORDER_STATUS_CONFLICT otherwise), 2–8 shares with
   * integer amounts ≥ 1 that sum EXACTLY to the bill total (422
   * VALIDATION_FAILED), one split per bill (a second create with a different
   * key → 409 CONFLICT). The initiator's share (the FIRST of the client-built
   * list) is pending; co-diner shares are PRE-PAID — simulated diners, honest
   * mock scope. Idempotent per key. */
  splitBill(dineInOrderId: string, input: { shares: { label: string; amountTZS: number }[] }, idempotencyKey: string): Promise<DineInSplit>;
  /** GET /dine-in/orders/{dineInOrderId}/splits — the bill's split with live
   * share statuses. One split per bill, so the split is addressed by its
   * order id (404 DINE_IN_ORDER_NOT_FOUND for an unknown bill, 404 NOT_FOUND
   * when the bill has no split yet). Mock-only-until-adopted path (#25). */
  getSplit(dineInOrderId: string): Promise<DineInSplit>;
  /** POST /dine-in/orders/{dineInOrderId}/splits — mark MY share paid
   * ({action: 'pay_my_share'}). Mock-only-until-adopted path (#25): the api
   * repo reuses the create literal (the parity harness is method-agnostic),
   * a live backend would ship the real shape. The mock runs the intent
   * lifecycle scoped to MY share amount (create → confirm → "webhook", same
   * machinery as mock/splits.ts payMyShare); settling it flips my share to
   * paid, and when every share is covered the split completes and the bill
   * settles (webhook — the full total is covered by the shares). An
   * already-paid share → 409 CONFLICT; idempotent per key. */
  payMyShare(dineInOrderId: string, idempotencyKey: string): Promise<DineInSplit>;
}

export interface ReservationsRepository {
  list(): Promise<Reservation[]>;
  /** POST /reservations — party size 1–50, future-only server window. */
  create(input: { merchantId: string; partySize: number; scheduledFor: string; note?: string }, idempotencyKey: string): Promise<Reservation>;
  cancel(reservationId: string, idempotencyKey: string): Promise<Reservation>;
}

/* ---------------- Entertainment (events + tickets) ---------------- */

export interface EventsRepository {
  /** GET /entertainment/events — cursor-paginated listing; optional
   * cityId/category filters. nextCursor is null on the last page. */
  list(params?: { cityId?: string; category?: string; cursor?: string; limit?: number }): Promise<{ results: EventListing[]; nextCursor: string | null }>;
  /** GET /entertainment/events/{eventId} — event detail incl. ticket tiers;
   * unknown id → 404 NOT_FOUND. */
  get(eventId: string): Promise<EventDetail>;
  /** POST /entertainment/event-tickets — purchase (quantity 1–10, contract
   * body {eventId, tierId, quantity}); idempotent per key (a retry replays
   * the same key and never double-issues); sold-out/insufficient remaining →
   * 409 CONFLICT; bad quantity → 422 VALIDATION_FAILED. */
  purchase(input: { eventId: string; tierId: string; quantity: number }, idempotencyKey: string): Promise<EventTicket[]>;
  /** GET /entertainment/event-tickets/me — my tickets (status active|used|refunded). */
  listMyTickets(): Promise<EventTicket[]>;
}

/* ---------------- Travel (intercity bus / ferry / flight) ---------------- */

/** GET /travel/options params (contract ListTravelOptionsParams). `date` is
 * the local calendar day serialized as YYYY-MM-DD; the server schedules
 * departures on that day. */
export interface TravelSearchParams {
  originCityId: string;
  destinationCityId: string;
  date: string;
  mode?: TravelOption['mode'];
}

/** POST /travel/bookings body minus the idempotency key (the client sends it
 * as both the Idempotency-Key header and the contract body field). */
export interface TravelBookingInput {
  travelOptionId: string;
  passengers: number;
  contactPhone: string;
}

export interface TravelRepository {
  /** GET /travel/options — search intercity departures (bus / ferry / flight). */
  search(params: TravelSearchParams): Promise<TravelOption[]>;
  /** POST /travel/bookings — idempotent per key; the server prices the
   * booking (totalTZS = priceTZS × passengers) and returns it pending payment. */
  book(input: TravelBookingInput, idempotencyKey: string): Promise<TravelBooking>;
  /** GET /travel/bookings/me — my travel bookings. */
  listMyBookings(): Promise<TravelBooking[]>;
}

/* ---------------- Hotels (P6d) ---------------- */

/** Contract listHotels params (cityId/checkIn/checkOut/guests/cursor/limit).
 * Dates are ISO strings (YYYY-MM-DD or full ISO); the server resolves
 * availability + nights. */
export interface HotelSearchParams {
  cityId?: string;
  checkIn?: string;
  checkOut?: string;
  guests?: number;
  cursor?: string;
  limit?: number;
}

export interface HotelsRepository {
  /** GET /hotels — city-scoped search; cursor-paginated
   * ({results, nextCursor}, contract ListHotels200). */
  list(params?: HotelSearchParams): Promise<{ results: Hotel[]; nextCursor: string | null }>;
  /** GET /hotels/{hotelId} — hotel + description + rooms. 404 → NOT_FOUND. */
  get(hotelId: string): Promise<HotelDetail>;
  /** POST /hotel-bookings — idempotent per key (same key replays the same
   * booking, never double-books); the server computes nights + totalTZS. */
  book(input: { hotelId: string; roomId: string; checkIn: string; checkOut: string; guests: number; contactPhone?: string }, idempotencyKey: string): Promise<HotelBooking>;
  /** GET /hotel-bookings/me — my hotel bookings. */
  listMyBookings(): Promise<HotelBooking[]>;
}

/* ---------------- Factories ---------------- */

// Deliberately imported at the bottom (rider pattern): factories.ts imports
// the interfaces from this module, so hoisting the import would create a cycle.
// eslint-disable-next-line import/first -- house pattern, see rider-mobile/app/src/repos/index.ts
import {
  getAssistantRepository,
  getAuthRepository,
  getBookingsRepository,
  getConversationsRepository,
  getCouponsRepository,
  getDineInRepository,
  getDisputesRepository,
  getEventsRepository,
  getFavoritesRepository,
  getFinanceRepository,
  getGroupBuyRepository,
  getGroupOrdersRepository,
  getHomeRepository,
  getHotelsRepository,
  getListsRepository,
  getMarketingRepository,
  getMembershipsRepository,
  getMerchantsRepository,
  getNotificationsRepository,
  getOrdersRepository,
  getPaymentsRepository,
  getProvidersRepository,
  getRedPacketRepository,
  getReservationsRepository,
  getReviewsRepository,
  getRewardsRepository,
  getSearchRepository,
  getShipmentsRepository,
  getSplitPaymentsRepository,
  getSupportRepository,
  getTravelRepository,
  getVouchersRepository,
  getWalletRepository,
} from './factories';

export {
  getAssistantRepository,
  getAuthRepository,
  getBookingsRepository,
  getConversationsRepository,
  getCouponsRepository,
  getDineInRepository,
  getDisputesRepository,
  getEventsRepository,
  getFavoritesRepository,
  getFinanceRepository,
  getGroupBuyRepository,
  getGroupOrdersRepository,
  getHomeRepository,
  getHotelsRepository,
  getListsRepository,
  getMarketingRepository,
  getMembershipsRepository,
  getMerchantsRepository,
  getNotificationsRepository,
  getOrdersRepository,
  getPaymentsRepository,
  getProvidersRepository,
  getRedPacketRepository,
  getReservationsRepository,
  getReviewsRepository,
  getRewardsRepository,
  getSearchRepository,
  getShipmentsRepository,
  getSplitPaymentsRepository,
  getSupportRepository,
  getTravelRepository,
  getVouchersRepository,
  getWalletRepository,
};
