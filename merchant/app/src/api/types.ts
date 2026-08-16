import type {
  AcceptOrderBody,
  AdvanceOrderBody,
  BulkCatalogueItems202,
  Catalogue,
  CatalogueItem,
  CatalogueItemUpdate,
  ChainStore,
  ExportCatalogue200,
  ImportCatalogue202,
  ImportCatalogueBodyRowsItem,
  LeadCreated,
  MerchantApplication,
  MerchantClaim,
  MerchantPrivate,
  MerchantPublic,
  MerchantUpdate,
  OtpDelivery,
  PayoutAccount,
  PayoutAccountWrite,
  ProductCategory,
  ProductTemplate,
  RejectOrderBody,
  RequestOtpBody,
  Session,
  StorePaymentAccount,
  StorePaymentAccountStatus,
  StorePaymentAccountType,
  StoreSettings,
  StoreSettingsAcceptedPaymentMethodsItem,
  StoreSettingsBusinessHoursItem,
  StoreSettingsUpdate,
  VerificationState,
  VerifyOtpBody,
} from '@hudumika/contract';
import type {
  AppMessage,
  Campaign,
  CampaignStatus,
  CampaignType,
  ChatThread,
  CustomerSegment,
  DecorationSettings,
  Order,
  OrderRefund,
  OrderSettings,
  PlatformCampaign,
  PromotionPlan,
  SegmentStats,
  Task,
  TaskPriority,
} from '@/types';

/* ---------- Auth & merchant ---------- */

// OTP request: contract RequestOtpBody shape; the app's `purpose` values are an
// extension — the contract enum is RequestOtpBodyPurpose (login|signup|password_reset|verify_role).
export type OtpPurpose = 'login' | 'register';
export type OtpRequestBody = Omit<RequestOtpBody, 'purpose'> & { purpose: OtpPurpose };

// Verify-OTP request: contract VerifyOtpBody + the app's `purpose` extension.
export type OtpVerifyRequestBody = VerifyOtpBody & { purpose: OtpPurpose };

export interface Merchant {
  id: string;
  phone: string;
  name: string;
  avatarUrl?: string;
  status: 'pending' | 'active' | 'suspended';
  plan: 'basic' | 'pro';
  country: string;
  currency: string;
  locale: string;
  consentAt: number;
  createdAt: number;
}

export interface Staff {
  id: string;
  merchantId: string;
  storeId: string;
  name: string;
  role: 'owner' | 'manager' | 'staff';
  phone: string;
  permissions: string[];
  active: boolean;
}

export interface StoreServer {
  id: string;
  merchantId: string;
  name: string;
  category: string;
  phone: string;
  address: string;
  description: string;
  bannerColor: string;
  featuredProductIds: string[];
  open: boolean;
  scheduledReopenAt?: number;
  hours: { open: string; close: string; closedDays: string[] };
  deliveryRadiusKm: number;
  deliveryFee: number;
  minOrder: number;
  rating: number;
  rank: { current: number; previous: number; category: string; score: number };
  orderSettings: OrderSettings;
  decoration: DecorationSettings;
  promotion: PromotionPlan;
  announcement?: string;
  coverImage?: string;
  deliveryEtaMin?: number;
  pickupReadyMinutes?: number;
  paymentMethods: Record<SupportedPaymentMethod, boolean>;
  dualScreen: {
    enabled: boolean;
    screen: 'orders' | 'kitchen' | 'media';
    refreshSec: number;
    showOrderNumbers: boolean;
    theme: 'dark' | 'light';
    pairingCode: string;
  };
  qrOrdering: { enabled: boolean; type: 'table' | 'counter'; urlPattern: string };
  receiptTemplateId?: string;
  freeDeliveryThreshold?: number;
}

/* ---------- Store & operations module ---------- */

export interface ClosureProtection {
  id: string;
  storeId: string;
  from: number;
  to: number;
  reason: string;
  status: 'active' | 'expired' | 'cancelled';
  createdAt: number;
}

export interface PaymentAccount extends StorePaymentAccount {
  storeId: string; // app extension — contract keys accounts at merchant level
  name: string; // app extension
  account: string; // app extension — masked server-side; responses carry accountMasked
  createdAt: number; // app extension
  isDefault: boolean; // required in the app (contract marks it optional)
}

export type PaymentAccountStatus = StorePaymentAccountStatus;
export type PaymentAccountType = StorePaymentAccountType;

export interface StoreLog {
  id: string;
  merchantId: string;
  storeId: string;
  action: string;
  field?: string;
  before?: unknown;
  after?: unknown;
  actorId: string;
  role: string;
  ts: number;
}

export interface ReceiptTemplate {
  id: string;
  storeId: string;
  name: string;
  headerText: string;
  footerText: string;
  showLogo: boolean;
  showQRCode: boolean;
  showPayment: boolean;
  showRider: boolean;
  paperSize: '58mm' | '80mm';
  copies: number;
  logoEmoji: string;
  isDefault: boolean;
  updatedAt: number;
}

export interface Printer {
  id: string;
  storeId: string;
  name: string;
  type: 'bluetooth' | 'network' | 'cloud';
  status: 'connected' | 'offline' | 'pairing';
  paperSize: '58mm' | '80mm';
  copies: number;
  purpose: 'receipt' | 'kitchen';
  isDefault: boolean;
  createdAt: number;
}

export interface TableRow {
  id: string;
  storeId: string;
  name: string;
  zone: string;
  capacity: number;
  status: 'idle' | 'occupied' | 'reserved';
  qrToken: string;
  qrUrl: string;
  disabled: boolean;
  currentOrderId?: string | null;
  createdAt: number;
  /* Contract DineInTable aliases (DINE-IN.md): `label` mirrors `name`,
   * `active` mirrors `!disabled`. Both are emitted server-side so the
   * contract shape and the app shape stay in sync. */
  label?: string;
  active?: boolean;
}

/** Contract DineInTable (DINE-IN.md): id, label (≤40), capacity (default 4),
 * active, currentOrderId. The mock emits the app TableRow + these aliases. */
export interface DineInTable {
  id: string;
  label: string;
  capacity: number;
  active: boolean;
  currentOrderId?: string | null;
}

/* ---------- Dine-in ---------- */

export type DineInOrderStatus = 'open' | 'billing' | 'paid' | 'closed' | 'cancelled';

export interface PriceBreakdown {
  subtotalTZS: number;
  deliveryFeeTZS: number;
  platformFeeTZS: number;
  taxTZS: number;
  discountTZS: number;
  totalTZS: number;
}

export interface DineInOrderItem {
  catalogueItemId: string;
  name: string;
  quantity: number;
  unitPriceTZS: number;
}

export interface DineInOrderCreateItem {
  catalogueItemId: string;
  quantity: number;
  options?: string[];
}

export interface DineInOrder {
  id: string;
  merchantId: string;
  tableId: string;
  status: DineInOrderStatus;
  items: DineInOrderItem[];
  totals: PriceBreakdown;
  createdAt: number;
  paidAt?: number | null;
  /* confirm-payment evidence (PAYMENTS.md): the recorded method
   * (mpesa | airtel_money | cod | card) and who recorded the receipt. */
  paymentMethod?: string;
  paidBy?: string;
  /* Bill-state timeline (DI-08): each transition (open → billing → paid →
   * closed) appends a row; the bill detail renders them in order. */
  events?: { status: DineInOrderStatus; at: number }[];
}

export interface ComplianceCheck {
  key: string;
  label: string;
  pass: boolean;
  detail: string;
}

export interface ComplianceStatus {
  status: 'compliant' | 'attention' | 'suspended';
  score: number;
  checks: ComplianceCheck[];
  updatedAt: number;
}

export interface SessionMe {
  merchant: Merchant;
  store: StoreServer;
  staff: Staff;
  permissions: string[];
}

export interface OtpRequestResponse extends OtpDelivery {
  resendAfterSec: number; // app extension — contract field is `resendInSeconds`
  debugCode: string; // mock-only extension (dev code shown in the UI)
  demo: boolean; // mock-only extension
}

// Verify-OTP response: contract Session (accessToken/refreshToken) with the
// merchant `me` payload instead of the consumer `user` — app extension.
export type SessionResponse = Omit<Session, 'user'> & { me: SessionMe };

// Contract RoleSummary — platform-level role the current user can act as.
export interface UserRole {
  role: string;
  merchantId?: string | null;
  providerId?: string | null;
  riderId?: string | null;
}

// Contract User (GET/PATCH /users/me) — epoch-ms createdAt (app convention).
// `merchantId` is an app extension so the client can resolve the active store.
export interface UserProfile {
  id: string;
  phone: string;
  email: string | null;
  fullName: string;
  avatarUrl: string | null;
  activeRole: string;
  roles: UserRole[];
  locale: string;
  createdAt: number;
  merchantId: string;
}

/* ---------- Catalog ---------- */

export interface VariantSpec {
  id: string;
  name: string;
  price: number;
}

export interface AddonOption {
  id: string;
  name: string;
  price: number;
  emoji?: string;
}

export interface ComboItem {
  productId: string;
  name: string;
  emoji: string;
  qty: number;
  price: number;
}

export interface ProductRow {
  id: string;
  merchantId: string;
  storeId: string;
  categoryId: string;
  name: string;
  emoji: string;
  price: number;
  stock: number;
  sold: number;
  visible: boolean;
  description: string;
  images: string[];
  videoUrl?: string;
  variants: VariantSpec[];
  options?: CatalogueOptionsGroup[];
  addons: AddonOption[];
  comboItems: ComboItem[];
  zeroStockAction: 'hide' | 'showSoldOut';
  sort: number;
  updatedAt: number;
  deleted?: boolean;
}

export interface CategoryRow {
  id: string;
  merchantId: string;
  storeId: string;
  name: string;
  sort: number;
  visible: boolean;
}

export interface ProductLog {
  id: string;
  merchantId: string;
  storeId: string;
  productId?: string;
  categoryId?: string;
  action: string;
  field?: string;
  before?: unknown;
  after?: unknown;
  actorId: string;
  role: string;
  ts: number;
}

export interface TemplateRow {
  id: string;
  merchantId: string;
  name: string;
  draft: Record<string, unknown>;
  createdAt: number;
}

export interface StoreListItem {
  id: string;
  name: string;
  address: string;
  open: boolean;
  productCount: number;
}

/* ---------- Orders & payments ---------- */

// Payment method enum from the contract (StoreSettingsAcceptedPaymentMethodsItem):
// mpesa | tigo_pesa | airtel_money | ezy_pesa | halotel | card | cod | bank.
export type PaymentMethodKey = StoreSettingsAcceptedPaymentMethodsItem;
export type PaymentProvider = PaymentMethodKey;

// App-supported subset of PaymentMethodKey — the store payment-method toggles.
export type SupportedPaymentMethod = 'mpesa' | 'airtel_money' | 'cod' | 'card';

// Order mutation request bodies — contract shapes (app extensions explicit):
export type OrderAcceptBody = AcceptOrderBody; // contract {expectedVersion}
export type OrderRejectBody = RejectOrderBody & { reasonCode?: string }; // reasonCode is an app extension
export type OrderBatchAcceptBody = { ids: string[] }; // app shape — contract uses {orderIds} (tracked, CONTRACT-ADDITIONS.md)
// Phase B: the app's ready/complete transitions map onto the contract status-advance
// endpoint POST /orders/{orderId}/status (body {status, note}) — see CONTRACT-ADDITIONS.md.
export type OrderAdvanceBody = AdvanceOrderBody;

// Contract rush reply body — {message} ≤300 (POST /orders/{orderId}/rush-reply).
export interface RushReplyBody {
  message: string; // ≤300
}

// Cancel response: the contract Order plus server-computed cancellation economics
// (ORDER-FLOW.md: cancel fee shown before confirmation after acceptance).
export type CancelOrderResult = OrderDto & {
  cancelFeeTZS: number; // 0 when cancelled before merchant acceptance
  refundTZS: number; // what the customer gets back (totalTZS − cancelFeeTZS)
};

// Contract receipt reprint row (GET /orders/receipts → [{orderId, printedAt, jobId}]).
// `no` is an app extension so the list can render the human-readable order number.
export interface ReceiptRowDto {
  orderId: string;
  printedAt: number; // epoch ms (contract: date-time)
  jobId: string;
  no?: string;
}

export interface OrderEvent {
  event: string;
  ts: number;
  actor: string;
  note?: string;
}

export interface OrderDto extends Order {
  merchantId: string;
  storeId: string;
  version: number;
  paymentId: string;
  timeline: OrderEvent[];
  riderId?: string;
  settledAt?: number;
  deliveryEtaMin?: number;
  freeDelivery?: boolean;
  /* P2: contract Order fields surfaced by the orders ops endpoints */
  routeSegments?: RouteSegmentDto[];
  waybillNumber?: string | null;
}

export interface Payment {
  id: string;
  merchantId: string;
  orderId: string;
  amount: number;
  method: PaymentMethodKey;
  provider: 'mock-mpesa' | 'mock-airtel-money'; // mock-only provider identifiers
  status: 'pending' | 'captured' | 'refunded' | 'failed' | 'reversed'; // reversed: POST /payments/{id}/reverse (finance role)
  idempotencyKey: string;
  createdAt: number;
  capturedAt?: number;
  refundedAmount: number;
  refunds: string[];
}

export interface Refund extends OrderRefund {
  id: string;
  merchantId: string;
  orderId: string;
  paymentId: string;
  reasonCode: string;
  decidedBy?: string;
  decidedAt?: number;
  createdAt: number;
}

/* ---------- Finance ---------- */

