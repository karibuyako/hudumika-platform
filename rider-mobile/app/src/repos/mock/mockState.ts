/* Shared in-memory state for the mock repositories.
 *
 * Module-level singleton, seeded deterministically from @hudumika/contract
 * fixtures (setFixturesSeed(20260813) at load). Tests call resetMockState()
 * between cases to restore the pristine seed.
 *
 * Money is integer TZS everywhere. FareBreakdown always satisfies
 *   base + distance + time + surge + tip + codFee + waitPay + bonus = total
 */
import {
  fixtureCompletedOrder,
  fixtureOrderDetail,
  fixtureRiderProfile,
  fixtureWallet,
  fixtureWalletTransactions,
  setFixturesSeed,
} from '@hudumika/contract/fixtures';
import type {
  Consignment,
  DeliveryException,
  DispatchOffer,
  ExportRiderReport202,
  FareBreakdown,
  GetRiderSecurity200,
  HeatmapZone,
  LedgerEntry,
  LogisticsTrip,
  MaskedCallSession,
  OrderDetail,
  Package,
  RiderExpense,
  RiderGoals,
  RiderMission,
  RiderPerformance,
  RiderPreferences,
  RiderPrivate,
  RiderShift,
  RouteSegment,
  SosAlert,
  Ticket,
  TrackingEvent,
  TrainingModule,
  Trip,
  TrustedContact,
  Vehicle,
  VehicleMaintenance,
} from '@hudumika/contract';
import { ApiError } from '@/api/client';
import { uid } from '@/lib/format';
import type { DispatchOfferFeedItem, NotificationItem, PayoutSummary } from '../index';
import type { FacilityWhitelistEntry } from '@/lib/logistics';

export const MOCK_SEED = 20260813;

/** Mock-only merchant pickup code shared by every seeded order. Shown in the
 * pickup-confirm sheet as a demo hint so testers can complete the flow. */
export const MOCK_PICKUP_CODE = '1234';

export interface OtpRequest {
  code: string;
  destination: string;
  purpose: 'login' | 'register';
  expiresAt: number;
}

export interface MockState {
  profile: RiderPrivate;
  feed: DispatchOfferFeedItem[];
  orders: OrderDetail[];
  /** Batch-trip (P10c) stop sequence: the rider's manual ordering of active
   * orders. Persists reorderStops(); the active trip itself is derived from
   * the live orders so statuses never drift. */
  tripSequence: string[] | null;
  /** Last completed batch trip — kept so getTrip() can still render the
   * trip.completed summary after the final order leaves the active set. */
  completedTrip: Trip | null;
  fares: Map<string, FareBreakdown>;
  /** Mock-only merchant pickup codes per order (live flow has no such field). */
  pickupCodes: Record<string, string>;
  ledger: LedgerEntry[];
  ledgerBalance: number;
  balanceTZS: number;
  availableTZS: number;
  payouts: PayoutSummary['payouts'];
  shifts: RiderShift[];
  missions: RiderMission[];
  notifications: NotificationItem[];
  preferences: RiderPreferences;
  performance: RiderPerformance;
  heatmap: HeatmapZone[];
  rejectReasons: string[];
  issueReasons: string[];
  otpRequests: Map<string, OtpRequest>;
  otpCounter: number;
  otpLastRequestAt: Map<string, number>;
  podSubmitted: Set<string>;
  shiftCodExpectedTZS: Record<string, number>;
  tickets: Ticket[];
  sosAlerts: SosAlert[];
  sosLastSentAt: number | null;
  trustedContacts: TrustedContact[];
  security: GetRiderSecurity200;
  shareTokens: Record<string, { shareToken: string; expiresAt: string }>;
  maintenance: VehicleMaintenance[];
  expenses: RiderExpense[];
  goals: RiderGoals;
  training: TrainingModule[];
  exportJobs: ExportRiderReport202[];
  // ---- Logistics OS (P11b-d) ----
  deliveryExceptions: DeliveryException[];
  facilityWhitelist: FacilityWhitelistEntry[];
  facilityScans: { facilityId: string; facilityName: string; at: string; result: 'granted' | 'blocked'; requestId?: string; code?: string }[];
  logisticsTrips: LogisticsTrip[];
  vehicles: Vehicle[];
  packages: Package[];
  consignments: Consignment[];
  orderRoutes: Map<string, RouteSegment[]>;
}

export function buildFare(orderId: string, cod: boolean): FareBreakdown {
  const baseTZS = 2500;
  const distanceTZS = 1200;
  const timeTZS = 800;
  const surgeTZS = 0;
  const tipTZS = 0;
  const codFeeTZS = cod ? 400 : 0;
  const waitPayTZS = 0;
  const bonusTZS = 0;
  return {
    orderId,
    baseTZS,
    distanceTZS,
    timeTZS,
    surgeMultiplier: 1,
    surgeTZS,
    tipTZS,
    codFeeTZS,
    waitPayTZS,
    bonusTZS,
    totalTZS: baseTZS + distanceTZS + timeTZS + surgeTZS + tipTZS + codFeeTZS + waitPayTZS + bonusTZS,
    currency: 'TZS',
  };
}

