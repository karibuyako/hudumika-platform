import { getAdminMock } from './generated/endpoints/admin/admin.msw'
import { getAuthMock } from './generated/endpoints/auth/auth.msw'
import { getBookingsMock } from './generated/endpoints/bookings/bookings.msw'
import { getCataloguesMock } from './generated/endpoints/catalogues/catalogues.msw'
import { getCitiesMock } from './generated/endpoints/cities/cities.msw'
import { getMerchantsMock } from './generated/endpoints/merchants/merchants.msw'
import { getNotificationsMock } from './generated/endpoints/notifications/notifications.msw'
import { getOrdersMock } from './generated/endpoints/orders/orders.msw'
import { getPaymentsMock } from './generated/endpoints/payments/payments.msw'
import { getPayoutsMock } from './generated/endpoints/payouts/payouts.msw'
import { getProvidersMock } from './generated/endpoints/providers/providers.msw'
import { getReviewsMock } from './generated/endpoints/reviews/reviews.msw'
import { getRidersMock } from './generated/endpoints/riders/riders.msw'
import { getServicesMock } from './generated/endpoints/services/services.msw'
import { getSupportMock } from './generated/endpoints/support/support.msw'
import { getUsersMock } from './generated/endpoints/users/users.msw'

export const getHudumikaMocks = () => [
  ...getAdminMock(),
  ...getAuthMock(),
  ...getBookingsMock(),
  ...getCataloguesMock(),
  ...getCitiesMock(),
  ...getMerchantsMock(),
  ...getNotificationsMock(),
  ...getOrdersMock(),
  ...getPaymentsMock(),
  ...getPayoutsMock(),
  ...getProvidersMock(),
  ...getReviewsMock(),
  ...getRidersMock(),
  ...getServicesMock(),
  ...getSupportMock(),
  ...getUsersMock(),
]