import type { Booking, ProviderJobOffer } from '@hudumika/contract';
import { create } from 'zustand';

import { ACTIVE_STATUSES_SET, TERMINAL_DEAD_SET, TERMINAL_DONE_SET } from '@/lib/booking';
import { getBookingsRepository, getDispatchRepository } from '@/repos';

interface JobsState {
  marketplace: ProviderJobOffer[];
  incoming: Booking[];
  active: Booking[];
  completed: Booking[];
  cancelled: Booking[];
  loading: boolean;
  error: string | null;
  refreshMarketplace: (kind?: string) => Promise<void>;
  refreshBookings: () => Promise<void>;
  acceptOffer: (bookingId: string) => Promise<Booking | null>;
  declineOffer: (bookingId: string, reason?: string) => Promise<void>;
}

function splitByStatus(bookings: Booking[]) {
  const incoming: Booking[] = [];
  const active: Booking[] = [];
  const completed: Booking[] = [];
  const cancelled: Booking[] = [];
  for (const b of bookings) {
    if (ACTIVE_STATUSES_SET.has(b.status)) active.push(b);
    else if (TERMINAL_DONE_SET.has(b.status)) completed.push(b);
    else if (TERMINAL_DEAD_SET.has(b.status)) cancelled.push(b);
    else incoming.push(b);
  }
  return { incoming, active, completed, cancelled };
}

export { splitByStatus };

export const useJobsStore = create<JobsState>()((set, get) => ({
  marketplace: [],
  incoming: [],
  active: [],
  completed: [],
  cancelled: [],
  loading: false,
  error: null,

  refreshMarketplace: async (kind = 'nearby') => {
    set({ loading: get().marketplace.length === 0, error: null });
    try {
      const jobs = await getDispatchRepository().listProviderJobs(kind);
      set({ marketplace: jobs, loading: false });
    } catch (e) {
      set({ loading: false, error: e instanceof Error ? e.message : 'Could not load jobs' });
    }
  },

  refreshBookings: async () => {
    set({ loading: get().active.length === 0, error: null });
    try {
      const bookings = await getBookingsRepository().listMyBookings();
      set({ ...splitByStatus(bookings), loading: false });
    } catch (e) {
      set({ loading: false, error: e instanceof Error ? e.message : 'Could not load bookings' });
    }
  },

  acceptOffer: async (bookingId) => {
    const booking = await getDispatchRepository().acceptOffer(bookingId);
    set((s) => ({
      marketplace: s.marketplace.filter((j) => j.bookingId !== bookingId),
      incoming: s.incoming.filter((b) => b.id !== bookingId),
      active: [booking, ...s.active.filter((b) => b.id !== bookingId)],
    }));
    return booking;
  },

  declineOffer: async (bookingId, reason) => {
    await getBookingsRepository().decline(bookingId, reason);
    set((s) => ({
      marketplace: s.marketplace.filter((j) => j.bookingId !== bookingId),
      incoming: s.incoming.filter((b) => b.id !== bookingId),
    }));
  },
}));
