import {
  UtensilsCrossed,
  ShoppingBag,
  Pill,
  Flower2,
  Wrench,
  Shirt,
  Home,
  Sparkles,
  Truck,
  Bus,
  PartyPopper,
  Plane,
  Dog,
  type LucideIcon,
} from 'lucide-react'

/* ── Image manifest (Pexels CDN, validated URLs) ───────────────── */
const px = (id: number, w = 800, h = 600) =>
  `https://images.pexels.com/photos/${id}/pexels-photo-${id}.jpeg?auto=compress&cs=tinysrgb&fit=crop&w=${w}&h=${h}`
const us = (id: string, w = 800, h = 600) =>
  `https://images.unsplash.com/${id}?auto=format&fit=crop&w=${w}&h=${h}&q=82`

export const IMG = {
  heroHome: px(2474661, 1200, 1400),
  heroFood: px(2474661),
  heroChoma: px(2474661),
  heroRider: us('photo-1558981806-ec527fa84c39', 1600, 900),
  riderPortrait: us('photo-1558981806-ec527fa84c39', 900, 700),
  riderAvatar: px(614810, 160, 160),
  merchant: px(2474661, 900, 700),
  provider: us('photo-1621905252507-b35492cc74b4', 900, 700),
  market: px(264537),
  pharmacy: px(3683070),
  flowers: px(931147),
  salon: px(3993449),
  nails: px(907489),
  spa: px(3822187),
  construction: px(8961201),
  repair: px(2582937),
  laundry: us('photo-1517677208171-0bc6725a3e60'),
  washing: us('photo-1517677208171-0bc6725a3e60'),
  education: px(5212698),
  concert: px(1190298),
  wellness: px(7526024),
  electronics: px(2582937),
  team: px(3184296),
  support: px(3184465),
  retail: us('photo-1523275335684-37898b6baf30'),
  travel: px(457882),
  plumbing: us('photo-1607472586893-edb57bdc0e39'),
  electrical: us('photo-1621905252507-b35492cc74b4'),
  cleaning: us('photo-1581578731548-c64695cc6952'),
  painting: us('photo-1562259949-e8e7689d7828'),
  carpentry: px(8961201),
  moving: us('photo-1600518464441-9154a4dea21b'),
  electrician2: us('photo-1621905252507-b35492cc74b4'),
  laundry2: us('photo-1517677208171-0bc6725a3e60'),
}

/* ── Services taxonomy ─────────────────────────────────────────── */
export type ServiceGroup = {
  id: string
  label: string
  tagline: string
  description: string
  image: string
  cta: string
  kind: 'order' | 'book'
}

