import { RIDERS } from '@/lib/format';
import type {
  AppMessage,
  Campaign,
  Category,
  ChatThread,
  CouponRecord,
  Order,
  PlatformCampaign,
  Product,
  Review,
  SegmentStats,
  Staff,
  Task,
  Transaction,
} from '@/types';

export const COMMISSION_RATE = 0.06;

export const CATEGORIES: Category[] = [
  { id: 'c1', name: 'Best Sellers', visible: true, sort: 0 },
  { id: 'c2', name: 'Signature Skewers', visible: true, sort: 1 },
  { id: 'c3', name: 'Veggie Skewers', visible: true, sort: 2 },
  { id: 'c4', name: 'Staple & Sides', visible: true, sort: 3 },
  { id: 'c5', name: 'Drinks', visible: true, sort: 4 },
];

let p = 0;
const P = (
  categoryId: string,
  name: string,
  emoji: string,
  price: number,
  sold: number,
  description: string,
  stock = 99,
  variants: { name: string; price: number }[] = [],
): Product => {
  p += 1;
  return {
    id: `p${p}`,
    categoryId,
    name,
    emoji,
    price,
    sold,
    description,
    stock,
    visible: true,
    variants: variants.map((v, i) => ({ id: `v${p}_${i}`, ...v })),
  };
};

export const PRODUCTS: Product[] = [
  P('c1', 'Signature Lamb Skewer', '🍢', 12, 1286, 'Inner-Mongolia lamb, secret cumin marinade, charred crisp', 200),
  P('c1', 'Grilled Chicken Wings', '🍗', 15, 986, 'Crisp skin, juicy bite, house glaze', 150, [
    { name: 'Mild spice', price: 0 },
    { name: 'Extra hot', price: 2 },
  ]),
  P('c1', 'Char-Grilled Kidney', '🔥', 18, 742, 'De-odorized, seared over open fire', 80),
  P('c1', 'Grilled Oysters (x6)', '🦪', 36, 512, 'Garlic vermicelli, fresh from Zhanjiang', 60),
  P('c2', 'Cumin Beef Skewer', '🥩', 14, 890, 'Grain-fed beef, cut and skewered fresh daily', 180),
  P('c2', 'Spicy Pork Belly', '🍖', 11, 764, 'Fat and lean, sizzling on the grill', 220),
  P('c2', 'Garlic Pork Ribs', '🦴', 22, 438, 'Marinated 8 hours in garlic', 70),
  P('c2', 'Grilled Intestine', '🌭', 16, 355, 'Braised, then grilled — soft and chewy', 55),
  P('c2', 'Honey Chicken Skin', '🐔', 9, 287, 'Sweet-savory and shatteringly crisp', 120),
  P('c3', 'Grilled Eggplant', '🍆', 10, 655, 'Whole over charcoal, loaded with garlic', 130),
  P('c3', 'Grilled Chives', '🌿', 8, 588, 'Fresh chives with secret sauce', 160),
  P('c3', 'Enoki Bacon Roll', '🥓', 12, 421, 'Crispy bacon, tender enoki', 90),
  P('c3', 'Grilled Corn', '🌽', 9, 377, 'Sweet corn, butter-glazed', 140),
  P('c3', 'Grilled Gluten Skewer', '🍥', 7, 266, 'Chewy and springy', 200),
  P('c4', 'Egg-Fried Rice', '🍚', 16, 421, 'Wok-fired, grain for grain', 99),
  P('c4', 'Grilled Cold Noodles', '🫓', 15, 388, 'Northeast style, sweet-sour sauce', 99),
  P('c4', 'Foil-Pack Clam Noodles', '🍜', 22, 312, 'Steamed in foil, spicy and fresh', 80, [
    { name: 'No spice', price: 0 },
    { name: 'Mild', price: 0 },
    { name: 'Medium', price: 1 },
  ]),
  P('c4', 'Handmade Flatbread', '🫓', 8, 245, 'Baked crisp to order', 120),
  P('c5', 'Tsingtao Lager', '🍺', 10, 566, 'Ice cold, 500ml', 200),
  P('c5', 'Arctic Ocean Soda', '🥤', 6, 434, 'Classic orange, glass bottle', 150),
  P('c5', 'Sour Plum Drink', '🧋', 8, 342, 'Slow-brewed, house recipe', 100),
  P('c5', 'Herbal Iced Tea', '🧃', 6, 298, 'Canned cooling tea', 180),
];

