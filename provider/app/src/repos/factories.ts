/* Repository factories — the single switch between mock and live.
 *
 * Env switches (docs/ENV-VARS.md, provider row):
 *   EXPO_PUBLIC_MOCK_AUTH        (auth + session)          default ON
 *   EXPO_PUBLIC_MOCK_PROFILE     (provider + availability) default ON
 *   EXPO_PUBLIC_MOCK_BOOKINGS    (bookings machine)        default ON
 *   EXPO_PUBLIC_MOCK_DISPATCH    (marketplace + dispatch)  default ON
 *   EXPO_PUBLIC_MOCK_SERVICES    (catalog + services)      default ON
 *   EXPO_PUBLIC_MOCK_TECHNICIANS (technicians + staff)     default ON
 *   EXPO_PUBLIC_MOCK_EARNINGS    (earnings + payouts)      default ON
 *   EXPO_PUBLIC_MOCK_NOTIFICATIONS (notifications)         default ON
 *   EXPO_PUBLIC_MOCK_SUPPORT     (support tickets)         default ON
 *   EXPO_PUBLIC_MOCK_CATALOG     (inventory/contracts/plans/trust/copilot) default ON
 *
 * Screens import the interfaces (src/repos/index.ts) and the getters below;
 * they never touch Mock/Api implementations directly.
 */
import { MockAuthRepository } from './mock/auth';
import { MockProviderRepository } from './mock/provider';
import { MockAvailabilityRepository } from './mock/availability';
import { MockCatalogRepository } from './mock/catalog';
import { MockServicesRepository } from './mock/services';
import { MockDispatchRepository } from './mock/dispatch';
import { MockBookingsRepository } from './mock/bookings';
import { MockTechniciansRepository } from './mock/technicians';
import { MockStaffRepository } from './mock/staff';
import { MockCertificationsRepository } from './mock/certifications';
import { MockEarningsRepository } from './mock/earnings';
import { MockNotificationsRepository } from './mock/notifications';
import { MockSupportRepository } from './mock/support';
import { MockReviewsRepository } from './mock/reviews';
import { MockInventoryRepository } from './mock/inventory';
import { MockContractsRepository } from './mock/contracts';
import { MockPlansRepository } from './mock/plans';
import { MockTrustRepository } from './mock/trust';
import { MockCopilotRepository } from './mock/copilot';
import { ApiAuthRepository } from './api/auth';
import { ApiProviderRepository } from './api/provider';
import { ApiAvailabilityRepository } from './api/availability';
import { ApiCatalogRepository } from './api/catalog';
import { ApiServicesRepository } from './api/services';
import { ApiDispatchRepository } from './api/dispatch';
import { ApiBookingsRepository } from './api/bookings';
import { ApiTechniciansRepository } from './api/technicians';
import { ApiStaffRepository } from './api/staff';
import { ApiCertificationsRepository } from './api/certifications';
import { ApiEarningsRepository } from './api/earnings';
import { ApiNotificationsRepository } from './api/notifications';
import { ApiSupportRepository } from './api/support';
import { ApiReviewsRepository } from './api/reviews';
import { ApiInventoryRepository } from './api/inventory';
import { ApiContractsRepository } from './api/contracts';
import { ApiPlansRepository } from './api/plans';
import { ApiTrustRepository } from './api/trust';
import { ApiCopilotRepository } from './api/copilot';
import type {
  AuthRepository,
  ProviderRepository,
  AvailabilityRepository,
  CatalogRepository,
  ServicesRepository,
  DispatchRepository,
  BookingsRepository,
  TechniciansRepository,
  StaffRepository,
  CertificationsRepository,
  EarningsRepository,
  NotificationsRepository,
  SupportRepository,
  ReviewsRepository,
  InventoryRepository,
  ContractsRepository,
  PlansRepository,
  TrustRepository,
  CopilotRepository,
} from './index';

const mock = (v: string | undefined, def = true) => (v === undefined ? def : v !== 'false');