export const SERVICE_GROUPS: ServiceGroup[] = [
  {
    id: 'food',
    label: 'Food & Restaurants',
    tagline: 'Meals in 25 min',
    description: 'From pilau to pizza — 2,000+ local restaurants, delivered hot.',
    image: IMG.heroFood,
    cta: 'Order food',
    kind: 'order',
  },
  {
    id: 'home',
    label: 'Home Services',
    tagline: 'Book in minutes',
    description: 'Plumbers, electricians, cleaners and repair pros — verified and rated.',
    image: IMG.plumbing,
    cta: 'Book a pro',
    kind: 'book',
  },
  {
    id: 'groceries',
    label: 'Groceries & Market',
    tagline: 'Fresh daily',
    description: 'Produce, essentials and household goods from trusted local shops.',
    image: IMG.market,
    cta: 'Shop groceries',
    kind: 'order',
  },
  {
    id: 'pharmacy',
    label: 'Pharmacy & Wellness',
    tagline: '24/7 delivery',
    description: 'Medicine, vitamins and health essentials delivered discreetly.',
    image: IMG.pharmacy,
    cta: 'Get medicine',
    kind: 'order',
  },
  {
    id: 'beauty',
    label: 'Beauty & Care',
    tagline: 'Salons at home',
    description: 'Hair, nails, spa and grooming — at home or in-salon appointments.',
    image: IMG.salon,
    cta: 'Book beauty',
    kind: 'book',
  },
  {
    id: 'laundry',
    label: 'Laundry & Cleaning',
    tagline: 'Pickup & drop',
    description: 'Wash, dry and fold — we collect, clean and return it fresh.',
    image: IMG.laundry,
    cta: 'Book laundry',
    kind: 'book',
  },
  {
    id: 'repairs',
    label: 'Repairs & Maintenance',
    tagline: 'Fix it today',
    description: 'Electronics, appliance and general repairs by certified technicians.',
    image: IMG.repair,
    cta: 'Book a repair',
    kind: 'book',
  },
  {
    id: 'logistics',
    label: 'Moving & Logistics',
    tagline: 'Door to door',
    description: 'Same-day delivery, moving help and parcel services across the city.',
    image: IMG.moving,
    cta: 'Book moving',
    kind: 'book',
  },
  {
    id: 'transport',
    label: 'Rides & Transport',
    tagline: 'Boda on demand',
    description: 'Fast, safe boda and car rides with tracked trips and fixed fares.',
    image: IMG.heroRider,
    cta: 'Book a ride',
    kind: 'book',
  },
  {
    id: 'events',
    label: 'Events & Catering',
    tagline: 'Celebrate easy',
    description: 'Catering, decor and event services for weddings and gatherings.',
    image: IMG.concert,
    cta: 'Plan an event',
    kind: 'book',
  },
  {
    id: 'shopping',
    label: 'Shopping & Retail',
    tagline: 'Delivered home',
    description: 'Fashion, electronics and household goods from city retailers.',
    image: IMG.retail,
    cta: 'Shop retail',
    kind: 'order',
  },
  {
    id: 'travel',
    label: 'Travel & Stays',
    tagline: 'City to coast',
    description: 'Hotels, lodges and transport packages across Tanzania.',
    image: IMG.travel,
    cta: 'Explore stays',
    kind: 'book',
  },
]

export const SERVICE_ICONS: Record<string, LucideIcon> = {
  food: UtensilsCrossed,
  home: Home,
  groceries: ShoppingBag,
  pharmacy: Pill,
  beauty: Sparkles,
  laundry: Shirt,
  repairs: Wrench,
  logistics: Truck,
  transport: Bus,
  events: PartyPopper,
  shopping: ShoppingBag,
  travel: Plane,
}

/* ── Home services subcategories ───────────────────────────────── */
export type HomeService = {
  id: string
  label: string
  description: string
  image: string
  rating: number
  price: string
  available: string
}

export const HOME_SERVICES: HomeService[] = [
  { id: 'plumbing', label: 'Plumbing', description: 'Leaks, pipes, toilets & installations', image: IMG.plumbing, rating: 4.8, price: 'From TZS 15,000', available: 'Today' },
  { id: 'electrical', label: 'Electrical', description: 'Wiring, sockets, lights & safety checks', image: IMG.electrical, rating: 4.9, price: 'From TZS 20,000', available: 'Today' },
  { id: 'cleaning', label: 'Home Cleaning', description: 'Deep cleans, move-out & office cleaning', image: IMG.cleaning, rating: 4.7, price: 'From TZS 25,000', available: 'Tomorrow' },
  { id: 'appliance', label: 'Appliance Repair', description: 'Fridges, ACs, washing machines & more', image: IMG.electrician2, rating: 4.8, price: 'From TZS 18,000', available: 'Today' },
  { id: 'painting', label: 'Painting & Decor', description: 'Interior & exterior painting, touch-ups', image: IMG.painting, rating: 4.6, price: 'From TZS 40,000', available: 'This week' },
  { id: 'carpentry', label: 'Carpentry', description: 'Furniture, repairs & custom builds', image: IMG.carpentry, rating: 4.7, price: 'From TZS 30,000', available: 'This week' },
  { id: 'moving', label: 'Moving Help', description: 'Moving, lifting & furniture assembly', image: IMG.moving, rating: 4.6, price: 'From TZS 35,000', available: 'Tomorrow' },
  { id: 'laundry', label: 'Laundry & Ironing', description: 'Wash, fold & iron — pickup and drop', image: IMG.laundry2, rating: 4.8, price: 'From TZS 12,000', available: 'Today' },
]

/* ── Audiences (4 paths) ───────────────────────────────────────── */
export type Audience = {
  id: string
  title: string
  description: string
  offer: string
  cta: string
  href: string
  icon: LucideIcon
}