export interface LedgerEntry {
  id: string;
  merchantId: string;
  type: 'order' | 'commission' | 'tax' | 'refund' | 'settlement' | 'withdraw' | 'adjustment';
  amount: number;
  balance?: number;
  title: string;
  ts: number;
  status: 'completed' | 'pending';
  refType?: string;
  refId?: string;
}

export interface Settlement {
  id: string;
  merchantId: string;
  batchNo: string;
  periodStart: number;
  periodEnd: number;
  gross: number;
  commission: number;
  tax: number;
  net: number;
  payoutStatus: 'pending' | 'paid';
  paidAt?: number;
  orderCount: number;
  createdAt: number;
}

export interface Invoice {
  id: string;
  merchantId: string;
  settlementId: string;
  no: string;
  amount: number;
  taxRate: number;
  taxAmount: number;
  status: 'draft' | 'issued';
  createdAt: number;
}

/* ---------- Messaging ---------- */

export interface NotificationDto extends AppMessage {
  merchantId: string;
  /* Contract Notification.deepLink (nullable) — opens the target screen on
   * tap (NOTIFICATIONS.md §Notification center). App-side values are
   * expo-router paths (e.g. /orders/{id}, /dashboard/im/{id}). */
  deepLink?: string | null;
}

export interface ChatThreadDto extends ChatThread {
  merchantId: string;
  /* P6: contract conversation fields (API-CONTRACT.yaml /conversations) — the
   * conversation handlers reuse this thread store, mapping rows 1:1. */
  subject?: string;
  status?: ConversationStatus;
  blockReason?: string | null;
  blockedAt?: number | null;
}

/* ---------- Campaigns ---------- */

export interface CampaignDto extends Campaign {
  merchantId: string;
  version: number;
}

export type PlatformCampaignDto = PlatformCampaign;

export interface SegmentDto extends SegmentStats {
  merchantId: string;
}

export interface SegmentRow extends SegmentDto {
  id: string;
}

/* ---------- Ops ---------- */

export interface SupportTicket {
  id: string;
  merchantId: string;
  subject: string;
  body: string;
  status: 'open' | 'replied' | 'resolved';
  replies: { from: 'agent' | 'merchant'; text: string; ts: number }[];
  createdAt: number;
  updatedAt: number;
  /* P6: contract Ticket extras (API-CONTRACT.yaml) — the legacy list rows
   * carry an optional priority and a contract-status override so tickets can
   * surface `assigned`/`closed` states without reworking the legacy status
   * enum (EDUCATION-SUPPORT.md §Service center). */
  priority?: 'low' | 'normal' | 'high' | 'critical';
  statusOverride?: 'assigned' | 'closed';
}

export interface Rider {
  id: string;
  name: string;
  status: 'idle' | 'delivering' | 'offline';
  lat: number;
  lng: number;
  updatedAt: number;
}

export interface AuditLog {
  id: string;
  merchantId: string;
  actor: string;
  role: string;
  action: string;
  resource: string;
  resourceId: string;
  detail: string;
  ts: number;
}

export interface Experiment {
  id: string;
  key: string;
  variant: string;
  rollout: number;
}

export interface TaskDto extends Task {
  merchantId: string;
  key: string;
}

/* ---------- Reviews & redemptions & risk ---------- */

export interface ReviewDto {
  id: string;
  merchantId: string;
  orderNo: string;
  customer: string;
  rating: number;
  content: string;
  ts: number;
  reply?: string;
  repliedAt?: number;
  repliedBy?: string;
  platform: 'meituan' | 'dianping';
  /* P6: contract Review extras (API-CONTRACT.yaml) — visibility state + helpful votes. */
  state?: ReviewState;
  helpfulCount?: number;
  notHelpfulCount?: number;
  myVote?: boolean | null;
}

export interface ReviewAnalytics {
  total: number;
  avgRating: number;
  praiseRate: number;
  replyRate: number;
  distribution: { rating: number; count: number }[];
  weeklyAvg: { label: string; avg: number }[];
  byPlatform: {
    meituan: { total: number; avgRating: number; praiseRate: number };
    dianping: { total: number; avgRating: number; praiseRate: number };
  };
}

export interface RevenueComposition {
  channels: { key: string; label: string; amount: number; orders: number; share: number }[];
  methods: { method: string; label: string; amount: number; share: number }[];
}

export interface CampaignPerformance {
  id: string;
  title: string;
  type: string;
  status: string;
  budget: number;
  spent: number;
  impressions: number;
  clicks: number;
  orders: number;
  revenue: number;
  ctr: number;
  roas: number;
}

export interface PromotionsAnalytics {
  totalSpend: number;
  attributedRevenue: number;
  roas: number;
  perCampaign: CampaignPerformance[];
}

/* Analytics — contract shapes (backend/API-CONTRACT.yaml /analytics*). */

export interface AnalyticsDashboard {
  date: string;
  today: {
    orderCount: number;
    dineInCount: number;
    groupBuyCount: number;
    revenueTZS: number;
    newCustomers: number;
    averageOrderValueTZS: number;
  };
  live: {
    activeOrders: number;
    activeDineInTables: number;
    openAlerts: number;
  };
}

export interface TrafficChannel {
  channel: 'search' | 'category' | 'promotion' | 'group_buy' | 'dine_in_qr' | 'direct' | 'referral';
  visits: number;
  orders: number;
  conversionRate: number;
}

export interface TrafficAnalysis {
  from: string;
  to: string;
  totals: Record<string, number>;
  byChannel: TrafficChannel[];
}

export interface ProductPerformance {
  catalogueItemId: string;
  name: string;
  unitsSold: number;
  revenueTZS: number;
  ordersCount: number;
  availabilityRate: number;
}

export interface RevenueChannel {
  channel: 'delivery' | 'dine_in' | 'group_buy' | 'pickup';
  amountTZS: number;
}

export interface RevenueAnalysis {
  from: string;
  to: string;
  totalTZS: number;
  byChannel: RevenueChannel[];
}

export interface BenchmarkMetric {
  metric: string;
  merchant: number;
  average: number;
}

export interface BenchmarkSummary {
  category: string;
  merchantScore: number;
  industryAverage: number;
  percentileRank: number;
  metrics: BenchmarkMetric[];
}

export interface AnalyticsDiagnostic {
  severity: 'issue' | 'warning' | 'opportunity';
  topic: string;
  insight: string;
  action: string | null;
}

export interface FunnelStep {
  name: 'impressions' | 'store_visits' | 'menu_views' | 'carts' | 'orders' | 'completed';
  count: number;
}

export interface Funnel {
  steps: FunnelStep[];
}

export interface MarketAnalysis {
  category: string;
  demandIndex: number;
  trend: 'growing' | 'stable' | 'declining';
  topSearches: string[];
  competitorCount: number;
  suggestedPriceBandTZS: { low: number; high: number };
}

export interface OrderAnalytics {
  totalOrders: number;
  byHour: { hour: number; count: number }[];
  byPriceBand: { band: string; count: number }[];
  avgOrderValueTZS: number;
}

export interface HourlyTrendPoint {
  hour: number;
  revenueTZS: number;
  orderCount: number;
}

export interface ChainStorePerformance {
  storeId: string;
  businessName: string;
  revenueTZS: number;
  orderCount: number;
  conversionRate: number;
  rating: number | null;
  isOpen: boolean;
  lowStockCount: number;
}

export interface ForecastPoint {
  date: string;
  predictedRevenueTZS: number;
  confidence: number;
  weather: { rain: boolean; temperatureC: number; orderDeltaPct: number } | null;
}

export interface ReportExport {
  downloadUrl: string;
  expiresInSeconds: number;
}

export interface Redemption {
  id: string;
  merchantId: string;
  code: string;
  amount: number;
  customer: string;
  status: 'valid' | 'redeemed' | 'invalid' | 'expired';
  ts: number;
  redeemedAt?: number;
  redeemedBy?: string;
}

export interface RiskEvent {
  id: string;
  merchantId: string;
  level: 'low' | 'medium' | 'high';
  type: 'refund-ratio' | 'refund-velocity' | 'large-refund' | 'withdrawal-anomaly' | 'login-risk' | 'unusual-order-pattern';
  detail: string;
  ts: number;
  status: 'open' | 'reviewed' | 'resolved';
  reviewedBy?: string;
  reviewedAt?: number;
  /* P8b review contract (TASKS-RISK.md §51): decision resolved/dismissed +
   * reason ≤500; RISK_ALREADY_REVIEWED on repeats. */
  decision?: 'resolved' | 'dismissed';
  reason?: string;
}

/* ---------- Group buys & vouchers (P6c) ---------- */

// Contract GroupBuyStatus enum (API-CONTRACT.yaml): draft | pending_review |
// live | extended | delisted | ended | rejected.
export type GroupBuyStatus = 'draft' | 'pending_review' | 'live' | 'extended' | 'delisted' | 'ended' | 'rejected';

export type VoucherStatus = 'unused' | 'redeemed' | 'expired' | 'refunded' | 'void';

export interface GroupBuyDeal {
  id: string;
  merchantId: string;
  title: string;
  description?: string;
  imageUrl?: string | null;
  priceTZS: number;
  originalPriceTZS: number;
  quantity: number;
  soldCount: number;
  validityDays: number;
  salesStartAt: number;
  salesEndAt: number;
  status: GroupBuyStatus;
  rejectReason?: string | null;
}

export interface GroupBuyVoucher {
  code: string;
  groupBuyId: string;
  title: string;
  priceTZS: number;
  status: VoucherStatus;
  purchasedAt: number;
  redeemedAt?: number | null;
  expiresAt: number;
  redeemedByMerchantId?: string | null;
  /** App extension: refund requested/in-progress — voucher not redeemable until resolved. */
  refundPendingAt?: number | null;
}

// Contract POST /vouchers/{voucherCode}/verify body {merchantId}.
export interface VoucherVerifyBody {
  merchantId: string;
}

// Contract GET /vouchers/verify-history row (result enum per contract).
export interface VerifyHistoryEntry {
  voucherCode: string;
  verifiedAt: number;
  verifiedBy: string;
  result: 'redeemed' | 'invalid' | 'expired' | 'already_used';
}

// POST /group-buys/{groupId}/extend body {newEndsAt}.
export interface GroupBuyExtendBody {
  newEndsAt: number;
}

// Merchant-side create/update payload: contract GroupBuyDeal minus server-owned fields.
export interface GroupBuyDealInput {
  title: string;
  description?: string;
  imageUrl?: string | null;
  priceTZS: number;
  originalPriceTZS: number;
  quantity: number;
  validityDays: number;
  salesStartAt: number;
  salesEndAt: number;
}

/* ---------- Loyalty (members + tiers + top-ups) ---------- */

export type TopUpPaymentMethod = 'mpesa' | 'tigo_pesa' | 'airtel_money' | 'card' | 'cash';

export interface MembershipTier {
  id: string;
  merchantId: string; // app extension — row scoped to the merchant
  name: string; // ≤40
  thresholdTZS: number; // minimum top-up eligible for bonus (integer TZS)
  bonusRateBps: number; // bonus in basis points (integer, e.g. 250 = 2.5%)
  discountBps?: number; // tier order discount in basis points (contract MemberTier, e.g. 500 = 5%)
  benefits: string[]; // free-text perks
}

export interface LoyaltyMember {
  id: string;
  merchantId: string; // app extension — row scoped to the merchant
  name: string;
  phone: string; // full phone — detail/cashier responses only
  maskedPhone: string; // PII mask used in list views
  birthday?: string; // YYYY-MM-DD
  balanceTZS: number; // integer TZS minor units
  tierId: string | null;
  tier: MembershipTier | null; // embedded on detail responses
  totalSpendTZS: number; // integer TZS minor units
  joinedAt: number;
  createdAt: number;
  updatedAt: number;
}

/** List view row — phone is never returned, only the mask. */
export interface LoyaltyMemberListItem {
  id: string;
  name: string;
  maskedPhone: string;
  balanceTZS: number;
  tierId: string | null;
  tierName: string | null;
  totalSpendTZS: number;
  joinedAt: number;
}

export interface TopUpResult {
  id: string;
  memberId: string;
  amountTZS: number; // credited principal
  bonusTZS: number; // bonus credited per tier bonusRateBps (integer math)
  totalTZS: number; // amountTZS + bonusTZS
  paymentMethod: TopUpPaymentMethod;
  member: LoyaltyMember; // updated member after crediting
  ts: number;
}

/* ---------- Wallet & withdrawals (P6d — contract /wallet*, integer TZS) ---------- */

export interface Wallet {
  withdrawableTZS: number; // integer TZS
  pendingTZS?: number; // integer TZS
  totalTZS: number; // integer TZS
  /* Earnings pass (gap-09): commercial cadence from MerchantPrivate.commercial,
   * served by the finance mock (server-computed — the client never recomputes). */
  commissionRateBps?: number; // platform commission in basis points
  payoutCycleDays?: number; // payout cadence (default 3)
}

export type WalletTransactionType =
  | 'settlement'
  | 'withdrawal'
  | 'refund'
  | 'adjustment'
  | 'coupon_cost'
  | 'promotion_spend'
  | 'group_buy_settlement';

export interface WalletTransaction {
  id: string;
  type: WalletTransactionType;
  amountTZS: number; // signed integer TZS
  balanceTZS: number; // integer TZS
  referenceType?: string;
  referenceId?: string;
  createdAt: number; // epoch ms (app mock convention; contract uses date-time)
}

export type WithdrawalStatus = 'pending' | 'processing' | 'paid' | 'failed' | 'exception';

