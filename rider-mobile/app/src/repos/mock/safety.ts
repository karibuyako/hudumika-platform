/* In-memory safety repository (SOS, trusted contacts, security score, trip share).
 * Mirrors POST /sos, GET/POST /riders/me/contacts, DELETE /riders/me/contacts/{contactId},
 * GET /riders/me/security, POST /riders/me/trips/{orderId}/share against module state
 * in mockState.ts.
 *
 * Contract-shaped errors:
 *   429 SOS_RATE_LIMITED      (details.retryAfterSeconds) after the first alert in 60 s
 *   422 CONTACT_LIMIT_REACHED (max 5 trusted contacts / share recipients)
 *   409 TRIP_SHARE_NOT_ALLOWED (order not in a shareable status)
 */
import { ApiError } from '@/api/client';
import { uid } from '@/lib/format';
import { getState, clone, nowIso } from './mockState';
import type { SafetyRepository } from '../index';
import type { GetRiderSecurity200, SosAlert, SosAlertType, TrustedContact } from '@hudumika/contract';

const SOS_WINDOW_MS = 60_000;
export const MAX_CONTACTS = 5;
export const MAX_SHARE_RECIPIENTS = 5;
const SHARE_STATUSES: string[] = ['rider_assigned', 'rider_arrived_pickup', 'picked_up', 'delivering', 'rider_arrived_dropoff'];

export class MockSafetyRepository implements SafetyRepository {
  async createSos(input: { type: SosAlertType; note?: string; lat?: number; lon?: number }): Promise<SosAlert> {
    const state = getState();
    const last = state.sosLastSentAt;
    if (last !== null && Date.now() - last < SOS_WINDOW_MS) {
      const retryAfterSeconds = Math.ceil((last + SOS_WINDOW_MS - Date.now()) / 1000);
      throw new ApiError(
        429,
        'SOS_RATE_LIMITED',
        'Alert already sent — safety ops has your last known location',
        false,
        { retryAfterSeconds },
      );
    }
    state.sosLastSentAt = Date.now();
    const alert: SosAlert = {
      id: uid('sos'),
      riderId: state.profile.id,
      type: input.type,
      status: 'open',
      note: input.note ?? null,
      lat: input.lat ?? null,
      lon: input.lon ?? null,
      createdAt: nowIso(),
    };
    state.sosAlerts.push(alert);
    return clone(alert);
  }

  async listTrustedContacts(): Promise<TrustedContact[]> {
    return clone(getState().trustedContacts);
  }

  async addTrustedContact(contact: TrustedContact): Promise<TrustedContact> {
    const state = getState();
    if (state.trustedContacts.length >= MAX_CONTACTS) {
      throw new ApiError(422, 'CONTACT_LIMIT_REACHED', `Maximum of ${MAX_CONTACTS} trusted contacts`);
    }
    const created: TrustedContact = {
      id: uid('contact'),
      name: contact.name,
      phone: contact.phone,
      relationship: contact.relationship ?? null,
      notifiedOnSos: contact.notifiedOnSos ?? true,
      shareLocation: contact.shareLocation ?? true,
    };
    state.trustedContacts.push(created);
    return clone(created);
  }

  async removeTrustedContact(contactId: string): Promise<void> {
    const state = getState();
    state.trustedContacts = state.trustedContacts.filter((c) => c.id !== contactId);
  }

  async getSecurityScore(): Promise<GetRiderSecurity200> {
    return clone(getState().security);
  }

  async shareTrip(orderId: string, recipients: string[], _includeRoute = true): Promise<{ shareToken: string; expiresAt: string }> {
    const state = getState();
    const order = state.orders.find((o) => o.id === orderId);
    if (!order || !SHARE_STATUSES.includes(order.status)) {
      throw new ApiError(409, 'TRIP_SHARE_NOT_ALLOWED', 'Only active trips can be shared');
    }
    if (recipients.length > MAX_SHARE_RECIPIENTS) {
      throw new ApiError(422, 'CONTACT_LIMIT_REACHED', `Maximum of ${MAX_SHARE_RECIPIENTS} share recipients`);
    }
    const share = {
      shareToken: uid('share'),
      expiresAt: new Date(Date.now() + 24 * 3600_000).toISOString(),
    };
    state.shareTokens[orderId] = share;
    return clone(share);
  }
}
