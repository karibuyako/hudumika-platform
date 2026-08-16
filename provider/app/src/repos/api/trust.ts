/* Live API trust repository. Thin typed wrapper over the hardened client.
 *
 * Paths (API-CONTRACT.yaml):
 *   GET /providers/me/trust → TrustProfile
 */
import { api } from '@/api/client';
import type { TrustRepository } from '../index';
import type { TrustProfile } from '@hudumika/contract';

export class ApiTrustRepository implements TrustRepository {
  async get(): Promise<TrustProfile> {
    return api.get<TrustProfile>('/providers/me/trust');
  }
}