export interface Withdrawal {
  id: string;
  amountTZS: number; // integer TZS
  feeTZS?: number; // integer TZS, default 0
  status: WithdrawalStatus;
  method?: string;
  estimatedArrivalDays?: number | null;
  createdAt: number; // epoch ms (app mock convention; contract uses date-time)
  paidAt?: number | null;
  reason?: string | null;
}

export interface RequestWithdrawalBody {
  amountTZS: number; // integer ≥ 1
}

/* ---------- Device registry (P6d — contract /devices) ---------- */

export type MerchantDeviceType = 'printer' | 'pos' | 'kitchen_display' | 'cashier_terminal';
export type MerchantDeviceStatus = 'online' | 'offline' | 'error' | 'pairing';
export type MerchantDevicePurpose = 'receipt' | 'kitchen';
export type MerchantDevicePaperSize = '58mm' | '80mm';

export interface MerchantDevice {
  id: string;
  type: MerchantDeviceType;
  label: string; // ≤80
  purpose?: MerchantDevicePurpose; // default receipt
  paperSize?: MerchantDevicePaperSize; // default 80mm
  copies?: number; // 1–5, default 1
  status: MerchantDeviceStatus;
  settings?: Record<string, unknown>;
  lastSeenAt?: number | null; // epoch ms (app mock convention; contract uses date-time)
}

/** POST /devices and PATCH /devices/{deviceId} body — contract MerchantDevice minus server-owned fields. */
export interface MerchantDeviceInput {
  type: MerchantDeviceType;
  label: string;
  purpose?: MerchantDevicePurpose;
  paperSize?: MerchantDevicePaperSize;
  copies?: number;
  settings?: Record<string, unknown>;
}

/* ---------- Merchant staff (P6d — contract /merchants/me/staff) ---------- */

export type MerchantStaffRole = 'owner' | 'manager' | 'cashier' | 'kitchen' | 'waiter';
export type MerchantStaffStatus = 'invited' | 'active' | 'suspended';

export interface MerchantStaff {
  id: string;
  name: string;
  phone: string;
  role: MerchantStaffRole;
  storeId?: string | null; // chain store scope
  permissions?: string[]; // extra scope strings, e.g. "orders.accept"
  status: MerchantStaffStatus;
  createdAt: number; // epoch ms (app mock convention; contract uses date-time)
}

export interface MerchantStaffInput {
  name: string;
  phone: string;
  role: MerchantStaffRole;
  storeId?: string | null;
  permissions?: string[];
}

/* ---------- Events (server -> app) ---------- */

export type ServerEvent =
  | { type: 'order.updated'; order: OrderDto; at: number }
  | { type: 'order.created'; order: OrderDto; at: number }
  | { type: 'payment.captured'; payment: Payment; at: number }
  | { type: 'notification.created'; notification: NotificationDto; at: number }
  | { type: 'chat.message'; thread: ChatThreadDto; at: number }
  | { type: 'campaign.updated'; campaign: CampaignDto; at: number }
  | { type: 'ledger.updated'; entry: LedgerEntry; at: number }
  | { type: 'settlement.created'; settlement: Settlement; at: number }
  | { type: 'merchant.updated'; store: StoreServer; at: number }
  | { type: 'task.updated'; task: TaskDto; at: number }
  | { type: 'group_buy.deal_created'; deal: GroupBuyDeal; at: number }
  | { type: 'group_buy.deal_live'; deal: GroupBuyDeal; at: number }
  | { type: 'group_buy.deal_delisted'; deal: GroupBuyDeal; at: number }
  | { type: 'group_buy.deal_ended'; deal: GroupBuyDeal; at: number }
  | { type: 'group_buy.voucher_verified'; voucher: GroupBuyVoucher; at: number }
  | { type: 'loyalty.member_registered'; member: LoyaltyMember; at: number }
  | { type: 'loyalty.topup_credited'; member: LoyaltyMember; topUp: TopUpResult; at: number }
  | { type: 'loyalty.tier_changed'; member: LoyaltyMember; previousTierId: string | null; at: number }
  | { type: 'dine_in.bill_opened'; order: DineInOrder; at: number }
  | { type: 'dine_in.payment_confirmed'; order: DineInOrder; at: number }
  | { type: 'dine_in.bill_closed'; order: DineInOrder; at: number }
  | { type: 'wallet.withdrawal_requested'; withdrawal: Withdrawal; at: number }
  | { type: 'devices.registered'; device: MerchantDevice; at: number }
  | { type: 'devices.updated'; device: MerchantDevice; at: number }
  | { type: 'devices.unregistered'; deviceId: string; at: number }
  | { type: 'staff.invited'; staff: MerchantStaff; at: number }
  | { type: 'staff.updated'; staff: MerchantStaff; at: number }
  | { type: 'staff.removed'; staffId: string; at: number }
  | { type: 'staff.activated'; staff: MerchantStaff; at: number }
  | { type: 'staff.suspended'; staff: MerchantStaff; at: number }
  | { type: 'promotion.created'; promotion: Promotion; at: number }
  | { type: 'promotion.updated'; promotion: Promotion; at: number }
  | { type: 'promotion.paused'; promotion: Promotion; at: number }
  | { type: 'marketing.flash_sale_created'; flashSale: FlashSale; at: number }
  | { type: 'marketing.flash_sale_updated'; flashSale: FlashSale; at: number }
  | { type: 'marketing.dianjin_created'; campaign: DianjinCampaign; at: number }
  | { type: 'marketing.dianjin_toggled'; campaign: DianjinCampaign; at: number }
  | { type: 'marketing.precision_created'; campaign: PrecisionCampaign; at: number }
  | { type: 'marketing.precision_sent'; campaign: PrecisionCampaign; at: number }
  | { type: 'marketing.brand_display_updated'; campaign: BrandDisplayCampaign; at: number }
  | { type: 'marketing.self_service_updated'; promotion: SelfServicePromotion; at: number }
  | { type: 'marketing.coupon_verified'; coupon: Coupon; at: number }
  | { type: 'orders.held'; order: OrderDto; at: number }
  | { type: 'orders.unheld'; order: OrderDto; at: number }
  | { type: 'orders.cancelled'; order: OrderDto; at: number }
  | { type: 'orders.rescheduled'; order: OrderDto; at: number }
  | { type: 'orders.transferred'; order: OrderDto; transferId: string; at: number }
  | { type: 'orders.tipped'; order: OrderDto; at: number }
  | { type: 'orders.items_added'; order: OrderDto; requestId: string; at: number }
  | { type: 'orders.damage_reported'; claim: DamageClaimDto; at: number }
  | { type: 'orders.failed_delivery'; order: OrderDto; at: number }
  | { type: 'orders.handoff'; handoff: HandoffDto; at: number }
  | { type: 'orders.masked_call'; session: MaskedCallSessionDto; at: number }
  | { type: 'orders.proof_of_delivery'; proof: ProofOfDeliveryDto; at: number }
  | { type: 'orders.modify_requested'; order: OrderDto; at: number }
  | { type: 'orders.advance_handoff'; order: OrderDto; at: number }
  | { type: 'orders.route_updated'; orderId: string; segments: RouteSegmentDto[]; at: number }
  | { type: 'orders.status_conflict'; orderId: string; code: 'ORDER_STATUS_CONFLICT' | 'ORDER_AUTO_CANCELLED'; at: number }
  | { type: 'print_jobs.created'; printJob: PrintJob; at: number }
  | { type: 'print_jobs.updated'; printJob: PrintJob; at: number }
  | { type: 'print_jobs.failed'; printJob: PrintJob; at: number }
  | { type: 'refunds.created'; refund: RefundRequestDto; at: number }
  | { type: 'refunds.decided'; refund: RefundRequestDto; at: number }
  | { type: 'inventory.adjusted'; item: InventoryItem; adjustment: InventoryAdjustment; at: number }
  | { type: 'inventory.sync_updated'; config: InventorySyncConfig; at: number }
  | { type: 'suppliers.created'; supplier: Supplier; at: number }
  | { type: 'suppliers.updated'; supplier: Supplier; at: number }
  | { type: 'suppliers.deactivated'; supplierId: string; at: number }
  | { type: 'purchase_orders.created'; purchaseOrder: PurchaseOrder; at: number }
  | { type: 'purchase_orders.sent'; purchaseOrder: PurchaseOrder; at: number }
  | { type: 'purchase_orders.received'; purchaseOrder: PurchaseOrder; at: number }
  | { type: 'purchase_orders.cancelled'; purchaseOrder: PurchaseOrder; at: number }
  | { type: 'supplier_returns.created'; supplierReturn: SupplierReturn; at: number }
  | { type: 'warehouses.created'; warehouse: Warehouse; at: number }
  | { type: 'warehouses.updated'; warehouse: Warehouse; at: number }
  | { type: 'warehouses.stock_updated'; warehouse: Warehouse; at: number }
  | { type: 'warehouses.fulfilled'; orderId: string; warehouseId: string; at: number }
  | { type: 'group_buy.purchase'; dealId: string; count: number; at: number }
  | { type: 'coupons.claimed'; couponId: string; at: number }
  /* Promotion lifecycle additions (PROMOTIONS.md) — appended to the shared union. */
  | { type: 'promotion.moderated'; promotion: Promotion; decision: 'approved' | 'rejected' | 'paused'; at: number }
  | { type: 'group_buy.moderated'; deal: GroupBuyDeal; decision: 'approved' | 'rejected' | 'delisted'; at: number }
  | { type: 'flash_sale.live'; flashSale: FlashSale; at: number }
  | { type: 'flash_sale.ended'; flashSale: FlashSale; at: number }
  | { type: 'marketing.dianjin_budget_exceeded'; campaign: DianjinCampaign; at: number }
  | { type: 'marketing.coupon_campaign_created'; couponCampaign: CouponCampaign; at: number }
  | { type: 'loyalty.redeemed'; member: LoyaltyMember; amountTZS: number; balanceTZS: number; at: number }
  /* Dine-in + reservations + refunds (DINE-IN.md / PAYMENTS.md) — appended. */
  | { type: 'dine_in.bill_requested'; order: DineInOrder; at: number }
  | { type: 'reservation.requested'; reservation: Reservation; at: number }
  | { type: 'reservation.confirmed'; reservation: Reservation; at: number }
  | { type: 'reservation.reminder'; reservation: Reservation; at: number }
  | { type: 'refund.processed'; refundId: string; orderId: string; amountTZS: number; at: number }
  | { type: 'conversation.blocked'; conversation: ConversationDetail; at: number };

/* ---------- Common ---------- */

// Error envelope used by the app transport (client.ts). The contract's error
// body is ErrorResponse ({code, message, requestId, retryAfterSeconds}, with
// errors[] on ValidationResponse); the `{error: {...}}` envelope is the mock
// adaptation. The mock emits BOTH shapes (top-level fields additive), so a
// live backend serving the contract shape parses identically.
export interface ApiErrorFieldError {
  field: string;
  message: string;
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    retriable?: boolean;
    details?: Record<string, unknown>;
  };
  /** Contract ErrorResponse fields — emitted additively by the mock. */
  code?: string;
  message?: string;
  requestId?: string;
  retryAfterSeconds?: number;
  /** Contract ValidationResponse field-level errors. */
  errors?: ApiErrorFieldError[];
}

export type { Campaign, CampaignStatus, CampaignType, CustomerSegment, OrderRefund, TaskPriority };

/* ---------- Promotions & marketing ops (P6c — contract /promotions, /marketing/*) ---------- */

export type PromotionType =
  | 'discount'
  | 'spend_based'
  | 'full_reduction'
  | 'new_customer'
  | 'free_delivery'
  | 'instant_discount'
  | 'bargain'
  | 'haggle'
  | 'coupon'
  | 'flash'
  | 'featured'
  | 'traffic'
  | 'ppc'
  | 'brand'
  | 'group_buy';

export type PromotionStatus = 'draft' | 'pending_review' | 'live' | 'paused' | 'rejected' | 'ended';
export type PromotionTarget = 'all' | 'new_customers' | 'returning_customers' | 'segment';

export interface PromotionGroupBuyTarget {
  buyers: number;
  discountRateBps: number;
}

/** Contract Promotion — app timestamps are epoch ms (contract uses date-time). */
export interface Promotion {
  id: string;
  merchantId: string;
  type: PromotionType;
  title: string;
  description?: string;
  status: PromotionStatus;
  rules?: Record<string, unknown>;
  couponAmountTZS?: number | null;
  thresholdTZS?: number | null;
  discountRateBps?: number | null;
  target?: PromotionTarget;
  productIds?: string[];
  groupBuyTargets?: PromotionGroupBuyTarget[];
  haggleEnabled?: boolean;
  cpcTZS?: number | null;
  budgetTZS?: number | null;
  startsAt?: number;
  endsAt?: number;
  redeemCount: number;
  spendTZS: number;
  impressions: number;
  clicks: number;
  attributedOrders: number;
  attributedRevenueTZS: number;
  rejectReason?: string | null;
  /** Set when the sweeper ended the promotion past budget (PROMOTION_BUDGET_EXCEEDED). */
  budgetExceededReason?: 'PROMOTION_BUDGET_EXCEEDED' | null;
  createdAt: number;
}

/** POST /promotions and PATCH /promotions/{promotionId} body — server-owned fields are ignored. */
export interface PromotionInput {
  type: PromotionType;
  title: string;
  description?: string;
  status?: PromotionStatus;
  couponAmountTZS?: number | null;
  thresholdTZS?: number | null;
  discountRateBps?: number | null;
  target?: PromotionTarget;
  productIds?: string[];
  haggleEnabled?: boolean;
  cpcTZS?: number | null;
  budgetTZS?: number | null;
  startsAt?: number;
  endsAt?: number;
}