export const AUDIENCES: Audience[] = [
  {
    id: 'customer',
    title: 'Order & Book',
    description: 'Order food, shop essentials, or book trusted professionals for your home.',
    offer: 'Free first delivery',
    cta: 'Explore services',
    href: '/services',
    icon: UtensilsCrossed,
  },
  {
    id: 'merchant',
    title: 'Partner As a Merchant',
    description: 'Reach more customers and grow sales with a dashboard built for business.',
    offer: '0% commission for 30 days',
    cta: 'Become a Partner',
    href: '/merchant',
    icon: ShoppingBag,
  },
  {
    id: 'provider',
    title: 'Offer Services',
    description: 'Plumbers, electricians, cleaners and pros — get bookings from your area.',
    offer: 'Weekly payouts',
    cta: 'Become a Provider',
    href: '/provider',
    icon: Wrench,
  },
  {
    id: 'rider',
    title: 'Deliver With Us',
    description: 'Earn on your schedule with daily M-Pesa payouts and full support.',
    offer: 'Sign up in minutes',
    cta: 'Start Delivering',
    href: '/rider',
    icon: Truck,
  },
]

/* ── Merchant content ──────────────────────────────────────────── */
export type CommissionTier = {
  name: string
  rate: string
  description: string
  featured?: boolean
}

export const COMMISSION_TIERS: CommissionTier[] = [
  { name: 'Launch', rate: '0%', description: 'First 30 days on HUDumika — zero commission, full earnings.' },
  { name: 'Standard', rate: '14%', description: 'Transparent flat rate on every order after launch. No hidden fees.' },
  { name: 'Growth', rate: '10%', description: 'For partners doing 300+ orders a month — lower rate, more tools.' },
]

export const MERCHANT_MODULES = [
  { title: 'Insights', desc: 'Sales trends & optimization score' },
  { title: 'Orders', desc: 'Accept, prepare & track live' },
  { title: 'Menu Manager', desc: 'Items, prices, photos & stock' },
  { title: 'Customers', desc: 'New, occasional & frequent' },
  { title: 'Marketing', desc: 'Campaigns, ads & promotions' },
  { title: 'Financials', desc: 'Transactions & statements' },
  { title: 'Payouts', desc: 'Daily settlements to M-Pesa' },
]

export const MERCHANT_TESTIMONIALS = [
  { quote: 'Orders are up 40% since we joined. The dashboard makes it easy to manage the whole menu from one place.', name: 'Grace Mwangi', role: 'Owner, Green Bowl Kitchen' },
  { quote: 'The merchant dashboard makes it easy to track orders and manage our menu. Best platform we have used.', name: 'Fatima Hassan', role: 'Manager, Spice Route' },
]

/* ── Provider content ──────────────────────────────────────────── */
export const PROVIDER_BENEFITS = [
  { title: 'Get booked', desc: 'Appear to customers in your area who need your trade — no cold calling.' },
  { title: 'Set your rates', desc: 'You choose pricing, service area and working hours.' },
  { title: 'Weekly payouts', desc: 'Payments settled weekly to M-Pesa or bank. Clear statements.' },
  { title: 'Verified badge', desc: 'Background checks and reviews build trust that wins jobs.' },
]

export const PROVIDER_CATEGORIES = [
  'Plumbing', 'Electrical', 'Home Cleaning', 'Appliance Repair', 'Painting & Decor',
  'Carpentry', 'Moving & Logistics', 'Laundry', 'Beauty & Grooming', 'Pest Control',
]

/* ── Rider content ─────────────────────────────────────────────── */
export const RIDER_TRACKS = [
  {
    id: 'dedicated',
    name: 'Dedicated Rider',
    tagline: 'Stable income, full support',
    features: [
      'Fixed delivery area — stable, predictable income',
      'Free equipment: hot bag, branded jacket & helmet',
      'Insurance & safety training included',
      'Dedicated area manager & coaching',
      'Weekly bonuses for top performers',
    ],
    cta: 'Apply for Dedicated',
    highlight: true,
  },
  {
    id: 'flex',
    name: 'Flex Rider',
    tagline: 'Your schedule, your rules',
    features: [
      'Dash whenever you want — no fixed shifts',
      'Instant daily payouts to M-Pesa',
      'Start in minutes — just a phone & a bike',
      'Earn during peaks, holidays & events',
      'Community support group & hotline',
    ],
    cta: 'Start Flex Today',
    highlight: false,
  },
]

