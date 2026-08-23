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
  Consignment,
  DeliveryException,
  DeliveryExceptionKind,
  DispatchOffer,
  ExportRiderReport202,
  ExportRiderReportBody,
  FareBreakdown,
  GetRiderSecurity200,
  HeatmapZone,
  LedgerEntry,
  LogisticsTrip,
  MaskedCallSession,
  Order,
  OrderDetail,
  Package,
  ProofOfDelivery,
  RiderExpense,
  RiderGoals,
  RiderMission,
  RiderPerformance,
  RiderPreferences,
  RiderPrivate,
  RiderShift,
  RiderUpdate,
  RouteSegment,
  SosAlert,
  SosAlertType,
  Ticket,
  TicketCreateCategory,
  TrackingEvent,
  TrainingModule,
  Trip,
  TrustedContact,
  Vehicle,
  VehicleMaintenance,
} from '@hudumika/contract';
import type { FacilityWhitelistEntry, FacilityScan } from '@/lib/logistics';

/* ---------------- Auth ---------------- */

export interface OtpRequestResult {
  requestId: string;
  expiresInSeconds: number;
  /** Seconds to wait before requesting another code (mock + 429 details). */
  resendAfterSeconds?: number;
  /** Mock-only extension: the dev code shown in the UI. Never present live. */
  debugCode?: string;
  demo?: boolean;
}

export interface AuthSession {
  accessToken: string;
  /** Present on live sessions; mocks synthesize one. Persisted by the session store. */
  refreshToken?: string;
  user: { id: string; name?: string; phone: string; role: string };
  rider?: RiderPrivate;
}

export interface AuthRepository {
  requestOtp(destination: string, purpose?: 'login' | 'register'): Promise<OtpRequestResult>;
  verifyOtp(requestId: string, code: string, purpose?: 'login' | 'register'): Promise<AuthSession>;
  me(): Promise<{ user: { id: string; name?: string; phone: string; role: string }; rider: RiderPrivate | null }>;
  logout(): Promise<void>;
}

/* ---------------- Rider profile / shifts ---------------- */

export interface RiderRepository {
  getProfile(): Promise<RiderPrivate>;
  updateProfile(patch: RiderUpdate): Promise<RiderPrivate>;
  setAvailability(online: boolean): Promise<RiderPrivate>;
  reportLocation(lat: number, lon: number): Promise<void>;
  listRejectReasons(): Promise<string[]>;
  listIssueReasons(): Promise<string[]>;
  updateUserLocale(locale: 'en' | 'sw'): Promise<void>;
  getPerformance(): Promise<RiderPerformance>;
  listMissions(): Promise<RiderMission[]>;
  listShifts(scope: 'current' | 'history'): Promise<RiderShift[]>;
  clockIn(): Promise<RiderShift>;
  clockOut(shiftId: string, cash?: { cashCollectedTZS: number; cashReconciled: boolean }): Promise<RiderShift>;
  getPreferences(): Promise<RiderPreferences>;
  putPreferences(prefs: RiderPreferences): Promise<RiderPreferences>;
}

/* ---------------- Dispatch / jobs ---------------- */

export interface DispatchOfferFeedItem {
  orderId: string;
  offer: DispatchOffer;
  expiresAt: number;
}

export interface JobsRepository {
  listAvailableOrders(): Promise<DispatchOfferFeedItem[]>;
  getHeatmap(): Promise<HeatmapZone[]>;
  respondOffer(orderId: string, decision: 'accept' | 'reject', reason?: string): Promise<{ accepted: boolean; order?: Order }>;
}

/* ---------------- Delivery ---------------- */

export type RiderAdvanceableStatus =
  | 'rider_arrived_pickup'
  | 'picked_up'
  | 'delivering'
  | 'rider_arrived_dropoff'
  | 'delivered';

/** Options for DeliveryRepository.advance. The contract advance endpoint
 * accepts only {status, note?} — `pickupCode` is a mock-only simulation (the
 * live API repo never sends it). */
export interface AdvanceOrderOptions {
  /** Free-text note (contract field). Manual pickup confirmation records one. */
  note?: string;
  /** Mock-only merchant pickup code. Never sent to the live API. */
  pickupCode?: string;
}

export interface DeliveryRepository {
  listMyOrders(scope: 'active' | 'completed'): Promise<Order[]>;
  getOrder(orderId: string): Promise<OrderDetail>;
  track(orderId: string): Promise<TrackingEvent>;
  getFare(orderId: string): Promise<FareBreakdown>;
  advance(orderId: string, status: RiderAdvanceableStatus, opts?: AdvanceOrderOptions): Promise<Order>;
  submitPOD(orderId: string, pod: ProofOfDelivery): Promise<Order>;
  failDelivery(orderId: string, reason: string): Promise<Order>;
  reschedule(orderId: string, requestedSlot: string): Promise<Order>;
  transfer(orderId: string, reason: string): Promise<Order>;
  createMaskedCall(orderId: string): Promise<MaskedCallSession>;
}

/* ---------------- Earnings ---------------- */

export interface PayoutSummary {
  availableBalanceTZS: number;
  pendingTZS: number;
  payouts: {
    id: string;
    status: 'pending' | 'processing' | 'paid' | 'failed' | 'exception';
    amountTZS: number;
    method: string;
    createdAt: string;
  }[];
}