const now = Date.now();
const MIN = 60000;
const HOUR = 3600000;

export const CUSTOMERS = [
  { name: 'David Zhang', phone: '138****2210', address: 'Wangjing SOHO Tower 1, Floor 12' },
  { name: 'Lily Li', phone: '159****8843', address: '6 Fudong East Street, Wangjing' },
  { name: 'Kevin Wang', phone: '186****5329', address: '27 Zhongguancun Ave, Haidian' },
  { name: 'Mia Zhao', phone: '137****9076', address: 'Wangjing West 4th District' },
  { name: 'Leo Liu', phone: '158****3345', address: '138 Wangfujing St, Dongcheng' },
  { name: 'Emma Chen', phone: '139****6721', address: '10 Jiuxianqiao Rd' },
  { name: 'Frank Yang', phone: '187****1198', address: 'Huaqing Jiayuan, Wudaokou' },
  { name: 'Ray Zhou', phone: '135****2874', address: '50 Sun Palace, Taiyanggong' },
];

function pick<T>(arr: T[], n: number): T[] {
  const copy = [...arr];
  const out: T[] = [];
  for (let i = 0; i < n; i++) {
    const idx = Math.floor(Math.random() * copy.length);
    out.push(copy.splice(idx, 1)[0]);
  }
  return out;
}

function seedOrder(idx: number, agoMin: number, status: Order['status'], opts: Partial<Order> = {}): Order {
  const itemCount = 1 + (idx % 4);
  const items = pick(PRODUCTS, itemCount).map((prod) => {
    const qty = 1 + (idx % 3);
    const variant = prod.variants.length
      ? prod.variants[Math.floor(Math.random() * prod.variants.length)]
      : null;
    return {
      productId: prod.id,
      name: prod.name,
      emoji: prod.emoji,
      qty,
      price: variant ? prod.price + variant.price : prod.price,
      variants: variant ? [variant.name] : [],
    };
  });
  const subtotal = items.reduce((s, i) => s + i.price * i.qty, 0);
  const isPickup = status === 'new' && idx % 2 === 1;
  const deliveryFee = isPickup ? 0 : 3 + (idx % 3);
  const customer = CUSTOMERS[idx % CUSTOMERS.length];
  const createdAt = now - (agoMin + Math.floor(Math.random() * 12)) * MIN;
  const statusAt = (m: number) => createdAt + m * MIN;
  return {
    id: `o_seed_${idx}`,
    no: `MT${String(88000 + idx)}`,
    status,
    items,
    customer,
    note: idx % 3 === 0 ? 'No cilantro, extra spicy please' : '',
    deliveryType: isPickup ? 'pickup' : 'delivery',
    subtotal,
    deliveryFee,
    total: subtotal + deliveryFee,
    createdAt,
    deadlineAt: createdAt + 5 * MIN,
    acceptedAt: status === 'new' ? undefined : statusAt(1),
    readyAt: status === 'ready' || status === 'completed' ? statusAt(14) : undefined,
    completedAt: status === 'completed' ? statusAt(42) : undefined,
    cancelledAt: status === 'cancelled' ? statusAt(2) : undefined,
    cancelReason: status === 'cancelled' ? 'Store closing soon' : undefined,
    rider: status === 'ready' || status === 'completed' ? RIDERS[0] : undefined,
    seen: true,
    rating: status === 'completed' ? 4 + (idx % 2) : undefined,
    ...opts,
  };
}