export interface PromotionPerformance {
  promotionId: string;
  impressions: number;
  clicks: number;
  redeemCount: number;
  spendTZS: number;
  attributedRevenueTZS: number;
  roiPercent: number;
}

export type FlashSaleStatus = 'draft' | 'scheduled' | 'live' | 'ended' | 'cancelled';

/** Contract FlashSale + merchantId (app-extension for scoping, cf. LoyaltyMember). */
export interface FlashSale {
  id: string;
  merchantId: string;
  itemIds: string[];
  discountBps: number;
  quantityLimit?: number | null;
  soldCount: number;
  startsAt: number;
  endsAt: number;
  status: FlashSaleStatus;
  createdAt: number;
}

export interface FlashSaleInput {
  itemIds: string[];
  discountBps: number;
  quantityLimit?: number | null;
  startsAt: number;
  endsAt: number;
  status?: FlashSaleStatus;
}

export type PrecisionOfferType = 'coupon' | 'discount' | 'message';

export interface PrecisionOffer {
  type: PrecisionOfferType;
  value?: string;
}

export type PrecisionStatus = 'draft' | 'sent' | 'active' | 'ended';

/** Contract PrecisionCampaign + merchantId (app-extension for scoping). */
export interface PrecisionCampaign {
  id: string;
  merchantId: string;
  name: string;
  segmentId: string;
  segmentLabel?: string;
  offer: PrecisionOffer;
  status: PrecisionStatus;
  sentCount: number;
  createdAt: number;
}

export interface PrecisionCampaignInput {
  name: string;
  segmentId: string;
  offer: PrecisionOffer;
  status?: PrecisionStatus;
}

/** Contract DianjinCampaign + merchantId (app-extension for scoping). */
export interface DianjinCampaign {
  id: string;
  merchantId: string;
  name: string;
  budgetTZS: number;
  bidBps: number;
  active: boolean;
  spendTZS: number;
  clicks: number;
  /** Sweeper stops delivery past budget (DIANJIN_BUDGET_EXCEEDED) until budget is raised. */
  stoppedReason?: 'DIANJIN_BUDGET_EXCEEDED' | null;
  createdAt: number;
}

export interface DianjinCampaignInput {
  name: string;
  budgetTZS: number;
  bidBps: number;
  active?: boolean;
}

/** Contract BrandDisplayCampaign + merchantId (app-extension for scoping). */
export interface BrandDisplayCampaign {
  id: string;
  merchantId: string;
  name: string;
  budgetTZS: number;
  startsAt: number;
  endsAt: number;
  active: boolean;
  impressions: number;
  createdAt: number;
}

export interface BrandDisplayCampaignInput {
  name: string;
  budgetTZS: number;
  startsAt: number;
  endsAt: number;
  active?: boolean;
}

export type SelfServicePackage = 'basic' | 'premium' | 'enterprise';

/** Contract SelfServicePromotion + merchantId (app-extension for scoping). */
export interface SelfServicePromotion {
  merchantId: string;
  active: boolean;
  designUrl?: string | null;
  homepageExposure: boolean;
  package: SelfServicePackage;
  packagePriceTZS?: number | null;
  startedAt?: number | null;
}

export type CouponStatus = 'available' | 'claimed' | 'used' | 'expired' | 'void';

export type CouponCampaignKind = 'percentage' | 'fixed' | 'shipping';
export type CouponCampaignStatus = 'draft' | 'live' | 'ended';

/** Contract CouponCampaign (POST /coupons body shape; stored per merchant). */
export interface CouponCampaign {
  id: string;
  merchantId: string;
  title: string;
  kind: CouponCampaignKind;
  discountTZS: number;
  discountRateBps?: number | null;
  minimumSpendTZS: number;
  maxDiscountTZS?: number | null;
  quantity: number;
  claimedCount: number;
  validUntil: number;
  status: CouponCampaignStatus;
}

/** POST /coupons (createCouponCampaign) body — merchant-owned fields are ignored. */
export interface CouponCampaignInput {
  title: string;
  kind?: CouponCampaignKind;
  discountTZS: number;
  discountRateBps?: number | null;
  minimumSpendTZS: number;
  maxDiscountTZS?: number | null;
  quantity: number;
  validUntil: number;
}

/** Contract Coupon — a single issued coupon code (POST /marketing/coupons/verify result). */
export interface Coupon {
  id: string;
  campaignId: string;
  code: string;
  title?: string;
  discountTZS?: number;
  minimumSpendTZS?: number;
  status: CouponStatus;
  claimedAt?: number | null;
  usedAt?: number | null;
  expiresAt: number;
}

export interface CouponStats {
  couponId: string;
  claimed: number;
  used: number;
  conversionRate: number;
}

declare module '@/types' {
  export interface OrderSettings {
    contactlessDelivery?: boolean;
    acceptWhileClosed?: boolean;
    requireNotes?: 'none' | 'optional' | 'required';
    autoCancelMinutes?: number;
  }
}

/* ---------- P2: orders ops + refunds queue (contract /orders*, /refunds*) ---------- */

// Contract OrderStatus enum (API-CONTRACT.yaml OrderStatus). The merchant app's
// own status set is a subset; these DTOs carry the full contract vocabulary.
export type ContractOrderStatus =
  | 'draft'
  | 'pending_payment'
  | 'paid'
  | 'merchant_accepted'
  | 'preparing'
  | 'rider_assigned'
  | 'rider_arrived_pickup'
  | 'picked_up'
  | 'delivering'
  | 'rider_arrived_dropoff'
  | 'delivered'
  | 'completed'
  | 'failed_delivery'
  | 'returning'
  | 'rescheduled'
  | 'timed_out'
  | 'cancelled'
  | 'refunded'
  | 'failed'
  | 'disputed';

// Contract OrderEvent — timeline row (GET /orders/{orderId}/timeline).
// `at` is epoch ms (app mock convention; contract uses date-time).
export interface OrderTimelineEventDto {
  status: ContractOrderStatus;
  at: number;
  by: string;
  note?: string;
}

// Contract TrackingEvent (GET /orders/{orderId}/track).
export interface TrackingEventDto {
  status: ContractOrderStatus;
  riderLocation?: { lat: number; lon: number };
  updatedAt: number;
  estimateMinutes?: number;
  stageEtas?: { merchantArrival?: number | null; pickup?: number | null; dropoff?: number | null } | null;
}

// Contract TrackingPhase (GET /orders/{orderId}/tracking-phases).
export interface TrackingPhaseDto {
  phase: 'confirmed' | 'picked_up' | 'in_transit' | 'arrived_city' | 'out_for_delivery' | 'delivered';
  label: string;
  status: 'pending' | 'active' | 'completed';
  at?: number | null;
  eta?: number | null;
}

// Contract RouteSegment (GET /orders/{orderId}/route, Order.routeSegments).
export interface RouteSegmentDto {
  legId: string;
  sequence: number;
  type: 'first_mile' | 'linehaul' | 'hub_transfer' | 'last_mile' | 'return';
  mode?: 'motorcycle' | 'car' | 'van' | 'linehaul_bus' | 'linehaul_truck';
  fromHubId?: string | null;
  toHubId?: string | null;
  handledBy?: string;
  status: 'pending' | 'in_progress' | 'completed' | 'skipped';
  plannedStartAt?: number | null;
  plannedEndAt?: number | null;
  etaAt?: number | null;
  startedAt?: number | null;
  completedAt?: number | null;
  custody?: { from: string; to: string; sealIntact: boolean; at: number } | null;
}

// Contract WaybillEvent + Waybill (GET /orders/{orderId}/waybill).
export interface WaybillEventDto {
  at: number;
  type: 'scanned' | 'handoff' | 'loaded' | 'departed' | 'arrived' | 'sorted' | 'exception' | 'delivered';
  location: string;
  actor?: string;
  note?: string | null;
}

export interface WaybillDto {
  waybillNumber: string;
  events: WaybillEventDto[];
}

// Contract FareBreakdown (GET /orders/{orderId}/fare) — integer TZS.
export interface FareBreakdownDto {
  orderId: string;
  totalTZS: number;
  baseTZS?: number;
  distanceTZS?: number;
  timeTZS?: number;
  surgeMultiplier?: number;
  surgeTZS?: number;
  tipTZS?: number;
  codFeeTZS?: number;
  waitPayTZS?: number;
  bonusTZS?: number;
  currency?: string;
}

// Contract RefundRequest (GET /refunds queue row). `createdAt` is epoch ms.
export interface RefundRequestDto {
  id: string;
  orderId: string;
  customerName?: string | null;
  amountTZS: number;
  reason: string;
  status: 'pending' | 'approved' | 'rejected';
  decisionReason?: string | null;
  createdAt: number;
  /** Mock extension — approval-gated refunds (ENTERPRISE-FINANCE.md L49-51):
   *  set while a refund above the merchant threshold awaits an approval
   *  decision. The refund executes only after the approval is approved. */
  awaitingApproval?: RefundAwaitingApproval | null;
}

// Contract Handoff (POST /orders/{orderId}/handoff).
export interface HandoffDto {
  id: string;
  fromLegId: string;
  toLegId: string;
  scanCode: string;
  sealIntact: boolean;
  conditionPhotoUrl?: string | null;
  location?: { lat: number; lon: number };
  from?: string;
  to?: string;
  at: number;
}

// Contract ProofOfDelivery (POST /orders/{orderId}/proof-of-delivery).
export interface ProofOfDeliveryDto {
  id: string;
  orderId: string;
  type: 'photo' | 'signature' | 'otp';
  value: string;
  dropoffOption?: 'hand_to_customer' | 'leave_at_door';
  itemIds?: string[];
  documentUrl?: string | null;
  gpsStamp?: { lat: number; lon: number; at: number } | null;
  verified: boolean;
  submittedAt: number;
}

// Contract MaskedCallSession (POST /orders/{orderId}/masked-call).
export interface MaskedCallSessionDto {
  sessionId: string;
  orderId: string;
  maskedNumber: string;
  direction?: 'rider_to_customer' | 'customer_to_rider';
  expiresAt: number;
}

// Contract DamageClaim (POST /orders/{orderId}/damage).
export interface DamageClaimDto {
  id: string;
  orderId: string;
  type: 'spilled' | 'missing' | 'wrong_item' | 'damaged_packaging' | 'quality';
  description: string;
  images?: string[];
  status: 'open' | 'approved' | 'rejected' | 'compensated';
  createdAt: number;
}

// Contract BatchResult (POST /orders/batch/accept|reject).
export interface BatchResultDto {
  accepted: number;
  failed: number;
  failures: { orderId: string; code: string }[];
}

// Contract EnterpriseOrder = Order + corporate block (GET /orders/enterprise).
export interface EnterpriseOrderDto extends OrderDto {
  companyName: string;
  costCenter?: string | null;
  billingRef?: string | null;
}

// Contract RushOrder (GET /orders/rush queue row).
export interface RushOrderDto {
  orderId: string;
  urgency?: 'low' | 'medium' | 'high' | 'critical';
  status: 'open' | 'replied' | 'resolved';
  requestedAt: number;
  repliedAt?: number | null;
  replyMessage?: string | null;
}

// ---- P2 mutation bodies (contract shapes; app mock conventions epoch ms) ----

export interface CancelOrderBody {
  reason: string; // ≤500
}

export interface HoldOrderBody {
  reason: string; // ≤300
  until?: number | null;
}

export interface RescheduleOrderBody {
  scheduledAt: number; // date-time
  reason: string; // ≤500
}

export interface TransferOrderBody {
  reason: string; // ≤500
}

export interface TipOrderBody {
  amountTZS: number; // integer ≥ 1
  method?: PaymentMethodKey;
  note?: string; // ≤200
}

export interface AddItemsOrderBody {
  items: { catalogueItemId: string; quantity: number }[]; // minItems 1
  reason: string; // ≤300
}

export interface FailedDeliveryBody {
  reason: 'customer_unavailable' | 'wrong_address' | 'refused' | 'damaged' | 'other';
  note?: string; // ≤500
  photoUrl?: string | null;
  returnToMerchant?: boolean;
}

export interface ModifyRequestBody {
  type: 'change_address' | 'change_time' | 'add_item' | 'remove_item' | 'other';
  note: string; // ≤500
  items?: { catalogueItemId: string; quantity: number }[] | null;
}

export interface DamageClaimBody {
  type: DamageClaimDto['type'];
  description: string; // ≤1000
  images?: string[]; // maxItems 5
}

export interface ProofOfDeliveryBody {
  type: 'photo' | 'signature' | 'otp';
  value: string;
  dropoffOption?: 'hand_to_customer' | 'leave_at_door';
  itemIds?: string[];
  documentUrl?: string | null;
  gpsStamp?: { lat: number; lon: number; at: number } | null;
}

export interface HandoffBody {
  fromLegId: string;
  toLegId: string;
  scanCode: string;
  sealIntact: boolean;
  conditionPhotoUrl?: string | null;
  location?: { lat: number; lon: number };
  from?: string;
  to?: string;
}

export interface AdvanceLegBody {
  action: 'start' | 'complete';
  location?: { lat: number; lon: number };
}

/** Advance-flow handoff: advance a scheduled order into preparation. */
export interface AdvanceOrderHandoffBody {
  orderId: string;
  expectedVersion?: number;
  note?: string;
}

export interface BatchRejectBody {
  orderIds: string[]; // minItems 1, maxItems 50
  reason: string; // ≤500
}

