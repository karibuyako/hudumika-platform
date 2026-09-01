import { getAdminMock } from './generated/endpoints/admin/admin.msw'
import { getAdminPendingMock } from './generated/endpoints/admin-pending/admin-pending.msw'
import { getAssistantMock } from './generated/endpoints/assistant/assistant.msw'
import { getAuthMock } from './generated/endpoints/auth/auth.msw'
import { getBookingsMock } from './generated/endpoints/bookings/bookings.msw'
import { getCataloguesMock } from './generated/endpoints/catalogues/catalogues.msw'
import { getCitiesMock } from './generated/endpoints/cities/cities.msw'
import { getEventsMock } from './generated/endpoints/events/events.msw'
import { getFinanceMock } from './generated/endpoints/finance/finance.msw'
import { getHotelsMock } from './generated/endpoints/hotels/hotels.msw'
import { getMarketingMock } from './generated/endpoints/marketing/marketing.msw'
import { getMerchantsMock } from './generated/endpoints/merchants/merchants.msw'
import { getNotificationsMock } from './generated/endpoints/notifications/notifications.msw'
import { getOrdersMock } from './generated/endpoints/orders/orders.msw'
import { getPaymentsMock } from './generated/endpoints/payments/payments.msw'
import { getPayoutsMock } from './generated/endpoints/payouts/payouts.msw'
import { getProvidersMock } from './generated/endpoints/providers/providers.msw'
import { getPublicMock } from './generated/endpoints/public/public.msw'
import { getReviewsMock } from './generated/endpoints/reviews/reviews.msw'
import { getRidersMock } from './generated/endpoints/riders/riders.msw'
import { getSearchMock } from './generated/endpoints/search/search.msw'
import { getServicesMock } from './generated/endpoints/services/services.msw'
import { getSupportMock } from './generated/endpoints/support/support.msw'
import { getTravelMock } from './generated/endpoints/travel/travel.msw'
import { getUsersMock } from './generated/endpoints/users/users.msw'

export const getHudumikaMocks = () => [
  ...getAdminMock(),
  ...getAdminPendingMock(),
  ...getAssistantMock(),
  ...getAuthMock(),
  ...getBookingsMock(),
  ...getCataloguesMock(),
  ...getCitiesMock(),
  ...getEventsMock(),
  ...getFinanceMock(),
  ...getHotelsMock(),
  ...getMarketingMock(),
  ...getMerchantsMock(),
  ...getNotificationsMock(),
  ...getOrdersMock(),
  ...getPaymentsMock(),
  ...getPayoutsMock(),
  ...getProvidersMock(),
  ...getPublicMock(),
  ...getReviewsMock(),
  ...getRidersMock(),
  ...getSearchMock(),
  ...getServicesMock(),
  ...getSupportMock(),
  ...getTravelMock(),
  ...getUsersMock(),
]