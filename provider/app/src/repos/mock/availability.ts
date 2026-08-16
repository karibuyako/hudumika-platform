/* In-memory availability repository. Mirrors GET/PUT /providers/me/availability
 * against module state in mockState.ts. putAvailability is a full replace with
 * 204 semantics (returns void); windows live on the profile's availability field.
 */
import { getState, clone } from './mockState';
import type { AvailabilityRepository } from '../index';
import type { AvailabilityWindow } from '@hudumika/contract';

export class MockAvailabilityRepository implements AvailabilityRepository {
  async getAvailability(): Promise<AvailabilityWindow[]> {
    return clone(getState().profile.availability ?? []);
  }

  async putAvailability(windows: AvailabilityWindow[]): Promise<void> {
    getState().profile.availability = clone(windows);
  }
}