export const SEED_ORDERS: Order[] = [
  seedOrder(0, 2, 'new', { rushAt: now - 1 * MIN, rushReplied: false, deadlineAt: now + 4 * MIN }),
  seedOrder(1, 6, 'new'),
  seedOrder(2, 11, 'new'),
  seedOrder(3, 18, 'preparing'),
  seedOrder(4, 26, 'preparing'),
  seedOrder(5, 35, 'ready'),
  seedOrder(6, 55, 'completed'),
  seedOrder(7, 70, 'completed'),
  seedOrder(8, 84, 'completed', { refund: { ts: now - 40 * MIN, reason: 'Missing side dish', amount: 6, status: 'requested' } }),
  seedOrder(9, 96, 'cancelled'),
  seedOrder(10, 130, 'completed'),
  seedOrder(11, 160, 'completed', { refund: { ts: now - 90 * MIN, reason: 'Delivered late', amount: 12, status: 'approved' } }),
  seedOrder(12, 200, 'completed'),
  seedOrder(13, 260, 'cancelled'),
  seedOrder(14, 320, 'completed'),
  seedOrder(15, 400, 'completed'),
  seedOrder(16, 520, 'completed'),
  seedOrder(17, 680, 'completed'),
  seedOrder(18, 900, 'completed'),
  seedOrder(19, 5, 'new', { scheduledAt: now + 38 * MIN, note: 'Pre-order · pickup at lunch rush', deadlineAt: now + 38 * MIN }),
  seedOrder(20, 210, 'completed', { rating: 2, note: 'Cold fries, waited 40 min' }),
];

export const SEED_CAMPAIGNS: Campaign[] = [
  {
    id: 'cp1',
    type: 'flash',
    status: 'active',
    title: 'Flash Sale · Lamb Skewers 50% Off',
    budget: 500,
    spent: 316,
    start: now - 2 * HOUR,
    end: now + 20 * HOUR,
    discountRate: 0.5,
    target: 'All nearby customers',
    productIds: ['p1'],
    createdAt: now - 3 * HOUR,
  },
  {
    id: 'cp2',
    type: 'coupon',
    status: 'scheduled',
    title: 'TZS 20 Off Orders Over TZS 60',
    budget: 300,
    spent: 0,
    start: now + 26 * HOUR,
    end: now + 96 * HOUR,
    couponAmount: 20,
    target: 'New customers within 3 km',
    productIds: ['p1', 'p2', 'p3'],
    createdAt: now - 1 * HOUR,
  },
  {
    id: 'cp3',
    type: 'ads',
    status: 'expired',
    title: 'Search Ads · BBQ Category',
    budget: 200,
    spent: 200,
    start: now - 5 * 24 * HOUR,
    end: now - 2 * 24 * HOUR,
    target: 'Users searching "BBQ"',
    productIds: [],
    createdAt: now - 6 * 24 * HOUR,
  } as unknown as Campaign,
  {
    id: 'cp4',
    type: 'full_reduction',
    status: 'active',
    title: 'Full Reduction · TZS 12 Off TZS 80+',
    budget: 400,
    spent: 132,
    start: now - 20 * HOUR,
    end: now + 28 * HOUR,
    couponAmount: 12,
    threshold: 80,
    target: 'All nearby customers',
    productIds: [],
    createdAt: now - 21 * HOUR,
  },
  {
    id: 'cp5',
    type: 'new_customer',
    status: 'scheduled',
    title: 'First Order · 30% Off Cap TZS 15',
    budget: 250,
    spent: 0,
    start: now + 3 * HOUR,
    end: now + 75 * HOUR,
    discountRate: 0.7,
    couponAmount: 15,
    target: 'New customers within 3 km',
    productIds: [],
    createdAt: now - 30 * MIN,
  },
  {
    id: 'cp6',
    type: 'free_delivery',
    status: 'active',
    title: 'Free Delivery · Orders Over TZS 35',
    budget: 150,
    spent: 48,
    start: now - 12 * HOUR,
    end: now + 12 * HOUR,
    threshold: 35,
    target: 'All nearby customers',
    productIds: [],
    createdAt: now - 13 * HOUR,
  },
];