export interface RefundDecisionBody {
  reason: string; // ≤500
  amountTZS?: number | null; // partial amount; defaults to requested
}

/* ---------- P8: inventory & supply chain (contract /inventory, /suppliers,
 * /purchase-orders, /supplier-returns, /warehouses — API-CONTRACT.yaml).
 * Money is integer TZS; quantities are integers; timestamps are epoch ms
 * (app mock convention; the contract uses date-time). ---------- */

export type InventoryAlertLevel = 'low' | 'out_of_stock';

/** Contract InventoryItem (GET /inventory/items, POST …/adjust). */
export interface InventoryItem {
  catalogueItemId: string;
  name: string;
  storeId?: string | null;
  stockOnHand: number;
  reserved: number;
  available: number;
  lowStockThreshold: number;
  unitCostTZS?: number | null;
  lastRestockedAt?: number | null;
}

/** Contract adjustment row (GET /inventory/adjustments, append-only). */
export interface InventoryAdjustment {
  id: string;
  itemId: string;
  delta: number;
  reason: string;
  storeId?: string | null;
  at: number;
  by: string;
}

/** Contract InventoryAlert (GET /inventory/alerts). */
export interface InventoryAlert {
  catalogueItemId: string;
  name: string;
  storeId?: string | null;
  level: InventoryAlertLevel;
  stockOnHand: number;
  suggestedReorderQty?: number;
}

export type InventoryMasterSource = 'platform' | 'pos' | 'erp';
export type InventorySyncChannel = 'platform_orders' | 'dine_in' | 'pos' | 'delivery_partners' | 'mini_program';

/** Contract InventorySyncConfig (GET/PUT /inventory/sync-config). */
export interface InventorySyncConfig {
  enabled: boolean;
  masterSource: InventoryMasterSource;
  channels: InventorySyncChannel[];
  lastSyncedAt?: number | null;
}

/** Contract InventorySyncConfig PUT body (server-owned lastSyncedAt ignored). */
export interface InventorySyncConfigInput {
  enabled: boolean;
  masterSource: InventoryMasterSource;
  channels: InventorySyncChannel[];
}

export type SupplierStatus = 'active' | 'suspended';

/** Contract Supplier (GET/POST /suppliers, PATCH /suppliers/{supplierId}). */
export interface Supplier {
  id: string;
  name: string;
  contactPhone: string;
  contactEmail?: string;
  categories?: string[];
  paymentTerms?: string;
  status: SupplierStatus;
  createdAt: number;
}

/** Contract Supplier create/update body (id/status/createdAt server-owned). */
export interface SupplierInput {
  name: string;
  contactPhone: string;
  contactEmail?: string;
  categories?: string[];
  paymentTerms?: string;
}

export type PurchaseOrderStatus = 'draft' | 'sent' | 'partially_received' | 'received' | 'closed' | 'cancelled';

export interface PurchaseOrderItem {
  catalogueItemId: string;
  name: string;
  quantity: number;
  receivedQuantity: number;
  unitCostTZS: number;
}

/** Contract PurchaseOrder (GET/POST /purchase-orders, …/{id}, send/receive/cancel). */
export interface PurchaseOrder {
  id: string;
  supplierId: string;
  storeId?: string | null;
  status: PurchaseOrderStatus;
  items: PurchaseOrderItem[];
  expectedArrivalAt?: number | null;
  totalCostTZS: number;
  note?: string;
  createdAt: number;
  receivedAt?: number | null;
}

/** Contract POST /purchase-orders body — items carry catalogueItemId+quantity; the
 * server derives name/unitCostTZS from the catalogue and starts the PO as draft. */
export interface PurchaseOrderInput {
  supplierId: string;
  storeId?: string | null;
  items: { catalogueItemId: string; quantity: number }[];
  expectedArrivalAt?: number | null;
  note?: string;
}

/** Contract POST /purchase-orders/{purchaseOrderId}/receive body (partial or full). */
export interface ReceivePurchaseOrderBody {
  items: { catalogueItemId: string; quantity: number }[];
}

/** Contract POST /purchase-orders/{purchaseOrderId}/cancel body. */
export interface CancelPurchaseOrderBody {
  reason: string; // ≤500
}

/** Contract POST /supplier-returns body. */
export interface CreateSupplierReturnBody {
  supplierId: string;
  items: { catalogueItemId: string; quantity: number }[]; // minItems 1
  reason: string; // ≤500
}

export type SupplierReturnStatus = 'pending' | 'processed' | 'rejected';

/** Contract POST /supplier-returns 201 body — no GET/list endpoint exists. */
export interface SupplierReturn {
  id: string;
  status: SupplierReturnStatus;
  createdAt: number;
}

export type WarehouseStatus = 'active' | 'full' | 'maintenance';

export interface WarehouseStockRow {
  catalogueItemId: string;
  quantity: number;
}

/** Contract Warehouse (GET/POST /warehouses, GET/PATCH /warehouses/{warehouseId}).
 * `totalUnits` is a mock-extension field, server-computed for the list view. */
export interface Warehouse {
  id: string;
  name: string;
  cityId: string;
  address?: string;
  lat?: number | null;
  lon?: number | null;
  servingCities: string[];
  stock: WarehouseStockRow[];
  status: WarehouseStatus;
  createdAt: number;
  totalUnits?: number;
}

/** Contract Warehouse create/update body (id/stock/createdAt server-owned). */
export interface WarehouseInput {
  name: string;
  cityId: string;
  address?: string;
  lat?: number | null;
  lon?: number | null;
  servingCities?: string[];
  status?: WarehouseStatus;
}

/** Contract PUT /warehouses/{warehouseId}/stock body — signed deltas (merchant bulk inbound). */
export interface AdjustWarehouseStockBody {
  items: { catalogueItemId: string; delta: number }[];
  /** ISC L154-156 — required when any delta is negative (write-off/return). */
  reason?: string;
}

/** Contract POST /warehouses/{warehouseId}/fulfill body (server-driven order tag). */
export interface FulfillFromWarehouseBody {
  orderId: string;
}

/* ================= P8: catalogue ops + chain (API-CONTRACT.yaml) ================= */

/* ---- Barcodes ---- */

export type BarcodeFormatCode = 'ean13' | 'ean8' | 'upca' | 'code128' | 'code39' | 'qr';

export interface BarcodeFormat {
  code: BarcodeFormatCode;
  label: string;
}

export interface BarcodeInfo {
  id: string;
  code: string;
  format: BarcodeFormatCode;
  catalogueItemId: string;
  createdAt: number;
}

export interface BarcodeLookup {
  catalogueItemId: string;
  name: string;
  priceTZS: number;
  available: boolean;
  stockOnHand: number | null;
}

export interface BarcodeHistoryEntry {
  at: number;
  action: 'generated' | 'scanned' | 'printed' | 'updated';
}

export interface BatchBarcodeEntry {
  code: string;
  catalogueItemId: string;
}

export interface BatchBarcodeResult {
  jobId: string;
  accepted: number;
  rejected: number;
}

/* ---- Combos ---- */

export interface ComboLine {
  catalogueItemId: string;
  quantity: number;
}

export interface Combo {
  id: string;
  name: string;
  description?: string;
  items: ComboLine[];
  priceTZS?: number;
  imageUrl?: string | null;
  available: boolean;
  createdAt: number;
}

/* ---- Menus (multi-store) ---- */

export interface MenuSection {
  name: string;
  itemIds: string[];
}

export interface Menu {
  id: string;
  name: string;
  storeIds: string[];
  sections: MenuSection[];
  active: boolean;
  createdAt: number;
}

/* ---- Product videos ---- */

export interface ProductVideo {
  id: string;
  title: string;
  url: string;
  thumbnailUrl?: string | null;
  catalogueItemId?: string | null;
  status: 'active' | 'processing' | 'failed';
  durationSeconds?: number | null;
  views: number;
  createdAt: number;
}

/* ---- Bulk operations ---- */

export type BulkOperationStatus = 'queued' | 'processing' | 'completed' | 'partial' | 'failed';
export type BulkOperationType = 'price_update' | 'availability' | 'promotion_apply' | 'catalogue_sync';

export interface BulkOperationResultRow {
  storeId: string;
  ok: boolean;
  error?: string;
}

export interface BulkOperation {
  id: string;
  type: BulkOperationType;
  storeIds: string[];
  payload: Record<string, unknown>;
  status: BulkOperationStatus;
  results: BulkOperationResultRow[];
  createdBy: string;
  createdAt: number;
  requiresApproval: boolean;
}

/* ---- Chain ---- */

export interface ChainDashboard {
  date: string;
  totals: {
    orders: number;
    revenueTZS: number;
    activeOrders: number;
    lowStockAlerts: number;
  };
  stores: ChainStorePerformance[];
}

export interface ChainReportBody {
  reportType: 'financial' | 'operational' | 'orders' | 'inventory';
  from: string;
  to: string;
  storeIds?: string[];
}

/* ---- P8 events (emitted on the mock event bus; app ws consumers only
 * handle known variants, so these stay optional on the wire) ---- */

export type CatalogueExtEvent =
  | { type: 'catalogue.combo_created'; combo: Combo; at: number }
  | { type: 'catalogue.combo_updated'; combo: Combo; at: number }
  | { type: 'catalogue.combo_deleted'; comboId: string; at: number }
  | { type: 'catalogue.menu_created'; menu: Menu; at: number }
  | { type: 'catalogue.menu_updated'; menu: Menu; at: number }
  | { type: 'catalogue.menu_deleted'; menuId: string; at: number }
  | { type: 'catalogue.video_created'; video: ProductVideo; at: number }
  | { type: 'catalogue.video_deleted'; videoId: string; at: number }
  | { type: 'catalogue.barcode_generated'; barcode: BarcodeInfo; at: number }
  | { type: 'catalogue.bulk_created'; operation: BulkOperation; at: number }
  | { type: 'catalogue.bulk_updated'; operation: BulkOperation; at: number }
  | { type: 'chain.report_exported'; reportType: string; at: number };

/* ---- P8b: staff ops + approvals (contract /staff/*, /approvals) ----
 * Same convention as CatalogueExtEvent: appended here so the ServerEvent
 * union (mid-file, shared with a parallel agent) is not touched; handlers
 * emit through the common base event type. */

export type StaffShiftStatus = 'scheduled' | 'active' | 'completed' | 'cancelled';

export interface StaffShift {
  id: string;
  staffId: string;
  role: MerchantStaffRole;
  startAt: number; // epoch ms (app mock convention; contract uses date-time)
  endAt: number;
  status: StaffShiftStatus;
  storeId: string | null;
}

export interface StaffShiftInput {
  staffId: string;
  role?: MerchantStaffRole;
  startAt: number;
  endAt: number;
  storeId?: string | null;
}

export type AttendanceSource = 'app' | 'pos';

export interface AttendanceRecord {
  id: string;
  staffId: string;
  shiftId: string | null;
  clockedInAt: number;
  clockedOutAt: number | null;
  durationMinutes: number | null;
  source: AttendanceSource;
}

export interface StaffPerformance {
  staffId: string;
  name: string;
  ordersProcessed: number;
  avgHandleTimeMinutes: number;
  cancellations: number;
  ratingAverage: number | null;
  attendanceRate: number;
  commissionTZS: number;
}

export type CommissionRuleType = 'per_order' | 'per_service' | 'per_revenue';

export interface CommissionRule {
  id: string;
  staffId: string | null; // null = rule applies to all staff
  type: CommissionRuleType;
  rateBps: number; // basis points, 0–10,000
  active: boolean;
}

export interface CommissionRuleInput {
  staffId?: string | null;
  type: CommissionRuleType;
  rateBps: number;
  active?: boolean;
}

export interface CommissionRulesBody {
  rules: CommissionRuleInput[];
}

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';

export type ApprovalType =
  | 'price_change'
  | 'promotion'
  | 'refund_above_threshold'
  | 'inventory_adjustment'
  | 'staff_role_change'
  | 'bulk_operation';

export interface ApprovalRequest {
  id: string;
  type: ApprovalType;
  refType?: string;
  refId?: string;
  summary?: string; // ≤300
  amountTZS?: number | null;
  status: ApprovalStatus;
  requestedBy: string;
  decisionBy: string | null;
  decisionComment: string | null;
  createdAt: number;
  decidedAt: number | null;
}

export interface ApprovalInput {
  type: ApprovalType;
  refType?: string;
  refId?: string;
  summary?: string;
  amountTZS?: number | null;
}

export type ApprovalDecision = 'approved' | 'rejected';

export interface ApprovalDecisionBody {
  decision: ApprovalDecision;
  comment: string; // ≤500, required
}

export type StaffOpsEvent =
  | { type: 'staff.shift_created'; shift: StaffShift; at: number }
  | { type: 'staff.shift_updated'; shift: StaffShift; at: number }
  | { type: 'staff.shift_deleted'; shiftId: string; at: number }
  | { type: 'attendance.clocked_in'; record: AttendanceRecord; at: number }
  | { type: 'attendance.clocked_out'; record: AttendanceRecord; at: number }
  | { type: 'approvals.requested'; approval: ApprovalRequest; at: number }
  | { type: 'approvals.decided'; approval: ApprovalRequest; at: number };

/* ---- P8b: webhooks + integrations + tasks center (contract /webhooks,
 * /integrations, /tasks/*). App timestamps are epoch ms (contract date-time);
 * money stays integer TZS. ---- */

export type WebhookStatus = 'active' | 'disabled' | 'failing';

export interface WebhookSubscription {
  id: string;
  url: string;
  events: string[];
  status: WebhookStatus;
  lastDeliveryAt: number | null;
  createdAt: number;
}

