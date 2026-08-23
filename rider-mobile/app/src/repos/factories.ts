/* Repository factories — the single switch between mock and live.
 *
 * Env switches (docs/MOBILE-MOCK-PATTERN.md, rider row):
 *   EXPO_PUBLIC_MOCK_JOBS      (dispatch + delivery)  default ON
 *   EXPO_PUBLIC_MOCK_EARNINGS  (earnings + payouts)   default ON
 *   EXPO_PUBLIC_MOCK_AUTH      (auth + rider profile) default ON
 *   EXPO_PUBLIC_MOCK_SUPPORT   (support tickets)      default ON
 *   EXPO_PUBLIC_MOCK_SAFETY    (sos + contacts + security + trip share) default ON
 *   EXPO_PUBLIC_MOCK_VEHICLE   (vehicle tools)        default ON
 *   EXPO_PUBLIC_MOCK_TRIPS     (batch trips P10c)     default ON
 *   EXPO_PUBLIC_MOCK_LOGISTICS (facilities/exceptions/shipments) default ON — gated, not always-mock
 *   Payments (collection QR) and notifications ride on MOCK_JOBS — they are
 *   order-lifecycle resources, no separate switch.
 *
 * Screens import the interface (src/repos/index.ts) and the getters below;
 * they never touch Mock/Api implementations directly.
 */
import { MockAuthRepository } from './mock/auth';
import { MockRiderRepository } from './mock/rider';
import { MockJobsRepository } from './mock/jobs';
import { MockDeliveryRepository } from './mock/delivery';
import { MockEarningsRepository } from './mock/earnings';
import { MockNotificationsRepository } from './mock/notifications';
import { MockSupportRepository } from './mock/support';
import { MockSafetyRepository } from './mock/safety';
import { MockVehicleRepository } from './mock/vehicle';
import { MockTripsRepository } from './mock/trips';
import { MockPaymentRepository } from './mock/payments';
import { MockLogisticsRepository } from './mock/logistics';
import { ApiAuthRepository } from './api/auth';
import { ApiRiderRepository } from './api/rider';
import { ApiJobsRepository } from './api/jobs';
import { ApiDeliveryRepository } from './api/delivery';
import { ApiEarningsRepository } from './api/earnings';
import { ApiNotificationsRepository } from './api/notifications';
import { ApiSupportRepository } from './api/support';
import { ApiSafetyRepository } from './api/safety';
import { ApiVehicleRepository } from './api/vehicle';
import { ApiTripsRepository } from './api/trips';
import { ApiPaymentRepository } from './api/payments';
import { ApiLogisticsRepository } from './api/logistics';
import type {
  AuthRepository,
  RiderRepository,
  JobsRepository,
  DeliveryRepository,
  EarningsRepository,
  NotificationsRepository,
  SupportRepository,
  SafetyRepository,
  VehicleRepository,
  TripsRepository,
  PaymentRepository,
  LogisticsRepository,
} from './index';
import { isValidApiBase } from '@/api/client';

const mock = (v: string | undefined, def = true) => (v === undefined ? def : v !== 'false');

// If EXPO_PUBLIC_API_URL is missing/invalid and we're in staging/production (no custom domain yet),
// force mocks at runtime so EAS preview/production can be built before DNS/TLS is ready.
// In development/test, respect the explicit MOCK flag even with empty API_BASE (default mock ON).
// When the URL becomes valid the app auto-switches to live on next `eas update` without a new binary.
const hasValidApiBase = isValidApiBase();
const forceMockForMissingUrl = !hasValidApiBase && (process.env.EXPO_PUBLIC_ENV === 'staging' || process.env.EXPO_PUBLIC_ENV === 'production');
if (forceMockForMissingUrl) {
  console.warn('[factories] EXPO_PUBLIC_API_URL invalid/empty in staging/production — forcing all mocks ON until a valid URL is configured. Set it via `eas update --channel preview --env EXPO_PUBLIC_API_URL=https://...`');
}

const MOCK_AUTH = forceMockForMissingUrl ? true : mock(process.env.EXPO_PUBLIC_MOCK_AUTH);
const MOCK_JOBS = forceMockForMissingUrl ? true : mock(process.env.EXPO_PUBLIC_MOCK_JOBS);
const MOCK_EARNINGS = forceMockForMissingUrl ? true : mock(process.env.EXPO_PUBLIC_MOCK_EARNINGS);
const MOCK_SUPPORT = forceMockForMissingUrl ? true : mock(process.env.EXPO_PUBLIC_MOCK_SUPPORT);
const MOCK_SAFETY = forceMockForMissingUrl ? true : mock(process.env.EXPO_PUBLIC_MOCK_SAFETY);
const MOCK_VEHICLE = forceMockForMissingUrl ? true : mock(process.env.EXPO_PUBLIC_MOCK_VEHICLE);
const MOCK_TRIPS = forceMockForMissingUrl ? true : mock(process.env.EXPO_PUBLIC_MOCK_TRIPS);
const MOCK_LOGISTICS = forceMockForMissingUrl ? true : mock(process.env.EXPO_PUBLIC_MOCK_LOGISTICS);

export function getAuthRepository(): AuthRepository {
  return MOCK_AUTH ? new MockAuthRepository() : new ApiAuthRepository();
}

export function getRiderRepository(): RiderRepository {
  return MOCK_AUTH ? new MockRiderRepository() : new ApiRiderRepository();
}

export function getJobsRepository(): JobsRepository {
  return MOCK_JOBS ? new MockJobsRepository() : new ApiJobsRepository();
}

export function getDeliveryRepository(): DeliveryRepository {
  return MOCK_JOBS ? new MockDeliveryRepository() : new ApiDeliveryRepository();
}

export function getEarningsRepository(): EarningsRepository {
  return MOCK_EARNINGS ? new MockEarningsRepository() : new ApiEarningsRepository();
}

export function getNotificationsRepository(): NotificationsRepository {
  return MOCK_JOBS ? new MockNotificationsRepository() : new ApiNotificationsRepository();
}

export function getSupportRepository(): SupportRepository {
  return MOCK_SUPPORT ? new MockSupportRepository() : new ApiSupportRepository();
}

export function getSafetyRepository(): SafetyRepository {
  return MOCK_SAFETY ? new MockSafetyRepository() : new ApiSafetyRepository();
}

export function getVehicleRepository(): VehicleRepository {
  return MOCK_VEHICLE ? new MockVehicleRepository() : new ApiVehicleRepository();
}

export function getTripsRepository(): TripsRepository {
  return MOCK_TRIPS ? new MockTripsRepository() : new ApiTripsRepository();
}

export function getPaymentRepository(): PaymentRepository {
  return MOCK_JOBS ? new MockPaymentRepository() : new ApiPaymentRepository();
}

export function getLogisticsRepository(): LogisticsRepository {
  return MOCK_LOGISTICS ? new MockLogisticsRepository() : new ApiLogisticsRepository();
}