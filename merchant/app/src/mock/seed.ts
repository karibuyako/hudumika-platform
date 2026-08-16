import {
  COMMISSION_RATE,
  CUSTOMERS,
  PRODUCTS,
  SEED_CAMPAIGNS,
  SEED_CHATS,
  SEED_CUSTOMER_SEGMENTS,
  SEED_MESSAGES,
  SEED_ORDERS,
  SEED_PLATFORM_CAMPAIGNS,
  SEED_REVIEWS,
  VALID_COUPON_CODES,
} from '@/data/seed';
import { RIDERS } from '@/lib/format';
import { db, uid } from '@/mock/db';
import type {
  AttendanceRecord,
  ApprovalRequest,
  BankCard,
  BarcodeFormat,
  BarcodeHistoryEntry,
  BarcodeInfo,
  BrandDisplayCampaign,
  BulkOperation,
  CategoryRow,
  Combo,
  CommissionRule,
  Coupon,
  CouponCampaign,
  DianjinCampaign,
  DineInOrder,
  ExpenseRecord,
  FlashSale,
  KitchenCamera,
  LoyaltyMember,
  LoyaltyTransaction,
  MembershipTier,
  Menu,
  MerchantDevice,
  MerchantStaff,
  MerchantPayoutAccountRow,
  MerchantSettingsRow,
  PaymentAccount,
  PrecisionCampaign,
  Printer,
  PrintJob,
  ProductLog,
  ProductRow,
  ProductVideo,
  Promotion,
  Qualification,
  ReceiptTemplate,
  Reservation,
  SelfPickupConfig,
  SelfServicePromotion,
  StaffShift,
  StoreLog,
  StoreQrCode,
  TableRow,
  TemplateRow,
  Withdrawal,
  InventoryAdjustment,
  InventoryItem,
  InventorySyncConfig,
  OrderDto,
  OrderEvent,
  PurchaseOrder,
  Supplier,
  SupplierReturn,
  Warehouse,
} from '@/api/types';
import type {
  Campaign,
  ChatThread,
  Invoice,
  Notification,
  Order,
  Payment,
  Refund,
  Settlement,
} from '@/mock/types';

export const DEMO_MERCHANT = {
  phone: '+255700000000',
  owner: 'Juma Mwenda',
  storeName: 'Skewer House BBQ · Kariakoo',
};

const TAX_RATE = 0.06;

/** Opaque segment rules (CRM.md) — the server-validated rules bag the editor
 *  writes and the API serves back. Rule shapes the rule-builder offers. */
function segmentRulesFor(segment: string): Record<string, unknown> {
  switch (segment) {
    case 'new':
      return { orders: { min: 0, max: 1 }, recencyDays: { max: 30 } };
    case 'returning':
      return { orders: { min: 2 }, spendTZS: { min: 50000 } };
    case 'vip':
      return { orders: { min: 5 }, spendTZS: { min: 150000 } };
    case 'lapsed':
      return { recencyDays: { min: 30 } };
    default:
      return {};
  }
}