function buildFeed(count: number): { feed: DispatchOfferFeedItem[]; orders: OrderDetail[] } {
  const feed: DispatchOfferFeedItem[] = [];
  const orders: OrderDetail[] = [];
  for (let i = 0; i < count; i += 1) {
    const order = fixtureOrderDetail();
    const cod = i % 2 === 0;
    const offer: DispatchOffer = {
      orderId: order.id,
      pickup: {
        lat: -6.79 + i * 0.01,
        lon: 39.2 + i * 0.01,
        address: 'Pickup point',
        merchantName: 'Sunrise Kitchen',
      },
      dropoff: {
        lat: (order.deliveryAddress?.lat ?? -6.81) + i * 0.005,
        lon: (order.deliveryAddress?.lon ?? 39.21) + i * 0.005,
        address: order.deliveryAddress?.lines ?? 'Dropoff',
      },
      distanceKm: 2.5 + i,
      predictedPrepMinutes: 15 + i * 3,
      estimatedEarningsTZS: (order.totals.deliveryFeeTZS ?? 3500) + (order.totals.platformFeeTZS ?? 500),
      itemsSummary: (order.items ?? []).slice(0, 2).map((it) => it.name).join(', ') || 'Order items',
      paymentMethod: cod ? 'cod' : 'mpesa',
      expiresAt: new Date(Date.now() + 20 * 60 * 1000 + i * 60_000).toISOString(),
    };
    feed.push({ orderId: order.id, offer, expiresAt: Date.parse(offer.expiresAt) });
    orders.push(order);
  }
  return { feed, orders };
}

function buildLedger(): { ledger: LedgerEntry[]; balance: number } {
  const transactions = fixtureWalletTransactions(6);
  const ledger: LedgerEntry[] = [];
  let balance = 0;
  for (const t of transactions) {
    balance += t.amountTZS;
    const type =
      t.type === 'settlement'
        ? 'order_earning'
        : t.type === 'withdrawal'
          ? 'payout'
          : t.type === 'refund'
            ? 'refund'
            : 'adjustment';
    ledger.push({
      id: t.id,
      type,
      amountTZS: t.amountTZS,
      balanceTZS: balance,
      referenceType: t.referenceType,
      referenceId: t.referenceId,
      createdAt: t.createdAt,
    });
  }
  return { ledger, balance };
}