const MOCK_AUTH = mock(process.env.EXPO_PUBLIC_MOCK_AUTH);
const MOCK_PROFILE = mock(process.env.EXPO_PUBLIC_MOCK_PROFILE);
const MOCK_BOOKINGS = mock(process.env.EXPO_PUBLIC_MOCK_BOOKINGS);
const MOCK_DISPATCH = mock(process.env.EXPO_PUBLIC_MOCK_DISPATCH);
const MOCK_SERVICES = mock(process.env.EXPO_PUBLIC_MOCK_SERVICES);
const MOCK_TECHNICIANS = mock(process.env.EXPO_PUBLIC_MOCK_TECHNICIANS);
const MOCK_EARNINGS = mock(process.env.EXPO_PUBLIC_MOCK_EARNINGS);
const MOCK_NOTIFICATIONS = mock(process.env.EXPO_PUBLIC_MOCK_NOTIFICATIONS);
const MOCK_SUPPORT = mock(process.env.EXPO_PUBLIC_MOCK_SUPPORT);
const MOCK_CATALOG = mock(process.env.EXPO_PUBLIC_MOCK_CATALOG);

export function getAuthRepository(): AuthRepository {
  return MOCK_AUTH ? new MockAuthRepository() : new ApiAuthRepository();
}

export function getProviderRepository(): ProviderRepository {
  return MOCK_PROFILE ? new MockProviderRepository() : new ApiProviderRepository();
}

export function getAvailabilityRepository(): AvailabilityRepository {
  return MOCK_PROFILE ? new MockAvailabilityRepository() : new ApiAvailabilityRepository();
}

export function getCatalogRepository(): CatalogRepository {
  return MOCK_SERVICES ? new MockCatalogRepository() : new ApiCatalogRepository();
}

export function getServicesRepository(): ServicesRepository {
  return MOCK_SERVICES ? new MockServicesRepository() : new ApiServicesRepository();
}

export function getDispatchRepository(): DispatchRepository {
  return MOCK_DISPATCH ? new MockDispatchRepository() : new ApiDispatchRepository();
}

export function getBookingsRepository(): BookingsRepository {
  return MOCK_BOOKINGS ? new MockBookingsRepository() : new ApiBookingsRepository();
}

export function getTechniciansRepository(): TechniciansRepository {
  return MOCK_TECHNICIANS ? new MockTechniciansRepository() : new ApiTechniciansRepository();
}

export function getStaffRepository(): StaffRepository {
  return MOCK_TECHNICIANS ? new MockStaffRepository() : new ApiStaffRepository();
}

export function getCertificationsRepository(): CertificationsRepository {
  return MOCK_PROFILE ? new MockCertificationsRepository() : new ApiCertificationsRepository();
}

export function getEarningsRepository(): EarningsRepository {
  return MOCK_EARNINGS ? new MockEarningsRepository() : new ApiEarningsRepository();
}

export function getNotificationsRepository(): NotificationsRepository {
  return MOCK_NOTIFICATIONS ? new MockNotificationsRepository() : new ApiNotificationsRepository();
}

export function getSupportRepository(): SupportRepository {
  return MOCK_SUPPORT ? new MockSupportRepository() : new ApiSupportRepository();
}

export function getReviewsRepository(): ReviewsRepository {
  return MOCK_BOOKINGS ? new MockReviewsRepository() : new ApiReviewsRepository();
}

export function getInventoryRepository(): InventoryRepository {
  return MOCK_CATALOG ? new MockInventoryRepository() : new ApiInventoryRepository();
}

export function getContractsRepository(): ContractsRepository {
  return MOCK_CATALOG ? new MockContractsRepository() : new ApiContractsRepository();
}

export function getPlansRepository(): PlansRepository {
  return MOCK_CATALOG ? new MockPlansRepository() : new ApiPlansRepository();
}

export function getTrustRepository(): TrustRepository {
  return MOCK_CATALOG ? new MockTrustRepository() : new ApiTrustRepository();
}

export function getCopilotRepository(): CopilotRepository {
  return MOCK_CATALOG ? new MockCopilotRepository() : new ApiCopilotRepository();
}
