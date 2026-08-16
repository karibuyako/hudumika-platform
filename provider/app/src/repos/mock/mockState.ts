/* Shared in-memory state for the provider mock repositories.
 *
 * Module-level singleton, seeded deterministically from @hudumika/contract
 * fixtures (setFixturesSeed(20260813) at load). Tests call resetMockState()
 * between cases to restore the pristine seed.
 *
 * Mirrors the provider API surface: /auth, /providers/me, /availability,
 * /catalog, /services, /dispatch, /bookings, /technicians, /staff,
 * /certifications, /earnings, /notifications, /support, /reviews,
 * /inventory, /contracts, /plans, /trust, /copilot. Money is integer TZS
 * everywhere.
 */
import { fixtureAddress, fixtureCategory, fixtureProvider, setFixturesSeed } from '@hudumika/contract/fixtures';
import type {
  BookingDetail,
  BookingDetailEventsItem,
  BookingEstimate,
  BookingQuote,
  BookingQuoteStatus,
  BookingStatus,
  Certification,
  City,
  LedgerEntry,
  Notification,
  NotificationPreferences,
  PartsLine,
  PayoutSummary,
  PriceBreakdown,
  ProofOfService,
  ProviderInventoryItem,
  ProviderJobOffer,
  ProviderPrivate,
  ProviderService,
  ProviderStaff,
  ProviderStaffRole,
  Review,
  Service,
  ServiceCategoryConfig,
  ServiceContract,
  ServiceInvoice,
  ServicePlan,
  ServiceQuestion,
  ServiceWarranty,
  Technician,
  TicketDetail,
  TrustProfile,
  VerificationState,
  Wallet,
} from '@hudumika/contract';
import { ApiError } from '@/api/client';
import { uid } from '@/lib/format';

export const MOCK_SEED = 20260813;

setFixturesSeed(MOCK_SEED);

export const MOCK_PHONE = '+255700000000';

export const ALL_CAPABILITIES: string[] = [
  'view_all_jobs',
  'view_own_jobs',
  'accept_job',
  'reject_job',
  'view_customer_location',
  'contact_customer',
  'start_job',
  'submit_quote',
  'complete_job',
  'view_schedule',
  'assign_technician',
  'reassign_job',
  'monitor_live_jobs',
  'manage_staff',
  'manage_services',
  'manage_inventory',
  'view_earnings',
  'request_payout',
  'issue_invoice',
  'issue_warranty',
  'manage_certifications',
  'manage_contracts',
  'manage_plans',
  'view_trust',
  'use_copilot',
];

export const STAFF_ROLE_CAPABILITIES: Record<ProviderStaffRole, string[]> = {
  owner: ALL_CAPABILITIES,
  dispatcher: ['view_all_jobs', 'assign_technician', 'reassign_job', 'view_schedule', 'contact_customer', 'monitor_live_jobs'],
  technician: ['view_own_jobs', 'accept_job', 'reject_job', 'view_customer_location', 'contact_customer', 'start_job', 'submit_quote', 'complete_job'],
  supervisor: ['view_all_jobs', 'view_schedule', 'contact_customer', 'monitor_live_jobs'],
};

export const NOTIFICATION_EVENTS: string[] = [
  'booking.requested',
  'job.offered',
  'quote.requested',
  'booking.accepted',
  'job.assigned_technician',
  'booking.reminder',
  'job.reminder',
  'booking.arrived',
  'job.check_in',
  'job.paused',
  'job.resumed',
  'booking.completed',
  'booking.no_show',
  'job.escalated',
  'job.provider_late',
  'job.warranty_claimed',
  'recurring.booking_created',
  'sla.deadline_approaching',
  'quote.issued',
  'quote.decision',
  'invoice.issued',
  'warranty.issued',
  'warranty.claim_opened',
  'booking.followup_due',
  'payout.paid',
  'payout.failed',
  'payout.exception',
  'dispute.opened',
  'dispute.resolved',
  'review.received',
  'review.moderated',
  'ticket.reply',
  'lead.reviewed',
  'document.expiring',
  'document.expired',
  'trust.flag_raised',
];

const SYSTEM_NOTIFICATION_EVENTS = ['dispute.opened', 'trust.flag_raised', 'document.expiring', 'document.expired', 'booking.no_show', 'job.escalated'];

export interface OtpRequest {
  code: string;
  destination: string;
  purpose?: string;
  expiresAt: number;
}

export interface BookingDocs {
  quote?: BookingQuote;
  proof?: ProofOfService;
  invoice?: ServiceInvoice;
  warranty?: ServiceWarranty;
}