export function seedDatabase() {
  const m = db.table('merchants');
  const st = db.table('stores');
  const staff = db.table('staff');
  const products = db.table<ProductRow>('products');
  const categories = db.table<CategoryRow>('categories');
  const customers = db.table('customers');
  const orders = db.table<Order>('orders');
  const payments = db.table<Payment>('payments');
  const refunds = db.table<Refund>('refunds');
  const ledger = db.table('ledger');
  const settlements = db.table<Settlement>('settlements');
  const invoices = db.table<Invoice>('invoices');
  const notifications = db.table<Notification>('notifications');
  const chats = db.table<ChatThread>('chatThreads');
  const campaigns = db.table<Campaign>('campaigns');
  const platformCampaigns = db.table('platformCampaigns');
  const segments = db.table('segments');
  const supportTickets = db.table('supportTickets');
  const audit = db.table('auditLogs');
  const riders = db.table('riders');
  const experiments = db.table('experiments');
  const tasks = db.table('tasks');
  const redemptions = db.table('redemptions');
  const reviews = db.table('reviews');
  const riskEvents = db.table('riskEvents');

  const merchantId = 'm_demo';
  m.insert({
    id: merchantId,
    phone: DEMO_MERCHANT.phone,
    name: DEMO_MERCHANT.owner,
    status: 'active',
    plan: 'pro',
    country: 'TZ',
    currency: 'TZS',
    locale: 'en',
    consentAt: Date.now() - 400 * 86400000,
    createdAt: Date.now() - 400 * 86400000,
  });

  const storeId = 's_demo';
  st.insert({
    id: storeId,
    merchantId,
    name: DEMO_MERCHANT.storeName,
    category: 'BBQ',
    phone: '010-8472 6688',
    address: '410 Wangjing West 4th District, Chaoyang, Beijing',
    description: 'Charcoal-grilled to order, open till late',
    bannerColor: '#FFB300',
    featuredProductIds: ['p1', 'p6', 'p16'],
    open: true,
    hours: { open: '16:30', close: '02:00', closedDays: [] },
    deliveryRadiusKm: 4,
    deliveryFee: 3,
    minOrder: 30,
    rating: 4.7,
    rank: { current: 6, previous: 9, category: 'BBQ & Grill', score: 92.4 },
    orderSettings: {
      autoAccept: false,
      autoAcceptDelaySec: 30,
      preOrderEnabled: true,
      voiceAnnounce: true,
      ringtone: 'beep',
      contactlessDelivery: true,
      acceptWhileClosed: false,
      requireNotes: 'optional',
      autoCancelMinutes: 5,
    },
    decoration: {
      posterColor: '#FFB300',
      posterText: 'Charcoal-grilled skewers, open till 2 AM',
      sign: 'Smoking hot, straight off the grill',
      brandStory: 'Founded in 2019, our family recipe has been over the coals for 30 years.',
      tagline: 'Charcoal-grilled to order',
    },
    promotion: { enabled: false, dailyBudget: 60, focus: 'ranking' },
    announcement: 'Summer night BBQ every Friday — family platters 15% off',
    coverImage: '🔥🍢',
    deliveryEtaMin: 30,
    pickupReadyMinutes: 15,
    freeDeliveryThreshold: 0,
    paymentMethods: { mpesa: true, airtel_money: true, cod: true, card: false },
    dualScreen: {
      enabled: false,
      screen: 'orders',
      refreshSec: 10,
      showOrderNumbers: true,
      theme: 'dark',
      pairingCode: 'DS-2026',
    },
    qrOrdering: { enabled: true, type: 'table', urlPattern: 'https://order.example.com/q' },
    receiptTemplateId: 'rt1',
  });

  staff.insertMany([
    {
      id: 's1',
      merchantId,
      storeId,
      name: DEMO_MERCHANT.owner,
      role: 'owner',
      phone: '+255700000000',
      permissions: ['*'],
      active: true,
    },
    {
      id: 's2',
      merchantId,
      storeId,
      name: 'Mia',
      role: 'manager',
      phone: '+255700000002',
      permissions: ['orders:manage', 'menu:manage', 'finance:view', 'redemption', 'campaigns:manage', 'team:manage'],
      active: true,
    },
    {
      id: 's3',
      merchantId,
      storeId,
      name: 'Kai',
      role: 'staff',
      phone: '+255700000003',
      permissions: ['orders:accept', 'redemption'],
      active: true,
    },
  ]);

  // ---- Passwords (W0a, /auth/change-password) ----
  // OTP is the primary sign-in; a password exists so change-password has a
  // baseline to verify against. Demo current password: demo1234.
  const authPasswords = db.table<{ id: string; password: string }>('authPasswords');
  authPasswords.insertMany([{ id: 's1', password: 'demo1234' }]);

  categories.insertMany([
    { id: 'c1', merchantId, storeId, name: 'Grilled Skewers', sort: 0, visible: true },
    { id: 'c2', merchantId, storeId, name: 'Platters & Combo', sort: 1, visible: true },
    { id: 'c3', merchantId, storeId, name: 'Drinks & Sides', sort: 2, visible: true },
  ]);

  const now = Date.now();
  const productCategory = (p: { categoryId: string }): string =>
    p.categoryId === 'c5' ? 'c3' : p.categoryId === 'c4' ? 'c2' : 'c1';

  PRODUCTS.forEach((p, i) => {
    products.insert({
      id: p.id,
      merchantId,
      storeId,
      categoryId: productCategory(p),
      name: p.name,
      emoji: p.emoji,
      price: p.price,
      variants: p.variants ?? [],
      stock: p.stock,
      sold: p.sold ?? 0,
      visible: p.visible ?? true,
      description: `Charcoal-grilled to order · ${p.name}`,
      images: [p.emoji],
      videoUrl: i === 0 ? 'https://example.com/videos/skewers.mp4' : undefined,
      addons:
        i === 0
          ? [
              { id: 'a1', name: 'Extra chili', price: 2, emoji: '🌶️' },
              { id: 'a2', name: 'Cucumber salad side', price: 5, emoji: '🥒' },
            ]
          : [],
      comboItems: [],
      zeroStockAction: p.categoryId === 'c5' ? 'hide' : 'showSoldOut',
      sort: i,
      updatedAt: now - i * 60000,
    });
  });

  {
    const comboRefs = [PRODUCTS[0], PRODUCTS[5], PRODUCTS[15]];
    const comboItems: { productId: string; name: string; emoji: string; qty: number; price: number }[] = [
      { productId: comboRefs[0].id, name: comboRefs[0].name, emoji: comboRefs[0].emoji, qty: 4, price: 18 },
      { productId: comboRefs[1].id, name: comboRefs[1].name, emoji: comboRefs[1].emoji, qty: 2, price: 15 },
      { productId: comboRefs[2].id, name: comboRefs[2].name, emoji: comboRefs[2].emoji, qty: 1, price: 20 },
    ];
    const comboSum = comboItems.reduce((s, c) => s + c.price * c.qty, 0);
    products.insert({
      id: 'p_combo1',
      merchantId,
      storeId,
      categoryId: 'c2',
      name: 'BBQ Family Set',
      emoji: '🍱',
      price: Math.round(comboSum * 0.85),
      variants: [],
      stock: 20,
      sold: 0,
      visible: true,
      description: 'Charcoal-grilled to order · BBQ Family Set',
      images: ['🍱'],
      addons: [],
      comboItems,
      zeroStockAction: 'showSoldOut',
      sort: PRODUCTS.length,
      updatedAt: now - PRODUCTS.length * 60000,
    });
  }

  {
    const store2Id = 's_demo_2';
    st.insert({
      id: store2Id,
      merchantId,
      name: 'Skewer House BBQ · Guomao',
      category: 'BBQ',
      phone: '010-8472 6699',
      address: 'Building 5, Guomao CBD, Chaoyang, Beijing',
      description: 'Charcoal-grilled to order, open till late',
      bannerColor: '#FF6B81',
      featuredProductIds: [],
      open: true,
      hours: { open: '11:30', close: '23:00', closedDays: [] },
      deliveryRadiusKm: 3,
      deliveryFee: 4,
      minOrder: 25,
      rating: 4.5,
      rank: { current: 0, previous: 0, category: '', score: 0 },
      orderSettings: {
        autoAccept: true,
        autoAcceptDelaySec: 20,
        preOrderEnabled: true,
        voiceAnnounce: true,
        ringtone: 'melody',
        contactlessDelivery: false,
        acceptWhileClosed: true,
        requireNotes: 'none',
        autoCancelMinutes: 5,
      },
      decoration: {
        posterColor: '#FF6B81',
        posterText: 'Charcoal-grilled skewers',
        sign: 'Smoking hot',
        brandStory: 'Our second location',
        tagline: 'Charcoal-grilled to order',
      },
      promotion: { enabled: false, dailyBudget: 60, focus: 'ranking' },
      announcement: 'Second location now open — same grill, new neighborhood',
      coverImage: '🍢✨',
      deliveryEtaMin: 35,
      pickupReadyMinutes: 20,
      freeDeliveryThreshold: 60,
      paymentMethods: { mpesa: true, airtel_money: false, cod: true, card: false },
      dualScreen: {
        enabled: false,
        screen: 'kitchen',
        refreshSec: 15,
        showOrderNumbers: true,
        theme: 'light',
        pairingCode: 'DS-8899',
      },
      qrOrdering: { enabled: true, type: 'counter', urlPattern: 'https://order.example.com/q' },
      receiptTemplateId: 'rt2',
    });
    categories.insertMany([
      { id: 'c2a', merchantId, storeId: store2Id, name: 'Grilled Skewers', sort: 0, visible: true },
      { id: 'c2b', merchantId, storeId: store2Id, name: 'Drinks & Sides', sort: 1, visible: true },
    ]);
    const store2Products: { id: string; name: string; emoji: string; price: number; stock: number; categoryId: string }[] = [
      { id: 'p2a', name: 'Charcoal Lamb Skewer', emoji: '🍢', price: 18, stock: 40, categoryId: 'c2a' },
      { id: 'p2b', name: 'Smoked Duck Neck', emoji: '🦆', price: 22, stock: 30, categoryId: 'c2a' },
      { id: 'p2c', name: 'Grilled Mushroom Skewer', emoji: '🍄', price: 12, stock: 50, categoryId: 'c2a' },
      { id: 'p2d', name: 'Salt & Pepper Squid', emoji: '🦑', price: 38, stock: 20, categoryId: 'c2a' },
      { id: 'p2e', name: 'Malt Beer', emoji: '🍺', price: 15, stock: 25, categoryId: 'c2b' },
    ];
    store2Products.forEach((p, i) => {
      products.insert({
        id: p.id,
        merchantId,
        storeId: store2Id,
        categoryId: p.categoryId,
        name: p.name,
        emoji: p.emoji,
        price: p.price,
        variants: [],
        stock: p.stock,
        sold: 0,
        visible: true,
        description: `Charcoal-grilled to order · ${p.name}`,
        images: [p.emoji],
        addons: [],
        comboItems: [],
        zeroStockAction: 'showSoldOut',
        sort: i,
        updatedAt: now - i * 60000,
      });
    });
  }

  {
    const store2Id = 's_demo_2';
    const qrUrlFor = (sid: string, tableId: string, token: string) => {
      const s = st.find(sid);
      return `${s?.qrOrdering?.urlPattern || 'https://order.example.com/q'}/${sid}/${tableId}?t=${token}`;
    };
    const tableSeeds: { storeId: string; name: string; zone: string; capacity: number; status: TableRow['status'] }[] = [
      { storeId, name: 'A1', zone: 'Indoor', capacity: 2, status: 'occupied' },
      { storeId, name: 'A2', zone: 'Indoor', capacity: 4, status: 'idle' },
      { storeId, name: 'A3', zone: 'Indoor', capacity: 4, status: 'idle' },
      { storeId, name: 'A4', zone: 'Indoor', capacity: 6, status: 'idle' },
      { storeId, name: 'B1', zone: 'Window', capacity: 4, status: 'idle' },
      { storeId, name: 'B2', zone: 'Window', capacity: 2, status: 'idle' },
      { storeId, name: 'C1', zone: 'Patio', capacity: 6, status: 'reserved' },
      { storeId, name: 'C2', zone: 'Patio', capacity: 8, status: 'idle' },
      { storeId: store2Id, name: 'T1', zone: 'Main Hall', capacity: 2, status: 'idle' },
      { storeId: store2Id, name: 'T2', zone: 'Main Hall', capacity: 4, status: 'idle' },
      { storeId: store2Id, name: 'T3', zone: 'Main Hall', capacity: 4, status: 'idle' },
      { storeId: store2Id, name: 'T4', zone: 'Main Hall', capacity: 6, status: 'idle' },
    ];
    const tables = db.table<TableRow>('tables');
    tableSeeds.forEach((t) => {
      const id = uid('tbl');
      const qrToken = uid('qr');
      tables.insert({
        id,
        storeId: t.storeId,
        name: t.name,
        zone: t.zone,
        capacity: t.capacity,
        status: t.status,
        qrToken,
        qrUrl: qrUrlFor(t.storeId, id, qrToken),
        disabled: false,
        createdAt: now,
      });
    });

    const paymentAccounts = db.table<PaymentAccount>('paymentAccounts');
    paymentAccounts.insertMany([
      { id: 'pa1', storeId, type: 'bank', provider: 'bank', name: 'NMB · Corporate', account: '014045004900', accountMasked: '****4900', status: 'active', isDefault: true, createdAt: now },
      { id: 'pa2', storeId, type: 'mobile_money', provider: 'mpesa', name: 'M-Pesa merchant', account: '+255700000000', accountMasked: '****0000', status: 'pending', isDefault: false, createdAt: now },
      { id: 'pa3', storeId: store2Id, type: 'bank', provider: 'bank', name: 'CRDB · Mlimani City', account: '01602800017', accountMasked: '****0017', status: 'active', isDefault: true, createdAt: now },
    ]);

    const receiptTemplates = db.table<ReceiptTemplate>('receiptTemplates');
    receiptTemplates.insertMany([
      { id: 'rt1', storeId, name: 'Standard', headerText: 'Skewer House BBQ · Wangjing', footerText: 'Thanks for dining with us! 🔥', showLogo: true, showQRCode: true, showPayment: true, showRider: true, paperSize: '80mm', copies: 1, logoEmoji: '🍢', isDefault: true, updatedAt: now },
      { id: 'rt2', storeId: store2Id, name: 'Guomao Night', headerText: 'Skewer House BBQ · Guomao', footerText: 'See you again!', showLogo: true, showQRCode: false, showPayment: true, showRider: false, paperSize: '80mm', copies: 1, logoEmoji: '🍢', isDefault: true, updatedAt: now },
    ]);

    const printers = db.table<Printer>('printers');
    printers.insertMany([
      { id: 'pr1', storeId, name: 'Kitchen Thermal', type: 'bluetooth', status: 'connected', paperSize: '80mm', copies: 1, purpose: 'receipt', isDefault: true, createdAt: now },
      { id: 'pr2', storeId, name: 'Counter Label', type: 'network', status: 'offline', paperSize: '58mm', copies: 1, purpose: 'receipt', isDefault: false, createdAt: now },
      { id: 'pr3', storeId: store2Id, name: 'Kitchen Thermal', type: 'bluetooth', status: 'connected', paperSize: '80mm', copies: 1, purpose: 'kitchen', isDefault: true, createdAt: now },
    ]);
  }

  CUSTOMERS.forEach((c, i) => {
    customers.insert({
      id: `cu${i}`,
      phone: c.phone,
      name: c.name,
      address: c.address,
      orders: 0,
      spend: 0,
      lastOrderAt: 0,
    });
  });

  // ---- Orders, payments, refunds ----
  const TAX_FACTOR = TAX_RATE;
  SEED_ORDERS.forEach((o, i) => {
    const paymentId = `pay_${o.id}`;
    const refunded = !!o.refund;
    const payStatus: Payment['status'] =
      o.status === 'cancelled' ? 'failed' : refunded && o.refund?.status === 'approved' ? 'refunded' : 'captured';
    payments.insert({
      id: paymentId,
      merchantId,
      orderId: o.id,
      amount: o.total,
      method: i % 3 === 0 ? 'airtel_money' : 'mpesa',
      provider: i % 3 === 0 ? 'mock-airtel-money' : 'mock-mpesa',
      status: payStatus,
      idempotencyKey: `pay-seed-${o.id}`,
      createdAt: o.createdAt,
      capturedAt: o.createdAt + 40000,
      refundedAmount: refunded && o.refund?.status === 'approved' ? o.refund.amount : 0,
      refunds: [],
    });

    if (o.refund) {
      refunds.insert({
        id: `rf_${o.id}`,
        merchantId,
        orderId: o.id,
        paymentId,
        amount: o.refund.amount,
        reason: o.refund.reason,
        reasonCode: 'CUSTOMER_REQUEST',
        status: o.refund.status,
        decidedBy: o.refund.status === 'requested' ? undefined : 's2',
        decidedAt: o.refund.status === 'requested' ? undefined : o.refund.ts + 60000,
        createdAt: o.refund.ts,
        ts: o.refund.ts,
      });
    }

    const timeline: Order['timeline'] = [{ event: 'created', ts: o.createdAt, actor: 'customer-platform' }];
    if (o.acceptedAt) timeline.push({ event: 'accepted', ts: o.acceptedAt, actor: 's2' });
    if (o.readyAt) timeline.push({ event: 'ready', ts: o.readyAt, actor: 's2' });
    if (o.completedAt) timeline.push({ event: 'delivered', ts: o.completedAt, actor: 'rider' });
    if (o.cancelledAt) timeline.push({ event: 'cancelled', ts: o.cancelledAt, actor: 'merchant' });

    orders.insert({
      id: o.id,
      merchantId,
      storeId,
      no: o.no,
      status: o.status,
      version: 1,
      items: o.items,
      customer: o.customer,
      note: o.note,
      deliveryType: o.deliveryType,
      subtotal: o.subtotal,
      deliveryFee: o.deliveryFee,
      total: o.total,
      createdAt: o.createdAt,
      deadlineAt: o.deadlineAt,
      scheduledAt: o.scheduledAt,
      rushAt: o.rushAt,
      rushReplied: o.rushReplied,
      refund: o.refund,
      acceptedAt: o.acceptedAt,
      readyAt: o.readyAt,
      completedAt: o.completedAt,
      cancelledAt: o.cancelledAt,
      cancelReason: o.cancelReason,
      rider: o.rider,
      riderId: o.rider ? `r_${o.rider}` : undefined,
      seen: o.seen,
      rating: o.rating,
      paymentId,
      timeline,
      settledAt: o.status === 'completed' ? o.completedAt : undefined,
    });
  });

  // ---- Terminal-status + merchant_accepted orders (ORDER-FLOW.md: refunded /
  // failed / disputed render as terminal states; merchant_accepted is the
  // intermediate accepted state) ----
  const terminalNow = now;
  const terminalRows: {
    id: string;
    status: Order['status'];
    pay: Payment['status'];
    seen: boolean;
    timeline: Order['timeline'];
    opts: Partial<OrderDto>;
  }[] = [
    {
      id: 'o_seed_21',
      status: 'refunded',
      pay: 'refunded',
      seen: true,
      // Historical (10 days ago) so the refund does not disturb the 7-day
      // compliance refund-ratio window for the seeded store.
      timeline: [
        { event: 'created', ts: terminalNow - 10 * 86400000, actor: 'customer-platform' },
        { event: 'accepted', ts: terminalNow - 10 * 86400000 + 6 * 60000, actor: 's2' },
        { event: 'cancelled', ts: terminalNow - 10 * 86400000 + 12 * 60000, actor: 's2' },
        { event: 'refund-approved', ts: terminalNow - 10 * 86400000 + 18 * 60000, actor: 'system' },
      ],
      opts: {
        acceptedAt: terminalNow - 10 * 86400000 + 6 * 60000,
        cancelledAt: terminalNow - 10 * 86400000 + 12 * 60000,
        cancelReason: 'Customer dispute — full refund issued',
        cancelReasonCode: 'CUSTOMER_DISPUTE',
        refund: { ts: terminalNow - 10 * 86400000 + 18 * 60000, reason: 'Customer dispute — full refund issued', amount: 0, status: 'approved' },
      },
    },
    {
      id: 'o_seed_22',
      status: 'failed',
      pay: 'failed',
      seen: true,
      timeline: [{ event: 'created', ts: terminalNow - 5 * 3600000, actor: 'customer-platform' }],
      opts: { cancelReason: 'Payment failed at the provider', cancelReasonCode: 'PAYMENT_FAILED' },
    },
    {
      id: 'o_seed_23',
      status: 'disputed',
      pay: 'captured',
      seen: false,
      timeline: [
        { event: 'created', ts: terminalNow - 26 * 3600000, actor: 'customer-platform' },
        { event: 'accepted', ts: terminalNow - 25.9 * 3600000, actor: 's2' },
        { event: 'disputed', ts: terminalNow - 20 * 3600000, actor: 'customer-platform' },
      ],
      opts: {
        acceptedAt: terminalNow - 25.9 * 3600000,
        cancelReason: 'Customer dispute — payout held pending review',
        cancelReasonCode: 'CUSTOMER_DISPUTE',
      },
    },
    {
      id: 'o_seed_24',
      status: 'merchant_accepted',
      pay: 'captured',
      seen: true,
      timeline: [
        { event: 'created', ts: terminalNow - 12 * 60000, actor: 'customer-platform' },
        { event: 'accepted', ts: terminalNow - 8 * 60000, actor: 's2' },
      ],
      opts: { acceptedAt: terminalNow - 8 * 60000, deadlineAt: terminalNow + 8 * 60000 },
    },
  ];
  terminalRows.forEach((t, i) => {
    const src = SEED_ORDERS[i % SEED_ORDERS.length];
    const paymentId = `pay_${t.id}`;
    const createdAt =
      t.id === 'o_seed_21' ? terminalNow - 10 * 86400000 : t.id === 'o_seed_24' ? terminalNow - 12 * 60000 : terminalNow - (i + 2) * 3600000;
    const orderRow: OrderDto = {
      id: t.id,
      merchantId,
      storeId,
      no: `MT${String(88000 + 21 + i)}`,
      status: t.status,
      version: 1,
      items: src.items,
      customer: src.customer,
      note: src.note,
      deliveryType: src.deliveryType,
      subtotal: src.subtotal,
      deliveryFee: src.deliveryFee,
      total: src.total,
      createdAt,
      deadlineAt: t.opts.deadlineAt ?? createdAt + 5 * 60000,
      rushAt: undefined,
      rushReplied: false,
      refund: t.opts.refund,
      acceptedAt: t.opts.acceptedAt,
      readyAt: undefined,
      completedAt: undefined,
      cancelledAt: t.opts.cancelledAt,
      cancelReason: t.opts.cancelReason,
      cancelReasonCode: t.opts.cancelReasonCode,
      rider: undefined,
      riderId: undefined,
      seen: t.seen,
      paymentId,
      timeline: t.timeline as OrderEvent[],
      settledAt: undefined,
      source: i === 1 ? 'phone' : i === 2 ? 'pos' : 'app',
    };
    orders.insert(orderRow);
    payments.insert({
      id: paymentId,
      merchantId,
      orderId: t.id,
      amount: src.total,
      method: i % 3 === 0 ? 'airtel_money' : 'mpesa',
      provider: i % 3 === 0 ? 'mock-airtel-money' : 'mock-mpesa',
      status: t.pay,
      idempotencyKey: `pay-seed-${t.id}`,
      createdAt,
      capturedAt: t.pay === 'failed' ? undefined : createdAt + 40000,
      refundedAmount: t.pay === 'refunded' ? Math.round(src.total) : 0,
      refunds: t.pay === 'refunded' ? [`rf_${t.id}`] : [],
    });
    if (t.status === 'refunded') {
      refunds.insert({
        id: `rf_${t.id}`,
        merchantId,
        orderId: t.id,
        paymentId,
        amount: Math.round(src.total),
        reason: 'Customer dispute — full refund issued',
        reasonCode: 'CUSTOMER_DISPUTE',
        status: 'approved',
        decidedBy: 'system',
        decidedAt: createdAt + 18 * 60000,
        createdAt: createdAt + 18 * 60000,
        ts: createdAt + 18 * 60000,
      });
    }
  });

  // ---- Receipt reprint history (GET /orders/receipts contract rows) ----
  const orderReceipts = db.table('orderReceipts');
  orderReceipts.insertMany([
    { id: 'rc_seed_1', merchantId, orderId: 'o_seed_6', printedAt: now - 2 * 3600000, jobId: 'pj_seed_1', no: 'MT88006' },
    { id: 'rc_seed_2', merchantId, orderId: 'o_seed_7', printedAt: now - 26 * 60000, jobId: 'pj_seed_2', no: 'MT88007' },
    { id: 'rc_seed_3', merchantId, orderId: 'o_seed_11', printedAt: now - 5 * 60000, jobId: 'pj_seed_3', no: 'MT88011' },
  ]);

  // ---- Ledger, settlements, invoices ----
  const completed = orders.where((o) => o.status === 'completed');
  let balance = 8642.5;
  const ledgerRows: { id: string; merchantId: string; type: string; amount: number; balance?: number; title: string; ts: number; status: string; refType?: string; refId?: string }[] = [];
  const dailyBatches = new Map<string, { gross: number; commission: number; tax: number }>();

  for (const o of completed) {
    const commission = Math.round(o.total * COMMISSION_RATE * 100) / 100;
    const tax = Math.round(o.total * TAX_FACTOR * 100) / 100;
    const net = Math.round((o.total - commission - tax) * 100) / 100;
    ledgerRows.push(
      { id: uid('l'), merchantId, type: 'order', amount: net, title: `Order ${o.no} settlement`, ts: o.completedAt!, status: 'completed', refType: 'order', refId: o.id },
      { id: uid('l'), merchantId, type: 'commission', amount: -commission, title: `Platform commission ${Math.round(COMMISSION_RATE * 100)}%`, ts: o.completedAt!, status: 'completed', refType: 'order', refId: o.id },
      { id: uid('l'), merchantId, type: 'tax', amount: -tax, title: `VAT ${Math.round(TAX_FACTOR * 100)}% (e-invoice)`, ts: o.completedAt!, status: 'completed', refType: 'order', refId: o.id },
    );
    balance = Math.round((balance + net - commission - tax) * 100) / 100;
    const day = new Date(o.completedAt!).setHours(0, 0, 0, 0);
    const b = dailyBatches.get(String(day)) ?? { gross: 0, commission: 0, tax: 0 };
    b.gross += o.total;
    b.commission += commission;
    b.tax += tax;
    dailyBatches.set(String(day), b);
  }

  const approvedRefunds = refunds.where((r) => r.status === 'approved');
  for (const r of approvedRefunds) {
    ledgerRows.push({ id: uid('l'), merchantId, type: 'refund', amount: -r.amount, title: `Refund ${r.orderId}`, ts: r.decidedAt!, status: 'completed', refType: 'order', refId: r.orderId });
    balance = Math.round((balance - r.amount) * 100) / 100;
  }

  ledgerRows.sort((a, b) => b.ts - a.ts);
  // replay to compute running balance per entry (newest first: balance at that ts)
  const byTs: typeof ledgerRows = [];
  let running = balance;
  for (const row of ledgerRows) {
    running = Math.round((running - row.amount) * 100) / 100;
    byTs.push({ ...row, balance: running });
  }
  byTs.forEach((r) => ledger.insert(r));

  const batchDays = [...dailyBatches.entries()].sort((a, b) => Number(b[0]) - Number(a[0])).slice(0, 3);
  const newestDay = batchDays.length ? Number(batchDays[0][0]) : new Date().setHours(0, 0, 0, 0);
  /* Seed exactly three daily settlements (newest paid, older two pending, each
   * with its invoice) so earnings flows always find a pending settlement. Days
   * without completed orders reuse the newest batch's figures as fixtures. */
  for (let i = 0; i < 3; i++) {
    const dayKey = newestDay - i * 86400000;
    const batch = dailyBatches.get(String(dayKey)) ?? dailyBatches.get(String(newestDay));
    const gross = batch ? Math.round(batch.gross * 100) / 100 : 0;
    const commission = batch ? Math.round(batch.commission * 100) / 100 : 0;
    const tax = batch ? Math.round(batch.tax * 100) / 100 : 0;
    const sid = `set_${dayKey}`;
    const net = Math.round((gross - commission - tax) * 100) / 100;
    settlements.insert({
      id: sid,
      merchantId,
      batchNo: `S${new Date(dayKey).toISOString().slice(0, 10).replace(/-/g, '')}`,
      periodStart: dayKey,
      periodEnd: dayKey + 86400000,
      gross,
      commission,
      tax,
      net,
      payoutStatus: i === 0 ? 'paid' : 'pending',
      orderCount: batch ? completed.filter((o) => new Date(o.completedAt!).setHours(0, 0, 0, 0) === dayKey).length : 0,
      createdAt: dayKey + 86400000 - 3600000,
    });
    invoices.insert({
      id: `inv_${dayKey}`,
      merchantId,
      settlementId: sid,
      no: `EV${new Date(dayKey).toISOString().slice(0, 10).replace(/-/g, '')}${String(100 + i)}`,
      amount: gross,
      taxRate: TAX_FACTOR,
      taxAmount: tax,
      status: i === 0 ? 'issued' : 'draft',
      createdAt: dayKey + 86400000 - 3600000,
    });
  }

  // ---- Notifications, chats, campaigns, segments, riders, support, audit, experiments ----
  SEED_MESSAGES.forEach((m) => {
    notifications.insert({
      id: m.id,
      merchantId,
      type: m.type,
      category: m.category,
      title: m.title,
      body: m.body,
      ts: m.ts,
      read: m.read,
      orderId: m.orderId,
    });
  });

  SEED_CHATS.forEach((c) => {
    chats.insert({ ...c, merchantId });
  });

  VALID_COUPON_CODES.forEach((code, i) => {
    redemptions.insert({
      id: `rd_${i}`,
      merchantId,
      code,
      amount: i === 0 ? 15 : 20,
      customer: `customer_${i}`,
      status: i === 2 ? 'expired' : 'valid',
      ts: Date.now() - i * 3600000,
    });
  });
  redemptions.insert({
    id: 'rd_used',
    merchantId,
    code: 'USED888',
    amount: 10,
    customer: 'customer_used',
    status: 'redeemed',
    ts: Date.now() - 86400000,
    redeemedAt: Date.now() - 86300000,
    redeemedBy: 's3',
  });

  // ---- Group-buy deals & vouchers (P6c) ----
  const groupBuys = db.table('groupBuys');
  const vouchers = db.table('vouchers');
  const verifyHistory = db.table('verifyHistory');
  const gbLiveId = 'gb_seed_live';
  const gbDraftId = 'gb_seed_draft';
  const gbNow = Date.now();
  groupBuys.insert({
    id: gbLiveId,
    merchantId,
    title: 'BBQ Family Set · Group deal',
    description: 'Four skewer platters for the price of three — the more that join, the more you save.',
    imageUrl: 'https://images.unsplash.com/photo-1529193591184-b1d58069ecdd?w=600',
    priceTZS: 60000,
    originalPriceTZS: 90000,
    quantity: 50,
    soldCount: 12,
    validityDays: 90,
    salesStartAt: gbNow - 3 * 86400000,
    salesEndAt: gbNow + 12 * 86400000,
    status: 'live',
  });
  groupBuys.insert({
    id: gbDraftId,
    merchantId,
    title: 'Weekend brunch tasting menu',
    description: 'Three-course brunch set for two.',
    priceTZS: 45000,
    originalPriceTZS: 70000,
    quantity: 30,
    soldCount: 0,
    validityDays: 60,
    salesStartAt: gbNow + 2 * 86400000,
    salesEndAt: gbNow + 16 * 86400000,
    status: 'draft',
  });
  vouchers.insertMany([
    {
      id: 'GB-7K2M-9QX4',
      code: 'GB-7K2M-9QX4',
      groupBuyId: gbLiveId,
      title: 'BBQ Family Set · Group deal',
      priceTZS: 60000,
      status: 'unused',
      purchasedAt: gbNow - 2 * 86400000,
      expiresAt: gbNow + 88 * 86400000,
    },
    {
      id: 'GB-3N8P-5TZ7',
      code: 'GB-3N8P-5TZ7',
      groupBuyId: gbLiveId,
      title: 'BBQ Family Set · Group deal',
      priceTZS: 60000,
      status: 'unused',
      purchasedAt: gbNow - 86400000,
      expiresAt: gbNow + 89 * 86400000,
    },
    {
      id: 'GB-9W1R-2C6V',
      code: 'GB-9W1R-2C6V',
      groupBuyId: gbLiveId,
      title: 'BBQ Family Set · Group deal',
      priceTZS: 60000,
      status: 'redeemed',
      purchasedAt: gbNow - 4 * 86400000,
      redeemedAt: gbNow - 5 * 3600000,
      expiresAt: gbNow + 86 * 86400000,
      redeemedByMerchantId: merchantId,
    },
  ]);
  verifyHistory.insert({
    id: 'vh_seed_1',
    voucherCode: 'GB-9W1R-2C6V',
    verifiedAt: gbNow - 5 * 3600000,
    verifiedBy: 's3',
    result: 'redeemed',
  });

  /* Voucher verify 409-code coverage (GROUP-BUY.md §Verification):
   * - refund in progress -> VOUCHER_REFUND_PENDING
   * - a deal owned by another merchant -> VOUCHER_NOT_REDEEMABLE_AT_MERCHANT
   *   when a store of m_demo tries to redeem it (the deal row belongs to a
   *   different merchant, so it never shows up in m_demo's own deal/voucher
   *   lists — only the global code lookup sees it). */
  vouchers.insert({
    id: 'GB-5R9K-3VXW',
    code: 'GB-5R9K-3VXW',
    groupBuyId: gbLiveId,
    title: 'BBQ Family Set · Group deal',
    priceTZS: 60000,
    status: 'refunded',
    purchasedAt: gbNow - 86400000,
    expiresAt: gbNow + 88 * 86400000,
    refundPendingAt: gbNow - 2 * 3600000,
  });
  groupBuys.insert({
    id: 'gb_seed_other',
    merchantId: 'm_grill_corner',
    title: 'Grill Corner weekend platter',
    description: 'Shared platter for four at a corner-store price.',
    imageUrl: 'https://images.unsplash.com/photo-1544025162-d76694265947?w=600',
    priceTZS: 42000,
    originalPriceTZS: 65000,
    quantity: 40,
    soldCount: 6,
    validityDays: 60,
    salesStartAt: gbNow - 2 * 86400000,
    salesEndAt: gbNow + 9 * 86400000,
    status: 'live',
  });
  vouchers.insert({
    id: 'GB-4T6H-8P2M',
    code: 'GB-4T6H-8P2M',
    groupBuyId: 'gb_seed_other',
    title: 'Grill Corner weekend platter',
    priceTZS: 42000,
    status: 'unused',
    purchasedAt: gbNow - 86400000,
    expiresAt: gbNow + 59 * 86400000,
  });

  SEED_REVIEWS.forEach((r, i) => {
    reviews.insert({ ...r, merchantId, platform: i % 3 === 0 ? 'dianping' : 'meituan' });
  });

  riskEvents.insertMany([
    { id: 'rk1', merchantId, level: 'low', type: 'login-risk', detail: 'Login from a new device (Chrome on Windows) — verification passed.', ts: Date.now() - 5 * 3600000, status: 'reviewed', reviewedBy: 's1', reviewedAt: Date.now() - 4 * 3600000 },
    { id: 'rk2', merchantId, level: 'medium', type: 'large-refund', detail: 'Large refund TZS 210 on order MT88010 exceeds the TZS 200 threshold — verify the customer story.', ts: Date.now() - 2 * 3600000, status: 'open' },
  ]);

  SEED_CAMPAIGNS.forEach((c) => {
    campaigns.insert({ ...c, merchantId, version: 1 });
  });
  SEED_PLATFORM_CAMPAIGNS.forEach((p) => {
    platformCampaigns.insert({ ...p });
  });
  SEED_CUSTOMER_SEGMENTS.forEach((s) => {
    /* Contract CustomerSegment fields (CRM.md) — additive on the legacy row:
     * name ≤80, opaque rules (server-validated), computed memberCount, createdAt. */
    segments.insert({ ...s, merchantId, id: `seg_${s.segment}`, name: s.label, rules: segmentRulesFor(s.segment), memberCount: s.count, createdAt: now - 30 * 86400000 });
  });

  RIDERS.forEach((r, i) => {
    riders.insert({
      id: `r_${i}`,
      name: r,
      status: i === 0 ? 'delivering' : 'idle',
      lat: 39.995 + (i % 3) * 0.002,
      lng: 116.46 + (i % 3) * 0.003,
      updatedAt: Date.now() - i * 120000,
    });
  });

  supportTickets.insertMany([
    {
      id: 'ticket1',
      merchantId,
      subject: 'Delivery zone coverage question',
      body: 'Can I expand my delivery radius to cover the new tech park?',
      status: 'replied',
      replies: [
        { from: 'agent', text: 'Hi Alex! Radius expansion is available on the Pro plan. Submit the request and we will review within 24h.', ts: Date.now() - 86400000 },
      ],
      createdAt: Date.now() - 90000000,
      updatedAt: Date.now() - 86400000,
    },
    {
      id: 'ticket2',
      merchantId,
      subject: 'Menu photo needs re-verification',
      body: 'My lamb skewer photo was flagged as low quality. Can you re-check?',
      status: 'open',
      replies: [],
      createdAt: Date.now() - 3600000,
      updatedAt: Date.now() - 3600000,
    },
    {
      id: 'ticket3',
      merchantId,
      subject: 'Withdrawal to the wrong payout account',
      body: 'The payout landed on the old account. Please help me get it re-routed.',
      status: 'resolved',
      priority: 'high',
      statusOverride: 'closed',
      replies: [
        { from: 'agent', text: 'We located the payout and re-routed it to your new account. It should reflect within one business day.', ts: Date.now() - 3 * 86400000 },
        { from: 'merchant', text: 'Received, thank you.', ts: Date.now() - 2 * 86400000 },
      ],
      createdAt: Date.now() - 6 * 86400000,
      updatedAt: Date.now() - 2 * 86400000,
    },
  ]);

  audit.insert({
    id: uid('a'),
    merchantId,
    actor: 's2',
    role: 'manager',
    action: 'orders:accept',
    resource: 'order',
    resourceId: 'o_seed_3',
    detail: 'accepted order MT88003',
    ts: Date.now() - 50 * 60000,
  });
  audit.insert({
    id: uid('a'),
    merchantId,
    actor: 'customer-platform',
    role: 'system',
    action: 'orders:create',
    resource: 'order',
    resourceId: 'o_seed_0',
    detail: 'order created via customer app',
    ts: Date.now() - 4 * 60000,
  });

  experiments.insertMany([
    { id: 'e1', key: 'home-banner-variant', variant: 'B', rollout: 1 },
    { id: 'e2', key: 'order-card-compact', variant: 'off', rollout: 0 },
  ]);

  tasks.insertMany([
    {
      id: 't1',
      merchantId,
      key: 'stock-risk',
      title: 'Stock out risk: Beef Skewers',
      sub: 'Sold 86% of 7-day forecast · top 3 bestseller',
      priority: 'high',
      done: false,
      action: 'open-product',
    },
    {
      id: 't2',
      merchantId,
      key: 'platform-campaign',
      title: 'Join "Summer Night BBQ Festival"',
      sub: 'Platform traffic bonus ends Aug 16 · 1 slot left in your area',
      priority: 'high',
      done: false,
      action: 'open-campaign',
    },
    {
      id: 't3',
      merchantId,
      key: 'unreplied-review',
      title: 'Reply to 1-star review from Ray Zhou',
      sub: 'Unreplied reviews hurt conversion · reply within 24h',
      priority: 'high',
      done: false,
      action: 'open-review',
    },
    {
      id: 't4',
      merchantId,
      key: 'peak-capacity',
      title: 'Optimize peak-hour prep capacity',
      sub: '17:00–19:00 orders are +23% vs last week',
      priority: 'medium',
      done: false,
      action: 'open-settings',
    },
    {
      id: 't5',
      merchantId,
      key: 'auto-accept',
      title: 'Set up auto-accept to cut order loss',
      sub: 'Orders auto-cancel when unaccepted for 5 min',
      priority: 'medium',
      done: false,
      action: 'open-orders',
    },
  ]);

  const productLogs = db.table<ProductLog>('productLogs');
  productLogs.insertMany([
    {
      id: 'pl_seed_1',
      merchantId,
      storeId,
      productId: 'p1',
      action: 'product:create',
      before: undefined,
      after: { name: 'Signature Lamb Skewer', price: 12, stock: 200, visible: true },
      actorId: 's2',
      role: 'manager',
      ts: now - 3 * 86400000,
    },
    {
      id: 'pl_seed_2',
      merchantId,
      storeId,
      productId: 'p2',
      action: 'product:update',
      field: 'price',
      before: 15,
      after: 16,
      actorId: 's2',
      role: 'manager',
      ts: now - 2 * 86400000,
    },
    {
      id: 'pl_seed_3',
      merchantId,
      storeId,
      productId: 'p5',
      action: 'product:stock',
      field: 'stock',
      before: 120,
      after: 180,
      actorId: 's2',
      role: 'manager',
      ts: now - 1 * 86400000,
    },
  ]);

  const storeLogs = db.table<StoreLog>('storeLogs');
  storeLogs.insertMany([
    {
      id: 'sl_seed_1',
      merchantId,
      storeId,
      action: 'store:update',
      field: 'announcement',
      before: 'Winter menu is live — hot pot specials every night',
      after: 'Summer night BBQ every Friday — family platters 15% off',
      actorId: 's2',
      role: 'manager',
      ts: now - 3 * 86400000,
    },
    {
      id: 'sl_seed_2',
      merchantId,
      storeId,
      action: 'closure:apply',
      before: undefined,
      after: { from: now - 2 * 86400000, to: now - 2 * 86400000 + 86400000 },
      actorId: 's2',
      role: 'manager',
      ts: now - 2 * 86400000,
    },
    {
      id: 'sl_seed_3',
      merchantId,
      storeId,
      action: 'store:update',
      field: 'hours',
      before: { open: '17:00', close: '01:00', closedDays: [] },
      after: { open: '16:30', close: '02:00', closedDays: [] },
      actorId: 's2',
      role: 'manager',
      ts: now - 1 * 86400000,
    },
  ]);

  const templates = db.table<TemplateRow>('templates');
  const tplSource = products.find('p1');
  if (tplSource) {
    const draft: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(tplSource)) {
      if (['id', 'merchantId', 'storeId', 'stock', 'sold', 'updatedAt', 'deleted'].includes(k)) continue;
      draft[k] = v;
    }
    templates.insert({
      id: 'tpl1',
      merchantId,
      name: 'Signature Skewer Starter',
      draft,
      createdAt: now - 86400000,
    });
  }

  // ---- Loyalty: membership tiers + members (P6d) ----
  // thresholdTZS = minimum top-up eligible for the tier bonus;
  // bonusRateBps = bonus in integer basis points (250 = 2.5%);
  // discountBps = tier order discount in integer basis points (500 = 5%, contract MemberTier).
  const membershipTiers = db.table<MembershipTier>('membershipTiers');
  const members = db.table<LoyaltyMember>('members');
  membershipTiers.insertMany([
    { id: 'tier_bronze', merchantId, name: 'Bronze', thresholdTZS: 20000, bonusRateBps: 250, discountBps: 300, benefits: ['Birthday bonus'] },
    { id: 'tier_gold', merchantId, name: 'Gold', thresholdTZS: 200000, bonusRateBps: 500, discountBps: 500, benefits: ['Free delivery', 'Priority service'] },
  ]);
  members.insertMany([
    {
      id: 'm_seed_1',
      merchantId,
      name: 'Neema Mushi',
      phone: '+255712345678',
      maskedPhone: '+2557…',
      birthday: '1992-03-15',
      balanceTZS: 45000,
      tierId: 'tier_bronze',
      tier: null,
      totalSpendTZS: 85000,
      joinedAt: now - 120 * 86400000,
      createdAt: now - 120 * 86400000,
      updatedAt: now - 5 * 86400000,
    },
    {
      id: 'm_seed_2',
      merchantId,
      name: 'Baraka Kessy',
      phone: '+255713333444',
      maskedPhone: '+2557…',
      balanceTZS: 120000,
      tierId: 'tier_gold',
      tier: null,
      totalSpendTZS: 245000,
      joinedAt: now - 90 * 86400000,
      createdAt: now - 90 * 86400000,
      updatedAt: now - 2 * 86400000,
    },
    {
      id: 'm_seed_3',
      merchantId,
      name: 'Amina Juma',
      phone: '+255754111222',
      maskedPhone: '+2557…',
      birthday: '1998-11-02',
      balanceTZS: 0,
      tierId: 'tier_bronze',
      tier: null,
      totalSpendTZS: 15000,
      joinedAt: now - 30 * 86400000,
      createdAt: now - 30 * 86400000,
      updatedAt: now - 86400000,
    },
  ]);

  const dineInBills = db.table<DineInOrder>('dineInOrders');
  const tableByName = (name: string) => db.table<TableRow>('tables').where((t) => t.storeId === storeId && t.name === name)[0];
  const billTotals = (subtotalTZS: number) => {
    const taxTZS = Math.round(subtotalTZS * 0.06);
    return {
      subtotalTZS,
      deliveryFeeTZS: 0,
      platformFeeTZS: 0,
      taxTZS,
      discountTZS: 0,
      totalTZS: subtotalTZS + taxTZS,
    };
  };
  const seedBill = (
    id: string,
    tableName: string,
    status: DineInOrder['status'],
    rows: { productId: string; quantity: number }[],
    createdAt: number,
    paidAt?: number,
  ) => {
    const table = tableByName(tableName)!;
    const items = rows.map((r) => {
      const product = products.find(r.productId)!;
      return { catalogueItemId: product.id, name: product.name, quantity: r.quantity, unitPriceTZS: product.price };
    });
    const bill: DineInOrder = {
      id,
      merchantId,
      tableId: table.id,
      status,
      items,
      totals: billTotals(items.reduce((sum, it) => sum + it.unitPriceTZS * it.quantity, 0)),
      createdAt,
      paidAt: paidAt ?? null,
    };
    dineInBills.insert(bill);
    db.table<TableRow>('tables').update(table.id, { currentOrderId: id, status: 'occupied' });
  };
  seedBill('dio_seed_1', 'A1', 'billing', [{ productId: 'p1', quantity: 2 }, { productId: 'p16', quantity: 1 }], now - 40 * 60000);
  seedBill('dio_seed_2', 'A2', 'paid', [{ productId: 'p2', quantity: 1 }], now - 90 * 60000, now - 30 * 60000);

  // ---- Wallet withdrawals (P6d, contract /wallet/withdrawals) ----
  const walletWithdrawals = db.table<Withdrawal & { merchantId: string }>('walletWithdrawals');
  walletWithdrawals.insertMany([
    {
      id: 'wd_seed_1',
      merchantId,
      amountTZS: 250000,
      feeTZS: 0,
      status: 'paid',
      method: 'bank',
      estimatedArrivalDays: 1,
      createdAt: now - 6 * 86400000,
      paidAt: now - 5 * 86400000,
      reason: null,
    },
    {
      id: 'wd_seed_2',
      merchantId,
      amountTZS: 50000,
      feeTZS: 0,
      status: 'pending',
      method: 'bank',
      estimatedArrivalDays: 1,
      createdAt: now - 3600000,
      paidAt: null,
      reason: null,
    },
  ]);

  // ---- P5 finance ops (contract /finance/bank-cards, /finance/expenses) ----
  // One linked bank card (default) + one recorded expense, so the finance
  // screen has seeded rows to render before any mutation happens.
  const bankCards = db.table<BankCard & { merchantId: string }>('bankCards');
  bankCards.insert({
    id: 'bc_seed_1',
    merchantId,
    bankName: 'NMB Bank',
    last4: '4900',
    accountHolderName: DEMO_MERCHANT.owner,
    isDefault: true,
    createdAt: now - 90 * 86400000,
  });

  const expenses = db.table<ExpenseRecord & { merchantId: string }>('expenses');
  expenses.insert({
    id: 'exp_seed_1',
    merchantId,
    category: 'ingredients',
    amountTZS: 85000,
    note: 'Weekly skewer meat + spices restock',
    incurredAt: now - 2 * 86400000,
    createdAt: now - 2 * 86400000,
  });

  // ---- Device registry (P6d, contract /devices) ----
  const devices = db.table<MerchantDevice & { merchantId: string }>('devices');
  devices.insertMany([
    {
      id: 'dev_seed_1',
      merchantId,
      type: 'pos',
      label: 'Front counter POS',
      purpose: 'receipt',
      paperSize: '80mm',
      copies: 1,
      status: 'online',
      settings: {},
      lastSeenAt: now - 60000,
    },
    {
      id: 'dev_seed_2',
      merchantId,
      type: 'kitchen_display',
      label: 'Kitchen display 1',
      purpose: 'kitchen',
      paperSize: '80mm',
      copies: 1,
      status: 'online',
      settings: {},
      lastSeenAt: now - 120000,
    },
    {
      id: 'dev_seed_3',
      merchantId,
      type: 'printer',
      label: 'Kitchen thermal printer',
      purpose: 'kitchen',
      paperSize: '58mm',
      copies: 1,
      status: 'error',
      settings: {},
      lastSeenAt: now - 86400000,
    },
  ]);

  // ---- Merchant staff (P6d, contract /merchants/me/staff) ----
  const merchantStaff = db.table<MerchantStaff & { merchantId: string }>('merchantStaff');
  merchantStaff.insertMany([
    {
      id: 'ms_seed_1',
      merchantId,
      storeId,
      name: DEMO_MERCHANT.owner,
      phone: '+255700000000',
      role: 'owner',
      permissions: ['*'],
      status: 'active',
      createdAt: now - 400 * 86400000,
    },
    {
      id: 'ms_seed_2',
      merchantId,
      storeId,
      name: 'Mia',
      phone: '+255700000002',
      role: 'manager',
      permissions: ['orders:manage', 'menu:manage', 'finance:view', 'redemption', 'campaigns:manage', 'team:manage'],
      status: 'active',
      createdAt: now - 200 * 86400000,
    },
    {
      id: 'ms_seed_3',
      merchantId,
      storeId,
      name: 'Kai',
      phone: '+255700000003',
      role: 'cashier',
      permissions: ['redemption', 'dine_in:billing'],
      status: 'active',
      createdAt: now - 100 * 86400000,
    },
    {
      id: 'ms_seed_4',
      merchantId,
      storeId,
      name: 'Neema Mushi',
      phone: '+255712345678',
      role: 'waiter',
      permissions: ['orders:view', 'dine_in:serve'],
      status: 'invited',
      createdAt: now - 2 * 86400000,
    },
  ]);

  // ---- Promotions & marketing ops (P6c, contract /promotions + /marketing/*) ----
  const promos = db.table<Promotion>('promotions');
  const promosAt = now;
  promos.insertMany([
    {
      id: 'promo_seed_live',
      merchantId,
      type: 'discount',
      title: 'Evening grill special · 15% off skewers',
      description: 'Flat 15% off all skewer platters between 18:00 and close.',
      status: 'live',
      discountRateBps: 1500,
      budgetTZS: 300000,
      target: 'all',
      productIds: ['p1', 'p6', 'p16'],
      haggleEnabled: false,
      startsAt: promosAt - 3 * 86400000,
      endsAt: promosAt + 11 * 86400000,
      redeemCount: 47,
      spendTZS: 120000,
      impressions: 18600,
      clicks: 1340,
      attributedOrders: 47,
      attributedRevenueTZS: 960000,
      createdAt: promosAt - 6 * 86400000,
    },
    {
      id: 'promo_seed_pending',
      merchantId,
      type: 'coupon',
      title: 'New customers · TZS 5,000 off first order',
      description: 'Welcome coupon for first-time buyers, min spend TZS 25,000.',
      status: 'pending_review',
      couponAmountTZS: 5000,
      thresholdTZS: 25000,
      budgetTZS: 200000,
      target: 'new_customers',
      startsAt: promosAt + 2 * 86400000,
      endsAt: promosAt + 30 * 86400000,
      redeemCount: 0,
      spendTZS: 0,
      impressions: 0,
      clicks: 0,
      attributedOrders: 0,
      attributedRevenueTZS: 0,
      createdAt: promosAt - 86400000,
    },
    {
      id: 'promo_seed_paused',
      merchantId,
      type: 'ppc',
      title: 'DianJin search boost · weekend push',
      description: 'Pay-per-click placement for weekend traffic spike.',
      status: 'paused',
      cpcTZS: 800,
      budgetTZS: 150000,
      startsAt: promosAt - 10 * 86400000,
      endsAt: promosAt + 4 * 86400000,
      redeemCount: 12,
      spendTZS: 64000,
      impressions: 9800,
      clicks: 820,
      attributedOrders: 12,
      attributedRevenueTZS: 410000,
      createdAt: promosAt - 12 * 86400000,
    },
  ]);

  const flashSales = db.table<FlashSale>('flashSales');
  flashSales.insert({
    id: 'fs_seed_live',
    merchantId,
    itemIds: ['p1', 'p6'],
    discountBps: 2500,
    quantityLimit: 100,
    soldCount: 34,
    startsAt: promosAt - 5 * 3600000,
    endsAt: promosAt + 19 * 3600000,
    status: 'live',
    createdAt: promosAt - 2 * 86400000,
  });

  const dianjin = db.table<DianjinCampaign>('dianjinCampaigns');
  dianjin.insert({
    id: 'dj_seed_1',
    merchantId,
    name: 'Kariakoo search boost',
    budgetTZS: 250000,
    bidBps: 400,
    active: true,
    spendTZS: 72000,
    clicks: 310,
    createdAt: promosAt - 8 * 86400000,
  });

  const precision = db.table<PrecisionCampaign>('precisionCampaigns');
  precision.insert({
    id: 'pc_seed_1',
    merchantId,
    name: 'VIP reorder nudge',
    segmentId: 'seg_vip',
    segmentLabel: 'VIP · 5+ orders',
    offer: { type: 'coupon', value: 'TZS 10,000 off' },
    status: 'draft',
    sentCount: 0,
    createdAt: promosAt - 3 * 86400000,
  });

  db.table<BrandDisplayCampaign>('brandDisplays').insert({
    id: 'bd_seed_1',
    merchantId,
    name: 'BBQ brand awareness',
    budgetTZS: 400000,
    startsAt: promosAt - 7 * 86400000,
    endsAt: promosAt + 23 * 86400000,
    active: true,
    impressions: 41200,
    createdAt: promosAt - 9 * 86400000,
  });

  db.table<SelfServicePromotion & { id: string }>('selfServicePromotions').insert({
    id: merchantId,
    merchantId,
    active: true,
    designUrl: 'https://hudumika.co.tz/promo/skewer-house',
    homepageExposure: true,
    package: 'basic',
    packagePriceTZS: 50000,
    startedAt: promosAt - 15 * 86400000,
  });

  db.table<CouponCampaign>('couponCampaigns').insert({
    id: 'cc_seed_1',
    merchantId,
    title: 'Mid-week coupon drop',
    kind: 'fixed',
    discountTZS: 5000,
    minimumSpendTZS: 25000,
    quantity: 100,
    claimedCount: 3,
    validUntil: promosAt + 14 * 86400000,
    status: 'live',
  });
  db.table<Coupon>('marketingCoupons').insertMany([
    {
      id: 'c_seed_1',
      campaignId: 'cc_seed_1',
      code: 'FRESH15',
      title: 'Mid-week coupon drop',
      discountTZS: 5000,
      minimumSpendTZS: 25000,
      status: 'claimed',
      claimedAt: promosAt - 2 * 3600000,
      usedAt: null,
      expiresAt: promosAt + 14 * 86400000,
    },
    {
      id: 'c_seed_2',
      campaignId: 'cc_seed_1',
      code: 'SAVE10',
      title: 'Mid-week coupon drop',
      discountTZS: 5000,
      minimumSpendTZS: 25000,
      status: 'available',
      claimedAt: promosAt - 3 * 3600000,
      usedAt: null,
      expiresAt: promosAt + 14 * 86400000,
    },
    {
      id: 'c_seed_3',
      campaignId: 'cc_seed_1',
      code: 'USED5K',
      title: 'Mid-week coupon drop',
      discountTZS: 5000,
      minimumSpendTZS: 25000,
      status: 'used',
      claimedAt: promosAt - 86400000,
      usedAt: promosAt - 20 * 3600000,
      expiresAt: promosAt + 14 * 86400000,
    },
    {
      id: 'c_seed_4',
      campaignId: 'cc_seed_1',
      code: 'OLDSALE',
      title: 'Mid-week coupon drop',
      discountTZS: 5000,
      minimumSpendTZS: 25000,
      status: 'expired',
      claimedAt: promosAt - 30 * 86400000,
      usedAt: null,
      expiresAt: promosAt - 10 * 86400000,
    },
  ]);

  // ---- P2: orders ops + refunds queue fixtures (held orders, reschedule
  // request, enterprise rows, route/waybill data, rejected refund row) ----
  const p2Now = Date.now();
  const p2 = (id: string) => orders.find(id);
  if (p2('o_seed_3')) {
    orders.update('o_seed_3', { hold: { at: p2Now - 12 * 60000, reason: 'Waiting for customer to confirm address' } });
  }
  if (p2('o_seed_4')) {
    orders.update('o_seed_4', { hold: { at: p2Now - 30 * 60000, reason: 'Kitchen capacity — will resume shortly' } });
  }
  if (p2('o_seed_0')) {
    orders.update('o_seed_0', {
      reschedule: { at: p2Now - 5 * 60000, reason: 'Customer requested a later delivery slot', status: 'requested', scheduledAt: p2Now + 90 * 60000 },
    });
  }
  if (p2('o_seed_6')) {
    orders.update('o_seed_6', { enterprise: { companyName: 'Tanzania Breweries Ltd', costCenter: 'CC-0412', billingRef: 'PO-88231' } });
  }
  if (p2('o_seed_14')) {
    orders.update('o_seed_14', { enterprise: { companyName: 'NMB Bank Corporate', costCenter: 'CC-0901', billingRef: 'PRF-22917' } });
  }
  if (p2('o_seed_5')) {
    orders.update('o_seed_5', {
      waybillNumber: `WB-${p2('o_seed_5')?.no ?? 'SEED'}`,
      routeSegments: [
        {
          legId: 'leg_o_seed_5_1',
          sequence: 1,
          type: 'first_mile',
          mode: 'motorcycle',
          handledBy: 'r_Baraka',
          status: 'completed',
          plannedStartAt: p2Now - 50 * 60000,
          plannedEndAt: p2Now - 40 * 60000,
          etaAt: p2Now - 40 * 60000,
          startedAt: p2Now - 50 * 60000,
          completedAt: p2Now - 40 * 60000,
          custody: { from: 'merchant', to: 'rider', sealIntact: true, at: p2Now - 40 * 60000 },
        },
        {
          legId: 'leg_o_seed_5_2',
          sequence: 2,
          type: 'last_mile',
          mode: 'motorcycle',
          handledBy: 'r_Baraka',
          status: 'in_progress',
          plannedStartAt: p2Now - 40 * 60000,
          plannedEndAt: p2Now + 15 * 60000,
          etaAt: p2Now + 15 * 60000,
          startedAt: p2Now - 39 * 60000,
        },
      ],
    });
  }
  const seededRejected = orders.find('o_seed_10');
  if (seededRejected && !refunds.find('rf_o_seed_10')) {
    refunds.insert({
      id: 'rf_o_seed_10',
      merchantId,
      orderId: 'o_seed_10',
      paymentId: 'pay_o_seed_10',
      amount: seededRejected.total,
      reason: 'Customer changed mind after pickup',
      reasonCode: 'CUSTOMER_REQUEST',
      status: 'declined',
      decidedBy: 's2',
      decidedAt: p2Now - 3 * 3600000,
      createdAt: p2Now - 4 * 3600000,
      ts: p2Now - 4 * 3600000,
    });
    orders.update('o_seed_10', {
      refund: { ts: p2Now - 4 * 3600000, reason: 'Customer changed mind after pickup', amount: seededRejected.total, status: 'declined' },
    });
  }

  // ---- P8: catalogue extensions + chain (contract /barcodes /combos /menus
  // /videos /bulk-operations /chain/dashboard /chain/reports) ----
  const p8Now = Date.now();

  const barcodeFormats = db.table<BarcodeFormat & { id: string }>('barcodeFormats');
  barcodeFormats.insertMany([
    { id: 'fmt_ean13', code: 'ean13', label: 'EAN-13 (retail) — 13 digits' },
    { id: 'fmt_ean8', code: 'ean8', label: 'EAN-8 (small retail) — 8 digits' },
    { id: 'fmt_upca', code: 'upca', label: 'UPC-A (North America) — 12 digits' },
    { id: 'fmt_code128', code: 'code128', label: 'Code 128 (logistics) — variable' },
    { id: 'fmt_code39', code: 'code39', label: 'Code 39 (industrial) — variable' },
    { id: 'fmt_qr', code: 'qr', label: 'QR code — scannable by any phone' },
  ]);

  const barcodes = db.table<BarcodeInfo & { merchantId: string }>('barcodes');
  barcodes.insertMany([
    { id: 'bc_seed_1', merchantId, code: '6900000000017', format: 'ean13', catalogueItemId: 'p1', createdAt: p8Now - 20 * 86400000 },
    { id: 'bc_seed_2', merchantId, code: 'HUD-P1-QR-2026', format: 'qr', catalogueItemId: 'p4', createdAt: p8Now - 10 * 86400000 },
  ]);
  db.table<BarcodeHistoryEntry & { code: string; id: string }>('barcodeHistory').insertMany([
    { id: 'bch_seed_1', code: '6900000000017', at: p8Now - 20 * 86400000, action: 'generated' },
    { id: 'bch_seed_2', code: '6900000000017', at: p8Now - 2 * 86400000, action: 'scanned' },
    { id: 'bch_seed_3', code: 'HUD-P1-QR-2026', at: p8Now - 10 * 86400000, action: 'generated' },
    { id: 'bch_seed_4', code: 'HUD-P1-QR-2026', at: p8Now - 3600000, action: 'printed' },
  ]);

  db.table<Combo & { merchantId: string }>('combos').insertMany([
    {
      id: 'combo_seed_1',
      merchantId,
      name: 'BBQ Family Skewer Set',
      description: '6 mixed skewers, rice and two drinks — feeds 3-4 people.',
      items: [
        { catalogueItemId: 'p1', quantity: 4 },
        { catalogueItemId: 'p15', quantity: 2 },
        { catalogueItemId: 'p19', quantity: 2 },
      ],
      priceTZS: 40000,
      imageUrl: null,
      available: true,
      createdAt: p8Now - 14 * 86400000,
    },
    {
      id: 'combo_seed_2',
      merchantId,
      name: 'Date Night Grill',
      description: 'Two premium skewers, cold noodles and a drink each.',
      items: [
        { catalogueItemId: 'p5', quantity: 2 },
        { catalogueItemId: 'p16', quantity: 1 },
        { catalogueItemId: 'p20', quantity: 2 },
      ],
      priceTZS: 28000,
      imageUrl: null,
      available: true,
      createdAt: p8Now - 7 * 86400000,
    },
  ]);

  db.table<Menu & { merchantId: string }>('menus').insert({
    id: 'menu_seed_1',
    merchantId,
    name: 'Weekday BBQ Menu',
    storeIds: ['s_demo', 's_demo_2'],
    sections: [
      { name: 'Grilled Skewers', itemIds: ['p1', 'p5', 'p6'] },
      { name: 'Staples & Sides', itemIds: ['p15', 'p16'] },
      { name: 'Drinks', itemIds: ['p19', 'p20'] },
    ],
    active: true,
    createdAt: p8Now - 5 * 86400000,
  });

  db.table<ProductVideo & { merchantId: string }>('productVideos').insert({
    id: 'video_seed_1',
    merchantId,
    title: 'Grilling the signature lamb skewer',
    url: 'https://example.com/videos/skewers.mp4',
    thumbnailUrl: null,
    catalogueItemId: 'p1',
    status: 'active',
    durationSeconds: 42,
    views: 1280,
    createdAt: p8Now - 6 * 86400000,
  });

  db.table<BulkOperation & { merchantId: string }>('bulkOperations').insert({
    id: 'bulk_seed_1',
    merchantId,
    type: 'price_update',
    storeIds: ['s_demo', 's_demo_2'],
    payload: { itemId: 'p1', priceTZS: 12000 },
    status: 'completed',
    results: [
      { storeId: 's_demo', ok: true },
      { storeId: 's_demo_2', ok: true },
    ],
    createdBy: DEMO_MERCHANT.owner,
    createdAt: p8Now - 3 * 86400000,
    requiresApproval: false,
  });

  // ---- P8: inventory & supply chain (contract /inventory, /suppliers,
  // /purchase-orders, /supplier-returns, /warehouses) ----
  const scNow = Date.now();
  const scInventory = db.table<InventoryItem & { id: string; merchantId: string }>('inventoryItems');
  const scAdjustments = db.table<InventoryAdjustment & { merchantId: string }>('inventoryAdjustments');
  products.all().forEach((p, i) => {
    const lowStockThreshold = 10;
    const stockOnHand = p.id === 'p3' ? 6 : p.id === 'p7' ? 0 : p.stock;
    const reserved = i % 5;
    scInventory.insert({
      id: p.id,
      catalogueItemId: p.id,
      merchantId,
      name: p.name,
      storeId: p.storeId,
      stockOnHand,
      reserved,
      available: stockOnHand - reserved,
      lowStockThreshold,
      unitCostTZS: Math.round(p.price * 800),
      lastRestockedAt: scNow - i * 86400000,
    });
  });
  scAdjustments.insertMany([
    {
      id: 'ia_seed_1',
      merchantId,
      itemId: 'p1',
      delta: 40,
      reason: 'stock_in · purchase order receive',
      storeId,
      at: scNow - 2 * 86400000,
      by: 's2 (manager)',
    },
    {
      id: 'ia_seed_2',
      merchantId,
      itemId: 'p3',
      delta: -5,
      reason: 'damaged during service — written off',
      storeId,
      at: scNow - 3600000,
      by: 's2 (manager)',
    },
  ]);
  db.table<InventorySyncConfig & { id: string; merchantId: string }>('inventorySyncConfigs').insert({
    id: 'sync_m_demo',
    merchantId,
    enabled: false,
    masterSource: 'platform',
    channels: ['platform_orders', 'dine_in'],
    lastSyncedAt: null,
  });

  const scSuppliers = db.table<Supplier & { merchantId: string }>('suppliers');
  scSuppliers.insertMany([
    {
      id: 'sup_seed_1',
      merchantId,
      name: 'Kariakoo Fresh Produce Co.',
      contactPhone: '+255744001001',
      contactEmail: 'sales@kariakoo-fresh.co.tz',
      categories: ['vegetables', 'dairy'],
      paymentTerms: 'Net 30',
      status: 'active',
      createdAt: scNow - 90 * 86400000,
    },
    {
      id: 'sup_seed_2',
      merchantId,
      name: 'Kilimanjaro Beverages Ltd',
      contactPhone: '+255754002002',
      contactEmail: 'orders@kilimanjaro-bev.co.tz',
      categories: ['beverages'],
      paymentTerms: 'Cash on delivery',
      status: 'active',
      createdAt: scNow - 45 * 86400000,
    },
  ]);

  const scPurchaseOrders = db.table<PurchaseOrder & { merchantId: string }>('purchaseOrders');
  scPurchaseOrders.insertMany([
    {
      id: 'po_seed_draft',
      merchantId,
      supplierId: 'sup_seed_1',
      storeId,
      status: 'draft',
      items: [
        { catalogueItemId: 'p10', name: 'Grilled Eggplant', quantity: 40, receivedQuantity: 0, unitCostTZS: 3000 },
        { catalogueItemId: 'p12', name: 'Enoki Bacon Roll', quantity: 25, receivedQuantity: 0, unitCostTZS: 4000 },
      ],
      expectedArrivalAt: scNow + 3 * 86400000,
      totalCostTZS: 40 * 3000 + 25 * 4000,
      note: 'Friday BBQ restock',
      createdAt: scNow - 2 * 86400000,
      receivedAt: null,
    },
    {
      id: 'po_seed_sent',
      merchantId,
      supplierId: 'sup_seed_2',
      storeId,
      status: 'sent',
      items: [{ catalogueItemId: 'p19', name: 'Tsingtao Lager', quantity: 60, receivedQuantity: 0, unitCostTZS: 2500 }],
      expectedArrivalAt: scNow + 2 * 86400000,
      totalCostTZS: 60 * 2500,
      note: undefined,
      createdAt: scNow - 86400000,
      receivedAt: null,
    },
  ]);

  db.table<SupplierReturn & { merchantId: string; supplierId: string; items: { catalogueItemId: string; quantity: number }[]; reason: string }>('supplierReturns').insert({
    id: 'sr_seed_1',
    merchantId,
    supplierId: 'sup_seed_1',
    items: [{ catalogueItemId: 'p3', quantity: 5 }],
    reason: 'Damaged carton received with the weekly delivery',
    status: 'pending',
    createdAt: scNow - 5 * 3600000,
  });

  /* Seeded processed + rejected returns exercise every status pill the
   * returns screen renders (ISC L91 pending → processed | rejected). */
  db.table<SupplierReturn & { merchantId: string; supplierId: string; items: { catalogueItemId: string; quantity: number }[]; reason: string }>('supplierReturns').insertMany([
    {
      id: 'sr_seed_2',
      merchantId,
      supplierId: 'sup_seed_2',
      items: [{ catalogueItemId: 'p19', quantity: 4 }],
      reason: 'Warm stock received — sell-by date too close',
      status: 'processed',
      createdAt: scNow - 2 * 86400000,
    },
    {
      id: 'sr_seed_3',
      merchantId,
      supplierId: 'sup_seed_1',
      items: [{ catalogueItemId: 'p12', quantity: 2 }],
      reason: 'Leaking packaging in the last delivery',
      status: 'rejected',
      createdAt: scNow - 3 * 86400000,
    },
  ]);

  const scWarehouses = db.table<Warehouse & { merchantId: string }>('warehouses');
  scWarehouses.insertMany([
    {
      id: 'wh_seed_1',
      merchantId,
      name: 'Dar es Salaam — Kariakoo Forward Stock',
      cityId: 'city_dar',
      address: 'Nyerere Road, Kariakoo',
      lat: -6.8199,
      lon: 39.2802,
      servingCities: ['city_dar', 'city_dodoma'],
      stock: [
        { catalogueItemId: 'p1', quantity: 100 },
        { catalogueItemId: 'p2', quantity: 60 },
        { catalogueItemId: 'p6', quantity: 80 },
        /* p3 sits under the catalogue low-stock threshold → low pill on the
         * warehouse detail Stock tab + warehouse.stock_low alert source. */
        { catalogueItemId: 'p3', quantity: 8 },
      ],
      status: 'active',
      createdAt: scNow - 30 * 86400000,
    },
    {
      id: 'wh_seed_2',
      merchantId,
      name: 'Dodoma — Central Hub',
      cityId: 'city_dodoma',
      address: 'Madaraka Street, Dodoma',
      lat: -6.1629,
      lon: 35.7516,
      servingCities: ['city_dodoma'],
      stock: [{ catalogueItemId: 'p1', quantity: 40 }],
      status: 'maintenance',
      createdAt: scNow - 12 * 86400000,
    },
  ]);

  // ---- P8b: staff ops + approvals (contract /staff/shifts, /staff/attendance,
  // /staff/performance, /staff/commissions, /approvals) ----
  const soNow = Date.now();
  const soDay = 86400000;
  const soDayStart = new Date(soNow);
  soDayStart.setHours(0, 0, 0, 0);
  const soToday = soDayStart.getTime();
  /* Shift fixtures anchor to TOMORROW so tests never trip SHIFT_IN_PAST
   * no matter when the suite runs. */
  const soShiftDay = soToday + soDay;

  const staffShifts = db.table<StaffShift & { merchantId: string }>('staffShifts');
  staffShifts.insertMany([
    {
      id: 'shift_seed_1',
      merchantId,
      staffId: 'ms_seed_2',
      role: 'manager',
      startAt: soShiftDay + 9 * 3600000,
      endAt: soShiftDay + 17 * 3600000,
      status: 'scheduled',
      storeId,
    },
    {
      id: 'shift_seed_2',
      merchantId,
      staffId: 'ms_seed_3',
      role: 'cashier',
      startAt: soShiftDay + 17 * 3600000,
      endAt: soShiftDay + 22 * 3600000,
      status: 'scheduled',
      storeId,
    },
  ]);

  // Attendance: Mia (manager) completed a full shift yesterday; Kai (cashier)
  // has an open record from this morning — the roster shows the live chip.
  const attendance = db.table<AttendanceRecord & { merchantId: string }>('attendance');
  attendance.insertMany([
    {
      id: 'att_seed_1',
      merchantId,
      staffId: 'ms_seed_2',
      shiftId: null,
      clockedInAt: soToday - soDay + 8.9 * 3600000,
      clockedOutAt: soToday - soDay + 17.2 * 3600000,
      durationMinutes: 498,
      source: 'app',
    },
    {
      id: 'att_seed_2',
      merchantId,
      staffId: 'ms_seed_3',
      shiftId: null,
      clockedInAt: soNow - 2 * 3600000,
      clockedOutAt: null,
      durationMinutes: null,
      source: 'app',
    },
  ]);

  const commissionRules = db.table<CommissionRule & { merchantId: string }>('commissionRules');
  commissionRules.insertMany([
    { id: 'cr_seed_1', merchantId, staffId: null, type: 'per_order', rateBps: 500, active: true },
    { id: 'cr_seed_2', merchantId, staffId: 'ms_seed_2', type: 'per_revenue', rateBps: 800, active: true },
  ]);

  const approvals = db.table<ApprovalRequest & { merchantId: string }>('approvals');
  approvals.insert({
    id: 'ap_seed_1',
    merchantId,
    type: 'refund_above_threshold',
    refType: 'order',
    refId: 'o_seed_11',
    summary: 'Refund TZS 180,000 on order MT88011 — above the TZS 150,000 auto-refund threshold',
    amountTZS: 180000,
    status: 'pending',
    requestedBy: 'Kai',
    decisionBy: null,
    decisionComment: null,
    createdAt: soNow - 2 * 3600000,
    decidedAt: null,
  });

  /* Approval-gated refunds (ENTERPRISE-FINANCE.md L49-51): the merchant-level
   * threshold config the refund approve path consults, plus one live demo —
   * a pending refund above the threshold with a matching pending approval. */
  db.table<{ id: string; merchantId: string; thresholdTZS: number }>('refundApprovalConfigs').insert({
    id: 'refundcfg_m_demo',
    merchantId,
    thresholdTZS: 150000,
  });
  const aboveThresholdOrder = orders.find('o_seed_15');
  if (aboveThresholdOrder && !refunds.find('rf_above_threshold')) {
    refunds.insert({
      id: 'rf_above_threshold',
      merchantId,
      orderId: 'o_seed_15',
      paymentId: 'pay_o_seed_15',
      amount: 180000,
      reason: 'Enterprise order — duplicate charge to the corporate card',
      reasonCode: 'DUPLICATE_CHARGE',
      status: 'requested',
      decidedBy: undefined,
      decidedAt: undefined,
      createdAt: soNow - 3 * 3600000,
      ts: soNow - 3 * 3600000,
    });
    approvals.insert({
      id: 'ap_seed_refund_gate',
      merchantId,
      type: 'refund_above_threshold',
      refType: 'refund',
      refId: 'rf_above_threshold',
      summary: 'Refund TZS 180,000 on order MT88015 — above the TZS 150,000 auto-refund threshold',
      amountTZS: 180000,
      status: 'pending',
      requestedBy: 'Kai',
      decisionBy: null,
      decisionComment: null,
      createdAt: soNow - 3 * 3600000,
      decidedAt: null,
    });
  }

  // ---- P8b: webhooks + integrations + tasks center (contract /webhooks,
  // /integrations, /tasks/*) ----
  const p8bNow = Date.now();

  const webhooks = db.table<{ id: string; merchantId: string; url: string; events: string[]; secret: string; status: 'active' | 'disabled' | 'failing'; lastDeliveryAt: number | null; createdAt: number }>('webhooks');
  webhooks.insertMany([
    {
      id: 'wh_seed_1',
      merchantId,
      url: 'https://hooks.example.com/skewer-house',
      events: ['order.created', 'order.updated', 'payment.captured'],
      secret: 'whsec_seed_1',
      status: 'active',
      lastDeliveryAt: p8bNow - 3600000,
      createdAt: p8bNow - 30 * 86400000,
    },
    {
      id: 'wh_seed_2',
      merchantId,
      url: 'https://hooks.example.com/ops-alerts',
      events: ['merchant.updated', 'task.updated'],
      secret: 'whsec_seed_2',
      status: 'failing',
      lastDeliveryAt: p8bNow - 1200000,
      createdAt: p8bNow - 12 * 86400000,
    },
  ]);

  db.table<{ id: string; merchantId: string; webhookId: string; event: string; status: 'success' | 'failed' | 'retrying'; attempts: number; statusCode: number | null; nextRetryAt: number | null; deliveredAt: number | null }>('webhookDeliveries').insertMany([
    {
      id: 'wdel_seed_1',
      merchantId,
      webhookId: 'wh_seed_1',
      event: 'order.created',
      status: 'success',
      attempts: 1,
      statusCode: 200,
      nextRetryAt: null,
      deliveredAt: p8bNow - 3600000,
    },
    {
      id: 'wdel_seed_2',
      merchantId,
      webhookId: 'wh_seed_2',
      event: 'merchant.updated',
      status: 'retrying',
      attempts: 4,
      statusCode: null,
      nextRetryAt: p8bNow + 30 * 60000,
      deliveredAt: null,
    },
  ]);

  const integrations = db.table<{ id: string; merchantId: string; provider: 'pos' | 'erp' | 'accounting' | 'payroll' | 'delivery_partner' | 'mini_program'; label: string; status: 'connected' | 'disconnected' | 'error'; lastSyncedAt: number | null; scopes: string[] }>('integrations');
  integrations.insertMany([
    {
      id: 'int_seed_1',
      merchantId,
      provider: 'pos',
      label: 'Front-of-house POS',
      status: 'connected',
      lastSyncedAt: p8bNow - 5 * 60000,
      scopes: ['orders:read', 'catalogue:read', 'inventory:read'],
    },
    {
      id: 'int_seed_2',
      merchantId,
      provider: 'erp',
      label: 'ERP accounting sync',
      status: 'error',
      lastSyncedAt: p8bNow - 3 * 86400000,
      scopes: ['orders:read', 'ledger:read'],
    },
  ]);

  const taskItems = db.table<{ id: string; merchantId: string; kind: 'anomaly' | 'violation' | 'activity' | 'setup'; title: string; description?: string; refType?: string | null; refId?: string | null; severity?: 'info' | 'warning' | 'critical'; status: 'open' | 'in_progress' | 'done' | 'dismissed'; createdAt: number; dueAt?: number | null }>('taskItems');
  taskItems.insertMany([
    {
      id: 'task_seed_anomaly_1',
      merchantId,
      kind: 'anomaly',
      title: 'Out of stock: Grilled Eggplant',
      description: 'Stock dropped below threshold — reorder or adjust pricing.',
      refType: 'product',
      refId: 'p10',
      severity: 'critical',
      status: 'open',
      createdAt: p8bNow - 2 * 3600000,
      dueAt: p8bNow + 24 * 3600000,
    },
    {
      id: 'task_seed_anomaly_2',
      merchantId,
      kind: 'anomaly',
      title: 'Price drop >50% in 24h: Enoki Bacon Roll',
      description: 'Price fell from 8,000 to 3,500 TZS — verify it was intended.',
      refType: 'product',
      refId: 'p12',
      severity: 'warning',
      status: 'open',
      createdAt: p8bNow - 86400000,
    },
    {
      id: 'task_seed_violation_1',
      merchantId,
      kind: 'violation',
      title: 'Rating below policy threshold',
      description: 'Store rating fell under 4.0 — respond to recent reviews.',
      refType: 'store',
      refId: 's_demo',
      severity: 'warning',
      status: 'open',
      createdAt: p8bNow - 5 * 3600000,
      dueAt: p8bNow + 48 * 3600000,
    },
    {
      id: 'task_seed_activity_1',
      merchantId,
      kind: 'activity',
      title: 'Submit Summer Night BBQ Festival enrollment',
      description: 'Platform campaign enrollment — traffic bonus ends soon.',
      refType: 'campaign',
      refId: 'pc_seed_platform_1',
      severity: 'info',
      status: 'open',
      createdAt: p8bNow - 26 * 3600000,
    },
  ]);

  db.table<{ id: string; merchantId: string; platformEventId: string; status: 'submitted' | 'approved' | 'rejected'; submittedAt: number }>('taskActivities').insertMany([
    {
      id: 'act_seed_1',
      merchantId,
      platformEventId: 'pe_seed_1',
      status: 'submitted',
      submittedAt: p8bNow - 2 * 86400000,
    },
    {
      id: 'act_seed_2',
      merchantId,
      platformEventId: 'pe_seed_2',
      status: 'approved',
      submittedAt: p8bNow - 10 * 86400000,
    },
  ]);

  db.table<{ id: string; merchantId: string; title: string; order: number; completed: boolean; deepLink?: string | null }>('setupSteps').insertMany([
    { id: 'step_seed_1', merchantId, title: 'Complete store profile', order: 1, completed: true, deepLink: '/store' },
    { id: 'step_seed_2', merchantId, title: 'Upload business qualifications', order: 2, completed: true, deepLink: '/store/compliance' },
    { id: 'step_seed_3', merchantId, title: 'Add a payout account', order: 3, completed: true, deepLink: '/store/accounts' },
    { id: 'step_seed_4', merchantId, title: 'Connect a receipt printer', order: 4, completed: true, deepLink: '/store/printers' },
    { id: 'step_seed_5', merchantId, title: 'Print table QR codes', order: 5, completed: false, deepLink: '/store/qr' },
    { id: 'step_seed_6', merchantId, title: 'Add your first product', order: 6, completed: false, deepLink: '/products' },
    { id: 'step_seed_7', merchantId, title: 'Set store hours and delivery settings', order: 7, completed: false, deepLink: '/store/settings' },
    { id: 'step_seed_8', merchantId, title: 'Invite your team', order: 8, completed: false, deepLink: '/profile' },
  ]);

  // ---- P6: notification preferences + order alert settings + help articles
  // (contract /notifications/me/preferences, /notifications/me/order-settings,
  // /help/articles). The merchant settings screen reads + PUTs these rows. ----
  const EVENT_KEYS = ['order.created', 'order.status', 'refund.processed', 'review.received', 'ticket.reply', 'withdrawal.paid', 'marketing.campaign', 'system.announcement'] as const;
  const prefs = { push: {}, sms: {}, email: {}, inApp: {} } as Record<string, Record<string, boolean>>;
  const prefsDefaults: Record<string, boolean> = { push: true, sms: false, email: true, inApp: true };
  for (const channel of Object.keys(prefsDefaults)) {
    prefs[channel] = Object.fromEntries(EVENT_KEYS.map((k) => [k, prefsDefaults[channel]]));
  }
  db.table<{ id: string; merchantId: string; push: Record<string, boolean>; sms: Record<string, boolean>; email: Record<string, boolean>; inApp: Record<string, boolean> }>('notificationPreferences').insert({
    id: `pref_${merchantId}`,
    merchantId,
    push: { ...prefs.push },
    sms: { ...prefs.sms },
    email: { ...prefs.email },
    inApp: { ...prefs.inApp },
  });
  db.table<{ id: string; merchantId: string; acceptanceMethod: 'manual' | 'auto'; voiceAlerts: boolean; channels: string[]; quietHours: { enabled: boolean; from: string; to: string }; autoAcceptWithinSeconds: number }>('orderAlertSettings').insert({
    id: `oa_${merchantId}`,
    merchantId,
    acceptanceMethod: 'manual',
    voiceAlerts: true,
    channels: ['push', 'in_app'],
    quietHours: { enabled: false, from: '22:00', to: '08:00' },
    autoAcceptWithinSeconds: 60,
  });
  db.table<{ id: string; title: string; category: string; body: string }>('helpArticles').insertMany([
    {
      id: 'help_seed_1',
      title: 'Handling your first refund request',
      category: 'orders',
      body: 'Open the order, tap Refund, choose a reason code and amount. Approved refunds settle to the customer within 2–5 business days and appear in your daily settlement.',
    },
    {
      id: 'help_seed_2',
      title: 'Auto-accept orders to cut missed sales',
      category: 'operations',
      body: 'Enable auto-accept in Notification settings and set the window between 30 and 300 seconds. Unaccepted orders auto-cancel after the store deadline.',
    },
  ]);

  // ---- FAQ bundle: 8 areas (EDUCATION-SUPPORT.md §Help/FAQ) — the bundle
  // ships with the app; articles carry screen deep links and ticket
  // escalation flags. Appended after the two legacy rows so the originals
  // stay untouched. ----
  db.table<{ id: string; title: string; category: string; body: string; deepLink?: string | null; escalateToTicket?: boolean }>('helpArticles').insertMany([
    { id: 'help_faq_1', title: 'Swapping a side or item on an order', category: 'orders', body: 'Open the order, message the customer, then confirm the change. Price differences are settled when the order completes.', deepLink: '/orders' },
    { id: 'help_faq_2', title: 'Table QR billing basics', category: 'dine-in', body: 'Print the table QR codes from Store settings. Customers scan, order and pay from their phone; the table chip turns paid when the bill is closed.', deepLink: '/store/qr' },
    { id: 'help_faq_3', title: 'How group deals pay out', category: 'group-buy', body: 'Voucher sales settle with your normal payout cycle. Track redemptions and verification history under Promos.', deepLink: '/marketing/deals' },
    { id: 'help_faq_4', title: 'Promotion moderation decisions', category: 'promotions', body: 'When a campaign is rejected you get a decision with a reason. Appeal by opening a support ticket with the campaign name.', deepLink: '/marketing/promotions', escalateToTicket: true },
    { id: 'help_faq_5', title: 'Earning and redeeming loyalty points', category: 'loyalty', body: 'Points accrue on completed orders per your program rules and appear on the customer receipt.', deepLink: '/store' },
    { id: 'help_faq_6', title: 'Withdrawal failed — what now?', category: 'wallet', body: 'A failed withdrawal shows the reason in the wallet card. Fix the payout account first, then retry the withdrawal.', deepLink: '/dashboard/finance', escalateToTicket: true },
    { id: 'help_faq_7', title: 'Pairing a new staff device', category: 'staff-devices', body: 'Invite the staff member from the Team tab, then sign in on the new device with the phone number used for the invite.', deepLink: '/ops' },
    { id: 'help_faq_8', title: 'Store hours and holiday closures', category: 'settings', body: 'Set open hours under Store settings. Schedule closures in advance so orders are not accepted while you are closed.', deepLink: '/store' },
  ]);

  // ---- deepLink on seeded notifications (NOTIFICATIONS.md — Notification
  // payload carries the target screen path; taps route there). ----
  db.table<{ id: string; deepLink?: string | null }>('notifications').update('m3', { deepLink: '/orders/o_seed_0' });
  db.table<{ id: string; deepLink?: string | null }>('notifications').update('m4', { deepLink: '/orders/o_seed_8' });

  // ---- P8c: scheduled reports + CRM journeys + data exports (contract
  // /reports, /journeys, /data/exports, /privacy/export) ----
  const p8cNow = Date.now();
  db.table<{ id: string; merchantId: string; name: string; reportType: string; cadence: string; format: string; recipients: string[]; filters?: Record<string, unknown>; storeIds: string[]; enabled: boolean; lastRunAt: string | null }>('reports').insertMany([
    {
      id: 'rep_seed_1',
      merchantId,
      name: 'Daily revenue summary',
      reportType: 'revenue',
      cadence: 'daily',
      format: 'csv',
      recipients: ['owner@skewer-house.co.tz'],
      filters: { channels: ['delivery', 'pickup'] },
      storeIds: ['s_demo', 's_demo_2'],
      enabled: true,
      lastRunAt: new Date(p8cNow - 86400000).toISOString(),
    },
    {
      id: 'rep_seed_2',
      merchantId,
      name: 'Weekly orders digest',
      reportType: 'orders',
      cadence: 'weekly',
      format: 'pdf',
      recipients: ['finance@skewer-house.co.tz'],
      storeIds: ['s_demo'],
      enabled: false,
      lastRunAt: null,
    },
  ]);

  db.table<{ id: string; merchantId: string; name: string; trigger: string; actions: { type: string; delayHours: number; template?: string }[]; status: string; createdAt: number }>('journeys').insert({
    id: 'jrn_seed_1',
    merchantId,
    name: 'First order welcome',
    trigger: 'order.completed',
    actions: [
      { type: 'coupon', delayHours: 24, template: 'Welcome back — TZS 5,000 off your next order' },
      { type: 'push', delayHours: 72, template: 'Your skewers miss you' },
    ],
    status: 'active',
    createdAt: p8cNow - 7 * 86400000,
  });

  db.table<{ id: string; merchantId: string; scope: string; format: string; status: string; downloadUrl: string | null; expiresInSeconds: number | null; createdAt: number; completedAt: number | null }>('dataExports').insert({
    id: 'dex_seed_1',
    merchantId,
    scope: 'orders',
    format: 'csv',
    status: 'ready',
    downloadUrl: 'data:application/csv;charset=utf-8,order-id,status,total',
    expiresInSeconds: 900,
    createdAt: p8cNow - 3600000,
    completedAt: p8cNow - 3590000,
  });

  // ---- P1: merchant settings + payout account (contract /merchants/me/settings,
  // /merchants/me/payout-account). Rows keyed by merchantId; handlers upsert. ----
  const p1Day = (dow: number, open: string, close: string) => ({ dayOfWeek: dow, open, close, closed: false });
  db.table<MerchantSettingsRow>('merchantSettings').insert({
    id: 'ms_seed_1',
    merchantId,
    settings: {
      businessHours: [0, 1, 2, 3, 4, 5, 6].map((dow) => p1Day(dow, '16:30', '02:00')),
      acceptanceMethod: 'manual',
      announcement: 'Summer night BBQ every Friday — family platters 15% off',
      coverImageUrl: null,
      isOpen: true,
      phoneOrderingHours: { enabled: true, open: '08:00', close: '20:00' },
      orderNotificationChannels: ['push', 'in_app'],
      acceptedPaymentMethods: ['mpesa', 'airtel_money', 'cod'],
      specialRules: 'Priority to dine-in walk-ins during peak hours.',
      printSettings: { autoPrint: true, copies: 1, labelPrinter: false },
      deliverySettings: { radiusKm: 4, deliveryFeeTZS: 3000, minimumOrderTZS: 30000, sameDayCutoff: '20:00' },
    },
    updatedAt: Date.now(),
  });
  db.table<MerchantPayoutAccountRow>('merchantPayoutAccounts').insert({
    id: 'mpa_seed_1',
    merchantId,
    type: 'mobile_money',
    provider: 'mpesa',
    accountMasked: '****1234',
    accountHolderName: DEMO_MERCHANT.owner,
    verified: true,
    updatedAt: new Date(Date.now() - 30 * 86400000).toISOString(),
  });

  // ---- P6b/P6d: store settings, QR codes, reservations, loyalty ledger,
  // print jobs (contract /store/*, /reservations/*, /loyalty-transactions,
  // /memberships/me, /print-jobs). Rows keyed by storeId where the endpoint
  // is store-scoped; contract rows carry the app-side extension keys. ----
  const p6Now = Date.now();
  const p6Day = 86400000;

  db.table<KitchenCamera & { id: string; storeId: string }>('kitchenCameras').insert({
    id: 'kc_seed_1',
    storeId,
    enabled: false,
    streamUrl: 'rtsp://camera-kitchen.example.com/skewer-house',
    publicAccess: false,
    recordingDurationMinutes: 30,
    storageUsedGb: 2.4,
    storageCapacityGb: 10,
    videoQuality: 'hd',
    lastCheckedAt: p6Now - 3600000,
  });

  db.table<Qualification & { storeId: string }>('qualifications').insert({
    id: 'q_seed_1',
    storeId,
    type: 'business_license',
    url: 'https://files.example.com/business-license-2026.pdf',
    status: 'approved',
    expiryDate: '2027-06-30',
    createdAt: p6Now - 200 * p6Day,
  });

  db.table<SelfPickupConfig & { id: string; storeId: string }>('selfPickup').insert({
    id: 'sp_seed_1',
    storeId,
    enabled: true,
    pickupReadyMinutes: 15,
    pickupHours: { open: '08:00', close: '21:00' },
  });

  db.table<StoreQrCode & { storeId: string }>('storeQrCodes').insertMany([
    {
      id: 'sq_seed_1',
      storeId,
      kind: 'ordering',
      qrPayload: 'https://hudumika.app/qr/order-s-demo',
      createdBy: 's1',
      createdAt: p6Now - 10 * p6Day,
    },
    {
      id: 'sq_seed_2',
      storeId,
      kind: 'collection',
      qrPayload: 'https://hudumika.app/qr/collect-s-demo',
      createdBy: 's2',
      createdAt: p6Now - 2 * p6Day,
    },
  ]);

  const seededTables = db.table<TableRow>('tables').where((t) => t.storeId === storeId);
  db.table<Reservation & { storeId: string }>('reservations').insert({
    id: 'rsv_seed_1',
    merchantId,
    storeId,
    tableId: seededTables[1]?.id ?? null,
    partySize: 4,
    scheduledFor: p6Now + 5 * 3600000,
    status: 'pending',
    note: 'Window table if possible',
    createdAt: p6Now - 3600000,
  });

  db.table<LoyaltyTransaction & { merchantId: string }>('loyaltyPointsLedger').insertMany([
    {
      id: 'lpl_seed_1',
      merchantId,
      type: 'earn',
      points: 120,
      balance: 120,
      reference: 'ORDER-MT88001',
      at: p6Now - 3 * p6Day,
    },
    {
      id: 'lpl_seed_2',
      merchantId,
      type: 'redeem',
      points: -50,
      balance: 70,
      reference: 'VOUCHER-50K',
      at: p6Now - p6Day,
    },
  ]);

  db.table<PrintJob & { merchantId: string }>('printJobs').insert({
    id: 'pj_seed_1',
    merchantId,
    jobType: 'receipt',
    orderIds: ['o_seed_0'],
    tableId: null,
    deviceId: null,
    copies: 1,
    label: 'Counter thermal · seed',
    status: 'done',
    error: null,
    createdAt: p6Now - 2 * p6Day,
    completedAt: p6Now - 2 * p6Day + 120000,
  });

  return { merchantId, storeId };
}