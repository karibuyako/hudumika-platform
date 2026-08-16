/* In-memory bookings repository — the provider-side booking state machine.
 *
 * Mirrors GET /providers/me/bookings, GET /bookings/{id}, POST accept/decline/
 * cancel/check-in/pause/resume, POST advance, POST complete, POST quote submit
 * + decision, POST proof, POST parts, POST invoice, POST warranty and the
 * estimate preview against module state in mockState.ts.
 *
 * Status transitions are validated against a strict table (else 409
 * BOOKING_STATUS_CONFLICT). Quote jobs are marked by quoteStatus ===
 * 'provisional' on the BookingDetail. getBooking auto-confirms
 * awaiting_customer_confirmation → completed (customer side) and layers the
 * mock-only extensions (paused, proof, invoice, warranty) on top via
 * ProviderBookingExt. Advancing completed → settled credits the ledger through
 * creditBookingEarning().
 */
import { ApiError } from '@/api/client';
import { clone, creditBookingEarning, findBooking, getState, nowIso, pushBookingEvent, requireCapability, estimateForService } from './mockState';
import { uid } from '@/lib/format';
import type { BookingsRepository } from '../index';
import type {
  Booking,
  BookingDetail,
  BookingEstimate,
  BookingQuote,
  BookingStatus,
  PartsLine,
  ProofOfService,
  ProofOfServiceType,
  ServiceInvoice,
  ServiceWarranty,
} from '@hudumika/contract';

export type ProviderBookingExt = BookingDetail & {
  paused?: boolean;
  proof?: ProofOfService;
  invoice?: ServiceInvoice;
  warranty?: ServiceWarranty;
  /** True after the first out-of-geofence check-in attempt (manual fallback). */
  manualOverride?: boolean;
};

/** Geofence radius for check-in (km). */
const GEO_FENCE_KM = 2;

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(a));
}

const TRANSITIONS: Record<string, BookingStatus[]> = {
  offered: ['provider_accepted'],
  provider_requested: ['provider_accepted'],
  provider_accepted: ['scheduled'],
  scheduled: ['en_route', 'reminder_sent'],
  reminder_sent: ['en_route'],
  en_route: ['provider_arrived'],
  provider_arrived: ['check_in'],
  check_in: ['diagnosing', 'in_progress'],
  diagnosing: ['in_progress', 'quote_required'],
  quote_required: ['quote_submitted'],
  quote_submitted: ['quote_accepted'],
  quote_accepted: ['in_progress'],
  in_progress: ['completion_review'],
  completion_review: ['awaiting_customer_confirmation'],
  awaiting_customer_confirmation: ['completed'],
  completed: ['settled'],
  settled: ['warranty'],
  warranty: [],
  declined: [],
  cancelled: [],
  customer_cancelled: [],
  provider_cancelled: [],
  refunded: [],
  disputed: [],
  escalated: [],
  reassignment: [],
  no_show: [],
  provider_late: [],
  draft: [],
  pending_payment: [],
  paid: [],
  validating: [],
  matching: [],
};

const INVOICE_ISSUABLE: BookingStatus[] = ['in_progress', 'completion_review', 'awaiting_customer_confirmation', 'completed', 'settled', 'warranty'];
const WARRANTY_ISSUABLE: BookingStatus[] = ['completed', 'settled', 'warranty'];
const CANCELLABLE: BookingStatus[] = ['offered', 'provider_requested', 'provider_accepted', 'scheduled', 'en_route', 'provider_arrived', 'check_in'];
const PARTS_ALLOWED: BookingStatus[] = ['diagnosing', 'in_progress', 'completion_review'];
const PAUSABLE: BookingStatus[] = ['in_progress', 'completion_review'];

function docsFor(bookingId: string) {
  const state = getState();
  let docs = state.bookingDocs.get(bookingId);
  if (!docs) {
    docs = {};
    state.bookingDocs.set(bookingId, docs);
  }
  return docs;
}

function toExt(booking: BookingDetail): ProviderBookingExt {
  const state = getState();
  const docs = state.bookingDocs.get(booking.id);
  return {
    ...clone(booking),
    paused: state.pausedBookings.has(booking.id),
    proof: docs?.proof,
    invoice: docs?.invoice,
    warranty: docs?.warranty,
    manualOverride: state.checkInOverrides.has(booking.id),
  };
}