export const RIDER_STORIES = [
  { name: 'Juma Hassan', role: 'Boda rider · Dar es Salaam', quote: 'I started flex while finishing my studies. Now I ride full-time and pay my rent with deliveries.', rating: 4.9, orders: '1,428 deliveries' },
  { name: 'Neema Kileo', role: 'Dedicated rider · Arusha', quote: 'The fixed area means I know every street. Stable income and the team always has my back.', rating: 5.0, orders: '3,210 deliveries' },
  { name: 'Salim Bakari', role: 'Flex rider · Mwanza', quote: 'Evenings and weekends only — the flexibility is perfect alongside my other work.', rating: 4.8, orders: '986 deliveries' },
]

/* ── Restaurants (consumer, mock catalog for the MSW phase) ───── */
export type Restaurant = {
  name: string
  cuisine: string
  rating: number
  deliveryTime: string
  deliveryFee: string
  image: string
  promo?: string
  category: string
}

export const RESTAURANTS: Restaurant[] = [
  { name: 'Green Bowl Kitchen', cuisine: 'Healthy · Salads · Bowls', rating: 4.8, deliveryTime: '20-30 min', deliveryFee: 'Free delivery', image: px(1640777), promo: '20% off', category: 'Food' },
  { name: 'Spice Route', cuisine: 'Indian · Curry · Biryani', rating: 4.7, deliveryTime: '25-35 min', deliveryFee: 'TZS 3,000 delivery', image: px(2474661), category: 'Food' },
  { name: 'Tokyo Ramen House', cuisine: 'Japanese · Ramen · Sushi', rating: 4.9, deliveryTime: '30-40 min', deliveryFee: 'Free delivery', image: px(884600), promo: 'New', category: 'Food' },
  { name: 'Pizza Corner', cuisine: 'Italian · Pizza · Pasta', rating: 4.6, deliveryTime: '15-25 min', deliveryFee: 'TZS 1,500 delivery', image: px(825661), category: 'Food' },
  { name: 'Burger Barn', cuisine: 'American · Burgers · Fries', rating: 4.5, deliveryTime: '15-20 min', deliveryFee: 'Free delivery', image: px(1639557), promo: '15% off', category: 'Food' },
  { name: 'Sweet Surrender', cuisine: 'Desserts · Cakes · Pastries', rating: 4.8, deliveryTime: '20-30 min', deliveryFee: 'TZS 4,000 delivery', image: px(291528), category: 'Food' },
  { name: 'Kariakoo Fresh Market', cuisine: 'Produce · Fruits · Veg', rating: 4.6, deliveryTime: '25-35 min', deliveryFee: 'TZS 2,000 delivery', image: px(264537), promo: 'Fresh daily', category: 'Groceries' },
  { name: 'Dawa Yetu Pharmacy', cuisine: 'Pharmacy · Health · Wellness', rating: 4.7, deliveryTime: '15-25 min', deliveryFee: 'Free delivery', image: px(3683070), category: 'Pharmacy' },
  { name: 'Flora & Bloom', cuisine: 'Flowers · Bouquets · Gifts', rating: 4.8, deliveryTime: '30-45 min', deliveryFee: 'TZS 5,000 delivery', image: px(931147), promo: 'Same day', category: 'Flowers' },
]

/* ── Cities ────────────────────────────────────────────────────── */
export type City = { id: string; name: string; region: string }

export const CITIES: City[] = [
  { id: 'dar', name: 'Dar es Salaam', region: 'Tanzania' },
  { id: 'dod', name: 'Dodoma', region: 'Tanzania' },
  { id: 'arusha', name: 'Arusha', region: 'Tanzania' },
  { id: 'mwanza', name: 'Mwanza', region: 'Tanzania' },
  { id: 'zanzibar', name: 'Zanzibar', region: 'Tanzania' },
  { id: 'mbeya', name: 'Mbeya', region: 'Tanzania' },
  { id: 'tanga', name: 'Tanga', region: 'Tanzania' },
  { id: 'morogoro', name: 'Morogoro', region: 'Tanzania' },
]

