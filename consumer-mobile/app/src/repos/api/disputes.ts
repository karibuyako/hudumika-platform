/* Live API disputes repository — GET /disputes/me, POST /disputes.
 *
 * Mock-only until the contract ships consumer dispute endpoints (verified
 * against the generated endpoints: only admin voucher-dispute tooling under
 * /admin/vouchers/verify exists — no /disputes* surface), so both paths are
 * mock-only-until-adopted (docs/CONTRACT-ADDITIONS.md #8, parity harness
 * allow-list). A live backend without the endpoints 404s/405s and the screen
 * falls back to its error state. */
import { api } from '@/api/client';
import type { DisputeRaiseInput, DisputeRecord, DisputesRepository } from '../index';

export class ApiDisputesRepository implements DisputesRepository {
  async list(): Promise<DisputeRecord[]> {
    return api.get<DisputeRecord[]>('/disputes/me');
  }

  async raise(input: DisputeRaiseInput, idempotencyKey: string): Promise<DisputeRecord> {
    return api.post<DisputeRecord>('/disputes', input, { idempotencyKey });
  }
}
