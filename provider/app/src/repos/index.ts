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
  AvailabilityWindow,
  Booking,
  BookingDetail,
  BookingEstimate,
  BookingQuote,
  BookingStatus,
  Certification,
  City,
  GetProviderDispatchConsole200,
  LedgerStatement,
  ListProviderCapabilities200,
  Notification,
  NotificationPreferences,
  PayoutSummary,
  ProofOfServiceType,
  ProviderApplication,
  ProviderJobOffer,
  ProviderPrivate,
  ProviderService,
  ProviderStaff,
  ProviderUpdate,
  RoleSummary,
  Service,
  ServiceCategoryConfig,
  ServiceContract,
  ServiceInvoice,
  ServicePlan,
  ServiceQuestion,
  ServiceWarranty,
  Technician,
  Ticket,
  TicketCreate,
  TicketDetail,
  TrustProfile,
  ProviderInventoryItem,
  ProviderCopilot200,
  Review,
  ReviewCreate,
  PartsLine,
  Wallet,
} from '@hudumika/contract';

/* ---------------- Auth ---------------- */

export interface OtpRequestResult {
  requestId: string;
  expiresInSeconds: number;
  /** Mock-only extension: the dev code shown in the UI. Never present live. */
  debugCode?: string;
  demo?: boolean;
}

export interface AuthSession {
  accessToken: string;
  refreshToken?: string;
  user: { id: string; name?: string; phone: string; role: string };
  provider?: ProviderPrivate | null;
}

export interface AuthRepository {
  requestOtp(destination: string, purpose?: 'login' | 'register' | 'verify_role'): Promise<OtpRequestResult>;
  verifyOtp(requestId: string, code: string, purpose?: 'login' | 'register' | 'verify_role'): Promise<AuthSession>;
  me(): Promise<{ user: { id: string; name?: string; phone: string; role: string }; provider: ProviderPrivate | null }>;
  capabilities(): Promise<ListProviderCapabilities200>;
  roles(): Promise<RoleSummary[]>;
  logout(): Promise<void>;
}

/* ---------------- Provider profile / onboarding ---------------- */

export interface ProviderRepository {
  getProfile(): Promise<ProviderPrivate>;
  apply(payload: ProviderApplication): Promise<{ status: 'submitted' | 'under_review' }>;
  updateProfile(patch: ProviderUpdate): Promise<ProviderPrivate>;
  getCapabilities(): Promise<ListProviderCapabilities200>;
}

/* ---------------- Availability ---------------- */

export interface AvailabilityRepository {
  getAvailability(): Promise<AvailabilityWindow[]>;
  /** Full replace semantics — PUT /providers/me/availability → 204. */
  putAvailability(windows: AvailabilityWindow[]): Promise<void>;
}

/* ---------------- Service catalog & lookups ---------------- */

export interface CatalogRepository {
  listCities(): Promise<City[]>;
  listServices(cityId?: string): Promise<Service[]>;
  listCategories(): Promise<ServiceCategoryConfig[]>;
  listQuestions(categoryId: string): Promise<ServiceQuestion[]>;
}

export interface ServicesRepository {
  list(): Promise<ProviderService[]>;
  create(input: ProviderService): Promise<ProviderService>;
  update(serviceId: string, input: Partial<ProviderService>): Promise<ProviderService>;
  remove(serviceId: string): Promise<void>;
  getEstimate(serviceId: string, area?: string): Promise<BookingEstimate>;
}

/* ---------------- Dispatch / marketplace ---------------- */

export interface DispatchOfferFeedItem {
  job: ProviderJobOffer;
  expiresAt: number | null;
}

export interface DispatchRepository {
  listProviderJobs(kind: string, trade?: string): Promise<ProviderJobOffer[]>;
  acceptOffer(bookingId: string): Promise<BookingDetail>;
  getConsole(): Promise<GetProviderDispatchConsole200>;
  assignTechnician(bookingId: string, technicianId: string, note?: string): Promise<BookingDetail>;
}

/* ---------------- Bookings ---------------- */