/* ── Trust metrics (verified configuration) ────────────────────── */
export const METRICS = [
  { value: '8', label: 'Cities served' },
  { value: '2,000+', label: 'Restaurants & shops' },
  { value: '500+', label: 'Service providers' },
  { value: '30 min', label: 'Average delivery' },
]

/* ── FAQ ───────────────────────────────────────────────────────── */
export type FaqItem = { q: string; a: string }
export type FaqGroup = { title: string; items: FaqItem[] }

export const FAQ_GROUPS: FaqGroup[] = [
  {
    title: 'Payments & Money',
    items: [
      { q: 'How do refunds work if I cancel an order?', a: 'If the restaurant has not accepted your order yet, cancel and the full amount returns to your HUDumika wallet instantly. After acceptance, you can request a refund and it is processed within 1 business day.' },
      { q: 'Which payment methods do you accept?', a: 'We accept M-Pesa, Tigo Pesa, Airtel Money, Visa and Mastercard, plus cash on delivery where available. Wallet balance from refunds can be used on your next order.' },
      { q: 'How do I pay for a home service booking?', a: 'Bookings are paid via M-Pesa or card at booking time, and funds are released to the provider after the job is completed to your satisfaction.' },
      { q: 'Is my card stored securely?', a: 'Yes. We never store full card details on our servers — payments are processed through PCI-compliant gateways.' },
    ],
  },
  {
    title: 'Promotions & Discounts',
    items: [
      { q: 'How do I get my free first delivery?', a: 'New customers who place their first order on the HUDumika app or web automatically get free delivery, no code required. Other fees may still apply.' },
      { q: 'What is the new-user discount?', a: 'New users (first order on the platform) enjoy up to 20% off their first order — one claim per phone number and device.' },
      { q: 'Can I combine multiple promo codes?', a: 'Only one active promotion can be applied per order. Delivery fee waivers and item discounts cannot be stacked.' },
      { q: 'Does the 0% merchant commission offer really exist?', a: 'Yes — new merchants pay 0% commission for the first 30 days after launch, then our standard transparent rate applies. No hidden fees.' },
    ],
  },
  {
    title: 'Orders & Bookings',
    items: [
      { q: 'How do I cancel an order?', a: 'Before the restaurant accepts: tap Cancel in the order screen and you are refunded immediately. After acceptance, contact support or call the restaurant directly through the app.' },
      { q: 'How do home service bookings work?', a: 'Pick a service, choose a provider, and book a time slot. The provider confirms within 15 minutes. You can reschedule or cancel free up to 2 hours before the slot.' },
      { q: 'What if my delivery is late?', a: 'If your order arrives after the promised time, you get a delivery-fee refund automatically. This is our late-delivery guarantee.' },
      { q: 'Can I order in advance?', a: 'Yes — most restaurants support scheduled orders. Pick a delivery window up to 7 days ahead during checkout.' },
    ],
  },
  {
    title: 'Home Services',
    items: [
      { q: 'Are service providers verified?', a: 'Every provider passes ID verification, a background check, and a skills review. Their ratings and completed-job history are public on their profile.' },
      { q: 'What if the job is not done properly?', a: 'We hold payment until you confirm completion. If something is wrong, raise it in-app within 48 hours and we mediate or rebook at no cost.' },
      { q: 'What if I need to reschedule a provider?', a: 'Reschedule free up to 2 hours before the slot. Late cancellations may incur a small fee to protect provider time.' },
      { q: 'How are provider prices set?', a: 'Providers set their own rates within fair ranges. You always see the full price before booking — no surprises.' },
    ],
  },
  {
    title: 'Delivery & Coverage',
    items: [
      { q: 'How long does delivery take?', a: 'Average delivery time is 25 minutes across Dar es Salaam. Peak hours and bad weather may extend times — we always show the live estimate before you order.' },
      { q: 'Can I track my order?', a: 'Yes. From the moment your order is accepted you can follow the rider live in the app — status, location, and ETA updates in real time.' },
      { q: 'What areas do you deliver to?', a: 'We currently serve 8 cities: Dar es Salaam, Dodoma, Arusha, Mwanza, Zanzibar, Mbeya, Tanga and Morogoro.' },
      { q: 'What if my address is hard to find?', a: 'Add a landmark or description in your delivery notes, and the rider can also call you directly through the app.' },
    ],
  },
  {
    title: 'For Merchants & Providers',
    items: [
      { q: 'How long does merchant onboarding take?', a: 'Apply online and most businesses are approved within 24 hours. Our team helps you list your menu and go live the same day.' },
      { q: 'How do provider payouts work?', a: 'Service providers receive payouts weekly to M-Pesa or bank, with a clear statement of every completed job.' },
      { q: 'Is there a fee to join?', a: 'No. Joining HUDumika is free — merchants pay commission only on orders, and providers keep a transparent share of each booking.' },
      { q: 'Do I need my own equipment as a provider?', a: 'Yes for most trades (tools, materials). For cleaning and laundry services, we help source partner supplies at wholesale rates.' },
    ],
  },
]

