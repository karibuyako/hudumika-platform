/* In-memory bookings repository — POST /bookings (Idempotency-Key),
 * /bookings/me, /bookings/{id}, cancel, complete, quote decision.
 *
 * Payment: a booking is created as `pending_payment` with a linked payment
 * intent (the same intent the payments repository returns for createIntent,
 * and which confirm() flips together with the booking). COD bookings skip
 * the intent and land directly in `paid`, mirroring the orders flow.
 */
import { ApiError } from '@/api/client';
import { uid } from '@/lib/format';
import { clone, fixtureAddress, getState, nowIso, type MockIntent } from './mockState';
import { MockProvidersRepository } from './providers';
import type {
  Booking,
  BookingCreate,
  BookingCreateAnswers,
  BookingCreatePaymentMethod,
  BookingDetail,
  BookingEstimate,
  BookingQuote,
  BookingStatus,
  DecideBookingQuoteBodyDecision,
} from '@hudumika/contract';
import { PaymentIntentStatus as S } from '@hudumika/contract';
import type { BookingsRepository, BookingInvoice, BookingProof, BookingWarranty } from '../index';

/** BookingDetail on the mock wire carries demo-only extras that the contract
 * does not type: `quote` (the issued quote breakdown), `answers` (the
 * questionnaire answers), `intentId`/`paymentMethod` (the linked payment
 * intent). Screens read them through a local intersection type; live API
 * responses just omit them.
 *
 * Quote revision extras (BOOKING-FLOW.md): the contract exposes no quote
 * revision/version fields (verified in bookingQuote.ts / bookingDetail.ts),
 * so `previousQuote` (the superseded quote) and `quoteAskProvider` (mock-only
 * capability flag for the ask_provider decision, which the contract enum does
 * not include) ride the mock wire the same way — stripped live. */
export type MockBookingDetail = BookingDetail & {
  quote?: BookingQuote;
  answers?: BookingCreateAnswers;
  intentId?: string;
  paymentMethod?: BookingCreatePaymentMethod;
  previousQuote?: BookingQuote;
  quoteAskProvider?: true;
};

/* Mock-only quote revision trail (BOOKING-FLOW.md): the superseded quote per
 * booking, attached to the wire as `previousQuote`. Module-local so shared
 * mockState stays untouched (same pattern as intentByBooking). */
const previousQuoteByBooking = new Map<string, BookingQuote>();

/** Deterministic demo revision for the seeded quote booking: the provider
 * originally priced labor higher with a pricier first part; the current quote
 * is the revision. Synthesized once and cached (deterministic, survives
 * resetMockState like the seeded ids). */
function seedPreviousQuote(booking: MockBookingDetail): void {
  if (previousQuoteByBooking.has(booking.id) || !booking.quote) return;
  previousQuoteByBooking.set(booking.id, {
    laborTZS: booking.quote.laborTZS + 10000,
    tripFeeTZS: booking.quote.tripFeeTZS,
    parts: (booking.quote.parts ?? []).map((p, i) => (i === 0 ? { ...p, unitCostTZS: p.unitCostTZS + 5000 } : { ...p })),
    expiresAt: booking.quote.expiresAt,
    note: booking.quote.note,
  });
}

/** Attach the mock-only quote extras (previousQuote + ask-provider flag) to a
 * booking read off the wire. Never present live. */
function withQuoteExtras(booking: MockBookingDetail): MockBookingDetail {
  seedPreviousQuote(booking);
  const prev = previousQuoteByBooking.get(booking.id);
  return {
    ...booking,
    ...(prev ? { previousQuote: clone(prev) } : {}),
    ...(booking.quoteStatus === 'quote_issued' ? { quoteAskProvider: true as const } : {}),
  };
}

/* bookingId → intent linkage (contract DTOs carry no such field; the mock
 * keeps it module-local, keyed by generated booking ids that never collide
 * across resets). */
const intentByBooking = new Map<string, MockIntent>();

export function bookingIntent(bookingId: string): MockIntent | undefined {
  return intentByBooking.get(bookingId);
}

export function linkBookingIntent(bookingId: string, intent: MockIntent): void {
  intentByBooking.set(bookingId, intent);
}

export function bookingIdForIntent(intentId: string): string | undefined {
  for (const [bookingId, intent] of intentByBooking) {
    if (intent.id === intentId) return bookingId;
  }
  return undefined;
}

