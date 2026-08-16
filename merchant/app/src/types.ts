/* OrderStatus mirrors the contract merchant-visible set: `merchant_accepted` is
 * the intermediate accepted state (doc: accept → merchant_accepted → preparing),
 * and `refunded` / `failed` / `disputed` are terminal states the merchant sees. */
export type OrderStatus = 'new' | 'merchant_accepted' | 'preparing' | 'ready' | 'completed' | 'cancelled' | 'refunded' | 'failed' | 'disputed';
export type DeliveryType = 'delivery' | 'pickup';

export interface Variant {
  id: string;
  name: string;
  price: number;
}

export interface Product {
  id: string;
  categoryId: string;
  name: string;
  emoji: string;
  price: number;
  originalPrice?: number;
  description: string;
  stock: number;
  visible: boolean;
  variants: Variant[];
  sold: number;
}

export interface Category {
  id: string;
  name: string;
  visible: boolean;
  sort: number;
}

export interface OrderItem {
  productId: string;
  name: string;
  emoji: string;
  qty: number;
  price: number;
  variants: string[];
}

export interface Customer {
  name: string;
  phone: string;
  address: string;
}

export interface OrderRefund {
  ts: number;
  reason: string;
  amount: number;
  status: 'requested' | 'approved' | 'declined';
}

export interface OrderEvent {
  event: string;
  ts: number;
  actor: string;
  note?: string;
}

export interface Order {
  id: string;
  no: string;
  status: OrderStatus;
  items: OrderItem[];
  customer: Customer;
  note: string;
  deliveryType: DeliveryType;
  subtotal: number;
  deliveryFee: number;
  total: number;
  createdAt: number;
  deadlineAt: number;
  scheduledAt?: number;
  rushAt?: number;
  rushReplied?: boolean;
  refund?: OrderRefund;
  acceptedAt?: number;
  readyAt?: number;
  completedAt?: number;
  cancelledAt?: number;
  cancelReason?: string;
  rider?: string;
  riderId?: string;
  seen: boolean;
  rating?: number;
  version?: number;
  paymentId?: string;
  timeline?: OrderEvent[];
  settledAt?: number;
  /* P2 orders ops — optional sub-states (flags, not contract OrderStatus) */
  source?: 'app' | 'web' | 'phone' | 'pos';
  rushRequestedAt?: number;
  rushCooldownMinutes?: number;
  preOrderReminderSent?: boolean;
  rejectReason?: string | null;
  rejectReasonCode?: string | null;
  cancelReasonCode?: string | null;
  tipTZS?: number;
  waybillNumber?: string | null;
  hold?: { at: number; reason: string; until?: number | null };
  reschedule?: { at: number; reason: string; status: 'requested' | 'approved'; scheduledAt: number };
  transfer?: { id: string; at: number; reason: string; status: 'requested' | 're_assigned' | 'cancelled' };
  addItemsRequest?: { id: string; at: number; items: { catalogueItemId: string; quantity: number }[]; reason: string; status: string };
  failedDelivery?: { at: number; reason: string; note?: string; photoUrl?: string | null; returnToMerchant?: boolean };
  modifyRequest?: { id: string; at: number; type: string; note: string; status: string };
  enterprise?: { companyName: string; costCenter?: string | null; billingRef?: string | null };
  /* Server-computed cancellation economics (ORDER-FLOW.md — fee shown before
   * confirmation when cancelling after merchant acceptance; integer TZS). */
  cancelFeeTZS?: number;
  refundTZS?: number;
}

/* Traffic/advertising (search ads) campaigns are contract-defined but phased
 * (PROMOTIONS.md) — the UI does not surface them until they ship. */
export type CampaignType = 'discount' | 'coupon' | 'flash' | 'full_reduction' | 'new_customer' | 'free_delivery' | 'group_buy' | 'haggle' | 'featured' | 'ppc' | 'brand' | 'instant_discount';
export type CampaignStatus = 'active' | 'scheduled' | 'expired';

export interface Campaign {
  id: string;
  type: CampaignType;
  status: CampaignStatus;
  title: string;
  budget: number;
  spent: number;
  start: number;
  end: number;
  discountRate?: number;
  couponAmount?: number;
  threshold?: number;
  target: string;
  productIds: string[];
  createdAt: number;
  groupBuyTargets?: { buyers: number; discountRate: number }[];
  haggleEnabled?: boolean;
  cpc?: number;
  impressions?: number;
  clicks?: number;
  attributedOrders?: number;
  attributedRevenue?: number;
}