/* ── Support tracks ────────────────────────────────────────────── */
export type SupportTrack = {
  id: 'consumer' | 'merchant' | 'provider' | 'rider'
  title: string
  hours: string
  points: string[]
}

export const SUPPORT_TRACKS: SupportTrack[] = [
  {
    id: 'consumer',
    title: 'Consumer Support',
    hours: 'Daily 9:00 – 23:00',
    points: ['Order & booking issues', 'Refunds and payments', 'Feedback on delivery experience'],
  },
  {
    id: 'merchant',
    title: 'Merchant Support',
    hours: 'Daily 8:00 – 21:00',
    points: ['Onboarding & verification', 'Dashboard & menu help', 'Payouts & commission queries'],
  },
  {
    id: 'provider',
    title: 'Provider Support',
    hours: 'Daily 8:00 – 20:00',
    points: ['Verification & profile help', 'Bookings & scheduling', 'Payouts & service standards'],
  },
  {
    id: 'rider',
    title: 'Rider Support',
    hours: '24/7',
    points: ['Application & onboarding', 'Earnings & payouts', 'Safety & equipment'],
  },
]

/* ── SEO meta ──────────────────────────────────────────────────── */
export const SEO_META: Record<string, { title: string; description: string }> = {
  '/': {
    title: 'HUDumika — Everything Your Day Needs, Delivered',
    description:
      'Order food, shop essentials, or book trusted home professionals — plumbers, electricians, cleaners and more. HUDumika serves 8 Tanzanian cities.',
  },
  '/services': {
    title: 'All Services — Order & Book | HUDumika',
    description:
      'Food delivery, groceries, pharmacy, home services, beauty, laundry, repairs, moving and more — browse and book across 8 Tanzanian cities.',
  },
  '/consumer': {
    title: 'Order Food Delivery Online | HUDumika',
    description:
      'Browse restaurants, groceries and pharmacy near you in Dar es Salaam and 7 more cities. Fast delivery, live tracking, pay with M-Pesa.',
  },
  '/merchant': {
    title: 'Grow Your Restaurant with HUDumika | Merchant Signup',
    description:
      'Partner with HUDumika: 0% commission for 30 days, order dashboard, marketing tools and fast daily payouts. Sign up your business today.',
  },
  '/provider': {
    title: 'Become a Service Provider — Plumbers, Electricians & More | HUDumika',
    description:
      'Get booked by customers in your area. Set your rates, earn weekly via M-Pesa, and grow with verified reviews. Join as a service provider today.',
  },
  '/rider': {
    title: 'Become a Rider — Earn on Your Schedule | HUDumika',
    description:
      'Deliver with HUDumika. Choose dedicated or flex riding, earn daily via M-Pesa, get insurance and support. Apply in minutes.',
  },
  '/faq': {
    title: 'Frequently Asked Questions | HUDumika Help',
    description:
      'Answers about payments, refunds, orders, home-service bookings, delivery and safety on HUDumika.',
  },
  '/support': {
    title: 'Contact Support | HUDumika',
    description:
      'Consumer, merchant, provider and rider support hotlines, hours and feedback — we respond fast.',
  },
  '/csr': {
    title: 'Our Community & Rider Welfare | HUDumika',
    description:
      'How HUDumika invests in rider safety, fair earnings, training and community impact across Tanzania.',
  },
  '/about': {
    title: 'About HUDumika — Your City, Delivered',
    description:
      'The story, mission and values behind HUDumika — Tanzania\u2019s local services and delivery platform.',
  },
  '/login': {
    title: 'Log In | HUDumika',
    description: 'Sign in to your HUDumika account.',
  },
  '/privacy': {
    title: 'Privacy Policy | HUDumika',
    description: 'How HUDumika collects, uses and protects your personal information.',
  },
  '/terms': {
    title: 'Terms of Service | HUDumika',
    description: 'The terms that govern your use of HUDumika as a customer, merchant, provider or rider.',
  },
  '/cookies': {
    title: 'Cookie Policy | HUDumika',
    description: 'How HUDumika uses cookies and how you can manage your preferences.',
  },
}

