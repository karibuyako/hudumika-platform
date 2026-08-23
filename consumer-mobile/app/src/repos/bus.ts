/* Bus repository barrel — Meituan bus parity.
 * Screens may import `BusRepository` from '@/repos' (house pattern) or from
 * '@/repos/bus' directly; both resolve to the same contract (src/repos/index.ts).
 * This file also re-exports the mock + api implementations for tooling/tests
 * that import the vertical directly (mirrors the existing travel/hotels barrels).
 */
export type { BusOption, BusRepository, BusRoute, BusSearchParams, BusStop, BusVehicle, StopReminder } from './index';
export { MockBusRepository, resetMockBusState } from './mock/bus';
export { ApiBusRepository } from './api/bus';
export { getBusRepository } from './factories';
