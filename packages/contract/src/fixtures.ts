import { faker } from '@faker-js/faker'
import type {
  Menu,
  MerchantPublic,
  OrderDetail,
  ProviderPublic,
  Promotion,
  RiderAdmin,
  ServiceCategoryConfig,
  Wallet,
  WalletTransaction,
} from './generated/model/index.ts'
import {
  OrderPriority,
  OrderStatus,
  PromotionStatus,
  PromotionType,
  WalletTransactionType,
} from './generated/model/index.ts'

/**
 * Pure-data fixture factories for React Native mock repositories.
 *
 * No msw import — safe to bundle in Expo apps. Deterministic: call
 * setFixturesSeed(123) to reproduce a demo state.
 */

faker.seed(20260813)
export function setFixturesSeed(seed: number) {
  faker.seed(seed)
}

const TZS = () => faker.number.int({ min: 2500, max: 85000 })
const uuid = () => faker.string.uuid()
const shortName = () => faker.helpers.arrayElement(['Sunrise Kitchen', 'Mama Nne Foods', 'Coastline Grill', 'Kilimanjaro Eats', 'Dar Delicacies', 'Spice Route Bistro'])
const past = (days: number) => faker.date.recent({ days: Math.max(1, Math.abs(days)) }).toISOString().slice(0, 19) + 'Z'

export function fixtureAddress() {
  return {
    label: faker.helpers.arrayElement(['Home', 'Office', 'Gym', 'Apartment 7B']),
    lines: `${faker.location.streetAddress()}, ${faker.location.city()}`,
    landmark: faker.helpers.arrayElement(['near Total petrol station', 'opposite the mosque', 'blue gate', 'beside Mama Mboga']),
    lat: faker.location.latitude(),
    lon: faker.location.longitude(),
    contactPhone: '+255' + faker.string.numeric(9),
  }
}

export function fixtureCategory(): ServiceCategoryConfig {
  return {
    id: uuid(),
    name: faker.helpers.arrayElement(['Plumbing', 'Electrical', 'Cleaning', 'Repairs', 'Moving', 'Tutoring']),
    pricingModel: faker.helpers.arrayElement(['fixed', 'hourly'] as const),
    defaultDurationMinutes: faker.helpers.arrayElement([60, 90, 120]),
    commissionBps: 1000,
    cancellationRules: 'Free cancellation up to 2 hours before the slot',
  }
}

export function fixtureMerchant(): MerchantPublic {
  const open = faker.datatype.boolean(0.8)
  return {
    id: uuid(),
    businessName: shortName(),
    logoUrl: null,
    city: faker.location.city(),
    serviceAreas: [faker.location.city(), faker.location.city()],
    categories: faker.helpers.arrayElements(['food', 'groceries', 'pharmacy', 'flowers'] as const),
    rating: faker.number.float({ min: 3.2, max: 4.9, fractionDigits: 1 }),
    reviewCount: faker.number.int({ min: 4, max: 900 }),
    isOpen: open,
    deliveryMinutes: open ? faker.number.int({ min: 15, max: 60 }) : null,
  }
}

export function fixtureProvider(): ProviderPublic {
  return {
    id: uuid(),
    name: faker.person.fullName(),
    trade: faker.helpers.arrayElement(['Plumber', 'Electrician', 'Cleaner', 'Handyman', 'Carpenter']),
    avatarUrl: null,
    rating: faker.number.float({ min: 3.1, max: 5, fractionDigits: 1 }),
    reviewCount: faker.number.int({ min: 1, max: 400 }),
    verified: faker.datatype.boolean(0.75),
    serviceAreas: [faker.location.city()],
    baseRateTZS: TZS(),
  }
}

export function fixturePromotion(): Promotion {
  return {
    id: uuid(),
    merchantId: uuid(),
    type: faker.helpers.arrayElement([PromotionType.discount, PromotionType.free_delivery, PromotionType.new_customer, PromotionType.coupon]),
    title: faker.helpers.arrayElement(['20% off asante orders', 'Free delivery tonight', 'Buy 2 get 1 free', 'Happy hour 15% off']),
    description: 'Limited-time offer.',
    status: PromotionStatus.live,
    discountRateBps: faker.helpers.arrayElement([1000, 1500, 2000]),
    thresholdTZS: faker.helpers.arrayElement([15000, 25000, null]),
    startsAt: past(7),
    endsAt: past(-7),
    redeemCount: faker.number.int({ min: 5, max: 500 }),
  }
}

export function fixtureMenu(): Menu {
  const sections = faker.helpers.arrayElements(['Popular', 'Rice & Stews', 'Grills', 'Drinks', 'Desserts'], { min: 2, max: 4 })
  return {
    id: uuid(),
    name: `${shortName()} menu`,
    storeIds: [uuid()],
    active: true,
    createdAt: past(30),
    sections: sections.map((name) => ({
      name,
      itemIds: Array.from({ length: faker.number.int({ min: 2, max: 6 }) }, uuid),
    })),
  }
}

