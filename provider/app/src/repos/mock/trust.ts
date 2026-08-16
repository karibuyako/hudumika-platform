/* In-memory trust repository. Mirrors GET /providers/me/trust against module
 * state in mockState.ts. Returns the seeded TrustProfile (trustScore 82,
 * riskScore 14, silver tier, verified badge) with the off_platform_payment
 * flag surfaced so the app can show risk guidance.
 */
import { getState, clone } from './mockState';
import type { TrustRepository } from '../index';
import type { TrustProfile } from '@hudumika/contract';

export class MockTrustRepository implements TrustRepository {
  async get(): Promise<TrustProfile> {
    return clone(getState().trust);
  }
}