/** Write-only secret set once on create — the API never returns it. */
export interface WebhookSubscriptionInput {
  url: string;
  events: string[];
  status?: WebhookStatus;
}

/** PATCH body — `rotateSecret: true` regenerates the write-only secret. */
export interface UpdateWebhookSubscriptionBody {
  url?: string;
  events?: string[];
  status?: WebhookStatus;
  rotateSecret?: boolean;
}

export type WebhookDeliveryStatus = 'success' | 'failed' | 'retrying';

export interface WebhookDelivery {
  id: string;
  webhookId: string;
  event: string;
  status: WebhookDeliveryStatus;
  attempts: number;
  statusCode: number | null;
  nextRetryAt: number | null;
  deliveredAt: number | null;
}

export type IntegrationProvider =
  | 'pos'
  | 'erp'
  | 'accounting'
  | 'payroll'
  | 'delivery_partner'
  | 'mini_program';

export type IntegrationStatus = 'connected' | 'disconnected' | 'error';

export interface IntegrationInfo {
  id: string;
  provider: IntegrationProvider;
  label: string;
  status: IntegrationStatus;
  lastSyncedAt: number | null;
  scopes: string[];
}

/** POST /integrations/{integrationId}/disconnect body — reason required (<=500). */
export interface DisconnectIntegrationBody {
  reason: string;
}

export type TaskKind = 'anomaly' | 'violation' | 'activity' | 'setup';
export type TaskSeverity = 'info' | 'warning' | 'critical';
export type TaskStatus = 'open' | 'in_progress' | 'done' | 'dismissed';

export interface TaskItem {
  id: string;
  kind: TaskKind;
  title: string;
  description?: string;
  refType?: string | null;
  refId?: string | null;
  severity?: TaskSeverity;
  status: TaskStatus;
  createdAt: number;
  dueAt?: number | null;
}

/** PATCH /tasks/{taskId} body — status required, note <=500. */
export interface UpdateTaskStatusBody {
  status: TaskStatus;
  note?: string;
}

export type ActivitySubmissionStatus = 'submitted' | 'approved' | 'rejected';

export interface ActivitySubmission {
  id: string;
  platformEventId: string;
  status: ActivitySubmissionStatus;
  submittedAt: number;
}

/** POST /tasks/activities body — contract requires platformEventId + status. */
export interface SubmitActivityBody {
  platformEventId: string;
  status?: ActivitySubmissionStatus;
}

export interface SetupStep {
  id: string;
  title: string;
  order: number;
  completed: boolean;
  deepLink?: string | null;
}

export type P8bEvent =
  | { type: 'webhooks.created'; webhook: WebhookSubscription; at: number }
  | { type: 'webhooks.updated'; webhook: WebhookSubscription; at: number }
  | { type: 'webhooks.deleted'; webhookId: string; at: number }
  | { type: 'webhooks.delivery_failed'; delivery: WebhookDelivery; at: number }
  | { type: 'integrations.disconnected'; integration: IntegrationInfo; at: number }
  | { type: 'tasks.updated'; task: TaskItem; at: number }
  | { type: 'tasks.activity_submitted'; submission: ActivitySubmission; at: number }
  | { type: 'tasks.setup_step_completed'; stepId: string; steps: SetupStep[]; at: number };

/* ---------- P8c: scheduled reports + CRM journeys + data exports
 * (contract /reports, /journeys, /data/exports, /privacy/export) ---------- */

export type ReportType = 'revenue' | 'orders' | 'products' | 'traffic' | 'inventory' | 'financial';
export type ReportCadence = 'daily' | 'weekly' | 'monthly';
export type ReportFormat = 'csv' | 'xlsx' | 'pdf';

/** Contract ScheduledReport (GET /reports, POST /reports, PATCH /reports/{id}). */
export interface ScheduledReport {
  id: string;
  name: string;
  reportType: ReportType;
  cadence: ReportCadence;
  format: ReportFormat;
  recipients?: string[];
  filters?: Record<string, unknown>;
  storeIds?: string[];
  enabled: boolean;
  lastRunAt?: string | null;
}

export interface ScheduledReportInput {
  name: string;
  reportType: ReportType;
  cadence: ReportCadence;
  format: ReportFormat;
  recipients?: string[];
  filters?: Record<string, unknown>;
  storeIds?: string[];
  enabled?: boolean;
}

/** PATCH /reports/{reportId} body — partial ScheduledReport update. */
export interface UpdateScheduledReportBody {
  name?: string;
  reportType?: ReportType;
  cadence?: ReportCadence;
  format?: ReportFormat;
  recipients?: string[];
  filters?: Record<string, unknown>;
  storeIds?: string[];
  enabled?: boolean;
}

export type JourneyActionType = 'push' | 'sms' | 'coupon' | 'email';
export type JourneyStatus = 'draft' | 'active' | 'paused';

export interface JourneyAction {
  type: JourneyActionType;
  delayHours: number;
  template?: string;
}

/** Contract CustomerJourney (GET /journeys, POST /journeys). */
export interface CustomerJourney {
  id: string;
  name: string;
  trigger: string;
  actions: JourneyAction[];
  status: JourneyStatus;
  createdAt: number;
}

export interface CustomerJourneyInput {
  name: string;
  trigger: string;
  actions: JourneyAction[];
  status?: JourneyStatus;
}

export type DataExportScope = 'all' | 'orders' | 'customers' | 'catalogue' | 'financial';
export type DataExportFormat = 'csv' | 'xlsx' | 'json';
export type DataExportStatus = 'queued' | 'processing' | 'ready' | 'failed';

/** Contract DataExportJob (GET /data/exports, POST /data/exports). */
export interface DataExportJob {
  id: string;
  scope: DataExportScope;
  format: DataExportFormat;
  status: DataExportStatus;
  downloadUrl?: string | null;
  expiresInSeconds?: number | null;
  createdAt: number;
  completedAt?: number | null;
}

export interface DataExportRequest {
  scope: DataExportScope;
  format: DataExportFormat;
}

/** POST /privacy/export result. */
export interface PrivacyExportResult {
  jobId: string;
  status: 'queued' | 'processing' | 'ready' | 'failed';
}

/** Contract StoreScore (GET /analytics/store-score). */
export interface StoreScore {
  score: number;
  ratingAverage: number;
  breakdown: { factor: string; score: number }[];
}

/** Contract customer insights (GET /analytics/customers). */
export interface CustomerInsights {
  newCustomers: number;
  returningCustomers: number;
  retentionRate: number;
  avgOrderFrequency?: number | null;
  avgLifetimeValueTZS?: number | null;
  churnRate?: number | null;
  monthlyTrend?: { month: string; newCustomers: number; returningCustomers: number }[];
}

/** Contract customer distribution row (GET /analytics/customer-distribution). */
export interface CustomerDistributionRow {
  area: string;
  customerCount: number;
}

/** Contract marketing analytics (GET /analytics/marketing). */
export interface MarketingAnalytics {
  totalSpendTZS: number;
  attributedRevenueTZS: number;
  roiPercent: number;
  activeCampaigns: number;
}

/** P8c event types — appended like P8bEvent; handlers cast to ServerEvent. */
export type P8cEvent =
  | { type: 'reports.created'; report: ScheduledReport; at: number }
  | { type: 'reports.updated'; report: ScheduledReport; at: number }
  | { type: 'reports.deleted'; reportId: string; at: number }
  | { type: 'journeys.created'; journey: CustomerJourney; at: number }
  | { type: 'journeys.updated'; journey: CustomerJourney; at: number }
  | { type: 'data_exports.created'; job: DataExportJob; at: number }
  | { type: 'data_exports.updated'; job: DataExportJob; at: number }
  | { type: 'privacy.export_requested'; jobId: string; at: number };

/* ================= P6: Engagement (contract /conversations, /notifications/me/*,
 * /support/tickets/*, /help/articles, /reviews — API-CONTRACT.yaml).
 * App timestamps are epoch ms (app mock convention; contract uses date-time). ================= */

/* ---- Conversations (contract /conversations) ---- */

export type ConversationStatus = 'open' | 'archived' | 'blocked';

export interface ConversationParticipant {
  role: 'customer' | 'merchant_staff' | 'system';
  displayName: string;
  maskedPhone?: string | null;
}

/** Contract Conversation — app mock reuses the chatThreads store, so the
 * contract fields live alongside the app's ChatThreadDto shape. */