/** Order in a dispatchable state (no rider yet) — the shape drivers/schedulers poll */
export function fixtureDispatchableOrder(overrides: Partial<OrderDetail> = {}): OrderDetail {
  return {
    id: uuid(),
    no: faker.helpers.arrayElement(['HD-OR-' + faker.string.numeric(6), undefined]),
    status: faker.helpers.arrayElement(['paid', 'merchant_accepted', 'preparing'] satisfies OrderStatus[]),
    merchantId: uuid(),
    riderId: null,
    source: faker.helpers.arrayElement(['app', 'web', 'phone', 'pos'] as const),
    priority: faker.helpers.arrayElement([OrderPriority.normal, OrderPriority.express, OrderPriority.vip]),
    fulfillmentType: faker.helpers.arrayElement(['local', 'intercity', 'relay'] as const),
    dispatchStrategy: faker.helpers.arrayElement(['nearest', 'zone', 'multi_leg'] as const),
    totals: {
      subtotalTZS: TZS(),
      deliveryFeeTZS: faker.number.int({ min: 0, max: 5000 }),
      platformFeeTZS: faker.number.int({ min: 200, max: 1000 }),
      taxTZS: 0,
      discountTZS: faker.number.int({ min: 0, max: 3000 }),
      totalTZS: 0,
    },
    items: Array.from({ length: faker.number.int({ min: 1, max: 4 }) }, () => ({
      catalogueItemId: uuid(),
      name: faker.helpers.arrayElement(['Chicken & Chips', 'Beef Pilau', 'Chapati + Beans', 'Fried Fish', 'Milk Tea']),
      quantity: faker.number.int({ min: 1, max: 3 }),
      unitPriceTZS: TZS(),
    })),
    deliveryAddress: fixtureAddress(),
    events: [{ status: 'paid', at: past(1), by: 'system', note: 'Order paid via mobile money' }],
    createdAt: past(1),
    ...overrides,
  }
}

/** Builds a totals-consistent order (call after overriding amounts if needed) */
export function fixtureOrderDetail(overrides: Partial<OrderDetail> = {}): OrderDetail {
  const base = fixtureDispatchableOrder(overrides as Partial<OrderDetail>)
  if (base.totals) {
    const { subtotalTZS = 0, deliveryFeeTZS = 0, platformFeeTZS = 0, taxTZS = 0, discountTZS = 0 } = base.totals
    base.totals.totalTZS = subtotalTZS + deliveryFeeTZS + platformFeeTZS + taxTZS - discountTZS
  }
  return base
}

export function fixtureCompletedOrder(overrides: Partial<OrderDetail> = {}): OrderDetail {
  return fixtureOrderDetail({
    status: 'delivered',
    riderId: uuid(),
    priority: OrderPriority.normal,
    events: [
      { status: 'paid', at: past(2), by: 'system', note: undefined },
      { status: 'preparing', at: past(2), by: 'merchant', note: undefined },
      { status: 'picked_up', at: past(1), by: 'rider', note: undefined },
      { status: 'delivered', at: past(0), by: 'rider', note: 'Handed to customer' },
    ],
    ...overrides,
  })
}

export function fixtureWallet(): Wallet {
  const withdrawableTZS = TZS()
  const pendingTZS = faker.number.int({ min: 0, max: 20000 })
  return {
    withdrawableTZS,
    pendingTZS,
    totalTZS: withdrawableTZS + pendingTZS,
  }
}

export function fixtureWalletTransactions(count = 8): WalletTransaction[] {
  return Array.from({ length: count }, () => ({
    id: uuid(),
    type: faker.helpers.arrayElement([WalletTransactionType.settlement, WalletTransactionType.withdrawal, WalletTransactionType.refund, WalletTransactionType.adjustment]),
    amountTZS: TZS() * (faker.helpers.arrayElement([-1, -1, 1]) as number),
    balanceTZS: TZS(),
    referenceType: faker.helpers.arrayElement(['order', 'promotion', undefined]),
    referenceId: uuid(),
    createdAt: past(14),
  }))
}

export function fixtureRiderProfile(overrides: Partial<RiderAdmin> = {}): RiderAdmin {
  return {
    id: uuid(),
    name: faker.person.fullName(),
    city: faker.location.city(),
    vehicle: faker.helpers.arrayElement(['motorcycle', 'bicycle', 'car'] as const),
    licensePlate: faker.string.alphanumeric({ length: 6 }).toUpperCase(),
    vehicleMake: faker.helpers.arrayElement(['Bajaj', 'TVS', 'Honda', 'Yamaha']),
    vehicleYear: faker.number.int({ min: 2015, max: 2026 }),
    verification: 'approved',
    documents: [{ type: 'national_id', status: 'approved' }],
    reliabilityScore: faker.number.float({ min: 60, max: 99, fractionDigits: 1 }),
    ...overrides,
  }
}

export function fixtureHomeFeed() {
  return {
    generatedAt: past(0),
    categories: Array.from({ length: 4 }, fixtureCategory),
    merchants: Array.from({ length: faker.number.int({ min: 5, max: 10 }) }, fixtureMerchant),
    providers: Array.from({ length: faker.number.int({ min: 0, max: 3 }) }, fixtureProvider),
    promotions: Array.from({ length: faker.number.int({ min: 1, max: 3 }) }, fixturePromotion),
  }
}