export const SEED_PLATFORM_CAMPAIGNS: PlatformCampaign[] = [
  {
    id: 'pc1',
    title: 'Summer Night BBQ Festival',
    date: 'Aug 14 – Aug 16',
    perks: 'Banner placement on home feed · estimated 30k+ views',
    traffic: '~9,600 extra visitors',
    requirement: 'Offer at least 1 item under TZS 20 and keep 4.6+ rating',
    status: 'open',
  },
  {
    id: 'pc2',
    title: 'Mid-Autumn Family Set Meal',
    date: 'Sep 11 – Sep 13',
    perks: 'Category channel push · coupon co-funding (50/50)',
    traffic: '~14,000 extra visitors',
    requirement: 'Add a 2–4 person set meal under TZS 120',
    status: 'open',
  },
  {
    id: 'pc3',
    title: 'Breakfast Rush Promotion',
    date: 'Aug 1 – Aug 7',
    perks: 'Top-3 ranking in breakfast search for 7 days',
    traffic: '~22,400 extra visitors',
    requirement: 'Keep 4.8+ rating and 95%+ acceptance',
    status: 'signed',
  },
  {
    id: 'pc4',
    title: 'Spring Restaurant Week',
    date: 'Apr 20 – Apr 26',
    perks: 'Feed recommendation boost',
    traffic: '~18,000 extra visitors',
    requirement: 'None',
    status: 'closed',
  },
];

export const SEED_TASKS: Task[] = [
  {
    id: 't1',
    title: 'Stock out risk: Beef Skewers',
    sub: 'Sold 86% of 7-day forecast · top 3 bestseller',
    priority: 'high',
    done: false,
    action: 'open-product',
  },
  {
    id: 't2',
    title: 'Join “Summer Night BBQ Festival”',
    sub: 'Platform traffic bonus ends Aug 16 · 1 slot left in your area',
    priority: 'high',
    done: false,
    action: 'open-campaign',
  },
  {
    id: 't3',
    title: 'Reply to 1-star review from Ray Zhou',
    sub: 'Unreplied reviews hurt conversion · reply within 24h',
    priority: 'high',
    done: false,
    action: 'open-review',
  },
  {
    id: 't4',
    title: 'Optimize peak-hour prep capacity',
    sub: '17:00–19:00 orders are +23% vs last week',
    priority: 'medium',
    done: false,
    action: 'open-settings',
  },
  {
    id: 't5',
    title: 'Set up auto-accept to cut order loss',
    sub: 'Orders auto-cancel when unaccepted for 5 min',
    priority: 'medium',
    done: false,
    action: 'open-orders',
  },
  {
    id: 't6',
    title: 'New follower milestone',
    sub: 'Store followers hit 2,400 last week · +180 new',
    priority: 'low',
    done: true,
  },
];

export const SEED_CHATS: ChatThread[] = [
  {
    id: 'ch1',
    customerName: 'Emily Wang',
    customerInitial: 'E',
    lastMessage: 'Can I swap the side to cucumber salad?',
    lastTs: now - 4 * MIN,
    unread: 1,
    context: 'Order MT88004 · In prep · Delivery to 12 Huayuan Rd',
    messages: [
      { id: 'm1', from: 'customer', text: 'Hi! I just placed order MT88004 🍢', ts: now - 12 * MIN },
      { id: 'm2', from: 'customer', text: 'Can I swap the side to cucumber salad?', ts: now - 4 * MIN },
    ],
  },
  {
    id: 'ch2',
    customerName: 'David Liu',
    customerInitial: 'D',
    lastMessage: 'Thanks, got it!',
    lastTs: now - 40 * MIN,
    unread: 0,
    context: 'Order MT87997 · Completed · Follow-up',
    messages: [
      { id: 'm1', from: 'customer', text: 'Can you add extra napkins to my order?', ts: now - 46 * MIN },
      { id: 'm2', from: 'merchant', text: 'Of course! Added to the bag for the rider. Anything else?', ts: now - 44 * MIN },
      { id: 'm3', from: 'customer', text: 'Thanks, got it!', ts: now - 40 * MIN },
    ],
  },
  {
    id: 'ch3',
    customerName: 'New customer · 7 min ago',
    customerInitial: 'N',
    lastMessage: 'Is the store open for pickup right now?',
    lastTs: now - 2 * 60 * MIN,
    unread: 0,
    context: 'Pre-order inquiry',
    messages: [
      { id: 'm1', from: 'customer', text: 'Hi, is the store open for pickup right now?', ts: now - 2 * 60 * MIN },
      { id: 'm2', from: 'merchant', text: 'Yes! 10:00–22:30 daily. Pickup is ready in ~15 min.', ts: now - 118 * MIN },
    ],
  },
];

