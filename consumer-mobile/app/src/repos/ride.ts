/* Ride repository re-export — satisfies Meituan ride spec path src/repos/ride.ts.
 * Canonical interfaces live in src/repos/index.ts (house pattern); this file
 * re-exports them so tooling referencing src/repos/ride.ts resolves.
 */
export type { Ride, RideCreateInput, RideDriver, RideEstimate, RideRepository, RideStatus, RideType } from './index';
export { MockRideRepository } from './mock/ride';
export { ApiRideRepository } from './api/ride';
