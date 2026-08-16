/* In-memory disputes repository — GET /disputes/me, POST /disputes.
 *
 * Mock-only until the contract ships consumer dispute endpoints
 * (docs/CONTRACT-ADDITIONS.md #8): the record shape, statuses and paths are
 * all mock-first. Seeds derive from the states the contract DOES carry —
 * the disputed order (ord_disputed_007), the disputed booking
 * (bk_disputed_101, module-local seed in mock/bookings.ts) and the refunded
 * order (ord_refunded_006, whose refund closes a resolved dispute). Raised
 * records accumulate module-locally; the same idempotency key replays the
 * same record (never double-creates).
 */
import { ApiError } from '@/api/client';
import { uid } from '@/lib/format';
import { clone, findOrder, getState, nowIso } from './mockState';
import { MockBookingsRepository } from './bookings';
import type { DisputeRaiseInput, DisputeRecord, DisputesRepository } from '../index';

/* Module-local raised records + idempotency replays — resetMockState covers
 * mockState only, so tests call resetMockDisputesState() between cases. */
const raisedDisputes: DisputeRecord[] = [];
const raiseReplays = new Map<string, DisputeRecord>();

export function resetMockDisputesState(): void {
  raisedDisputes.length = 0;
  raiseReplays.clear();
}

/** Resolve a reference for validation — orders from shared state, bookings
 * through the bookings repo so the module-local disputed seed resolves too.
 * Unknown references reject (404 from the underlying repo), which raise()
 * remaps to a plain NOT_FOUND. */
async function findReference(referenceType: 'order' | 'booking', referenceId: string): Promise<void> {
  if (referenceType === 'order') {
    findOrder(referenceId);
    return;
  }
  await new MockBookingsRepository().get(referenceId);
}

export class MockDisputesRepository implements DisputesRepository {
  async list(): Promise<DisputeRecord[]> {
    const state = getState();
    const seeds: DisputeRecord[] = [];
    const disputedOrder = state.orders.find((o) => o.id === 'ord_disputed_007');
    if (disputedOrder) {
      const disputedAt = disputedOrder.events.find((e) => e.status === 'disputed')?.at ?? nowIso();
      seeds.push({
        id: 'disp_001',
        referenceType: 'order',
        referenceId: disputedOrder.id,
        status: 'open',
        reason: 'missing_item',
        description: 'One item was missing from my order',
        createdAt: disputedAt,
        updatedAt: disputedAt,
      });
    }
    // The disputed booking seed lives module-local in mock/bookings.ts
    // (mockState is read-only) — the dispute record mirrors it.
    seeds.push({
      id: 'disp_002',
      referenceType: 'booking',
      referenceId: 'bk_disputed_101',
      status: 'resolving',
      reason: 'service_not_completed',
      description: 'Work was not completed as agreed',
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
    const refundedOrder = state.orders.find((o) => o.id === 'ord_refunded_006');
    if (refundedOrder) {
      const resolvedAt = refundedOrder.cancelledAt ?? refundedOrder.updatedAt ?? nowIso();
      seeds.push({
        id: 'disp_003',
        referenceType: 'order',
        referenceId: refundedOrder.id,
        status: 'resolved',
        reason: 'other',
        description: 'Refund issued after cancellation',
        createdAt: resolvedAt,
        updatedAt: resolvedAt,
        resolution: { outcome: 'refunded', at: resolvedAt, note: 'Refunded to your original payment method' },
      });
    }
    return clone([...raisedDisputes, ...seeds]);
  }

  async raise(input: DisputeRaiseInput, idempotencyKey: string): Promise<DisputeRecord> {
    const replay = raiseReplays.get(idempotencyKey);
    if (replay) return clone(replay);
    const { orderId, bookingId } = input;
    if (orderId && bookingId) {
      throw new ApiError(422, 'VALIDATION_FAILED', 'Provide exactly one of orderId or bookingId', false);
    }
    const referenceType = orderId ? ('order' as const) : bookingId ? ('booking' as const) : null;
    if (!referenceType) {
      throw new ApiError(422, 'VALIDATION_FAILED', 'Provide an order or booking reference', false);
    }
    const referenceId = orderId ?? bookingId!;
    try {
      await findReference(referenceType, referenceId);
    } catch {
      // Never leak the underlying repo code — a dispute on an unknown
      // reference is a plain NOT_FOUND on the dispute surface.
      throw new ApiError(404, 'NOT_FOUND', `No ${referenceType} ${referenceId} found`, false);
    }
    const record: DisputeRecord = {
      id: uid('disp'),
      referenceType,
      referenceId,
      status: 'open',
      reason: input.reason,
      description: input.description,
      evidenceUrls: input.evidenceUrls,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    raisedDisputes.unshift(record);
    raiseReplays.set(idempotencyKey, record);
    return clone(record);
  }
}