export const SEED_TRANSACTIONS: Transaction[] = [
  { id: 't1', type: 'commission', amount: -32.4, title: 'Platform commission 6%', ts: now - 55 * MIN, status: 'completed' },
  { id: 't2', type: 'order', amount: 508, title: 'Order settlement', ts: now - 55 * MIN, status: 'completed' },
  { id: 't3', type: 'order', amount: 386, title: 'Order settlement', ts: now - 96 * MIN, status: 'completed' },
  { id: 't4', type: 'order', amount: 274.5, title: 'Order settlement', ts: now - 130 * MIN, status: 'completed' },
  { id: 't5', type: 'refund', amount: -42, title: 'Refund (customer cancelled)', ts: now - 200 * MIN, status: 'completed' },
  { id: 't6', type: 'withdraw', amount: -5000, title: 'Withdraw to CMB ····8612', ts: now - 22 * HOUR, status: 'completed' },
  { id: 't7', type: 'order', amount: 612, title: 'Order settlement', ts: now - 24 * HOUR, status: 'pending' },
  { id: 't8', type: 'order', amount: 458, title: 'Order settlement', ts: now - 30 * HOUR, status: 'pending' },
];

export const SEED_REVIEWS: Review[] = [
  { id: 'r1', orderNo: 'MT88096', customer: '****2210', rating: 5, content: 'Lamb skewers are incredibly fresh with real charcoal flavor. Fast delivery — will order again!', ts: now - 2 * HOUR },
  { id: 'r2', orderNo: 'MT88090', customer: '****8876', rating: 4, content: 'Chicken wings were great, slightly spicier than expected. Will add a note next time.', ts: now - 5 * HOUR },
  { id: 'r3', orderNo: 'MT88083', customer: '****3345', rating: 2, content: 'Almost an hour wait and the grilled eggplant arrived cold. Not a great experience.', ts: now - 9 * HOUR },
  { id: 'r4', orderNo: 'MT88075', customer: '****8321', rating: 5, content: 'The cold noodles are delicious and the clam noodles portion is generous!', ts: now - 20 * HOUR, reply: 'Thanks for the support — see you next time!', repliedAt: now - 19 * HOUR },
  { id: 'r5', orderNo: 'MT88069', customer: '****9980', rating: 1, content: 'One chive skewer was missing and the merchant was slow to respond.', ts: now - 26 * HOUR },
  { id: 'r6', orderNo: 'MT88060', customer: '****7754', rating: 5, content: 'Really careful packaging, and they honored the “no cilantro” note perfectly. Five stars!', ts: now - 31 * HOUR },
  { id: 'r7', orderNo: 'MT88052', customer: '****4463', rating: 4, content: 'Oysters were a good size and the garlic sauce was fragrant.', ts: now - 44 * HOUR },
  { id: 'r8', orderNo: 'MT88045', customer: '****1298', rating: 3, content: 'Decent overall, but slightly overpriced for the portion.', ts: now - 50 * HOUR },
];

export const SEED_STAFF: Staff[] = [
  { id: 's1', name: 'Alex Liu', role: 'owner', phone: '138****0001', permissions: ['Full access'] },
  { id: 's2', name: 'Mia', role: 'manager', phone: '186****2211', permissions: ['Orders', 'Menu', 'Coupons'] },
  { id: 's3', name: 'Kai', role: 'staff', phone: '135****3322', permissions: ['Orders', 'Coupons'] },
];

export const SEED_MESSAGES: AppMessage[] = [
  {
    id: 'm1',
    type: 'review',
    title: 'New review alert',
    body: 'A customer left a 4-star review on order MT88090 — take a look.',
    ts: now - 5 * HOUR,
    read: false,
  },
  {
    id: 'm2',
    type: 'system',
    title: 'Platform notice',
    body: 'This Saturday night is a BBQ peak window. Stock up early and enable rush-hour alerts.',
    ts: now - 10 * HOUR,
    read: false,
  },
  {
    id: 'm3',
    type: 'order',
    title: 'New order notification',
    body: 'You have a new order waiting to be accepted.',
    ts: now - 11 * MIN,
    read: false,
    orderId: 'o_seed_0',
  },
  {
    id: 'm4',
    type: 'order',
    title: 'Refund request · MT88008',
    body: 'Customer requests a refund for TZS 6 · “Missing side dish”',
    ts: now - 38 * MIN,
    read: false,
    orderId: 'o_seed_8',
  },
];

