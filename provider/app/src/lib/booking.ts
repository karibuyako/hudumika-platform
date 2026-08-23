/* Booking domain helpers: status → label/tone maps (mirroring the contract
 * enum 1:1), the advance sequence the provider drives, and the idempotency-key
 * helper every booking/payment mutation carries (safe retries, never double-apply).
 */
import type { BookingStatus } from '@hudumika/contract';

import { uid } from '@/lib/format';

export interface StatusMeta {
  label: string;
  tone: 'neutral' | 'danger' | 'success' | 'info' | 'warning';
}

const STATUS_META: Record<string, StatusMeta> = {
  validating: { label: 'Validating', tone: 'neutral' },
  matching: { label: 'Matching', tone: 'neutral' },
  offered: { label: 'Offered', tone: 'info' },
  provider_requested: { label: 'Requested', tone: 'info' },
  provider_accepted: { label: 'Accepted', tone: 'info' },
  scheduled: { label: 'Scheduled', tone: 'info' },
  reminder_sent: { label: 'Reminder sent', tone: 'info' },
  en_route: { label: 'En route', tone: 'warning' },
  provider_arrived: { label: 'Arrived', tone: 'warning' },
  check_in: { label: 'Checked in', tone: 'warning' },
  diagnosing: { label: 'Diagnosing', tone: 'warning' },
  quote_required: { label: 'Quote required', tone: 'warning' },
  quote_submitted: { label: 'Quote submitted', tone: 'warning' },
  quote_accepted: { label: 'Quote approved', tone: 'info' },
  in_progress: { label: 'In progress', tone: 'warning' },
  completion_review: { label: 'Completion review', tone: 'warning' },
  awaiting_customer_confirmation: { label: 'Awaiting confirmation', tone: 'warning' },
  completed: { label: 'Completed', tone: 'success' },
  settled: { label: 'Settled', tone: 'success' },
  warranty: { label: 'Warranty', tone: 'success' },
  declined: { label: 'Declined', tone: 'neutral' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
  customer_cancelled: { label: 'Customer cancelled', tone: 'neutral' },
  provider_cancelled: { label: 'Cancelled by you', tone: 'neutral' },
  refunded: { label: 'Refunded', tone: 'neutral' },
  disputed: { label: 'Disputed', tone: 'danger' },
  escalated: { label: 'Escalated', tone: 'danger' },
  reassignment: { label: 'Reassignment', tone: 'danger' },
  no_show: { label: 'No show', tone: 'danger' },
  provider_late: { label: 'Provider late', tone: 'danger' },
};

export function statusMeta(status: BookingStatus): StatusMeta {
  return STATUS_META[status] ?? { label: status.replace(/_/g, ' '), tone: 'neutral' };
}

/** Statuses the provider can still act on (drive forward). */
export const ACTIVE_STATUSES: BookingStatus[] = [
  'offered',
  'provider_requested',
  'provider_accepted',
  'scheduled',
  'reminder_sent',
  'en_route',
  'provider_arrived',
  'check_in',
  'diagnosing',
  'quote_required',
  'quote_submitted',
  'quote_accepted',
  'in_progress',
  'completion_review',
  'awaiting_customer_confirmation',
];

export const TERMINAL_STATUSES: BookingStatus[] = [
  'completed',
  'settled',
  'warranty',
  'declined',
  'cancelled',
  'customer_cancelled',
  'provider_cancelled',
  'refunded',
  'disputed',
  'escalated',
  'reassignment',
  'no_show',
  'provider_late',
];

/** A booking whose payout is held (dispute blocks settle). */
export function isDisputeHeld(status: BookingStatus): boolean {
  return status === 'disputed' || status === 'escalated';
}

/** Statuses shown in the "incoming requests" tab of the jobs screen. */
export const INCOMING_STATUSES: BookingStatus[] = ['offered', 'provider_requested', 'scheduled', 'reminder_sent'];

/** Statuses shown as active work. */
export const WORK_STATUSES: BookingStatus[] = [
  'provider_accepted',
  'en_route',
  'provider_arrived',
  'check_in',
  'diagnosing',
  'quote_required',
  'quote_submitted',
  'quote_accepted',
  'in_progress',
  'completion_review',
  'awaiting_customer_confirmation',
];

export const TERMINAL_DONE_STATUSES: BookingStatus[] = ['completed', 'settled', 'warranty'];
export const TERMINAL_DEAD_STATUSES: BookingStatus[] = [
  'declined',
  'cancelled',
  'customer_cancelled',
  'provider_cancelled',
  'refunded',
  'disputed',
  'escalated',
  'reassignment',
  'no_show',
  'provider_late',
];

/** Stale offer error codes — the offer is no longer actionable and the list should refresh. */
export const STALE_OFFER_CODES = ['BOOKING_ALREADY_ACCEPTED', 'JOB_OFFER_EXPIRED', 'DISPATCH_ACCEPTANCE_TIMEOUT'] as const;

/** Status sets for tab bucketing — single source of truth for store/jobs. */
export const ACTIVE_STATUSES_SET = new Set<BookingStatus>(ACTIVE_STATUSES);
export const TERMINAL_DONE_SET = new Set<BookingStatus>(TERMINAL_DONE_STATUSES);
export const TERMINAL_DEAD_SET = new Set<BookingStatus>(TERMINAL_DEAD_STATUSES);

/** The statuses the provider advances through while working a job. */
export const PROVIDER_ADVANCE_SEQUENCE: { from: BookingStatus; to: BookingStatus; labelKey: string }[] = [
  { from: 'scheduled', to: 'en_route', labelKey: 'booking.action.enRoute' },
  { from: 'reminder_sent', to: 'en_route', labelKey: 'booking.action.enRoute' },
  { from: 'en_route', to: 'provider_arrived', labelKey: 'booking.action.arrived' },
  { from: 'provider_arrived', to: 'check_in', labelKey: 'booking.action.checkIn' },
  { from: 'check_in', to: 'diagnosing', labelKey: 'booking.action.diagnose' },
  { from: 'diagnosing', to: 'in_progress', labelKey: 'booking.action.startWork' },
  { from: 'quote_accepted', to: 'in_progress', labelKey: 'booking.action.startWork' },
  { from: 'in_progress', to: 'completion_review', labelKey: 'booking.action.reviewWork' },
];

export function advanceStepFor(status: BookingStatus, isQuoteJob = false): { from: BookingStatus; to: BookingStatus; labelKey: string } | null {
  // Simple jobs (no quote gate) skip diagnosing: check_in → in_progress directly.
  if (status === 'check_in' && !isQuoteJob) {
    return { from: 'check_in', to: 'in_progress', labelKey: 'booking.action.startWork' };
  }
  return PROVIDER_ADVANCE_SEQUENCE.find((s) => s.from === status) ?? null;
}

/** Statuses where the provider can still cancel (destructive action needs a confirm dialog). */
export const CANCELLABLE_STATUSES: BookingStatus[] = ['offered', 'provider_requested', 'provider_accepted', 'scheduled', 'reminder_sent', 'en_route', 'provider_arrived', 'check_in'];

/** Idempotency-key helper — one per mutation; the server dedupes retries. */
export function idemKey(prefix: string): string {
  return `${prefix}_${uid('op')}`;
}

/** Quote status meta (Booking.quoteStatus). */
export function quoteStatusMeta(quoteStatus?: string): StatusMeta | null {
  const map: Record<string, StatusMeta> = {
    provisional: { label: 'Provisional estimate', tone: 'neutral' },
    quote_issued: { label: 'Quote issued', tone: 'info' },
    quote_approved: { label: 'Quote approved', tone: 'success' },
    quote_declined: { label: 'Quote declined', tone: 'danger' },
  };
  return quoteStatus ? map[quoteStatus] ?? null : null;
}