/* ── Legal documents (data layer) ──────────────────────────────── */
export type LegalDoc = {
  title: string
  updated: string
  intro: string
  sections: { h: string; p: string }[]
}

export const LEGAL_DOCS: Record<string, LegalDoc> = {
  privacy: {
    title: 'Privacy Policy',
    updated: '1 August 2026',
    intro: 'Your privacy matters to us. This policy explains what we collect, why we collect it, and how we protect your information when you use HUDumika.',
    sections: [
      { h: 'What we collect', p: 'We collect information you provide directly — name, phone number, email, delivery address — plus device and usage data needed to run the service. Payment details are processed by our PCI-compliant partners; we never store full card numbers.' },
      { h: 'How we use it', p: 'We use your data to deliver orders, process payments, match bookings with providers, provide support, improve our service, and — with your consent — send promotions. Location data is used only to match you with nearby restaurants, shops and service providers.' },
      { h: 'Sharing', p: 'We share the minimum necessary data with restaurants (order details), providers (job details and address), and riders (pickup and delivery location). We never sell your personal information.' },
      { h: 'Your rights', p: 'You may access, correct, or delete your personal data by contacting the support team through the public support page. You can also opt out of marketing in the app settings.' },
      { h: 'Security', p: 'We use encryption in transit and at rest, role-based access controls, and regular security reviews. Breaches are reported within 72 hours as required by Tanzanian law.' },
    ],
  },
  terms: {
    title: 'Terms of Service',
    updated: '1 August 2026',
    intro: 'These terms govern your use of the HUDumika platform — as a customer, merchant, service provider, or rider. By using the service you agree to them.',
    sections: [
      { h: 'The service', p: 'HUDumika connects customers with local restaurants, shops, service providers, and riders for on-demand delivery and bookings. We are a technology platform; goods and services are supplied by the partners on our platform.' },
      { h: 'Orders, bookings & payments', p: 'You agree to pay for orders and bookings placed, including delivery fees and applicable taxes. Refunds follow the policy in our FAQ. Provider payments are held until the customer confirms completion.' },
      { h: 'Merchants', p: 'Merchants agree to our commission structure (0% for the first 30 days, then a transparent rate), food-safety standards, and to fulfil orders promptly. Payouts are processed daily.' },
      { h: 'Service providers', p: 'Providers must pass verification, hold valid qualifications for their trade, and meet our service standards. Providers set their own rates within fair ranges and receive weekly payouts.' },
      { h: 'Riders', p: 'Riders must be 18+, hold a valid ID, and follow our safety guidelines and road rules. Earnings are calculated transparently per delivery and paid daily to M-Pesa.' },
      { h: 'Limitation of liability', p: 'To the maximum extent permitted by law, our liability is limited to the value of the affected order or booking. Nothing in these terms limits consumer rights guaranteed by Tanzanian law.' },
    ],
  },
  cookies: {
    title: 'Cookie Policy',
    updated: '1 August 2026',
    intro: 'HUDumika uses cookies and similar technologies to keep the site working, remember your preferences, and understand what is useful.',
    sections: [
      { h: 'Essential cookies', p: 'Required for the site to function — session management, security, and remembering your city and cart. These are always on and cannot be disabled.' },
      { h: 'Optional cookies', p: 'Analytics and personalisation cookies help us improve the experience. These are only set if you accept them in our cookie banner.' },
      { h: 'Managing cookies', p: 'You can change your choice at any time through your browser settings, or withdraw consent by clearing site data. Disabling optional cookies does not affect core functionality.' },
    ],
  },
}

/* ── Formatters ────────────────────────────────────────────────── */
export const formatTZS = (v: number) => `TZS ${Math.round(v).toLocaleString('en-US')}`