function buildState(): MockState {
  const profileFixture = fixtureRiderProfile();
  const profile: RiderPrivate = {
    id: profileFixture.id,
    name: profileFixture.name,
    city: profileFixture.city,
    vehicle: profileFixture.vehicle as RiderPrivate['vehicle'],
    transportMode: 'local_motorcycle',
    serviceModel: 'specialized',
    fleetAccountId: null,
    licensePlate: profileFixture.licensePlate,
    vehicleMake: profileFixture.vehicleMake,
    vehicleYear: profileFixture.vehicleYear,
    verification: profileFixture.verification,
    online: false,
    rating: 4.8,
    reviewCount: 142,
    deliveryZone: profileFixture.city,
    fleetType: 'contracted',
    employmentType: 'full_time',
    availability: { preferredDays: [1, 3, 5], preferredStart: '08:00', preferredEnd: '20:00', maxHoursPerDay: 8 },
    lastLocation: { lat: -6.7924, lon: 39.2083, updatedAt: nowIso() },
  };

  const { feed, orders: feedOrders } = buildFeed(5);

  const completed: OrderDetail[] = [0, 1].map(() =>
    fixtureCompletedOrder({ riderId: profile.id, version: 1 }),
  );
  const orders: OrderDetail[] = [...feedOrders, ...completed];

  const pickupCodes: Record<string, string> = {};
  for (const order of orders) pickupCodes[order.id] = MOCK_PICKUP_CODE;

  const wallet = fixtureWallet();
  const { ledger, balance } = buildLedger();
  const heatmap: HeatmapZone[] = [
    { zoneId: 'zone_kinondoni', name: 'Kinondoni', polygon: ['-6.7500,39.2700', '-6.7800,39.2900', '-6.7700,39.3100'], demandLevel: 'high', surgeMultiplier: 1.4, activeOrders: 12, activeRiders: 8 },
    { zoneId: 'zone_ilala', name: 'Ilala', polygon: ['-6.8200,39.2500', '-6.8500,39.2700', '-6.8300,39.3000'], demandLevel: 'critical', surgeMultiplier: 1.8, activeOrders: 21, activeRiders: 11 },
    { zoneId: 'zone_kariakoo', name: 'Kariakoo', polygon: ['-6.8200,39.2800', '-6.8400,39.2900', '-6.8300,39.3000'], demandLevel: 'medium', surgeMultiplier: 1.2, activeOrders: 6, activeRiders: 5 },
    { zoneId: 'zone_mikocheni', name: 'Mikocheni', polygon: ['-6.7600,39.2400', '-6.7800,39.2500', '-6.7700,39.2700'], demandLevel: 'low', surgeMultiplier: 1.0, activeOrders: 2, activeRiders: 3 },
    { zoneId: 'zone_tegeta', name: 'Tegeta', polygon: ['-6.7100,39.2200', '-6.7300,39.2400', '-6.7200,39.2600'], demandLevel: 'medium', surgeMultiplier: 1.3, activeOrders: 7, activeRiders: 4 },
  ];

  const missions: RiderMission[] = [
    {
      id: 'mission_rush8',
      title: 'Lunch rush — 8 deliveries',
      description: 'Complete 8 deliveries between 12:00 and 15:00',
      targetDeliveries: 8,
      completedDeliveries: 8,
      rewardTZS: 15000,
      status: 'active',
      claimed: false,
      canClaim: true,
      startsAt: nowIso(),
      endsAt: new Date(Date.now() + 3 * 3600_000).toISOString(),
    },
    {
      id: 'mission_week12',
      title: 'Weekly sprint — 12 deliveries',
      description: 'Complete 12 deliveries this week',
      targetDeliveries: 12,
      completedDeliveries: 5,
      rewardTZS: 25000,
      status: 'active',
      claimed: false,
      canClaim: false,
      startsAt: nowIso(),
      endsAt: new Date(Date.now() + 4 * 24 * 3600_000).toISOString(),
    },
    {
      id: 'mission_gold30',
      title: 'Gold streak — 30 deliveries',
      description: 'Finish the month at 30 deliveries',
      targetDeliveries: 30,
      completedDeliveries: 30,
      rewardTZS: 60000,
      status: 'completed',
      claimed: true,
      canClaim: false,
    },
  ];

  const notifications: NotificationItem[] = [
    { id: 'ntf_1', type: 'order', title: 'New order offer', body: 'Sunrise Kitchen — 2.5 km · TZS 4,200', read: false, ts: nowIso(), deepLink: `/orders/${orders[0].id}` },
    { id: 'ntf_2', type: 'earnings', title: 'Earnings updated', body: 'Your statement is ready for this week', read: false, ts: nowIso(), deepLink: '/earnings' },
    { id: 'ntf_3', type: 'system', title: 'Shift reminder', body: 'Clock in to start your shift', read: true, ts: nowIso() },
    { id: 'ntf_4', type: 'warning', title: 'Low balance', body: 'Top up your wallet before the next shift', read: false, ts: nowIso(), deepLink: '/tickets/ntf_unknown' },
  ];

  const maintenance: VehicleMaintenance[] = [
    {
      id: 'mnt_oil_1',
      riderId: profile.id,
      type: 'oil_change',
      performedAt: new Date(Date.now() - 5 * 24 * 3600_000).toISOString(),
      mileageKm: 12450,
      costTZS: 35000,
      notes: 'Oil and filter change',
      nextDueAt: new Date(Date.now() + 3 * 24 * 3600_000).toISOString(),
    },
    {
      id: 'mnt_brake_1',
      riderId: profile.id,
      type: 'brake_service',
      performedAt: new Date(Date.now() - 12 * 24 * 3600_000).toISOString(),
      mileageKm: 12100,
      costTZS: 28000,
      notes: 'Front brake pads replaced',
      nextDueAt: new Date(Date.now() - 2 * 24 * 3600_000).toISOString(),
    },
  ];

  const expenses: RiderExpense[] = [
    {
      id: 'exp_fuel_1',
      category: 'fuel',
      amountTZS: 15000,
      deductible: true,
      note: 'Fuel — Kariakoo station',
      incurredAt: new Date(Date.now() - 1 * 24 * 3600_000).toISOString(),
    },
    {
      id: 'exp_brake_1',
      category: 'maintenance',
      amountTZS: 28000,
      deductible: false,
      note: 'Front brake pads',
      incurredAt: new Date(Date.now() - 3 * 24 * 3600_000).toISOString(),
    },
    {
      id: 'exp_ins_1',
      category: 'insurance',
      amountTZS: 20000,
      deductible: true,
      note: 'Monthly insurance premium',
      incurredAt: new Date(Date.now() - 6 * 24 * 3600_000).toISOString(),
    },
  ];

  const goals: RiderGoals = {
    hoursGoalPerWeek: 40,
    earningsGoalTZS: 350000,
    weeklyAvailability: [
      { dayOfWeek: 1, startTime: '08:00', endTime: '20:00' },
      { dayOfWeek: 3, startTime: '08:00', endTime: '20:00' },
      { dayOfWeek: 5, startTime: '08:00', endTime: '20:00' },
    ],
    peakHourAlerts: true,
  };

  const training: TrainingModule[] = [
    {
      id: 'module_road_safety',
      title: 'Road safety essentials',
      category: 'safety',
      durationMinutes: 25,
      progressPct: 100,
      status: 'certified',
      certificateUrl: 'https://hudumika.example/cert/module_road_safety',
      rewardTZS: 10000,
      completedAt: new Date(Date.now() - 10 * 24 * 3600_000).toISOString(),
    },
    {
      id: 'module_cod',
      title: 'Cash on delivery handling',
      category: 'skills',
      durationMinutes: 15,
      progressPct: 40,
      status: 'in_progress',
      certificateUrl: null,
      rewardTZS: 5000,
      completedAt: null,
    },
    {
      id: 'module_platform',
      title: 'Platform basics',
      category: 'onboarding',
      durationMinutes: 10,
      progressPct: 0,
      status: 'not_started',
      certificateUrl: null,
      rewardTZS: 3000,
      completedAt: null,
    },
  ];

  return {
    profile,
    feed,
    orders,
    pickupCodes,
    fares: new Map(),
    ledger,
    ledgerBalance: balance,
    balanceTZS: wallet.totalTZS,
    availableTZS: wallet.withdrawableTZS,
    payouts: [
      { id: 'po_1', status: 'paid', amountTZS: 125000, method: 'Mobile Money', createdAt: nowIso() },
      { id: 'po_2', status: 'processing', amountTZS: 62000, method: 'Mobile Money', createdAt: nowIso() },
    ],
    shifts: [],
    missions,
    notifications,
    preferences: {
      soundNotifications: true,
      autoAccept: false,
      longDistance: true,
      wifiOnlyMaps: false,
      destinationFilters: [],
      language: 'en',
    },
    performance: {
      acceptanceRate: 88,
      onTimePct: 94,
      ratingAverage: 4.8,
      completedOrders: 128,
      earningsTZS: 845000,
      safetyScore: 92,
      behaviorScore: 78,
      reliabilityScore: profileFixture.reliabilityScore,
      level: 'gold',
      deliveryStreak: 6,
      securityScore: 90,
      avgPerTripTZS: 4200,
      topHours: ['11:00-13:00', '18:00-21:00'],
      onlineHoursWeek: 38,
      levelBenefits: ['Priority dispatch', 'Higher fare multiplier', 'Weekend bonus'],
      benchmarks: { teamAverage: 3.9, fleetAverage: 4.1, percentileRank: 82 },
      trends: [
        { label: 'Mon', value: 12 },
        { label: 'Tue', value: 15 },
        { label: 'Wed', value: 11 },
        { label: 'Thu', value: 18 },
        { label: 'Fri', value: 22 },
        { label: 'Sat', value: 26 },
        { label: 'Sun', value: 24 },
      ],
    },
    heatmap,
    tripSequence: null,
    completedTrip: null,
    rejectReasons: ['Restaurant too busy', 'Customer unreachable', 'Distance too far', 'Traffic', 'Other'],
    issueReasons: ['Customer unavailable', 'Wrong address', 'Order damaged', 'Address inaccessible', 'Payment issue', 'Other'],
    otpRequests: new Map(),
    otpCounter: 0,
    otpLastRequestAt: new Map(),
    podSubmitted: new Set(),
    shiftCodExpectedTZS: {},
    tickets: [],
    sosAlerts: [],
    sosLastSentAt: null,
    trustedContacts: [
      { id: 'contact_1', name: 'Neema Mwakyusa', phone: '+255712345678', relationship: 'sibling', notifiedOnSos: true, shareLocation: true },
      { id: 'contact_2', name: 'Baraka Joseph', phone: '+255713456789', relationship: 'friend', notifiedOnSos: true, shareLocation: false },
    ],
    security: {
      securityScore: 90,
      alerts: [
        { type: 'unusual_location', severity: 'medium', at: nowIso() },
        { type: 'unusual_login', severity: 'low', at: nowIso() },
      ],
    },
    shareTokens: {},
  // ---- Logistics seed ----
  // Enrich first two feed orders with deep-logistics fields for demo
  if (feedOrders[0]) {
    feedOrders[0].fulfillmentSource = 'warehouse';
    feedOrders[0].dispatchStrategy = 'warehouse';
    feedOrders[0].routeSegments = [
      { legId: 'leg_1', sequence: 0, type: 'first_mile', mode: 'van', fromHubId: null, toHubId: 'hub_a', handledBy: profile.id, status: 'pending', etaAt: new Date(Date.now() + 30 * 60_000).toISOString() },
      { legId: 'leg_2', sequence: 1, type: 'linehaul', mode: 'linehaul_bus', fromHubId: 'hub_a', toHubId: 'hub_b', handledBy: 'carrier_dar_mwanza', status: 'pending', etaAt: new Date(Date.now() + 12 * 3600_000).toISOString() },
      { legId: 'leg_3', sequence: 2, type: 'last_mile', mode: 'motorcycle', fromHubId: 'hub_b', toHubId: null, handledBy: 'rider_last_mile', status: 'pending', etaAt: new Date(Date.now() + 13 * 3600_000).toISOString() },
    ];
  }
  if (feedOrders[1]) {
    feedOrders[1].fulfillmentSource = 'merchant';
    feedOrders[1].dispatchStrategy = 'multi_leg';
    feedOrders[1].routeSegments = [
      { legId: 'leg_4', sequence: 0, type: 'first_mile', mode: 'motorcycle', fromHubId: null, toHubId: 'hub_a', handledBy: profile.id, status: 'pending', etaAt: new Date(Date.now() + 20 * 60_000).toISOString() },
      { legId: 'leg_5', sequence: 1, type: 'last_mile', mode: 'motorcycle', fromHubId: 'hub_a', toHubId: null, handledBy: profile.id, status: 'pending', etaAt: new Date(Date.now() + 50 * 60_000).toISOString() },
    ];
  }
  if (feedOrders[2]) {
    feedOrders[2].fulfillmentSource = 'warehouse';
    feedOrders[2].dispatchStrategy = 'relay';
  }

  const vehicles: Vehicle[] = [
    {
      id: 'veh_bus_15',
      vehicleType: 'linehaul_bus',
      registration: 'T 123 XYZ',
      operatorId: profile.id,
      capacity: {
        totalUnits: 327,
        maxWeightKg: 800,
        maxVolumeL: 6000,
        compartments: [
          { name: 'standard', capacity: 150, used: 120, usedWeightKg: 340, usedVolumeL: 2200 },
          { name: 'fragile', capacity: 25, used: 24, usedWeightKg: 45, usedVolumeL: 400 },
          { name: 'cold_chain', capacity: 20, used: 0, usedWeightKg: 0, usedVolumeL: 0 },
          { name: 'documents', capacity: 40, used: 40, usedWeightKg: 30, usedVolumeL: 200 },
          { name: 'high_value', capacity: 12, used: 12, usedWeightKg: 25, usedVolumeL: 150 },
        ],
      },
      temperatureCapable: false,
      securityCapability: 'lockbox',
      permittedRoutes: ['route_dar_mwanza'],
      status: 'active',
      currentLocation: { lat: -6.79, lon: 39.2, updatedAt: nowIso() },
      currentTripId: 'trip_log_1',
    },
    {
      id: 'veh_van_3',
      vehicleType: 'van',
      registration: 'T 987 ABC',
      operatorId: profile.id,
      capacity: {
        totalUnits: 50,
        maxWeightKg: 500,
        maxVolumeL: 3000,
        compartments: [
          { name: 'standard', capacity: 30, used: 10, usedWeightKg: 120, usedVolumeL: 800 },
          { name: 'fragile', capacity: 10, used: 2, usedWeightKg: 10, usedVolumeL: 100 },
          { name: 'cold_chain', capacity: 5, used: 0, usedWeightKg: 0, usedVolumeL: 0 },
          { name: 'documents', capacity: 5, used: 1, usedWeightKg: 2, usedVolumeL: 10 },
        ],
      },
      temperatureCapable: false,
      securityCapability: 'none',
      permittedRoutes: ['route_dar_mwanza'],
      status: 'active',
      currentLocation: { lat: -6.79, lon: 39.2, updatedAt: nowIso() },
      currentTripId: null,
    },
  ];

  const logisticsTrips: LogisticsTrip[] = [
    {
      id: 'trip_log_1',
      tripNumber: 'TRP-9912',
      routeId: 'route_dar_mwanza',
      vehicleId: 'veh_bus_15',
      consignmentIds: ['cons_1'],
      status: 'loading',
      manifestSummary: { expectedUnits: 327, verifiedUnits: 196, exceptions: 1 },
      scheduledDeparture: new Date(Date.now() + 2 * 3600_000).toISOString(),
      departedAt: null,
      arrivedAt: null,
      driverId: profile.id,
      createdBy: 'dispatch_1',
      createdAt: nowIso(),
    },
  ];

  const consignments: Consignment[] = [
    {
      id: 'cons_1',
      consignmentNumber: 'CN-2026-0001',
      fromHubId: 'hub_a',
      toHubId: 'hub_b',
      transportMode: 'linehaul_bus',
      carrierId: 'carrier_dar_mwanza',
      orderCount: 327,
      manifest: [
        { orderId: feedOrders[0]?.id ?? 'order_1', waybillNumber: 'WB-0001', section: 'standard', scannedIn: true, scannedOut: false },
        { orderId: feedOrders[1]?.id ?? 'order_2', waybillNumber: 'WB-0002', section: 'fragile', scannedIn: true, scannedOut: false },
      ],
      status: 'manifesting',
      scheduledDeparture: new Date(Date.now() + 2 * 3600_000).toISOString(),
      departedAt: null,
      arrivedAt: null,
      createdBy: 'dispatch_1',
      createdAt: nowIso(),
    },
  ];

  const packages: Package[] = [
    {
      id: 'pkg_1',
      packageId: 'PKG-7F92A8',
      shipmentId: 'sh_1',
      containerId: null,
      attributes: { temperature: 'ambient', fragile: false, hazardous: false, highValue: false, maxTransitHours: null, allowedModes: [], compatible: true, weightKg: 12, volumeL: 45 },
      status: 'prepared',
      scannedIn: false,
      scannedOut: false,
    },
    {
      id: 'pkg_heavy',
      packageId: 'PKG-HEAVY',
      shipmentId: 'sh_2',
      containerId: null,
      attributes: { temperature: 'ambient', fragile: false, hazardous: false, highValue: false, maxTransitHours: null, allowedModes: [], compatible: true, weightKg: 500, volumeL: 100 },
      status: 'prepared',
      scannedIn: false,
      scannedOut: false,
    },
    {
      id: 'pkg_bulky',
      packageId: 'PKG-BULKY',
      shipmentId: 'sh_3',
      containerId: null,
      attributes: { temperature: 'ambient', fragile: false, hazardous: false, highValue: false, maxTransitHours: null, allowedModes: [], compatible: true, weightKg: 5, volumeL: 4000 },
      status: 'prepared',
      scannedIn: false,
      scannedOut: false,
    },
  ];

  const orderRoutes = new Map<string, RouteSegment[]>();
  for (const o of feedOrders) {
    if (o.routeSegments) orderRoutes.set(o.id, o.routeSegments);
  }

  return {
    profile,
    feed,
    orders,
    pickupCodes,
    fares: new Map(),
    ledger,
    ledgerBalance: balance,
    balanceTZS: wallet.totalTZS,
    availableTZS: wallet.withdrawableTZS,
    payouts: [
      { id: 'po_1', status: 'paid', amountTZS: 125000, method: 'Mobile Money', createdAt: nowIso() },
      { id: 'po_2', status: 'processing', amountTZS: 62000, method: 'Mobile Money', createdAt: nowIso() },
    ],
    shifts: [],
    missions,
    notifications: [
      { id: 'ntf_1', type: 'order', title: 'New order offer', body: 'Sunrise Kitchen — 2.5 km · TZS 4,200', read: false, ts: nowIso(), deepLink: `/orders/${orders[0].id}` },
      { id: 'ntf_2', type: 'earnings', title: 'Earnings updated', body: 'Your statement is ready for this week', read: false, ts: nowIso(), deepLink: '/earnings' },
      { id: 'ntf_3', type: 'system', title: 'Shift reminder', body: 'Clock in to start your shift', read: true, ts: nowIso() },
      { id: 'ntf_4', type: 'warning', title: 'Low balance', body: 'Top up your wallet before the next shift', read: false, ts: nowIso(), deepLink: '/tickets/ntf_unknown' },
      { id: 'ntf_fac_grant', type: 'system', title: 'Facility access granted', body: 'You have been whitelisted for Green View Estate (whitelist_only)', read: false, ts: nowIso(), deepLink: null },
      { id: 'ntf_fac_revoke', type: 'system', title: 'Facility access revoked', body: 'Access revoked for Old Industrial Park', read: true, ts: new Date(Date.now() - 2 * 24 * 3600_000).toISOString(), deepLink: null },
    ],
    preferences: {
      soundNotifications: true,
      autoAccept: false,
      longDistance: true,
      wifiOnlyMaps: false,
      destinationFilters: [],
      language: 'en',
    },
    performance: {
      acceptanceRate: 88,
      onTimePct: 94,
      ratingAverage: 4.8,
      completedOrders: 128,
      earningsTZS: 845000,
      safetyScore: 92,
      behaviorScore: 78,
      reliabilityScore: profileFixture.reliabilityScore,
      level: 'gold',
      deliveryStreak: 6,
      securityScore: 90,
      avgPerTripTZS: 4200,
      topHours: ['11:00-13:00', '18:00-21:00'],
      onlineHoursWeek: 38,
      levelBenefits: ['Priority dispatch', 'Higher fare multiplier', 'Weekend bonus'],
      benchmarks: { teamAverage: 3.9, fleetAverage: 4.1, percentileRank: 82 },
      trends: [
        { label: 'Mon', value: 12 },
        { label: 'Tue', value: 15 },
        { label: 'Wed', value: 11 },
        { label: 'Thu', value: 18 },
        { label: 'Fri', value: 22 },
        { label: 'Sat', value: 26 },
        { label: 'Sun', value: 24 },
      ],
    },
    heatmap,
    tripSequence: null,
    completedTrip: null,
    rejectReasons: ['Restaurant too busy', 'Customer unreachable', 'Distance too far', 'Traffic', 'Other'],
    issueReasons: ['Customer unavailable', 'Wrong address', 'Order damaged', 'Address inaccessible', 'Payment issue', 'Other'],
    otpRequests: new Map(),
    otpCounter: 0,
    otpLastRequestAt: new Map(),
    podSubmitted: new Set(),
    shiftCodExpectedTZS: {},
    tickets: [],
    sosAlerts: [],
    sosLastSentAt: null,
    trustedContacts: [
      { id: 'contact_1', name: 'Neema Mwakyusa', phone: '+255712345678', relationship: 'sibling', notifiedOnSos: true, shareLocation: true },
      { id: 'contact_2', name: 'Baraka Joseph', phone: '+255713456789', relationship: 'friend', notifiedOnSos: true, shareLocation: false },
    ],
    security: {
      securityScore: 90,
      alerts: [
        { type: 'unusual_location', severity: 'medium', at: nowIso() },
        { type: 'unusual_login', severity: 'low', at: nowIso() },
      ],
    },
    shareTokens: {},
    maintenance,
    expenses,
    goals,
    training,
    exportJobs: [],
    deliveryExceptions: [],
    facilityWhitelist: [
      {
        facilityId: 'fac_green_view',
        facilityName: 'Green View Estate',
        policy: 'whitelist_only',
        grantedAt: nowIso(),
        revokedAt: null,
        status: 'granted',
        lastScanOutcome: { at: nowIso(), scanType: 'delivery', result: 'granted', requestId: 'req_fac_1' },
      },
      {
        facilityId: 'fac_old_industrial',
        facilityName: 'Old Industrial Park',
        policy: 'whitelist_or_otp',
        grantedAt: new Date(Date.now() - 5 * 24 * 3600_000).toISOString(),
        revokedAt: new Date(Date.now() - 2 * 24 * 3600_000).toISOString(),
        status: 'revoked',
        lastScanOutcome: { at: new Date(Date.now() - 1 * 24 * 3600_000).toISOString(), scanType: 'pickup', result: 'blocked', requestId: 'req_fac_block_1', code: 'NOT_WHITELISTED' },
      },
    ],
    facilityScans: [
      { facilityId: 'fac_green_view', facilityName: 'Green View Estate', at: nowIso(), result: 'granted', requestId: 'req_fac_1', code: undefined },
      { facilityId: 'fac_old_industrial', facilityName: 'Old Industrial Park', at: new Date(Date.now() - 1 * 24 * 3600_000).toISOString(), result: 'blocked', requestId: 'req_fac_block_1', code: 'NOT_WHITELISTED' },
    ],
    logisticsTrips,
    vehicles,
    packages,
    consignments,
    orderRoutes,
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

export const MOCK_PHONE = '+255700000000';

export function findOrder(orderId: string): OrderDetail {
  const order = state.orders.find((o) => o.id === orderId);
  if (!order) throw new ApiError(404, 'ORDER_NOT_FOUND', `Order ${orderId} not found`);
  return order;
}

export function trackFor(order: OrderDetail): TrackingEvent {
  return {
    status: order.status,
    riderLocation: state.profile.lastLocation ?? undefined,
    updatedAt: order.updatedAt ?? order.createdAt,
    estimateMinutes: order.deliveryEtaMin ?? 20,
  };
}

export function createMaskedCall(orderId: string): MaskedCallSession {
  return {
    sessionId: uid('call'),
    orderId,
    maskedNumber: '+2557' + String(Math.floor(100000000 + Math.random() * 900000000)),
    direction: 'rider_to_customer',
    expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
  };
}

export function creditDelivery(order: OrderDetail, amountTZS: number): LedgerEntry {
  state.balanceTZS += amountTZS;
  state.ledgerBalance += amountTZS;
  const entry: LedgerEntry = {
    id: uid('led'),
    type: 'delivery_fee',
    amountTZS,
    balanceTZS: state.ledgerBalance,
    referenceType: 'order',
    referenceId: order.id,
    createdAt: nowIso(),
  };
  state.ledger.push(entry);
  return entry;
}

export const ACTIVE_STATUSES: string[] = ['rider_assigned', 'rider_arrived_pickup', 'picked_up', 'delivering', 'rider_arrived_dropoff', 'rescheduled'];
export const TERMINAL_STATUSES: string[] = ['delivered', 'completed', 'failed_delivery', 'cancelled', 'refunded', 'timed_out', 'returning'];

/** Force an offer to expire (test helper) — sets the feed item's expiresAt in the past. */
export function expireOffer(orderId: string): void {
  const state = getState();
  const item = state.feed.find((i) => i.orderId === orderId);
  if (item) {
    item.expiresAt = Date.now() - 1;
    item.offer.expiresAt = new Date(item.expiresAt).toISOString();
  }
}

/** Add a delivered COD order's total to the active shift's expected cash collection. */
export function recordShiftCod(order: OrderDetail): void {
  const state = getState();
  const shift = state.shifts.find((s) => s.status === 'active');
  if (!shift) return;
  const cod = (state.fares.get(order.id)?.codFeeTZS ?? 0) > 0;
  if (!cod) return;
  state.shiftCodExpectedTZS[shift.id] = (state.shiftCodExpectedTZS[shift.id] ?? 0) + order.totals.totalTZS;
}

export function expectedShiftCod(shiftId: string): number {
  return getState().shiftCodExpectedTZS[shiftId] ?? 0;
}

/* ---------------- Batch trips (P10c) ---------------- */

/** Order status → stop status for a trip stop of the given type. */
function stopStatusFor(order: OrderDetail, stopType: 'pickup' | 'dropoff'): 'pending' | 'arrived' | 'done' | 'failed' {
  if (TERMINAL_STATUSES.includes(order.status)) {
    if (order.status === 'failed_delivery' || order.status === 'cancelled' || order.status === 'refunded' || order.status === 'timed_out' || order.status === 'returning') {
      return 'failed';
    }
    return 'done';
  }
  if (stopType === 'pickup') {
    if (order.status === 'rider_arrived_pickup') return 'arrived';
    if (order.status === 'picked_up' || order.status === 'delivering' || order.status === 'rider_arrived_dropoff') return 'done';
    return 'pending';
  }
  if (order.status === 'rider_arrived_dropoff') return 'arrived';
  if (order.status === 'delivered' || order.status === 'completed') return 'done';
  return 'pending';
}

/** Derive the batch trip for the current state. Returns null when the rider
 * has no trip orders. When the rider's last order leaves the active set the
 * trip is snapshotted as completed (trip.completed summary) and the active
 * trip no longer exists. */
export function buildTripFromState(): Trip | null {
  const state = getState();
  const active = state.orders.filter(
    (o) => o.riderId === state.profile.id && ACTIVE_STATUSES.includes(o.status),
  );
  if (active.length > 0) {
    if (state.tripSequence === null) {
      state.tripSequence = [...active].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)).map((o) => o.id);
    }
    const byId = new Map(active.map((o) => [o.id, o]));
    const sequence = state.tripSequence.filter((id) => byId.has(id));
    const stops = sequence.flatMap((orderId, i) => {
      const order = byId.get(orderId);
      if (!order) return [];
      return [
        { orderId, sequence: i * 2, stopType: 'pickup' as const, status: stopStatusFor(order, 'pickup') },
        { orderId, sequence: i * 2 + 1, stopType: 'dropoff' as const, status: stopStatusFor(order, 'dropoff') },
      ];
    });
    let earningsTZS = 0;
    for (const order of active) earningsTZS += state.fares.get(order.id)?.totalTZS ?? 0;
    return {
      id: 'trip_active',
      riderId: state.profile.id,
      orderIds: sequence,
      status: 'active',
      stops,
      routeOptimized: false,
      earningsTZS,
      startedAt: new Date(Math.min(...active.map((o) => Date.parse(o.acceptedAt ?? o.createdAt)))).toISOString(),
      completedAt: null,
    };
  }
  if (state.tripSequence !== null) {
    const byId = new Map(state.orders.map((o) => [o.id, o]));
    const sequence = state.tripSequence.filter((id) => byId.has(id));
    const stops = sequence.flatMap((orderId, i) => {
      const order = byId.get(orderId);
      if (!order) return [];
      return [
        { orderId, sequence: i * 2, stopType: 'pickup' as const, status: stopStatusFor(order, 'pickup') },
        { orderId, sequence: i * 2 + 1, stopType: 'dropoff' as const, status: stopStatusFor(order, 'dropoff') },
      ];
    });
    let earningsTZS = 0;
    for (const orderId of sequence) earningsTZS += state.fares.get(orderId)?.totalTZS ?? 0;
    const startedAt = new Date(
      Math.min(...sequence.map((id) => Date.parse(byId.get(id)?.createdAt ?? '')).filter((n) => !Number.isNaN(n)) || [Date.now()]),
    ).toISOString();
    const completedAt = new Date(
      Math.max(...sequence.map((id) => Date.parse(byId.get(id)?.completedAt ?? byId.get(id)?.updatedAt ?? '')).filter((n) => !Number.isNaN(n)) || [Date.now()]),
    ).toISOString();
    state.completedTrip = {
      id: 'trip_active',
      riderId: state.profile.id,
      orderIds: sequence,
      status: 'completed',
      stops,
      routeOptimized: false,
      earningsTZS,
      startedAt,
      completedAt,
    };
    state.tripSequence = null;
  }
  return null;
}