export class MockBookingsRepository implements BookingsRepository {
  async listMyBookings(status?: BookingStatus): Promise<Booking[]> {
    const all = getState().bookings;
    const filtered = status ? all.filter((b) => b.status === status) : all;
    return clone([...filtered].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)));
  }

  async getBooking(bookingId: string): Promise<ProviderBookingExt> {
    const booking = findBooking(bookingId);
    if (booking.status === 'awaiting_customer_confirmation') {
      booking.status = 'completed';
      pushBookingEvent(booking, 'completed', 'customer', 'Customer confirmed completion');
    }
    // On-site payment awareness (webhook simulation, never a client callback):
    // a settled booking's issued invoice is paid.
    if (['completed', 'settled', 'warranty'].includes(booking.status)) {
      const invoice = getState().bookingDocs.get(bookingId)?.invoice;
      if (invoice && invoice.status === 'issued') invoice.status = 'paid';
    }
    return toExt(booking);
  }

  async accept(bookingId: string): Promise<BookingDetail> {
    const state = getState();
    const booking = findBooking(bookingId);
    if (!['offered', 'provider_requested', 'quote_required'].includes(booking.status)) {
      if (booking.status === 'provider_accepted') {
        throw new ApiError(409, 'BOOKING_ALREADY_ACCEPTED', 'This booking has already been accepted');
      }
      throw new ApiError(409, 'JOB_OFFER_EXPIRED', 'This offer has expired');
    }
    const index = state.marketplace.findIndex((j) => j.bookingId === bookingId);
    if (index >= 0) state.marketplace.splice(index, 1);
    booking.status = 'provider_accepted';
    booking.technicianId = null;
    pushBookingEvent(booking, 'provider_accepted', 'provider', 'Offer accepted');
    return this.getBooking(bookingId);
  }

  async decline(bookingId: string, reason?: string): Promise<void> {
    const state = getState();
    const booking = findBooking(bookingId);
    if (!['offered', 'provider_requested', 'quote_required'].includes(booking.status)) {
      throw new ApiError(409, 'BOOKING_NOT_DECLINABLE', 'This booking can no longer be declined');
    }
    const index = state.marketplace.findIndex((j) => j.bookingId === bookingId);
    if (index >= 0) state.marketplace.splice(index, 1);
    booking.status = 'declined';
    pushBookingEvent(booking, 'declined', 'provider', reason ?? 'Declined by provider');
  }

  async advance(bookingId: string, status: BookingStatus, note?: string): Promise<BookingDetail> {
    const booking = findBooking(bookingId);
    if (booking.status === status) return this.getBooking(bookingId);
    const isQuoteJob = booking.quoteStatus !== undefined;
    let legal = (TRANSITIONS[booking.status] ?? []).includes(status);
    if (booking.status === 'diagnosing') {
      if (status === 'in_progress' && isQuoteJob) legal = false;
      if (status === 'quote_required' && !isQuoteJob) legal = false;
    }
    // Simple jobs (no quote gate) skip diagnosing: check_in → in_progress directly.
    if (booking.status === 'check_in') {
      if (status === 'diagnosing' && !isQuoteJob) legal = false;
      if (status === 'in_progress' && isQuoteJob) legal = false;
    }
    if (!legal) {
      throw new ApiError(409, 'BOOKING_STATUS_CONFLICT', `Cannot move booking from ${booking.status} to ${status}`);
    }
    booking.status = status;
    pushBookingEvent(booking, status, 'provider', note);
    if (status === 'settled') {
      const docs = getState().bookingDocs.get(bookingId);
      const invoice = docs?.invoice;
      const total = invoice?.totalTZS ?? booking.price?.totalTZS ?? 0;
      if (total > 0) creditBookingEarning(bookingId, total);
      // On-site payment awareness: the webhook (never a client callback) flips
      // the issued invoice to paid once the booking settles.
      if (invoice && invoice.status === 'issued') {
        invoice.status = 'paid';
        invoice.issuedAt = invoice.issuedAt ?? new Date().toISOString();
      }
    }
    return this.getBooking(bookingId);
  }

  async complete(bookingId: string): Promise<BookingDetail> {
    const booking = findBooking(bookingId);
    if (booking.status !== 'completion_review') {
      throw new ApiError(409, 'BOOKING_STATUS_CONFLICT', 'Booking must be in completion review before completing');
    }
    if (!getState().bookingDocs.get(bookingId)?.proof) {
      throw new ApiError(409, 'PROOF_OF_SERVICE_INVALID', 'Proof of service required before completing');
    }
    booking.status = 'awaiting_customer_confirmation';
    pushBookingEvent(booking, 'awaiting_customer_confirmation', 'provider', 'Work completed, awaiting customer confirmation');
    return toExt(booking);
  }

  async cancel(bookingId: string, reason: string): Promise<void> {
    const state = getState();
    const booking = findBooking(bookingId);
    if (!CANCELLABLE.includes(booking.status)) {
      throw new ApiError(409, 'BOOKING_NOT_CANCELLABLE', 'This booking can no longer be cancelled');
    }
    const index = state.marketplace.findIndex((j) => j.bookingId === bookingId);
    if (index >= 0) state.marketplace.splice(index, 1);
    booking.status = 'provider_cancelled';
    pushBookingEvent(booking, 'provider_cancelled', 'provider', reason);
  }

  async checkIn(bookingId: string, lat: number, lon: number): Promise<BookingDetail> {
    const state = getState();
    const booking = findBooking(bookingId);
    if (booking.status !== 'provider_arrived') {
      throw new ApiError(409, 'CHECK_IN_NOT_ALLOWED', booking.status === 'check_in' ? 'You are already checked in' : 'Check-in is only allowed after arriving');
    }
    const { lat: addrLat, lon: addrLon } = booking.address;
    const overridden = state.checkInOverrides.has(bookingId);
    // Geofence: the first attempt outside the radius is rejected and records a
    // manual-override flag; the retry (manual fallback) is accepted.
    if (!overridden && typeof addrLat === 'number' && typeof addrLon === 'number' && haversineKm(lat, lon, addrLat, addrLon) > GEO_FENCE_KM) {
      state.checkInOverrides.set(bookingId, true);
      throw new ApiError(409, 'CHECK_IN_NOT_ALLOWED', 'You are outside the service location geofence');
    }
    booking.status = 'check_in';
    pushBookingEvent(booking, 'check_in', 'provider', `Checked in at ${lat.toFixed(4)}, ${lon.toFixed(4)}`);
    return this.getBooking(bookingId);
  }

  async pause(bookingId: string, reason: string): Promise<BookingDetail> {
    const booking = findBooking(bookingId);
    if (!PAUSABLE.includes(booking.status)) {
      throw new ApiError(409, 'PAUSE_NOT_ALLOWED', 'Booking can only be paused while in progress');
    }
    if (getState().pausedBookings.has(bookingId)) {
      throw new ApiError(409, 'PAUSE_NOT_ALLOWED', 'Booking is already paused');
    }
    getState().pausedBookings.set(bookingId, reason);
    return this.getBooking(bookingId);
  }

  async resume(bookingId: string): Promise<BookingDetail> {
    findBooking(bookingId);
    if (!getState().pausedBookings.has(bookingId)) {
      throw new ApiError(409, 'RESUME_NOT_ALLOWED', 'Booking is not paused');
    }
    getState().pausedBookings.delete(bookingId);
    return this.getBooking(bookingId);
  }

  async submitQuote(bookingId: string, quote: BookingQuote): Promise<BookingDetail> {
    requireCapability('submit_quote');
    const booking = findBooking(bookingId);
    if (booking.quoteStatus === undefined) {
      throw new ApiError(409, 'QUOTE_NOT_ALLOWED', 'This booking does not require a quote');
    }
    if (booking.quoteStatus !== 'provisional') {
      throw new ApiError(409, 'QUOTE_ALREADY_ISSUED', 'A quote has already been issued for this booking');
    }
    if (!['provider_accepted', 'quote_required', 'diagnosing'].includes(booking.status)) {
      throw new ApiError(409, 'QUOTE_NOT_ALLOWED', 'Quote cannot be submitted in this state');
    }
    docsFor(bookingId).quote = clone(quote);
    booking.quoteStatus = 'quote_issued';
    booking.status = 'quote_submitted';
    pushBookingEvent(booking, 'quote_submitted', 'provider', 'Quote submitted to customer');
    return this.getBooking(bookingId);
  }

  async decideQuote(bookingId: string, decision: 'approved' | 'declined', note?: string): Promise<BookingDetail> {
    const booking = findBooking(bookingId);
    if (booking.quoteStatus === 'quote_approved' || booking.quoteStatus === 'quote_declined') {
      throw new ApiError(409, 'QUOTE_ALREADY_ISSUED', 'A decision has already been made for this quote');
    }
    if (booking.quoteStatus !== 'quote_issued') return this.getBooking(bookingId);
    if (decision === 'approved') {
      booking.status = 'quote_accepted';
      booking.quoteStatus = 'quote_approved';
      pushBookingEvent(booking, 'quote_accepted', 'customer', note ?? 'Customer approved the quote');
    } else {
      booking.status = 'quote_required';
      booking.quoteStatus = 'quote_declined';
      pushBookingEvent(booking, 'quote_required', 'customer', note ?? 'Customer declined the quote');
    }
    return this.getBooking(bookingId);
  }

  async submitProof(bookingId: string, type: ProofOfServiceType, value: string): Promise<BookingDetail> {
    const booking = findBooking(bookingId);
    if (booking.status !== 'completion_review') {
      throw new ApiError(409, 'PROOF_OF_SERVICE_INVALID', 'Proof can only be submitted during completion review');
    }
    const docs = docsFor(bookingId);
    if (docs.proof) {
      throw new ApiError(409, 'PROOF_OF_SERVICE_ALREADY_SUBMITTED', 'Proof of service already submitted');
    }
    if (!value.trim()) {
      throw new ApiError(422, 'PROOF_OF_SERVICE_INVALID', 'Proof value is required');
    }
    docs.proof = { type, value, gpsStamp: { lat: -6.79, lon: 39.2, at: nowIso() } };
    return this.getBooking(bookingId);
  }

  async addParts(bookingId: string, parts: PartsLine[]): Promise<BookingDetail> {
    const state = getState();
    const booking = findBooking(bookingId);
    if (!PARTS_ALLOWED.includes(booking.status)) {
      throw new ApiError(409, 'PARTS_NOT_ALLOWED', 'Parts can only be added while working on the job');
    }
    for (const part of parts) {
      if (!part.name.trim() || !Number.isInteger(part.quantity) || part.quantity < 1 || !Number.isInteger(part.unitCostTZS)) {
        throw new ApiError(422, 'PARTS_INVALID', 'Parts must have a name, an integer quantity of at least 1 and an integer unit cost');
      }
    }
    for (const part of parts) {
      if (!part.catalogueItemId) continue;
      const item = state.inventory.find((i) => i.id === part.catalogueItemId);
      if (!item) continue;
      const next = item.stockOnHand - part.quantity;
      if (next < 0) throw new ApiError(409, 'INVENTORY_NEGATIVE_STOCK', 'Not enough stock to cover the parts');
      item.stockOnHand = next;
      item.updatedAt = nowIso();
    }
    const existing = state.quoteParts.get(bookingId) ?? [];
    state.quoteParts.set(bookingId, [...existing, ...parts.map((p) => clone(p))]);
    return this.getBooking(bookingId);
  }

  async issueInvoice(bookingId: string, laborTZS: number, discountTZS = 0, note?: string): Promise<ServiceInvoice> {
    requireCapability('issue_invoice');
    const state = getState();
    const booking = findBooking(bookingId);
    const docs = docsFor(bookingId);
    if (docs.invoice) return clone(docs.invoice);
    if (!INVOICE_ISSUABLE.includes(booking.status)) {
      throw new ApiError(409, 'INVOICE_NOT_ISSUABLE', 'Invoice can only be issued for completed work');
    }
    const partsTZS = (state.quoteParts.get(bookingId) ?? []).reduce((sum, p) => sum + p.quantity * p.unitCostTZS, 0);
    const tripFeeTZS = 5000;
    const taxable = laborTZS + partsTZS + tripFeeTZS - discountTZS;
    const taxTZS = Math.round(taxable * 0.18);
    const invoice: ServiceInvoice = {
      id: uid('inv'),
      bookingId,
      laborTZS,
      tripFeeTZS,
      partsTZS,
      discountTZS,
      taxTZS,
      totalTZS: taxable + taxTZS,
      status: 'issued',
      note: note ?? null,
      issuedAt: nowIso(),
    };
    docs.invoice = invoice;
    return clone(invoice);
  }

  async issueWarranty(bookingId: string, validDays: number, coverage?: string, followUpAt?: string): Promise<ServiceWarranty> {
    requireCapability('issue_warranty');
    const booking = findBooking(bookingId);
    if (!WARRANTY_ISSUABLE.includes(booking.status)) {
      throw new ApiError(409, 'WARRANTY_NOT_ALLOWED', 'Warranty can only be issued for completed bookings');
    }
    if (!Number.isInteger(validDays) || validDays < 1) {
      throw new ApiError(422, 'WARRANTY_INVALID', 'validDays must be a positive integer');
    }
    const docs = docsFor(bookingId);
    if (docs.warranty) return clone(docs.warranty);
    const warranty: ServiceWarranty = {
      id: uid('wrnty'),
      bookingId,
      validDays,
      coverage,
      followUpAt: followUpAt ?? null,
      status: 'active',
      issuedAt: nowIso(),
    };
    docs.warranty = warranty;
    if (booking.status === 'settled') {
      booking.status = 'warranty';
      pushBookingEvent(booking, 'warranty', 'provider', 'Warranty issued');
    }
    return clone(warranty);
  }

  async getInvoice(bookingId: string): Promise<ServiceInvoice | null> {
    const invoice = getState().bookingDocs.get(bookingId)?.invoice;
    return invoice ? clone(invoice) : null;
  }

  async getWarranty(bookingId: string): Promise<ServiceWarranty | null> {
    const warranty = getState().bookingDocs.get(bookingId)?.warranty;
    return warranty ? clone(warranty) : null;
  }

  async getEstimatePreview(bookingId: string): Promise<BookingEstimate> {
    const booking = findBooking(bookingId);
    return clone(estimateForService(booking.serviceId));
  }
}