export interface MockState {
  profile: ProviderPrivate;
  capabilities: string[];
  bookings: BookingDetail[];
  marketplace: ProviderJobOffer[];
  technicians: Technician[];
  staff: ProviderStaff[];
  certifications: Certification[];
  ledger: LedgerEntry[];
  payouts: PayoutSummary[];
  wallet: Wallet;
  notifications: Notification[];
  preferences: NotificationPreferences;
  tickets: TicketDetail[];
  inventory: ProviderInventoryItem[];
  contracts: ServiceContract[];
  plans: ServicePlan[];
  trust: TrustProfile;
  services: ProviderService[];
  categories: ServiceCategoryConfig[];
  cities: City[];
  publicServices: Service[];
  questions: Map<string, ServiceQuestion[]>;
  reviews: Review[];
  reviewsByBooking: Map<string, Review>;
  otpRequests: Map<string, OtpRequest>;
  otpAttempts: Map<string, number[]>;
  otpCounter: number;
  pausedBookings: Map<string, string>;
  /** Bookings that passed the manual check-in fallback (geofence override). */
  checkInOverrides: Map<string, boolean>;
  bookingDocs: Map<string, BookingDocs>;
  quoteParts: Map<string, PartsLine[]>;
  /** Outcome the platform review applies after apply() (mock decision). */
  verificationDecision: VerificationState;
  copilotAvailable: boolean;
}

const iso = (ms: number) => new Date(ms).toISOString();

let mockBookingIndex = 0;

function buildBooking(
  providerId: string,
  opts: {
    status: BookingStatus;
    serviceId: string;
    scheduledFor: string;
    technicianId?: string | null;
    quoteStatus?: BookingQuoteStatus;
    description?: string;
    price?: PriceBreakdown;
    events?: BookingDetailEventsItem[];
    createdAt?: string;
  },
): BookingDetail {
  const createdAt = opts.createdAt ?? new Date(Date.now() - 3600_000).toISOString();
  const address = fixtureAddress();
  // Mock geofence anchor: pin service addresses to Dar es Salaam (~-6.79, 39.2)
  // with a tiny deterministic jitter so the simulated device position
  // (DEVICE_POS -6.79, 39.21 in the UI) sits inside the 2 km fence.
  address.lat = -6.79 + (mockBookingIndex % 4) * 0.0004;
  address.lon = 39.2 + (mockBookingIndex % 5) * 0.0004;
  mockBookingIndex += 1;
  return {
    id: uid('booking'),
    status: opts.status,
    providerId,
    serviceId: opts.serviceId,
    scheduledFor: opts.scheduledFor,
    technicianId: opts.technicianId ?? null,
    contractId: null,
    recurringPlanId: null,
    slaDeadlineAt: null,
    quoteStatus: opts.quoteStatus,
    price: opts.price,
    createdAt,
    updatedAt: createdAt,
    address,
    description: opts.description,
    events: opts.events ?? [{ status: opts.status, at: createdAt, by: 'system' }],
  };
}

function buildLedger(bookingSettledId: string, bookingDoneId: string): { ledger: LedgerEntry[]; balance: number } {
  const ledger: LedgerEntry[] = [];
  let balance = 0;
  const push = (type: LedgerEntry['type'], amountTZS: number, referenceType?: string, referenceId?: string) => {
    balance += amountTZS;
    ledger.push({
      id: uid('led'),
      type,
      amountTZS,
      balanceTZS: balance,
      referenceType,
      referenceId,
      createdAt: nowIso(),
    });
  };
  push('booking_earning', 350000, 'booking', bookingSettledId);
  push('commission', -35000, 'booking', bookingSettledId);
  push('booking_earning', 285000, 'booking', bookingDoneId);
  push('payout', -125000, 'payout', 'po_2');
  push('adjustment', 65000, 'payout', 'po_1');
  return { ledger, balance };
}

function buildPreferences(): NotificationPreferences {
  const channel = () => {
    const map: Record<string, boolean> = {};
    for (const key of NOTIFICATION_EVENTS) map[key] = key !== 'lead.reviewed';
    return map;
  };
  const system = () => {
    const map = channel();
    for (const key of SYSTEM_NOTIFICATION_EVENTS) map[key] = true;
    return map;
  };
  return { push: channel(), sms: channel(), email: channel(), inApp: system() };
}