export const SEED_COUPON_RECORDS: CouponRecord[] = [
  { id: 'cr1', code: 'MJ8K2F9Q', amount: 15, ts: now - 3 * HOUR, status: 'used' },
  { id: 'cr2', code: '7XW3P4MD', amount: 20, ts: now - 26 * HOUR, status: 'used' },
  { id: 'cr3', code: '9ZQ1R5VT', amount: 10, ts: now - 48 * HOUR, status: 'expired' },
];

export const VALID_COUPON_CODES: string[] = ['MT6666', 'YQ888', 'BBQ2026', '5KM20'];

export const TRAFFIC_SOURCES = [
  { name: 'Search', value: 42, color: '#1a5c44' },
  { name: 'Homepage feed', value: 28, color: '#1B7CFF' },
  { name: 'Deals page', value: 18, color: '#059669' },
  { name: 'Other', value: 12, color: '#959CA8' },
];

export function dailyStats(orders: Order[], days = 7) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const out: { label: string; revenue: number; orders: number }[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const from = start.getTime() - i * 24 * 3600000;
    const to = from + 24 * 3600000;
    const dayOrders = orders.filter((o) => o.createdAt >= from && o.createdAt < to);
    out.push({
      label: `${start.getMonth() + 1}/${start.getDate()}`,
      revenue: dayOrders.filter((o) => o.status === 'completed').reduce((s, o) => s + o.subtotal, 0),
      orders: dayOrders.length,
    });
  }
  return out;
}

export function weekdayRevenueProfile(orders: Order[]) {
  const days: { label: string; revenue: number; orders: number }[] = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now - i * 24 * HOUR);
    const startOf = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const endOf = startOf + 24 * HOUR;
    const list = orders.filter((o) => o.createdAt >= startOf && o.createdAt < endOf && o.status === 'completed');
    days.push({
      label: i === 0 ? 'Today' : ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()],
      revenue: list.reduce((s, o) => s + o.total, 0),
      orders: list.length,
    });
  }
  return days;
}

export function hourlyOrders(orders: Order[]) {
  const buckets: { label: string; value: number }[] = [];
  for (let h = 0; h < 24; h++) {
    const list = orders.filter((o) => {
      const d = new Date(o.createdAt);
      return d.getHours() === h && o.status === 'completed';
    });
    buckets.push({ label: `${h}:00`, value: Math.round(list.reduce((s, o) => s + o.total, 0)) });
  }
  return buckets;
}
export const TRAFFIC_SERVICE_MARKETING = {
  reach: 38400,
  reachDelta: 0.16,
  engagement: 148,
  engagementDelta: 0.09,
  ctr: 0.042,
  ctrDelta: 0.006,
  topKeywords: [
    { keyword: 'lamb skewer', ctr: 0.087, rank: 2 },
    { keyword: 'bbq platter', ctr: 0.071, rank: 3 },
    { keyword: 'grilled corn', ctr: 0.055, rank: 5 },
  ],
  keywordHistory: [
    { label: 'Tue', value: 0.028 },
    { label: 'Wed', value: 0.031 },
    { label: 'Thu', value: 0.029 },
    { label: 'Fri', value: 0.038 },
    { label: 'Sat', value: 0.046 },
    { label: 'Sun', value: 0.044 },
    { label: 'Mon', value: 0.042 },
  ],
};

export const SEED_CUSTOMER_SEGMENTS: SegmentStats[] = [
  { segment: 'new', label: 'New', count: 42, avgSpend: 28.5, lastOrderDaysAgo: 1, color: '#FF7A45' },
  { segment: 'returning', label: 'Returning', count: 87, avgSpend: 41.2, lastOrderDaysAgo: 3, color: '#7B61FF' },
  { segment: 'vip', label: 'VIP · 5+ orders', count: 23, avgSpend: 62.8, lastOrderDaysAgo: 2, color: '#FFB800' },
  { segment: 'lapsed', label: 'Lapsed 30d+', count: 156, avgSpend: 34.0, lastOrderDaysAgo: 40, color: '#8C9AA8' },
];