export interface BookingsRepository {
  listMyBookings(status?: BookingStatus): Promise<Booking[]>;
  getBooking(bookingId: string): Promise<BookingDetail>;
  accept(bookingId: string): Promise<BookingDetail>;
  decline(bookingId: string, reason?: string): Promise<void>;
  advance(bookingId: string, status: BookingStatus, note?: string): Promise<BookingDetail>;
  complete(bookingId: string): Promise<BookingDetail>;
  cancel(bookingId: string, reason: string): Promise<void>;
  checkIn(bookingId: string, lat: number, lon: number): Promise<BookingDetail>;
  pause(bookingId: string, reason: string): Promise<BookingDetail>;
  resume(bookingId: string): Promise<BookingDetail>;
  submitQuote(bookingId: string, quote: BookingQuote): Promise<BookingDetail>;
  decideQuote(bookingId: string, decision: 'approved' | 'declined', note?: string): Promise<BookingDetail>;
  submitProof(bookingId: string, type: ProofOfServiceType, value: string): Promise<BookingDetail>;
  addParts(bookingId: string, parts: PartsLine[]): Promise<BookingDetail>;
  issueInvoice(bookingId: string, laborTZS: number, discountTZS?: number, note?: string): Promise<ServiceInvoice>;
  issueWarranty(bookingId: string, validDays: number, coverage?: string, followUpAt?: string): Promise<ServiceWarranty>;
  getInvoice(bookingId: string): Promise<ServiceInvoice | null>;
  getWarranty(bookingId: string): Promise<ServiceWarranty | null>;
  getEstimatePreview(bookingId: string): Promise<BookingEstimate>;
}

/* ---------------- Technicians ---------------- */

export interface TechniciansRepository {
  list(): Promise<Technician[]>;
  create(input: Technician): Promise<Technician>;
  update(technicianId: string, input: Partial<Technician>): Promise<Technician>;
  remove(technicianId: string): Promise<void>;
}

/* ---------------- Staff & certifications ---------------- */

export interface StaffRepository {
  list(): Promise<ProviderStaff[]>;
  invite(input: ProviderStaff): Promise<ProviderStaff>;
  update(staffId: string, input: Partial<ProviderStaff>): Promise<ProviderStaff>;
  remove(staffId: string): Promise<void>;
}

export interface CertificationsRepository {
  list(): Promise<Certification[]>;
  create(input: Certification): Promise<Certification>;
  update(certificationId: string, input: Partial<Certification>): Promise<Certification>;
}

/* ---------------- Earnings ---------------- */

export interface EarningsRepository {
  listPayouts(): Promise<PayoutSummary[]>;
  getStatement(from?: string, to?: string): Promise<LedgerStatement>;
  getWallet(): Promise<Wallet>;
  requestPayout(amountTZS: number): Promise<void>;
}

/* ---------------- Notifications ---------------- */

export interface NotificationsRepository {
  list(cursor?: string, unreadOnly?: boolean): Promise<{ items: Notification[]; nextCursor?: string }>;
  markRead(id: string): Promise<void>;
  markAllRead(): Promise<void>;
  getPreferences(): Promise<NotificationPreferences>;
  putPreferences(prefs: NotificationPreferences): Promise<NotificationPreferences>;
}

/* ---------------- Support ---------------- */

export interface SupportRepository {
  create(input: TicketCreate): Promise<Ticket>;
  list(): Promise<Ticket[]>;
  get(ticketId: string): Promise<TicketDetail>;
  reply(ticketId: string, body: string): Promise<TicketDetail>;
}

/* ---------------- Reviews ---------------- */

export interface ReviewsRepository {
  createForCustomer(bookingId: string, review: ReviewCreate): Promise<Review>;
  report(reviewId: string, reason: string): Promise<void>;
  /** Received reviews — blocked until GET /reviews/me lands (Team 6 gate). */
  listReceived(): Promise<never>;
}

/* ---------------- Inventory / contracts / plans / trust / copilot ---------------- */

export interface InventoryRepository {
  list(): Promise<ProviderInventoryItem[]>;
  create(input: ProviderInventoryItem): Promise<ProviderInventoryItem>;
  adjust(itemId: string, delta: number, reason: string): Promise<ProviderInventoryItem>;
}

export interface ContractsRepository {
  list(): Promise<ServiceContract[]>;
  create(input: ServiceContract): Promise<ServiceContract>;
}

export interface PlansRepository {
  list(): Promise<ServicePlan[]>;
  create(input: ServicePlan): Promise<ServicePlan>;
  update(planId: string, input: Partial<ServicePlan>): Promise<ServicePlan>;
}

export interface TrustRepository {
  get(): Promise<TrustProfile>;
}

export interface CopilotRepository {
  ask(action: string, input: { bookingId?: string; jobSummary?: string; historyMonths?: number }): Promise<ProviderCopilot200>;
}

export interface KycRepository {
  verify(input: { nidaNumber: string; selfieCaptured: boolean }): Promise<import('@/lib/kyc').KycVerification>;
}

/* ---------------- Factories ---------------- */

export {
  getAuthRepository,
  getProviderRepository,
  getAvailabilityRepository,
  getCatalogRepository,
  getServicesRepository,
  getDispatchRepository,
  getBookingsRepository,
  getTechniciansRepository,
  getStaffRepository,
  getCertificationsRepository,
  getEarningsRepository,
  getNotificationsRepository,
  getSupportRepository,
  getReviewsRepository,
  getInventoryRepository,
  getContractsRepository,
  getPlansRepository,
  getTrustRepository,
  getCopilotRepository,
  getKycRepository,
} from './factories';