/* Module-local disputed booking seed — the shared store (mockState, read-only
 * per house rules) carries no disputed booking, so the dispute-center data
 * path keeps a seed here (same pattern as intentByBooking: module-local,
 * deterministic ids that never collide with generated bookings). list() and
 * get() merge it; nothing in mockState changes. */
const DISPUTED_BOOKING_ID = 'bk_disputed_101';

const disputedSeeds: BookingDetail[] = [
  {
    id: DISPUTED_BOOKING_ID,
    status: 'disputed',
    providerId: 'prov_001',
    serviceId: 'svc_001',
    scheduledFor: new Date(Date.now() + 4 * 3600_000).toISOString(),
    address: fixtureAddress(),
    description: 'Kitchen sink leak — service issue',
    price: { subtotalTZS: 60000, deliveryFeeTZS: 0, platformFeeTZS: 5000, taxTZS: 0, discountTZS: 0, totalTZS: 65000 },
    events: [
      { status: 'paid', at: nowIso(), by: 'system', note: 'Paid via M-Pesa' },
      { status: 'provider_accepted', at: nowIso(), by: 'provider', note: 'Provider accepted the job' },
      { status: 'disputed', at: nowIso(), by: 'customer', note: 'Work was not completed as agreed' },
    ],
    createdAt: nowIso(),
    updatedAt: nowIso(),
  },
];

export class MockBookingsRepository implements BookingsRepository {
  async estimate(input: { serviceId: string; cityId?: string }): Promise<BookingEstimate> {    const services = await new MockProvidersRepository().listServices();
    const known = services.some((s) => s.id === input.serviceId);
    if (!known) throw new ApiError(404, 'SERVICE_NOT_FOUND', 'Service not found');
    return { serviceId: input.serviceId, lowTZS: 35000, highTZS: 60000, tripFeeTZS: 5000, estimatedDurationMinutes: 120, disclaimer: 'Final quote may vary after on-site inspection' };
  }