function buildState(): MockState {
  const now = Date.now();
  const providerFixture = fixtureProvider();
  const profile: ProviderPrivate = {
    id: providerFixture.id,
    name: providerFixture.name,
    trade: providerFixture.trade,
    avatarUrl: providerFixture.avatarUrl,
    rating: 4.8,
    reviewCount: 142,
    verified: true,
    serviceAreas: ['Dar es Salaam'],
    baseRateTZS: 20000,
    verification: 'approved',
    payoutCycleDays: 7,
    bio: 'Licensed home services professional serving Dar es Salaam and Arusha',
    availability: [
      { dayOfWeek: 1, startTime: '08:00', endTime: '17:00', active: true },
      { dayOfWeek: 2, startTime: '08:00', endTime: '17:00', active: true },
      { dayOfWeek: 3, startTime: '08:00', endTime: '17:00', active: true },
      { dayOfWeek: 4, startTime: '08:00', endTime: '17:00', active: true },
      { dayOfWeek: 5, startTime: '08:00', endTime: '17:00', active: true },
      { dayOfWeek: 6, startTime: '09:00', endTime: '14:00', active: true },
      { dayOfWeek: 0, startTime: '09:00', endTime: '13:00', active: false },
    ],
  };

  const categories: ServiceCategoryConfig[] = [
    { ...fixtureCategory(), id: 'cat_plumbing', name: 'Plumbing', pricingModel: 'fixed', defaultDurationMinutes: 60, commissionBps: 1000, requiredSkills: ['Leak repair', 'Pipe fitting'], requiredCertifications: ['Plumbing License'], requiredPhotos: 1 },
    { ...fixtureCategory(), id: 'cat_electrical', name: 'Electrical', pricingModel: 'quote', defaultDurationMinutes: 60, commissionBps: 1200, requiredSkills: ['Socket wiring', 'Circuit testing'], requiredCertifications: ['Electrical Safety Certificate'], requiredPhotos: 2 },
    { ...fixtureCategory(), id: 'cat_cleaning', name: 'Cleaning', pricingModel: 'hourly', defaultDurationMinutes: 120, commissionBps: 800 },
  ];

  const questions: Map<string, ServiceQuestion[]> = new Map([
    ['cat_plumbing', [
      { key: 'leak_severity', label: 'How severe is the leak?', type: 'single_choice', required: true, options: ['Minor drip', 'Moderate flow', 'Major leak'] },
      { key: 'pipe_material', label: 'What is the pipe material?', type: 'single_choice', required: false, options: ['Copper', 'PVC', 'Galvanized', "Don't know"] },
      { key: 'leak_photo', label: 'Upload a photo of the issue', type: 'photo', required: false },
    ]],
    ['cat_electrical', [
      { key: 'fault_type', label: 'What type of electrical fault?', type: 'single_choice', required: true, options: ['No power', 'Frequent tripping', 'Sparks from socket', 'Other'] },
      { key: 'breaker_tripping', label: 'Is the circuit breaker tripping?', type: 'boolean', required: true },
      { key: 'socket_count', label: 'How many sockets need work?', type: 'number', required: false },
    ]],
    ['cat_cleaning', [
      { key: 'property_size', label: 'Property size', type: 'single_choice', required: true, options: ['1 bed', '2 bed', '3 bed', '4+ bed'] },
      { key: 'pets', label: 'Any pets at home?', type: 'boolean', required: false },
      { key: 'cleaning_type', label: 'Type of clean', type: 'multi_choice', required: false, options: ['Kitchen', 'Bathroom', 'Windows', 'Floors'] },
    ]],
  ]);
  for (const cat of categories) cat.questionnaireTemplate = questions.get(cat.id);

  const cities: City[] = [
    {
      id: 'city_dar',
      name: 'Dar es Salaam',
      country: 'Tanzania',
      serviceAreas: [
        { id: 'area_kinondoni', name: 'Kinondoni' },
        { id: 'area_ilala', name: 'Ilala' },
        { id: 'area_kariakoo', name: 'Kariakoo' },
      ],
    },
    {
      id: 'city_arusha',
      name: 'Arusha',
      country: 'Tanzania',
      serviceAreas: [
        { id: 'area_njiro', name: 'Njiro' },
        { id: 'area_sekei', name: 'Sekei' },
      ],
    },
  ];

  const publicServices: Service[] = [
    { id: 'svc_plumb_tap', category: 'cat_plumbing', name: 'Tap Repair', unit: 'per_visit' },
    { id: 'svc_plumb_pipe', category: 'cat_plumbing', name: 'Pipe Replacement', unit: 'per_item' },
    { id: 'svc_elec_socket', category: 'cat_electrical', name: 'Socket Installation', unit: 'per_item' },
    { id: 'svc_elec_rewire', category: 'cat_electrical', name: 'Rewiring', unit: 'per_hour' },
    { id: 'svc_clean_home', category: 'cat_cleaning', name: 'Home Deep Clean', unit: 'per_visit' },
  ];

  const services: ProviderService[] = [
    {
      id: 'srv_tap_repair',
      name: 'Tap Repair',
      description: 'Fix leaking taps and faucets',
      trade: 'Plumber',
      durationMinutes: 45,
      pricing: { baseTZS: 25000, perHourTZS: null, tripFeeTZS: 5000, partsIncluded: false },
      active: true,
      createdAt: nowIso(),
    },
    {
      id: 'srv_socket_install',
      name: 'Socket Installation',
      description: 'Install new power sockets',
      trade: 'Electrician',
      durationMinutes: 60,
      pricing: { baseTZS: 35000, perHourTZS: 20000, tripFeeTZS: 5000, partsIncluded: true },
      active: true,
      createdAt: nowIso(),
    },
    {
      id: 'srv_deep_clean',
      name: 'Home Deep Clean',
      description: 'Full home cleaning service',
      trade: 'Cleaner',
      durationMinutes: 120,
      pricing: { baseTZS: 40000, perHourTZS: 15000, tripFeeTZS: 0, partsIncluded: false },
      active: true,
      createdAt: nowIso(),
    },
  ];

  const bookingOfferedA = buildBooking(profile.id, {
    status: 'offered',
    serviceId: 'srv_tap_repair',
    scheduledFor: iso(now + 90 * 60_000),
    description: 'Kitchen tap leaking',
    createdAt: new Date(now - 2 * 60_000).toISOString(),
    events: [{ status: 'offered', at: new Date(now - 2 * 60_000).toISOString(), by: 'system', note: 'Matched to your area' }],
  });
  const bookingOfferedB = buildBooking(profile.id, {
    status: 'offered',
    serviceId: 'srv_tap_repair',
    scheduledFor: iso(now + 4 * 60_000),
    description: 'Bathroom faucet dripping',
    createdAt: new Date(now - 3 * 60_000).toISOString(),
    events: [{ status: 'offered', at: new Date(now - 3 * 60_000).toISOString(), by: 'system', note: 'Urgent — nearby customer' }],
  });
  const bookingQuote = buildBooking(profile.id, {
    status: 'quote_required',
    serviceId: 'srv_socket_install',
    scheduledFor: iso(now + 5 * 3600_000),
    quoteStatus: 'provisional',
    description: 'Install two power sockets in the living room',
    events: [{ status: 'quote_required', at: new Date(now - 30 * 60_000).toISOString(), by: 'system', note: 'Customer requested a quote' }],
  });
  const bookingNearbyA = buildBooking(profile.id, {
    status: 'provider_requested',
    serviceId: 'srv_tap_repair',
    scheduledFor: iso(now + 2 * 3600_000),
    description: 'Burst pipe under kitchen sink',
  });
  const bookingNearbyB = buildBooking(profile.id, {
    status: 'provider_requested',
    serviceId: 'srv_deep_clean',
    scheduledFor: iso(now + 3 * 3600_000),
    description: '3-bed home deep clean',
  });
  const bookingRecoA = buildBooking(profile.id, {
    status: 'provider_requested',
    serviceId: 'srv_tap_repair',
    scheduledFor: iso(now + 4 * 3600_000),
    description: 'Toilet running non-stop',
  });
  const bookingRecoB = buildBooking(profile.id, {
    status: 'provider_requested',
    serviceId: 'srv_socket_install',
    scheduledFor: iso(now + 6 * 3600_000),
    description: 'Replace three wall sockets',
  });
  const bookingScheduled = buildBooking(profile.id, {
    status: 'scheduled',
    serviceId: 'srv_tap_repair',
    scheduledFor: iso(now + 3 * 3600_000),
    description: 'Garden tap replacement',
    price: { subtotalTZS: 25000, deliveryFeeTZS: 0, platformFeeTZS: 2500, taxTZS: 4950, discountTZS: 0, totalTZS: 32450 },
    events: [
      { status: 'offered', at: new Date(now - 3 * 3600_000).toISOString(), by: 'system' },
      { status: 'provider_accepted', at: new Date(now - 3 * 3600_000).toISOString(), by: 'provider', note: 'Offer accepted' },
      { status: 'scheduled', at: new Date(now - 2 * 3600_000).toISOString(), by: 'system', note: 'Slot confirmed' },
    ],
  });
  const techBusy: Technician = {
    id: uid('tech'),
    name: 'Juma Mohamed',
    phone: '+255712345001',
    trade: 'Plumber',
    skills: ['Leak repair', 'Pipe fitting'],
    status: 'on_job',
    currentBookingId: null,
    certifications: [],
    rating: 4.7,
    createdAt: new Date(now - 200 * 24 * 3600_000).toISOString(),
  };
  const bookingProgress = buildBooking(profile.id, {
    status: 'in_progress',
    serviceId: 'srv_tap_repair',
    scheduledFor: iso(now - 30 * 60_000),
    technicianId: techBusy.id,
    description: 'Shower head and mixer repair',
    price: { subtotalTZS: 25000, deliveryFeeTZS: 0, platformFeeTZS: 2500, taxTZS: 4950, discountTZS: 0, totalTZS: 32450 },
    createdAt: new Date(now - 2 * 3600_000).toISOString(),
    events: [
      { status: 'offered', at: new Date(now - 2 * 3600_000).toISOString(), by: 'system' },
      { status: 'provider_accepted', at: new Date(now - 2 * 3600_000).toISOString(), by: 'provider' },
      { status: 'scheduled', at: new Date(now - 2 * 3600_000).toISOString(), by: 'system' },
      { status: 'en_route', at: new Date(now - 60 * 60_000).toISOString(), by: 'provider' },
      { status: 'provider_arrived', at: new Date(now - 45 * 60_000).toISOString(), by: 'provider' },
      { status: 'check_in', at: new Date(now - 44 * 60_000).toISOString(), by: 'provider' },
      { status: 'diagnosing', at: new Date(now - 40 * 60_000).toISOString(), by: 'provider' },
      { status: 'in_progress', at: new Date(now - 30 * 60_000).toISOString(), by: 'provider', note: 'Started repair' },
    ],
  });
  techBusy.currentBookingId = bookingProgress.id;
  const bookingDone = buildBooking(profile.id, {
    status: 'completed',
    serviceId: 'srv_tap_repair',
    scheduledFor: iso(now - 2 * 24 * 3600_000),
    description: 'Kitchen tap washer replacement',
    price: { subtotalTZS: 25000, deliveryFeeTZS: 0, platformFeeTZS: 2500, taxTZS: 4950, discountTZS: 0, totalTZS: 32450 },
    createdAt: new Date(now - 2 * 24 * 3600_000).toISOString(),
  });
  const bookingSettled = buildBooking(profile.id, {
    status: 'settled',
    serviceId: 'srv_deep_clean',
    scheduledFor: iso(now - 5 * 24 * 3600_000),
    description: 'Office deep clean',
    price: { subtotalTZS: 120000, deliveryFeeTZS: 0, platformFeeTZS: 12000, taxTZS: 23760, discountTZS: 0, totalTZS: 155760 },
    createdAt: new Date(now - 5 * 24 * 3600_000).toISOString(),
  });
  const bookingCancelled = buildBooking(profile.id, {
    status: 'provider_cancelled',
    serviceId: 'srv_tap_repair',
    scheduledFor: iso(now - 1 * 24 * 3600_000),
    description: 'Bathroom pipe repair',
    createdAt: new Date(now - 1 * 24 * 3600_000).toISOString(),
    events: [
      { status: 'offered', at: new Date(now - 1 * 24 * 3600_000).toISOString(), by: 'system' },
      { status: 'provider_accepted', at: new Date(now - 26 * 3600_000).toISOString(), by: 'provider' },
      { status: 'provider_cancelled', at: new Date(now - 25 * 3600_000).toISOString(), by: 'provider', note: 'Missing parts' },
    ],
  });

  const bookings: BookingDetail[] = [
    bookingOfferedA,
    bookingOfferedB,
    bookingQuote,
    bookingNearbyA,
    bookingNearbyB,
    bookingRecoA,
    bookingRecoB,
    bookingScheduled,
    bookingProgress,
    bookingDone,
    bookingSettled,
    bookingCancelled,
  ];

  const marketplace: ProviderJobOffer[] = [
    {
      bookingId: bookingNearbyA.id,
      kind: 'nearby',
      trade: 'Plumber',
      summary: 'Burst pipe under kitchen sink',
      photoCount: 3,
      distanceKm: 1.2,
      customerArea: 'Kinondoni',
      estimatedDurationMinutes: 90,
      estimateLowTZS: 20000,
      estimateHighTZS: 35000,
      urgency: 'standard',
      scheduledFor: iso(now + 2 * 3600_000),
      matchScore: 0.92,
      expiresAt: null,
      reasons: ['Close to your location', 'Matches your trade'],
    },
    {
      bookingId: bookingNearbyB.id,
      kind: 'nearby',
      trade: 'Cleaner',
      summary: '3-bed home deep clean',
      photoCount: 1,
      distanceKm: 2.4,
      customerArea: 'Ilala',
      estimatedDurationMinutes: 120,
      estimateLowTZS: 40000,
      estimateHighTZS: 60000,
      urgency: 'standard',
      scheduledFor: iso(now + 3 * 3600_000),
      matchScore: 0.78,
      expiresAt: null,
      reasons: ['Repeat customer area', 'Good match score'],
    },
    {
      bookingId: bookingRecoA.id,
      kind: 'recommended',
      trade: 'Plumber',
      summary: 'Toilet running non-stop',
      photoCount: 2,
      distanceKm: 3.1,
      customerArea: 'Kariakoo',
      estimatedDurationMinutes: 60,
      estimateLowTZS: 20000,
      estimateHighTZS: 35000,
      urgency: 'standard',
      scheduledFor: iso(now + 4 * 3600_000),
      matchScore: 0.85,
      expiresAt: null,
      reasons: ['High review provider matches', 'Similar completed jobs'],
    },
    {
      bookingId: bookingRecoB.id,
      kind: 'recommended',
      trade: 'Electrician',
      summary: 'Replace three wall sockets',
      photoCount: 4,
      distanceKm: 1.8,
      customerArea: 'Mikocheni',
      estimatedDurationMinutes: 90,
      estimateLowTZS: 35000,
      estimateHighTZS: 55000,
      urgency: 'standard',
      scheduledFor: iso(now + 6 * 3600_000),
      matchScore: 0.81,
      expiresAt: null,
      reasons: ['Customer asked for certified electrician'],
    },
    {
      bookingId: bookingOfferedA.id,
      kind: 'offer',
      trade: 'Plumber',
      summary: 'Kitchen tap leaking',
      photoCount: 2,
      distanceKm: 0.9,
      customerArea: 'Kinondoni',
      estimatedDurationMinutes: 45,
      estimateLowTZS: 20000,
      estimateHighTZS: 30000,
      urgency: 'standard',
      scheduledFor: iso(now + 90 * 60_000),
      matchScore: 0.95,
      expiresAt: iso(now + 20 * 60_000),
      reasons: ['High match score'],
    },
    {
      bookingId: bookingOfferedB.id,
      kind: 'offer',
      trade: 'Plumber',
      summary: 'Bathroom faucet dripping',
      photoCount: 1,
      distanceKm: 1.5,
      customerArea: 'Ilala',
      estimatedDurationMinutes: 45,
      estimateLowTZS: 20000,
      estimateHighTZS: 35000,
      urgency: 'urgent',
      scheduledFor: iso(now + 4 * 60_000),
      matchScore: 0.88,
      expiresAt: iso(now + 4 * 60_000),
      reasons: ['Expiring soon'],
    },
    {
      bookingId: bookingQuote.id,
      kind: 'quote_request',
      trade: 'Electrician',
      summary: 'Install two power sockets in the living room',
      photoCount: 3,
      distanceKm: 2.2,
      customerArea: 'Kinondoni',
      estimatedDurationMinutes: 60,
      estimateLowTZS: null,
      estimateHighTZS: null,
      urgency: 'standard',
      scheduledFor: iso(now + 5 * 3600_000),
      matchScore: 0.74,
      expiresAt: null,
      reasons: ['Quote requested by customer'],
    },
  ];

  const technicians: Technician[] = [
    { id: uid('tech'), name: 'Amina Hassan', phone: '+255712345000', trade: 'Plumber', skills: ['Tap repair', 'Pipe fitting'], status: 'idle', currentBookingId: null, certifications: [], rating: 4.9, createdAt: new Date(now - 300 * 24 * 3600_000).toISOString() },
    techBusy,
    { id: uid('tech'), name: 'Baraka Mushi', phone: '+255712345002', trade: 'Electrician', skills: ['Socket wiring', 'Testing'], status: 'offline', currentBookingId: null, certifications: [], rating: 4.5, createdAt: new Date(now - 120 * 24 * 3600_000).toISOString() },
  ];

  const staff: ProviderStaff[] = [
    { id: uid('stf'), name: profile.name, phone: MOCK_PHONE, role: 'owner', capabilities: [...ALL_CAPABILITIES], status: 'active', createdAt: new Date(now - 400 * 24 * 3600_000).toISOString() },
    { id: uid('stf'), name: 'Rashidi Ally', phone: '+255712345010', role: 'dispatcher', capabilities: [...STAFF_ROLE_CAPABILITIES.dispatcher], status: 'active', createdAt: new Date(now - 90 * 24 * 3600_000).toISOString() },
    { id: uid('stf'), name: 'Neema John', phone: '+255712345011', role: 'technician', capabilities: [...STAFF_ROLE_CAPABILITIES.technician], status: 'invited', createdAt: new Date(now - 2 * 24 * 3600_000).toISOString() },
  ];

  const certifications: Certification[] = [
    {
      id: uid('cert'),
      type: 'Plumbing License',
      number: 'TPL-2024-1187',
      issuer: 'NACTE',
      issuedAt: new Date(now - 300 * 24 * 3600_000).toISOString(),
      expiryDate: new Date(now + 65 * 24 * 3600_000).toISOString(),
      documentUrl: 'https://docs.example.com/cert/plumbing.pdf',
      verified: true,
      status: 'verified',
    },
    {
      id: uid('cert'),
      type: 'Electrical Safety Certificate',
      number: 'TEC-2021-0442',
      issuer: 'TANESCO',
      issuedAt: new Date(now - 800 * 24 * 3600_000).toISOString(),
      expiryDate: new Date(now - 30 * 24 * 3600_000).toISOString(),
      documentUrl: null,
      verified: false,
      status: 'expired',
    },
  ];

  const { ledger, balance } = buildLedger(bookingSettled.id, bookingDone.id);

  const payouts: PayoutSummary[] = [
    { id: 'po_1', amountTZS: 60000, status: 'pending', method: 'Mobile Money', createdAt: new Date(now - 3600_000).toISOString(), paidAt: null },
    { id: 'po_2', amountTZS: 125000, status: 'paid', method: 'Mobile Money', createdAt: new Date(now - 3 * 24 * 3600_000).toISOString(), paidAt: new Date(now - 2 * 24 * 3600_000).toISOString() },
    { id: 'po_3', amountTZS: 45000, status: 'exception', method: 'Mobile Money', createdAt: new Date(now - 5 * 24 * 3600_000).toISOString(), paidAt: null },
  ];

  const notifications: Notification[] = [
    { id: uid('ntf'), type: 'booking.requested', title: 'New booking request', body: 'Customer requested Tap Repair for later today', deepLink: `/jobs/${bookingOfferedA.id}`, read: false, createdAt: new Date(now - 2 * 60_000).toISOString() },
    { id: uid('ntf'), type: 'job.offered', title: 'Job offered to you', body: 'Bathroom faucet dripping — 1.5 km away', deepLink: `/jobs/${bookingOfferedB.id}`, read: false, createdAt: new Date(now - 3 * 60_000).toISOString() },
    { id: uid('ntf'), type: 'quote.requested', title: 'Quote requested', body: 'Customer wants a quote for socket installation', deepLink: `/jobs/${bookingQuote.id}`, read: false, createdAt: new Date(now - 30 * 60_000).toISOString() },
    { id: uid('ntf'), type: 'payout.paid', title: 'Payout sent', body: 'TZS 125,000 sent to your Mobile Money', deepLink: '/earnings', read: true, createdAt: new Date(now - 2 * 24 * 3600_000).toISOString() },
    { id: uid('ntf'), type: 'review.received', title: 'New review', body: 'Customer left you a 5-star review', deepLink: '/reviews', read: true, createdAt: new Date(now - 3 * 24 * 3600_000).toISOString() },
    { id: uid('ntf'), type: 'ticket.reply', title: 'Support replied', body: 'Our team replied to your payout ticket', deepLink: '/support', read: true, createdAt: new Date(now - 4 * 24 * 3600_000).toISOString() },
    { id: uid('ntf'), type: 'sla.deadline_approaching', title: 'SLA deadline approaching', body: 'Respond to the faucet offer before it expires', deepLink: `/jobs/${bookingOfferedB.id}`, read: false, createdAt: nowIso() },
    { id: uid('ntf'), type: 'booking.reminder', title: 'Job reminder', body: 'Socket installation starts in 1 hour', deepLink: `/jobs/${bookingScheduled.id}`, read: true, createdAt: new Date(now - 40 * 60_000).toISOString() },
    { id: uid('ntf'), type: 'trust.flag_raised', title: 'Trust flag raised', body: 'A risk flag was raised on your account — review and appeal if needed', deepLink: '/profile/trust', read: false, createdAt: new Date(now - 6 * 24 * 3600_000).toISOString() },
    { id: uid('ntf'), type: 'document.expiring', title: 'Certification expiring', body: 'Your Plumbing License expires soon — renew to keep listings active', deepLink: '/profile/certifications', read: true, createdAt: new Date(now - 7 * 24 * 3600_000).toISOString() },
  ];

  const tickets: TicketDetail[] = [
    {
      id: uid('ticket'),
      subject: 'Payout not received',
      status: 'open',
      priority: 'high',
      assignedAgentId: 'agent_1',
      createdAt: new Date(now - 6 * 3600_000).toISOString(),
      updatedAt: new Date(now - 3600_000).toISOString(),
      messages: [
        { id: uid('msg'), authorRole: 'provider', body: 'My payout from last week has not arrived.', createdAt: new Date(now - 6 * 3600_000).toISOString() },
        { id: uid('msg'), authorRole: 'agent', body: 'Thanks — we are investigating. Please share your payout ID.', createdAt: new Date(now - 3600_000).toISOString() },
      ],
    },
  ];

  const inventory: ProviderInventoryItem[] = [
    { id: uid('inv'), name: 'Tap washers 15mm', category: 'part', stockOnHand: 24, lowStockThreshold: 10, unitCostTZS: 1500, assignedTechnicianId: null, updatedAt: nowIso() },
    { id: uid('inv'), name: 'PVC pipe 25mm', category: 'part', stockOnHand: 4, lowStockThreshold: 10, unitCostTZS: 8500, assignedTechnicianId: null, updatedAt: nowIso() },
    { id: uid('inv'), name: 'Sealant tape', category: 'consumable', stockOnHand: 30, lowStockThreshold: 5, unitCostTZS: 2000, assignedTechnicianId: null, updatedAt: nowIso() },
    { id: uid('inv'), name: 'Pipe wrench 24"', category: 'tool', stockOnHand: 2, lowStockThreshold: 1, unitCostTZS: 45000, assignedTechnicianId: techBusy.id, updatedAt: nowIso() },
    { id: uid('inv'), name: 'Spare socket outlets', category: 'part', stockOnHand: 16, lowStockThreshold: 6, unitCostTZS: 12000, assignedTechnicianId: null, updatedAt: nowIso() },
  ];

  const contracts: ServiceContract[] = [
    {
      id: uid('ctr'),
      organizationName: 'Mlimani Towers Estate',
      locations: ['Dar es Salaam'],
      coveredServices: ['srv_tap_repair', 'srv_socket_install'],
      slaResponseMinutes: 60,
      slaResolutionMinutes: 240,
      pricing: { monthlyRetainerTZS: 350000 },
      coverageArea: ['Kinondoni'],
      workingHours: '08:00-17:00 Mon-Sat',
      escalationRules: 'Escalate to estate manager after 2 missed SLAs',
      status: 'active',
      createdAt: new Date(now - 30 * 24 * 3600_000).toISOString(),
    },
  ];

  const plans: ServicePlan[] = [
    {
      id: uid('plan'),
      name: 'Monthly maintenance',
      serviceId: 'srv_tap_repair',
      frequency: 'monthly',
      priceTZS: 80000,
      active: true,
      customerCount: 4,
      createdAt: new Date(now - 60 * 24 * 3600_000).toISOString(),
    },
  ];

  return {
    profile,
    capabilities: [...ALL_CAPABILITIES],
    bookings,
    marketplace,
    technicians,
    staff,
    certifications,
    ledger,
    payouts,
    wallet: { withdrawableTZS: 480000, pendingTZS: 60000, totalTZS: balance },
    notifications,
    preferences: buildPreferences(),
    tickets,
    inventory,
    contracts,
    plans,
    trust: { trustScore: 82, riskScore: 14, flags: ['off_platform_payment'], verifiedBadge: true, tier: 'silver' },
    services,
    categories,
    cities,
    publicServices,
    questions,
    reviews: [],
    reviewsByBooking: new Map(),
    otpRequests: new Map(),
    otpAttempts: new Map(),
    otpCounter: 0,
    pausedBookings: new Map(),
    checkInOverrides: new Map(),
    bookingDocs: new Map(),
    quoteParts: new Map(),
    copilotAvailable: true,
    verificationDecision: 'approved',
  };
}

