/* In-memory dispatch repository. Mirrors GET /providers/me/dispatch/jobs,
 * POST /providers/me/dispatch/jobs/{bookingId}/accept,
 * GET /providers/me/dispatch/console and
 * POST /providers/me/dispatch/jobs/{bookingId}/technician against module state
 * in mockState.ts.
 *
 * listProviderJobs filters the marketplace by kind ('nearby' returns everything);
 * the query kinds 'offers' / 'quote_requests' map to job kinds 'offer' /
 * 'quote_request'. acceptOffer removes the job from the marketplace and moves
 * the booking to provider_accepted; a second accept of the same booking throws
 * 409 BOOKING_ALREADY_ACCEPTED and an expired/missing offer throws 409
 * JOB_OFFER_EXPIRED. assignTechnician guards against busy technicians
 * (409 TECHNICIAN_BUSY) and requires the assign_technician capability.
 */
import { ApiError } from '@/api/client';
import { getState, clone, findBooking, pushBookingEvent, requireCapability } from './mockState';
import type { DispatchRepository } from '../index';
import type { BookingDetail, GetProviderDispatchConsole200, ProviderJobOffer } from '@hudumika/contract';

function bookingToJob(booking: BookingDetail): ProviderJobOffer {
  return {
    bookingId: booking.id,
    kind: 'nearby',
    trade: 'Plumber',
    summary: booking.description ?? 'Job in your area',
    photoCount: 0,
    distanceKm: 1.5,
    customerArea: booking.address.label,
    estimatedDurationMinutes: 60,
    estimateLowTZS: 20000,
    estimateHighTZS: 35000,
    urgency: 'standard',
    scheduledFor: booking.scheduledFor,
    matchScore: 0.7,
    expiresAt: null,
    reasons: ['Sourced from booking state'],
  };
}

export class MockDispatchRepository implements DispatchRepository {
  async listProviderJobs(kind: string, _trade?: string): Promise<ProviderJobOffer[]> {
    const jobs = getState().marketplace;
    if (kind === 'nearby') return clone(jobs);
    const target = kind === 'offers' ? 'offer' : kind === 'quote_requests' ? 'quote_request' : kind;
    return clone(jobs.filter((j) => j.kind === target));
  }

  async acceptOffer(bookingId: string): Promise<BookingDetail> {
    const state = getState();
    const index = state.marketplace.findIndex((j) => j.bookingId === bookingId);
    const job = index >= 0 ? state.marketplace[index] : null;
    const booking = findBooking(bookingId);
    if (!job) {
      if (booking.status === 'provider_accepted') {
        throw new ApiError(409, 'BOOKING_ALREADY_ACCEPTED', 'This booking has already been accepted');
      }
      throw new ApiError(409, 'JOB_OFFER_EXPIRED', 'This offer has expired');
    }
    if (job.expiresAt && Date.parse(job.expiresAt) < Date.now()) {
      throw new ApiError(409, 'JOB_OFFER_EXPIRED', 'This offer has expired');
    }
    state.marketplace.splice(index, 1);
    booking.status = 'provider_accepted';
    booking.technicianId = null;
    pushBookingEvent(booking, 'provider_accepted', 'provider', 'Offer accepted');
    return clone(booking);
  }

  async getConsole(): Promise<GetProviderDispatchConsole200> {
    const state = getState();
    const marketJobs = state.marketplace.filter((j) => j.kind === 'nearby' || j.kind === 'recommended');
    const orphanBookings = state.bookings.filter(
      (b) => (b.status === 'offered' || b.status === 'provider_requested') && !state.marketplace.some((j) => j.bookingId === b.id),
    );
    const unassignedJobs: ProviderJobOffer[] = [...marketJobs, ...orphanBookings.map(bookingToJob)];
    const scheduledBooking = state.bookings.find((b) => b.status === 'scheduled');
    const technicianSchedule = state.technicians.map((t) => ({
      technicianId: t.id ?? '',
      name: t.name,
      status: t.status ?? 'offline',
      currentBookingId: t.currentBookingId ?? null,
      nextBookingAt: t.status === 'idle' ? (scheduledBooking?.scheduledFor ?? null) : null,
    }));
    return { unassignedJobs: clone(unassignedJobs), technicianSchedule: clone(technicianSchedule) };
  }

  async assignTechnician(bookingId: string, technicianId: string, _note?: string): Promise<BookingDetail> {
    requireCapability('assign_technician');
    const state = getState();
    const booking = findBooking(bookingId);
    const tech = state.technicians.find((t) => t.id === technicianId);
    if (!tech) throw new ApiError(404, 'TECHNICIAN_NOT_FOUND', `Technician ${technicianId} not found`);
    if (tech.status === 'on_job' || tech.currentBookingId) {
      throw new ApiError(409, 'TECHNICIAN_BUSY', 'Technician is already assigned to a job');
    }
    booking.technicianId = technicianId;
    tech.currentBookingId = bookingId;
    tech.status = 'on_job';
    pushBookingEvent(booking, booking.status, 'provider', 'Technician assigned');
    return clone(booking);
  }
}