export type TransactionType = 'order' | 'commission' | 'withdraw' | 'refund';

export interface Transaction {
  id: string;
  type: TransactionType;
  amount: number;
  title: string;
  ts: number;
  status: 'pending' | 'completed';
}

export interface Review {
  id: string;
  orderNo: string;
  customer: string;
  rating: number;
  content: string;
  reply?: string;
  ts: number;
  repliedAt?: number;
}

export interface AppMessage {
  id: string;
  type: 'order' | 'review' | 'system';
  category?: 'important' | 'feature' | 'campaign' | 'marketing' | 'im' | 'system';
  title: string;
  body: string;
  ts: number;
  read: boolean;
  orderId?: string;
}

export type MessageType = AppMessage['type'];

export type CustomerSegment = 'new' | 'returning' | 'vip' | 'lapsed';

export interface SegmentStats {
  segment: CustomerSegment;
  label: string;
  count: number;
  avgSpend: number;
  lastOrderDaysAgo: number;
  color: string;
  /* Contract CustomerSegment fields (CRM.md) — additive on the legacy row:
   * name (≤80), rules (opaque, server-validated), memberCount (computed
   * server-side, never client-estimated), createdAt. */
  name?: string;
  rules?: Record<string, unknown>;
  memberCount?: number;
  createdAt?: number;
}

export interface PlatformCampaign {
  id: string;
  title: string;
  date: string;
  perks: string;
  traffic: string;
  requirement: string;
  /* Contract PlatformEvent statuses (open -> enrolling -> active -> ended,
   * PROMOTIONS.md) — additive on the legacy open/signed/closed vocabulary. */
  status: 'open' | 'signed' | 'closed' | 'enrolling' | 'active' | 'ended';
  enrolled?: boolean;
  startsAt?: number;
  endsAt?: number;
}

export type TaskPriority = 'high' | 'medium' | 'low';
export type TaskAction = 'open-product' | 'open-promos' | 'open-campaign' | 'open-traffic' | 'open-review' | 'open-settings' | 'open-orders' | 'none';

export interface Task {
  id: string;
  title: string;
  sub: string;
  priority: TaskPriority;
  done: boolean;
  action?: TaskAction;
}

export interface ChatMessage {
  id: string;
  from: 'customer' | 'merchant';
  text: string;
  ts: number;
}

export interface ChatThread {
  id: string;
  customerName: string;
  customerInitial: string;
  lastMessage: string;
  lastTs: number;
  unread: number;
  context: string;
  messages: ChatMessage[];
}

export interface OrderSettings {
  autoAccept: boolean;
  autoAcceptDelaySec: number;
  preOrderEnabled: boolean;
  voiceAnnounce: boolean;
  ringtone: 'beep' | 'melody' | 'none';
}

export interface DecorationSettings {
  posterColor: string;
  posterText: string;
  sign: string;
  brandStory: string;
  tagline: string;
}

export interface PromotionPlan {
  enabled: boolean;
  dailyBudget: number;
  focus: 'ranking' | 'impressions';
}

export interface CouponRecord {
  id: string;
  code: string;
  amount: number;
  ts: number;
  status: 'valid' | 'invalid' | 'used' | 'expired';
}

export interface Staff {
  id: string;
  name: string;
  role: 'owner' | 'manager' | 'staff';
  phone: string;
  permissions: string[];
}

export interface CouponDraft {
  code: string;
  amount: number;
  used: boolean;
}

export interface BusinessHours {
  open: string;
  close: string;
  closedDays: string[];
}

export interface StoreSettings {
  name: string;
  category: string;
  phone: string;
  address: string;
  description: string;
  bannerColor: string;
  featuredProductIds: string[];
  open: boolean;
  hours: BusinessHours;
  deliveryRadiusKm: number;
  deliveryFee: number;
  minOrder: number;
  rating?: number;
  rank?: { current: number; previous: number; category: string; score: number };
}

export interface NotificationSettings {
  newOrder: boolean;
  orderProgress: boolean;
  review: boolean;
  campaign: boolean;
  system: boolean;
}

export interface PrinterSettings {
  enabled: boolean;
  copies: number;
  paperSize: '58mm' | '80mm';
}