export const nowIso = () => new Date().toISOString();

let state: MockState = buildState();
let decisionTimer: ReturnType<typeof setTimeout> | null = null;

export function getState(): MockState {
  return state;
}

/**
 * Mock verification decision (M1 "mock decision"): after a provider applies,
 * the platform reviews and decides. Default outcome is 'approved' (demo);
 * tests override `state.verificationDecision` before applying, or force the
 * decision synchronously via applyVerificationDecision().
 */
export function applyVerificationDecision(): void {
  const outcome = state.verificationDecision ?? 'approved';
  if (state.profile.verification === outcome) return;
  state.profile.verification = outcome;
  const notification: Notification = {
    id: uid('ntf'),
    type: 'lead.reviewed',
    title: outcome === 'approved' ? 'Application approved' : 'Application update',
    body: outcome === 'approved' ? 'Welcome — you can start receiving jobs now' : 'Reviewer requested changes to your application',
    deepLink: '/profile/settings',
    read: false,
    createdAt: nowIso(),
  };
  state.notifications.unshift(notification);
}

export function scheduleVerificationDecision(ms: number): void {
  if (decisionTimer) clearTimeout(decisionTimer);
  decisionTimer = setTimeout(() => {
    decisionTimer = null;
    applyVerificationDecision();
  }, ms);
}