  async create(input: BookingCreate, _idempotencyKey: string): Promise<Booking> {
    const state = getState();
    if (new Date(input.scheduledFor).getTime() < Date.now()) {
      throw new ApiError(422, 'BOOKING_TIME_IN_PAST', 'Scheduled time is in the past');
    }
    if (input.durationMinutes && (input.durationMinutes < 15 || input.durationMinutes > 480)) {
      throw new ApiError(422, 'BOOKING_DURATION_INVALID', 'Duration must be between 15 and 480 minutes');
    }
    // Server-authority price derived from the estimate (integer TZS); a new
    // booking is never "paid" — it waits for the payment intent to confirm.
    let subtotalTZS = 60000;
    let tripFeeTZS = 5000;
    try {
      const est = await this.estimate({ serviceId: input.serviceId });
      subtotalTZS = est.lowTZS;
      tripFeeTZS = est.tripFeeTZS;
    } catch {
      /* unknown service keeps the demo default */
    }
    const cod = input.paymentMethod === 'cod';
    const totalTZS = subtotalTZS + tripFeeTZS;
    const booking: Booking = {
      id: uid('bk'),
      status: cod ? 'paid' : 'pending_payment',
      // Category-first flow (services tab → /book?serviceId=) has no provider
      // choice yet: assign the first provider for the service deterministically.
      providerId: input.providerId || this.defaultProviderId(input.serviceId),
      serviceId: input.serviceId,
      scheduledFor: input.scheduledFor,
      price: { subtotalTZS, deliveryFeeTZS: tripFeeTZS, platformFeeTZS: 0, taxTZS: 0, discountTZS: 0, totalTZS },
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    const detail: MockBookingDetail = {
      ...booking,
      address: input.address ?? fixtureAddress(),
      description: input.description,
      answers: input.answers,
      events: cod
        ? [{ status: 'paid', at: nowIso(), by: 'system', note: 'Paid via cash on delivery' }]
        : [{ status: 'pending_payment', at: nowIso(), by: 'customer', note: 'Awaiting payment' }],
    };
    if (!cod) {
      detail.intentId = uid('intent');
      detail.paymentMethod = input.paymentMethod;
      const intent: MockIntent = {
        id: detail.intentId,
        status: S.created,
        amountTZS: totalTZS,
        method: input.paymentMethod,
      };
      state.intents.push(intent);
      linkBookingIntent(booking.id, intent);
    }
    state.bookings.unshift(detail);
    return clone(detail);
  }

  async list(params?: { status?: string; cursor?: string; limit?: number }): Promise<Booking[]> {
    const state = getState();
    let list = [...state.bookings, ...disputedSeeds];
    if (params?.status === 'active') list = list.filter((b) => !['completed', 'cancelled', 'refunded', 'declined', 'no_show', 'disputed'].includes(b.status));
    const offset = params?.cursor ? Number(params.cursor) : 0;
    const limit = params?.limit ?? 20;
    return clone(list.slice(offset, offset + limit));
  }

  async get(bookingId: string): Promise<BookingDetail> {
    const booking = [...getState().bookings, ...disputedSeeds].find((b) => b.id === bookingId);
    if (!booking) throw new ApiError(404, 'BOOKING_NOT_FOUND', `Booking ${bookingId} not found`);
    return clone(withQuoteExtras(booking as MockBookingDetail));
  }

  async cancel(bookingId: string, reason: string, _idempotencyKey: string): Promise<Booking> {
    const state = getState();
    const booking = state.bookings.find((b) => b.id === bookingId);
    if (!booking) throw new ApiError(404, 'BOOKING_NOT_FOUND', `Booking ${bookingId} not found`);
    // A declined booking ends via "cancel with refund" (BOOKING-FLOW.md):
    // the customer is not charged and the booking is refunded.
    if (booking.status === 'declined') {
      booking.status = 'refunded';
      booking.events.push({ status: 'refunded', at: nowIso(), by: 'customer', note: reason || 'Provider declined — refund requested' });
      booking.updatedAt = nowIso();
      return clone(booking);
    }
    if (booking.status !== 'pending_payment' && booking.status !== 'paid' && booking.status !== 'provider_requested' && booking.status !== 'provider_accepted') {
      throw new ApiError(409, 'BOOKING_NOT_CANCELLABLE', 'This booking can no longer be cancelled');
    }
    booking.status = 'cancelled';
    booking.events.push({ status: 'cancelled', at: nowIso(), by: 'customer', note: reason || undefined });
    return clone(booking);
  }

  async complete(bookingId: string, _idempotencyKey: string): Promise<Booking> {
    const state = getState();
    const booking = state.bookings.find((b) => b.id === bookingId);
    if (!booking) throw new ApiError(404, 'BOOKING_NOT_FOUND', `Booking ${bookingId} not found`);
    if (booking.status !== 'awaiting_customer_confirmation') {
      throw new ApiError(409, 'BOOKING_STATUS_CONFLICT', 'Booking is not awaiting your confirmation');
    }
    booking.status = 'completed';
    booking.events.push({ status: 'completed', at: nowIso(), by: 'customer', note: 'Job completed' });
    return clone(booking);
  }

  async decideQuote(bookingId: string, decision: DecideBookingQuoteBodyDecision | 'ask_provider', note: string | undefined, _idempotencyKey: string): Promise<Booking> {
    const state = getState();
    const booking = state.bookings.find((b) => b.id === bookingId);
    if (!booking) throw new ApiError(404, 'BOOKING_NOT_FOUND', `Booking ${bookingId} not found`);
    if (booking.quoteStatus !== 'quote_issued') {
      throw new ApiError(409, 'QUOTE_NOT_ALLOWED', 'There is no issued quote awaiting your decision');
    }
    if (decision === 'ask_provider') {
      // Mock-only extension (BOOKING-FLOW.md): the contract decision enum is
      // approved|declined only (decideBookingQuoteBodyDecision.ts — verified),
      // so ask_provider exists only in the mock. The demo simulates the
      // provider replying with a revised quote right away: the current quote
      // moves to the revision trail and a new one is issued, keeping
      // quoteStatus quote_issued so the customer still decides.
      // 'quote_asked' is a mock-only timeline status (not in the contract
      // BookingStatus enum) — cast keeps the mock type-consistent.
      booking.events.push({ status: 'quote_asked' as BookingStatus, at: nowIso(), by: 'customer', note: note || 'Asked the provider about the quote' });
      const current = (booking as MockBookingDetail).quote;
      if (current) {
        previousQuoteByBooking.set(bookingId, clone(current));
        (booking as MockBookingDetail).quote = {
          laborTZS: Math.max(5000, current.laborTZS - 15000),
          tripFeeTZS: current.tripFeeTZS,
          parts: (current.parts ?? []).map((p, i) => (i === 0 ? { ...p, unitCostTZS: Math.max(1000, p.unitCostTZS - 5000) } : { ...p })),
          expiresAt: new Date(Date.now() + 48 * 3600_000).toISOString(),
          note: note ? `Revised: ${note}` : 'Quote revised per your request',
        };
        booking.events.push({ status: 'quote_submitted', at: nowIso(), by: 'provider', note: 'Revised quote issued' });
      }
      booking.updatedAt = nowIso();
      return clone(withQuoteExtras(booking as MockBookingDetail));
    }
    if (decision === 'approved') {
      booking.quoteStatus = 'quote_approved';
      booking.status = 'quote_accepted';
      // Server-authority price breakdown derived from the quote the provider
      // submitted: labor + parts as subtotal, trip fee as the delivery fee.
      const quote = (booking as MockBookingDetail).quote;
      const partsTZS = (quote?.parts ?? []).reduce((acc, p) => acc + p.unitCostTZS * p.quantity, 0);
      const subtotalTZS = (quote?.laborTZS ?? 0) + partsTZS;
      const deliveryFeeTZS = quote?.tripFeeTZS ?? 0;
      booking.price = { subtotalTZS, deliveryFeeTZS, platformFeeTZS: 0, taxTZS: 0, discountTZS: 0, totalTZS: subtotalTZS + deliveryFeeTZS };
      booking.events.push({ status: 'quote_accepted', at: nowIso(), by: 'customer', note: note || 'Quote approved' });
    } else {
      booking.quoteStatus = 'quote_declined';
      booking.status = 'quote_required';
      booking.events.push({ status: 'quote_required', at: nowIso(), by: 'customer', note: note || 'Quote declined' });
    }
    booking.updatedAt = nowIso();
    return clone(withQuoteExtras(booking as MockBookingDetail));
  }

  /** Deterministic demo default: first provider whose trade matches the
   * service name, falling back to the seeded demo provider. */
  private defaultProviderId(serviceId: string): string {
    const services = getState().home.providers ?? [];
    const serviceName = (getState().home.categories ?? []).find((c) => c.id === serviceId)?.name;
    if (serviceName) {
      const match = services.find((p) => p.trade.toLowerCase() === serviceName.toLowerCase());
      if (match) return match.id;
    }
    return 'prov_001';
  }

  /* ---------- customer documents (CONTRACT-ADDITIONS.md #9) ----------
   * Mock-only until the contract ships the customer GETs: the mock serves
   * deterministic documents for terminal-completed bookings, derived from the
   * booking's server-price breakdown (integer TZS). Non-completed bookings →
   * null (the document was never issued). The live repo returns null on 404. */

  /** Terminal states after which the documents exist (the screen renders the
   * documents section on completed; settled/warranty are its successors). */
  private static DOCUMENTED_STATUSES: readonly string[] = ['completed', 'settled', 'warranty'];

  private findDocumentedBooking(bookingId: string): BookingDetail {
    const booking = [...getState().bookings, ...disputedSeeds].find((b) => b.id === bookingId);
    if (!booking) throw new ApiError(404, 'BOOKING_NOT_FOUND', `Booking ${bookingId} not found`);
    return booking;
  }

  async getInvoice(bookingId: string): Promise<BookingInvoice | null> {
    const booking = this.findDocumentedBooking(bookingId);
    if (!MockBookingsRepository.DOCUMENTED_STATUSES.includes(booking.status)) return null;
    const price = booking.price;
    return {
      lineItems: [{ name: booking.description || booking.serviceId, quantity: 1, unitPriceTZS: price?.subtotalTZS ?? 0 }],
      subtotalTZS: price?.subtotalTZS ?? 0,
      feesTZS: (price?.deliveryFeeTZS ?? 0) + (price?.platformFeeTZS ?? 0),
      totalTZS: price?.totalTZS ?? 0,
      issuedAt: nowIso(),
    };
  }

  async getWarranty(bookingId: string): Promise<BookingWarranty | null> {
    const booking = this.findDocumentedBooking(bookingId);
    if (!MockBookingsRepository.DOCUMENTED_STATUSES.includes(booking.status)) return null;
    return {
      coverage: 'Labor and replaced parts covered for 90 days from completion',
      expiresAt: new Date(Date.parse(booking.scheduledFor) + 90 * 86400_000).toISOString(),
    };
  }

  async getProofOfService(bookingId: string): Promise<BookingProof | null> {
    const booking = this.findDocumentedBooking(bookingId);
    if (!MockBookingsRepository.DOCUMENTED_STATUSES.includes(booking.status)) return null;
    return {
      photos: [`/mock/bookings/${bookingId}/proof-1.jpg`],
      signatureStatus: 'signed',
      completedAt: nowIso(),
    };
  }
}