export interface EarningsRepository {
  getTodaySummary(): Promise<{ earningsTZS: number; deliveries: number; onlineMinutes: number }>;
  getStatement(from?: string, to?: string): Promise<LedgerEntry[]>;
  getWallet(): Promise<{ balanceTZS: number; availableTZS: number }>;
  listPayouts(): Promise<PayoutSummary['payouts']>;
  requestPayout(amountTZS: number): Promise<void>;
}

/* ---------------- Notifications ---------------- */

export interface NotificationItem {
  id: string;
  type: 'order' | 'earnings' | 'system' | 'warning';
  title: string;
  body: string;
  read: boolean;
  ts: string;
  /** Contract Notification.deepLink — navigate only on known patterns. */
  deepLink?: string | null;
}

export interface NotificationsRepository {
  list(): Promise<NotificationItem[]>;
  markRead(id: string): Promise<void>;
  markAllRead(): Promise<void>;
}

/* ---------------- Payments (COD collection QR) ---------------- */

export interface PaymentQrResult {
  qrPayload: string;
  provider: string;
  /** null = variable amount */
  amountTZS: number | null;
  merchantRef: string;
  expiresAt: string;
}

export interface PaymentRepository {
  /** POST /payments/qr — collection QR the customer scans to pay. The rider
   * app never collects mobile-money details. */
  createCollectionQr(orderId: string, opts?: { amountTZS?: number }): Promise<PaymentQrResult>;
}

/* ---------------- Safety ---------------- */

export interface SafetyRepository {
  createSos(input: { type: SosAlertType; note?: string; lat?: number; lon?: number }): Promise<SosAlert>;
  listTrustedContacts(): Promise<TrustedContact[]>;
  addTrustedContact(contact: TrustedContact): Promise<TrustedContact>;
  removeTrustedContact(contactId: string): Promise<void>;
  getSecurityScore(): Promise<GetRiderSecurity200>;
  shareTrip(orderId: string, recipients: string[], includeRoute?: boolean): Promise<{ shareToken: string; expiresAt: string }>;
}

/* ---------------- Support ---------------- */

export interface SupportRepository {
  createTicket(subject: string, body: string, category?: TicketCreateCategory, orderId?: string): Promise<Ticket>;
  listTickets(): Promise<Ticket[]>;
}

/* ---------------- Batch trips (P10c) ---------------- */

export interface TripsRepository {
  /** GET /riders/me/trips — active batch trip; 404 → null (no active trip). */
  getActiveTrip(): Promise<Trip | null>;
  /** GET /riders/me/trips/{tripId} */
  getTrip(tripId: string): Promise<Trip>;
  /** POST /riders/me/trips/{tripId}/reorder {orderIds} — 409 on completed trip
   * or a sequence that is not a subset of the trip's orders. */
  reorderStops(tripId: string, orderIds: string[]): Promise<Trip>;
}

/* ---------------- Vehicle tools ---------------- */

export interface VehicleRepository {
  listMaintenance(): Promise<VehicleMaintenance[]>;
  createMaintenance(record: VehicleMaintenance): Promise<VehicleMaintenance>;
  listExpenses(from?: string, to?: string): Promise<RiderExpense[]>;
  createExpense(expense: RiderExpense): Promise<RiderExpense>;
  getGoals(): Promise<RiderGoals>;
  putGoals(goals: RiderGoals): Promise<RiderGoals>;
  requestExport(body: ExportRiderReportBody): Promise<ExportRiderReport202>;
  listTraining(): Promise<TrainingModule[]>;
  completeTraining(moduleId: string): Promise<TrainingModule>;
}

/* ---------------- Logistics (facility/shipments) — gated via MOCK_LOGISTICS ---------------- */

export interface LogisticsRepository {
  getFacilityStatus(): Promise<{ entries: FacilityWhitelistEntry[]; lastScanOutcomes: FacilityScan[] }>;
  scanAtFacility(facilityId: string): Promise<{ granted: boolean; requestId: string }>;
  createException(input: { kind: DeliveryExceptionKind; description: string }): Promise<DeliveryException>;
  getException(id: string): Promise<DeliveryException>;
  listExceptions(filter?: { kind?: string; status?: string }): Promise<DeliveryException[]>;
  updateException(id: string, patch: { status: string; outcome?: string | null }): Promise<DeliveryException>;
  getVehicle(vehicleId: string): Promise<Vehicle>;
  listVehicles(): Promise<Vehicle[]>;
  getPackage(packageId: string): Promise<Package>;
  getLogisticsTrip(tripId: string): Promise<LogisticsTrip>;
  listLogisticsTrips(): Promise<LogisticsTrip[]>;
  getConsignment(consignmentId: string): Promise<Consignment>;
  listConsignments(): Promise<Consignment[]>;
  getOrderRoute(orderId: string): Promise<RouteSegment[]>;
  checkVehicleCapacity(vehicleId: string, packageId: string): Promise<void>;
}

export { getAuthRepository, getRiderRepository, getJobsRepository, getDeliveryRepository, getEarningsRepository, getNotificationsRepository, getSupportRepository, getSafetyRepository, getVehicleRepository, getPaymentRepository, getTripsRepository, getLogisticsRepository } from './factories';