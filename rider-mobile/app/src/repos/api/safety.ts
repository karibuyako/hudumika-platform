/* Live API safety repository. Thin typed wrapper over the hardened client.
 *
 * Paths (API-CONTRACT.yaml):
 *   POST /sos                          {CreateSosAlertBody} → SosAlert
 *   GET  /riders/me/contacts           → TrustedContact[]
 *   POST /riders/me/contacts           {TrustedContact} → TrustedContact
 *   DELETE /riders/me/contacts/{id}    → 204
 *   GET  /riders/me/security           → GetRiderSecurity200
 *   POST /riders/me/trips/{orderId}/share {ShareTripBody} → {shareToken, expiresAt}
 */
import { api } from '@/api/client';
import type { SafetyRepository } from '../index';
import type { CreateSosAlertBody, GetRiderSecurity200, ShareTrip201, ShareTripBody, SosAlert, SosAlertType, TrustedContact } from '@hudumika/contract';

export class ApiSafetyRepository implements SafetyRepository {
  async createSos(input: { type: SosAlertType; note?: string; lat?: number; lon?: number }): Promise<SosAlert> {
    const body: CreateSosAlertBody = {
      type: input.type,
      note: input.note,
      lat: input.lat ?? null,
      lon: input.lon ?? null,
    };
    return api.post<SosAlert>('/sos', body);
  }

  async listTrustedContacts(): Promise<TrustedContact[]> {
    return api.get<TrustedContact[]>('/riders/me/contacts');
  }

  async addTrustedContact(contact: TrustedContact): Promise<TrustedContact> {
    return api.post<TrustedContact>('/riders/me/contacts', contact);
  }

  async removeTrustedContact(contactId: string): Promise<void> {
    await api.delete<void>(`/riders/me/contacts/${contactId}`);
  }

  async getSecurityScore(): Promise<GetRiderSecurity200> {
    return api.get<GetRiderSecurity200>('/riders/me/security');
  }

  async shareTrip(orderId: string, recipients: string[], includeRoute = true): Promise<ShareTrip201> {
    const body: ShareTripBody = { recipients, includeRoute };
    return api.post<ShareTrip201>(`/riders/me/trips/${orderId}/share`, body);
  }
}