export function resetMockState(): void {
  if (decisionTimer) clearTimeout(decisionTimer);
  decisionTimer = null;
  setFixturesSeed(MOCK_SEED);
  state = buildState();
}

/** Deep-clone a plain contract object so consumers can't mutate mock state. */
export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function requireCapability(cap: string): void {
  if (!getState().capabilities.includes(cap)) {
    throw new ApiError(403, 'CAPABILITY_FORBIDDEN', `Provider lacks capability: ${cap}`);
  }
}

export function findBooking(bookingId: string): BookingDetail {
  const booking = getState().bookings.find((b) => b.id === bookingId);
  if (!booking) throw new ApiError(404, 'BOOKING_NOT_FOUND', `Booking ${bookingId} not found`);
  return booking;
}

export function pushBookingEvent(booking: BookingDetail, status: BookingStatus, by: string, note?: string): void {
  booking.events.push({ status, at: nowIso(), by, note });
  booking.updatedAt = nowIso();
}

export function creditBookingEarning(bookingId: string, amountTZS: number): LedgerEntry {
  const current = getState();
  const balance = current.ledger.length > 0 ? current.ledger[current.ledger.length - 1].balanceTZS : 0;
  const entry: LedgerEntry = {
    id: uid('led'),
    type: 'booking_earning',
    amountTZS,
    balanceTZS: balance + amountTZS,
    referenceType: 'booking',
    referenceId: bookingId,
    createdAt: nowIso(),
  };
  current.ledger.push(entry);
  current.wallet.totalTZS += amountTZS;
  current.wallet.withdrawableTZS += amountTZS;
  return entry;
}

export function estimateForService(serviceId: string): BookingEstimate {
  if (!getState().services.some((s) => s.id === serviceId)) {
    throw new ApiError(404, 'ESTIMATE_UNAVAILABLE', `No estimate available for service ${serviceId}`);
  }
  return {
    serviceId,
    lowTZS: 20000,
    highTZS: 35000,
    tripFeeTZS: 5000,
    estimatedDurationMinutes: 60,
    disclaimer: 'Final quote may vary after on-site inspection',
  };
}