export interface Conversation {
  id: string;
  merchantId: string;
  customerUserId?: string;
  orderId?: string | null;
  subject?: string;
  status: ConversationStatus;
  lastMessagePreview: string;
  unreadCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface ConversationDetail extends Conversation {
  participants: ConversationParticipant[];
  /* app extensions — the merchant UI renders the blocked state with the reason */
  blockReason?: string | null;
  blockedAt?: number | null;
}

/** POST /conversations body (customer opens a conversation with a merchant). */
export interface ConversationCreate {
  merchantId: string;
  orderId?: string | null;
  subject: string; // ≤160
  initialMessage: string; // ≤2000
}

export interface ChatMessageAttachment {
  mediaType: 'image' | 'document' | 'voice' | 'location';
  url: string;
  locationPin?: { lat: number; lon: number; label?: string } | null;
}

/** Contract ChatMessage (GET /conversations/{id}/messages). */
export interface ChatMessage {
  id: string;
  conversationId: string;
  authorRole: 'customer' | 'merchant_staff' | 'rider' | 'dispatch' | 'provider' | 'provider_staff' | 'system';
  authorUserId?: string | null;
  body: string; // ≤2000
  attachments?: ChatMessageAttachment[];
  readAt?: number | null;
  createdAt: number;
}

/** POST /conversations/{id}/messages body. */
export interface ChatMessageCreate {
  body: string; // minLength 1, maxLength 2000
  attachments?: ChatMessageAttachment[];
}

/** POST /conversations/{conversationId}/block body. */
export interface BlockConversationBody {
  reason: string; // ≤500
}

/* ---- Notification preferences + order alerts (contract /notifications/me/*) ---- */

/** Contract NotificationPreferences: per-channel maps of event key → boolean. */
export interface NotificationPreferences {
  push: Record<string, boolean>;
  sms: Record<string, boolean>;
  email: Record<string, boolean>;
  inApp: Record<string, boolean>;
}

export type OrderAcceptanceMethod = 'manual' | 'auto';
export type OrderAlertChannel = 'push' | 'sms' | 'in_app';

/** Contract OrderAlertSettings (GET/PUT /notifications/me/order-settings). */
export interface OrderAlertSettings {
  acceptanceMethod: OrderAcceptanceMethod;
  voiceAlerts: boolean;
  channels: OrderAlertChannel[];
  quietHours?: {
    enabled: boolean;
    from: string; // "22:00"
    to: string; // "08:00"
  };
  autoAcceptWithinSeconds?: number; // 30–300
}

/* ---- Support tickets + help (contract /support/tickets/*, /help/articles) ---- */

export type TicketStatus = 'open' | 'assigned' | 'in_progress' | 'resolved' | 'closed';
export type TicketPriority = 'low' | 'normal' | 'high' | 'critical';
export type TicketMessageAuthor = 'customer' | 'merchant' | 'provider' | 'rider' | 'agent';

/** Contract TicketDetail message row (GET /support/tickets/{ticketId}). */
export interface TicketMessage {
  id: string;
  authorRole: TicketMessageAuthor;
  body: string;
  createdAt: number;
}

/** Contract TicketDetail — the app store keeps the legacy SupportTicket row
 * (status open|replied|resolved + replies[]); detail responses map onto the
 * contract shape (status open|assigned|in_progress|resolved|closed). */
export interface TicketDetail {
  id: string;
  subject: string;
  status: TicketStatus;
  priority: TicketPriority;
  assignedAgentId?: string | null;
  createdAt: number;
  updatedAt: number;
  messages: TicketMessage[];
}

/** Contract help article row (GET /help/articles). */
export interface HelpArticle {
  id: string;
  title: string;
  category: string;
  body: string;
  /* App extension: article → screen deep link (expo-router path) and the
   * "open a ticket about this" escalation affordance (EDUCATION-SUPPORT.md
   * §Help/FAQ — deep links are API values, never hardcoded). */
  deepLink?: string | null;
  escalateToTicket?: boolean;
}

/* ---- Reviews (contract /reviews*) ---- */

/** Contract Review.state — the app's ReviewDto gains the visibility state. */
export type ReviewState = 'pending' | 'published' | 'hidden' | 'deleted';

/** Contract ReviewCreate (POST /reviews — customer writes, mock-only). */
export interface ReviewCreate {
  targetType: 'merchant' | 'provider' | 'rider' | 'customer';
  targetId: string;
  rating: number; // 1–5
  body: string; // ≤2000
  dimensions?: Record<string, unknown> | null;
}

/** Contract PATCH /reviews/{reviewId} body — `state` is an app extension
 * (merchant demo visibility toggle; the contract only defines rating/body). */
export interface EditReviewBody {
  rating?: number; // 1–5
  body?: string; // ≤2000
  dimensions?: Record<string, unknown> | null;
  state?: ReviewState;
}

/** Contract POST /reviews/{reviewId}/helpful body + response. */
export interface VoteReviewHelpfulBody {
  helpful: boolean;
}

export interface ReviewHelpfulCounts {
  helpfulCount: number;
  notHelpfulCount: number;
  myVote: boolean | null;
}

/** Contract ReviewReport (POST /reviews/{reviewId}/report). */
export interface ReviewReport {
  id: string;
  reviewId: string;
  reason: string;
  state: 'open' | 'resolved' | 'dismissed';
}

/* ================= P5: finance ops (contract /payouts/me, /finance/bank-cards,
 * /finance/expenses, /finance/invoices, /finance/transactions/{id}/issue —
 * API-CONTRACT.yaml). Money is integer TZS; timestamps are epoch ms (app mock
 * convention; the contract uses date-time). ================= */

/** Contract PayoutSummary.status enum (GET /payouts/me). */
export type PayoutStatus = 'pending' | 'processing' | 'paid' | 'failed' | 'exception';

/** Contract PayoutSummary (GET /payouts/me — array response). */
export interface PayoutSummary {
  id: string;
  amountTZS: number; // integer TZS
  status: PayoutStatus;
  method?: string;
  createdAt: number;
  paidAt?: number | null;
}

/** Contract BankCard (GET/POST /finance/bank-cards). */
export interface BankCard {
  id: string;
  bankName: string;
  last4: string;
  accountHolderName?: string;
  isDefault: boolean;
  createdAt: number;
}

/** POST /finance/bank-cards body — id/isDefault/createdAt are server-owned. */
export interface BankCardInput {
  bankName: string;
  last4: string; // 4 digits
  accountHolderName?: string;
}

/** Contract ExpenseRecord.category enum (GET/POST /finance/expenses). */
export type ExpenseCategory =
  | 'ingredients'
  | 'delivery'
  | 'packaging'
  | 'platform_fees'
  | 'rent'
  | 'utilities'
  | 'staff'
  | 'marketing'
  | 'equipment'
  | 'other';

/** Contract ExpenseRecord (GET/POST /finance/expenses). */
export interface ExpenseRecord {
  id: string;
  category: ExpenseCategory;
  amountTZS: number; // integer TZS
  note?: string; // ≤500
  incurredAt: number; // epoch ms (app mock convention; contract uses date-time)
  createdAt: number;
}

/** POST /finance/expenses body — id/createdAt are server-owned. */
export interface ExpenseRecordInput {
  category: ExpenseCategory;
  amountTZS: number; // integer ≥ 1
  note?: string; // ≤500
  incurredAt?: number; // epoch ms, defaults to now
}

/** Contract Invoice (GET/POST /finance/invoices) — the legacy app Invoice type
 * (settlements module, float TZS, `no`) is untouched; contract rows live here. */
export type FinanceInvoiceStatus = 'draft' | 'requested' | 'issued' | 'paid';

export interface FinanceInvoice {
  id: string;
  number: string;
  amountTZS: number; // integer TZS
  kind: 'vat' | 'standard';
  taxRateBps?: number | null;
  taxAmountTZS?: number | null;
  taxId?: string | null;
  status: FinanceInvoiceStatus;
  buyerDetails?: Record<string, unknown>;
  periodFrom?: string | null; // YYYY-MM-DD
  periodTo?: string | null; // YYYY-MM-DD
  createdAt: number;
  issuedAt?: number | null;
}

/** POST /finance/invoices body — id/number/status/createdAt are server-owned. */
export interface FinanceInvoiceInput {
  amountTZS: number; // integer ≥ 1
  kind?: 'vat' | 'standard';
  taxRateBps?: number | null;
  taxId?: string | null;
  buyerDetails?: Record<string, unknown>;
  periodFrom?: string | null;
  periodTo?: string | null;
}

/** Contract GET /finance/invoices/{invoiceId}/download response. */
export interface InvoiceDownload {
  downloadUrl: string;
  expiresInSeconds: number; // default 900
}

/** Contract POST /finance/transactions/{transactionId}/issue body. */
export type TransactionIssueType = 'amount_mismatch' | 'missing_items' | 'other';

export interface IssueTransactionBody {
  issueType: TransactionIssueType;
  description: string; // ≤500
}

/** Contract POST /finance/transactions/{transactionId}/issue 201 response. */
export interface TransactionIssueTicket {
  ticketId: string;
  status: 'open';
}

/** P5 finance events — appended like P8bEvent; handlers cast to ServerEvent
 * (the union mid-file is shared with parallel agents and stays untouched). */
export type FinanceExtEvent =
  | { type: 'finance.bank_card_added'; card: BankCard; at: number }
  | { type: 'finance.bank_card_removed'; cardId: string; at: number }
  | { type: 'finance.bank_card_default_changed'; card: BankCard; at: number }
  | { type: 'finance.expense_created'; expense: ExpenseRecord; at: number }
  | { type: 'finance.expense_deleted'; expenseId: string; at: number }
  | { type: 'finance.invoice_requested'; invoice: FinanceInvoice; at: number }
  | { type: 'finance.transaction_issue_reported'; ticket: TransactionIssueTicket; transactionId: string; at: number }
  /* Earnings pass (gap-09): in-app events per EARNINGS.md lifecycle. */
  | { type: 'settlement.paid'; settlement: Settlement; at: number }
  | { type: 'payout.paid'; payout: PayoutSummary; at: number }
  | { type: 'invoice.issued'; invoice: FinanceInvoice; at: number }
  | { type: 'payment.qr_created'; qr: PaymentQr; at: number }
  | { type: 'payment.reversed'; item: PaymentHistoryItem; at: number }
  | { type: 'dispute.opened'; hold: DisputeHold; at: number }
  | { type: 'dispute.resolved'; hold: DisputeHold; at: number };

/* ================= Earnings pass (gap-09) — collection QR, payments history
 * / reversal, reconciliation summary, dispute holds, commercial cadence.
 * Contract shapes from API-CONTRACT.yaml; timestamps are epoch ms (app mock
 * convention; the contract uses date-time). ================= */

/** Contract PaymentQrCreate.provider enum (POST /payments/qr). */
export type PaymentQrProvider = 'mpesa' | 'tigo_pesa' | 'airtel_money';

/** Contract POST /payments/qr body (API-CONTRACT.yaml PaymentQrCreate). */
export interface PaymentQrCreate {
  provider: PaymentQrProvider;
  amountTZS?: number | null; // null = variable amount
  description?: string; // ≤120
  orderId?: string | null;
}

/** Contract PaymentQr (POST /payments/qr — 201). */
export interface PaymentQr {
  qrPayload: string;
  provider: string;
  amountTZS?: number | null; // null = variable
  merchantRef: string;
  expiresAt: number; // epoch ms (app mock convention; contract uses date-time)
}

/** Contract GET /payments/history row status enum. */
export type PaymentHistoryStatus = 'created' | 'pending' | 'paid' | 'failed' | 'refunded' | 'reversed';

/** Contract GET /payments/history row. */
export interface PaymentHistoryItem {
  id: string;
  method: string;
  amountTZS: number; // integer TZS
  status: PaymentHistoryStatus;
  reference?: string | null;
  createdAt: number; // epoch ms (app mock convention; contract uses date-time)
}

/** Contract POST /payments/{intentId}/reverse body. */
export interface ReversePaymentBody {
  reason: string; // ≤500
}

/** Contract ReconciliationSummary.day — per-day order vs settlement rows. */
export interface ReconciliationDay {
  day: string; // YYYY-MM-DD
  ledgerGross: number;
  settlementGross: number;
  commission: number;
  diff: number;
  ok: boolean;
}

/** Contract ReconciliationSummary (GET /finance/reconciliation?from&to) — the
 * app keeps the legacy per-day `days` rows alongside the summary fields
 * (contract.test.ts drift parity). */
export interface ReconciliationSummary {
  from: string; // YYYY-MM-DD
  to: string;
  orderTotalTZS: number;
  paymentTotalTZS: number;
  matched: number;
  exceptions: number;
  days: ReconciliationDay[];
}

/** Dispute hold — money withheld from payout while a refund/dispute is in
 * review; release resolves to a payout or a `refund` ledger entry. */
export interface DisputeHold {
  id: string;
  orderId: string;
  amountTZS: number;
  reason?: string | null;
  status: 'disputed' | 'resolved';
  disputedAt: number; // epoch ms
}

/** GET /finance/dispute-holds (app-extension surface — the contract projects
 * holds via the wallet/ledger; EARNINGS.md dispute-holds card). */
export interface DisputeHoldsResponse {
  holds: DisputeHold[];
  totalTZS: number;
}

/* ---------- P6b/P6d contract shapes — store settings, QR codes, receipts,
 * reservations, loyalty ledger, memberships, print jobs ---------- */

export type KitchenCameraVideoQuality = 'sd' | 'hd' | 'fhd';

/** Contract GET/PATCH /store/kitchen-camera. PATCH semantics: absent fields
 * keep their current values. A store that never configured a camera answers
 * 404 KITCHEN_CAMERA_NOT_CONFIGURED. */
export interface KitchenCamera {
  enabled: boolean;
  streamUrl?: string | null; // URI
  publicAccess?: boolean; // default false
  recordingDurationMinutes?: number; // default 30
  storageUsedGb?: number | null;
  storageCapacityGb?: number; // default 10
  videoQuality?: KitchenCameraVideoQuality; // default hd
  lastCheckedAt?: number | null; // epoch ms (app mock convention; contract uses date-time)
}

export type QualificationStatus = 'pending' | 'approved' | 'rejected' | 'expired';

/** Contract GET/POST /store/qualifications. Submissions start as pending. */
export interface Qualification {
  id: string;
  type: string; // e.g. business_license
  url?: string | null; // echoed back on create, not persisted (contract behavior)
  status: QualificationStatus;
  expiryDate?: string | null; // YYYY-MM-DD
  createdAt: number; // epoch ms
}

/** Contract POST /store/qualifications body. */
export interface QualificationUpload {
  type: string;
  url: string; // URI
}

export type StoreQrCodeKind =
  | 'ordering'
  | 'table'
  | 'menu'
  | 'collection'
  | 'feedback'
  | 'download'
  | 'review';

/** Contract GET/POST /store/qr-codes + DELETE /store/qr-codes/{qrCodeId}. */
export interface StoreQrCode {
  id: string;
  kind: StoreQrCodeKind;
  qrPayload: string;
  createdBy?: string;
  createdAt: number; // epoch ms
}

export type StoreQrCodeKindInput = 'ordering' | 'collection' | 'download' | 'review';

/** Contract GET/PUT /store/self-pickup. Unconfigured store answers
 * { enabled: false }. pickupReadyMinutes must be 5–120. */
export interface SelfPickupConfig {
  enabled: boolean;
  pickupReadyMinutes?: number; // default 15 (server default 10 when absent)
  pickupHours?: { open: string; close: string } | null; // "HH:MM"
}

export type ReservationStatus = 'pending' | 'confirmed' | 'seated' | 'completed' | 'cancelled' | 'no_show';

/** Contract Reservation (POST /reservations, GET /reservations/me, cancel). */
export interface Reservation {
  id: string;
  merchantId: string;
  tableId?: string | null;
  partySize: number; // 1–50
  scheduledFor: number; // epoch ms (app mock convention; contract uses date-time)
  status: ReservationStatus;
  note?: string; // ≤300
  createdAt: number; // epoch ms
}

/** Contract POST /reservations body. */
export interface ReservationCreate {
  merchantId: string;
  partySize: number; // 1–50
  scheduledFor: number; // epoch ms
  note?: string; // ≤300
  tableId?: string | null;
}

export type LoyaltyTransactionType = 'earn' | 'redeem' | 'check_in' | 'bonus' | 'expire' | 'adjust';

/** Contract GET /loyalty-transactions — loyalty points ledger. */
export interface LoyaltyTransaction {
  id: string;
  type: LoyaltyTransactionType;
  points: number; // signed integer
  balance: number; // integer
  reference?: string | null;
  at: number; // epoch ms (app mock convention; contract uses date-time)
}

/** Contract GET /memberships/me — customer membership (customer-side mock). */
export interface CustomerMembership {
  points: number;
  level: string; // e.g. bronze
  memberSince?: string | null; // YYYY-MM-DD
  benefits: string[];
}

/** Contract PUT /membership-tiers topUpRewards entries. */
export interface MembershipTopUpReward {
  thresholdTZS: number;
  bonusTZS: number;
}

/** Contract PUT /membership-tiers body. */
export interface MembershipTiersConfig {
  topUpRewards?: MembershipTopUpReward[];
  tiers: MembershipTier[];
}

export type PrintJobType = 'receipt' | 'kitchen_ticket' | 'label' | 'voucher';
export type PrintJobStatus = 'queued' | 'printing' | 'done' | 'failed';

/** Contract PrintJob (POST /print-jobs, GET /print-jobs, GET /print-jobs/{id}). */
export interface PrintJob {
  id: string;
  jobType: PrintJobType;
  orderIds?: string[]; // batch receipts
  tableId?: string | null;
  deviceId?: string | null; // target printer; null = default
  copies?: number; // 1–5, default 1
  label?: string; // ≤80
  status: PrintJobStatus;
  error?: string | null;
  createdAt: number; // epoch ms
  completedAt?: number | null;
}

/** Contract POST /print-jobs body — id/status/createdAt are server-owned. */
export interface PrintJobCreate {
  jobType: PrintJobType;
  orderIds?: string[];
  tableId?: string | null;
  deviceId?: string | null;
  copies?: number;
  label?: string;
  /** App extension: queue despite a DEVICE_OFFLINE target (STAFF-AND-DEVICES.md
   * §54 "queue-until-online"). Absent/false → 409 DEVICE_OFFLINE. */
  queueIfOffline?: boolean;
}

/** Contract ReceiptTemplate.fields — the 14 receipt field toggles. */
export interface ReceiptTemplateFields {
  logo: boolean;
  storeName: boolean;
  address: boolean;
  phone: boolean;
  orderId: boolean;
  date: boolean;
  items: boolean;
  subtotal: boolean;
  tax: boolean;
  total: boolean;
  paymentMethod: boolean;
  thankYou: boolean;
  qrCode: boolean;
  cashierName: boolean;
}

export type ReceiptTemplateFont = 'monospace' | 'sans_serif';

/** Contract ReceiptTemplate (PUT /store/receipt-templates/{templateId},
 * POST .../activate). The mock maps this onto the app ReceiptTemplate row. */
export interface ContractReceiptTemplate {
  id: string;
  name: string; // ≤80
  headerText: string; // ≤200
  footerText?: string; // ≤200
  showLogo?: boolean; // default true
  logoEmoji?: string | null; // ≤4
  paperSize?: '58mm' | '80mm'; // default 80mm
  copies?: number; // 1–5, default 1
  font?: ReceiptTemplateFont; // default monospace
  fields?: ReceiptTemplateFields;
  isActive?: boolean; // default false; flips via activate
  createdAt?: number; // epoch ms
}

/** Store-ops/reservations events — appended like P8bEvent; handlers cast to
 * ServerEvent (the union mid-file is shared with parallel agents and stays
 * untouched). */
export type StoreOpsExtEvent =
  | { type: 'store.kitchen_camera_updated'; config: KitchenCamera; at: number }
  | { type: 'store.self_pickup_updated'; config: SelfPickupConfig; at: number }
  | { type: 'store.qualification_uploaded'; qualification: Qualification; at: number }
  | { type: 'store.qr_code_created'; qrCode: StoreQrCode; at: number }
  | { type: 'store.qr_code_deleted'; qrCodeId: string; at: number }
  | { type: 'store.receipt_template_updated'; template: ReceiptTemplate; at: number }
  | { type: 'store.receipt_template_activated'; template: ReceiptTemplate; at: number }
  | { type: 'reservation.created'; reservation: Reservation; at: number }
  | { type: 'reservation.cancelled'; reservation: Reservation; at: number };

/** Print-job events — appended like P8bEvent; handlers cast to ServerEvent. */
export type PrintJobsExtEvent =
  | { type: 'print_jobs.created'; printJob: PrintJob; at: number }
  | { type: 'print_jobs.updated'; printJob: PrintJob; at: number };

/* =====================================================================
 * P1 — Marketplace & merchant onboarding (contract /catalogues*, /merchants*)
 * Contract types are re-exported from @hudumika/contract (single source of
 * truth); only mock-internal rows + app extensions live here.
 * ===================================================================== */

export type { Catalogue, CatalogueItem, CatalogueItemUpdate, ProductCategory, ProductTemplate };
export type { MerchantPublic, MerchantPrivate, MerchantApplication, MerchantClaim, MerchantUpdate };
export type { LeadCreated, VerificationState, StoreSettings, StoreSettingsUpdate, StoreSettingsBusinessHoursItem };
export type { PayoutAccount, PayoutAccountWrite, ChainStore };
export type { BulkCatalogueItems202 as CatalogueBulkResult, ImportCatalogue202 as CatalogueImportResult, ExportCatalogue200 as CatalogueExportResult, ImportCatalogueBodyRowsItem as CatalogueImportRow };

/** Contract CatalogueItem mapped from the mock products table. */
export interface CatalogueItemDto extends CatalogueItem {
  categoryId?: string;
}

/** Mock-internal merchant settings row (GET/PUT /merchants/me/settings). */
export interface MerchantSettingsRow {
  id: string;
  merchantId: string;
  settings: StoreSettings;
  updatedAt: number;
}

/** Mock-internal payout account row (GET/PUT /merchants/me/payout-account). */
export interface MerchantPayoutAccountRow {
  id: string;
  merchantId: string;
  type: PayoutAccount['type'];
  provider: string;
  accountMasked: string;
  accountHolderName: string;
  verified: boolean;
  updatedAt: string;
}

/** Mock-internal merchant lead (POST /merchants + /merchants/claim). */
export interface MerchantLeadRow {
  id: string;
  merchantId: string;
  source: 'application' | 'claim';
  businessName?: string;
  contactPhone: string;
  documentsNote?: string;
  status: 'submitted' | 'under_review';
  createdAt: string;
}

/** Mock-internal published catalogue snapshot (PUT /catalogues/me). */
export interface CataloguePublishRow {
  id: string;
  merchantId: string;
  publishedAt: string;
  items: CatalogueItemDto[];
}

/** Import job row (POST /catalogues/import) — keeps per-row failures for the
 *  result summary (app extension; the contract only carries jobId + status). */
export interface CatalogueImportJobRow {
  id: string;
  merchantId: string;
  status: 'queued' | 'processing' | 'completed' | 'failed';
  accepted: number;
  rejected: number;
  failures: { row: number; reason: string }[];
  createdAt: number;
}

/** Bulk job row (POST /catalogue-items/bulk). */
export interface CatalogueBulkJobRow {
  id: string;
  merchantId: string;
  accepted: number;
  rejected: number;
  failures: { index: number; reason: string }[];
  createdAt: number;
}

/** P1 events — appended like P8bEvent; handlers cast to ServerEvent. */
export type P1Event =
  | { type: 'catalogue.published'; catalogue: Catalogue; at: number }
  | { type: 'catalogue.import_completed'; job: CatalogueImportJobRow; at: number }
  | { type: 'catalogue.bulk_completed'; job: CatalogueBulkJobRow; at: number }
  | { type: 'merchant.settings_updated'; settings: StoreSettings; at: number }
  | { type: 'merchant.payout_updated'; account: PayoutAccount; at: number };

/* ---- P8d: inventory/supply-chain events + supplier-returns detail
 * (INVENTORY-SUPPLY-CHAIN.md). Appended like P8bEvent; handlers emit through
 * the common base event type. ---- */

export interface SupplierReturnLine {
  catalogueItemId: string;
  quantity: number;
}

/** Full supplier-return row — the contract's POST /supplier-returns only
 *  returns {id, status, createdAt}; the merchant returns list (mock
 *  extension GET /supplier-returns) serves this detail shape so the screen
 *  can render items, reason and the pending → processed|rejected pills. */
export interface SupplierReturnDetail {
  id: string;
  supplierId: string;
  items: SupplierReturnLine[];
  reason: string;
  status: SupplierReturnStatus;
  createdAt: number;
  processedAt?: number | null;
  rejectedAt?: number | null;
  rejectionReason?: string | null;
}

/** Refund queue row — mock extension: set when a refund above the merchant's
 *  configured threshold is awaiting an approval decision (EF L49-51). */
export interface RefundAwaitingApproval {
  approvalId: string;
  approvalStatus: 'pending' | 'rejected';
  thresholdTZS: number;
  amountTZS: number;
}

export type SupplyChainExtEvent =
  | { type: 'inventory.low_stock'; item: InventoryItem; at: number }
  | { type: 'inventory.out_of_stock'; item: InventoryItem; at: number }
  | { type: 'purchase_order.received'; purchaseOrder: PurchaseOrder; at: number }
  | {
      type: 'warehouse.stock_low';
      warehouseId: string;
      warehouseName: string;
      item: { catalogueItemId: string; quantity: number; threshold: number };
      at: number;
    }
  | { type: 'supplier_returns.processed'; supplierReturn: SupplierReturnDetail; at: number }
  | { type: 'supplier_returns.rejected'; supplierReturn: SupplierReturnDetail; at: number }
  | { type: 'refunds.awaiting_approval'; refund: RefundRequestDto; approval: ApprovalRequest; at: number };

/* ---- P6e round-2: contract ReviewAnalytics shape (ANALYTICS.md:55-60,
 * API-CONTRACT.yaml schemas.ReviewAnalytics). The legacy ReviewAnalytics
 * interface above stays for the reviews-screen consumer; the contract shape
 * is served on GET /analytics/reviews?from&to. ---- */

export interface ReviewTrendDay {
  date: string;
  count: number;
  avgRating: number;
}

export interface ReviewAnalyticsContract {
  from: string;
  to: string;
  ratingAverage: number;
  reviewCount: number;
  replyRate: number;
  trendByDay: ReviewTrendDay[];
}

/** Contract ReviewAnalytics + the contract forecast point (weather nullable,
 *  never fabricated — the mock returns null weather). */
export interface ForecastContractPoint {
  date: string;
  predictedRevenueTZS: number;
  confidence: number;
  weather: null;
}

/* =====================================================================
 * P10 — Onboarding verification gate, commercial terms, privacy & account
 * (docs/ONBOARDING.md, SETTINGS.md, STORE-MANAGEMENT.md, PRIVACY-ACCOUNT.md).
 * Appends only — shared file, parallel agents.
 * ===================================================================== */

/** Per-document onboarding status — server-owned (docs/ONBOARDING.md:50). */
export type MerchantDocumentState = 'missing' | 'pending' | 'approved' | 'rejected';
export type MerchantDocumentType =
  | 'business_registration'
  | 'trading_license'
  | 'tin_certificate'
  | 'owner_id'
  | 'payout_account';

export interface MerchantDocumentStatus {
  type: MerchantDocumentType;
  status: MerchantDocumentState;
  fileName?: string | null;
  mime?: string | null;
  sizeBytes?: number | null;
  updatedAt?: number | null;
}

/** MerchantPrivate.verification (VerificationState) + decision surface. */
export interface MerchantVerificationStatus {
  status: VerificationState;
  documents: MerchantDocumentStatus[];
  reason?: string | null;
  reviewedAt?: number | null;
  submittedAt?: number | null;
}

/** MerchantPrivate.commercial — backend-configured terms (ONBOARDING.md:52-62). */
export interface MerchantCommercialTerms {
  commissionRateBps?: number;
  payoutCycleDays?: number;
  payoutAccount?: string | null;
}

export interface OnboardingStepStatus {
  key: 'profile' | 'documents' | 'submit';
  status: 'done' | 'current' | 'pending';
}

/** GET /onboarding/status — steps + currentStep + completed/submittedAt. */
export interface OnboardingStatusResponse {
  verification: MerchantVerificationStatus;
  steps: OnboardingStepStatus[];
  currentStep: OnboardingStepStatus['key'];
  completed: boolean;
  submittedAt?: number | null;
}

/** GET /merchants/me — app extension bundle: contract MerchantPrivate
 *  surface (verification + commercial) next to the legacy `me` payload. */
export interface MerchantMeBundle {
  me: SessionMe;
  verification: MerchantVerificationStatus;
  commercial: MerchantCommercialTerms;
}

/** StoreSettings app extensions carried on GET/PUT /merchants/me/settings:
 *  logoUrl (contract MerchantUpdate.logoUrl — the PATCH /merchants/me mock
 *  is frozen, so the settings surface carries it) and printSettings.paperSize
 *  (receipt paper, kept with the print settings block). */
export interface StoreSettingsExt extends StoreSettings {
  logoUrl?: string | null;
  printSettings?: NonNullable<StoreSettings['printSettings']> & { paperSize?: '58mm' | '80mm' };
}

/** Async privacy export job (docs/PRIVACY-ACCOUNT.md:18-24). */
export interface PrivacyExportJob {
  jobId: string;
  status: 'queued' | 'processing' | 'ready' | 'failed';
  downloadUrl?: string | null;
  expiresInSeconds?: number | null;
  completedAt?: number | null;
}

/** POST /privacy/delete cooling-off request (docs/PRIVACY-ACCOUNT.md:26-32). */
export interface AccountDeletionStatus {
  requestId: string;
  status: 'pending' | 'completed';
  estimatedDays: number;
  requestedAt: number;
  completesAt: number;
  reason?: string | null;
}

/** Active device session (GET /sessions, PRIVACY-ACCOUNT.md:12-16). */
export interface ActiveSession {
  token: string;
  staffId: string;
  role: string;
  createdAt: number;
  expiresAt: number;
  revoked: boolean;
  device: string;
  ip: string;
}

/** POST /store/compliance/recheck job — queued → processing → completed. */
export interface ComplianceRecheckJob {
  jobId: string;
  storeId: string;
  status: 'queued' | 'processing' | 'completed' | 'failed';
  compliance?: ComplianceStatus;
  blockedUntil: number;
}

/** P10 events — appended like P8bEvent; handlers cast to ServerEvent. */
export type P10ExtEvent =
  | { type: 'onboarding.submitted'; verification: MerchantVerificationStatus; at: number }
  | { type: 'onboarding.verification_updated'; verification: MerchantVerificationStatus; at: number }
  | { type: 'compliance.recheck_completed'; job: ComplianceRecheckJob; at: number }
  | { type: 'privacy.export_ready'; job: PrivacyExportJob; at: number }
  | { type: 'privacy.deletion_requested'; request: AccountDeletionStatus; at: number };

/* ---- Catalogue options groups (MENU-CATALOGUE.md §Item fields) ----
 * Contract shape: CatalogueItemOptionsItem {name, choices: {label, priceTZS}[]}.
 * The app keeps the contract shape and adds editor-only extensions (required /
 * min / max); the contract round-trip carries name+choices and drops the rest. */

export interface CatalogueOptionChoice {
  /** Editor-local stable id (not part of the contract shape). */
  id?: string;
  label: string;
  priceTZS: number;
}

export interface CatalogueOptionsGroup {
  name: string;
  choices: CatalogueOptionChoice[];
  required?: boolean;
  min?: number;
  max?: number;
}

// Contract payment-method availability row (GET /payments/methods) — PY-06:
// merchant surfaces derive availability from the API, never hardcode channels.
export interface PaymentMethodAvailability {
  method: string;
  available: boolean;
}
