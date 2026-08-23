/* Repository factories — the single switch between mock and live.
 *
 * Env switches (docs/MOBILE-MOCK-PATTERN.md, consumer row):
 *   EXPO_PUBLIC_MOCK_AUTH    (auth + users)         default ON
 *   EXPO_PUBLIC_MOCK_HOME    (home + search)        default ON
 *   EXPO_PUBLIC_MOCK_ORDERS  (orders + payments +
 *                             bookings + reviews +
 *                             support + conversations +
 *                             merchants + providers +
 *                             shipments + disputes +
 *                             marketing/live-deals +
 *                             hotels + travel + events)   default ON
 *   EXPO_PUBLIC_MOCK_WALLET  (wallet + coupons + red packets +
 *                             favorites + memberships +
 *                             group-buy + dine-in +
 *                             reservations + rewards
 *                             (referral + birthday))   default ON
 *   EXPO_PUBLIC_MOCK_ASSISTANT (assistant chat)      default ON
 *
 * Screens import the interface (src/repos/index.ts) and the getters below;
 * they never touch Mock/Api implementations directly.
 */
import { MockAuthRepository } from './mock/auth';
import { MockAssistantRepository } from './mock/assistant';
import { MockHomeRepository } from './mock/home';
import { MockHotelsRepository } from './mock/hotels';
import { MockEventsRepository } from './mock/events';
import { MockListsRepository } from './mock/lists';
import { MockSearchRepository } from './mock/search';
import { MockMerchantsRepository } from './mock/merchants';
import { MockProvidersRepository } from './mock/providers';
import { MockOrdersRepository } from './mock/orders';
import { MockPaymentsRepository } from './mock/payments';
import { MockWalletRepository } from './mock/wallet';
import { MockFinanceRepository } from './mock/finance';
import { MockBookingsRepository } from './mock/bookings';
import { MockReviewsRepository } from './mock/reviews';
import { MockNotificationsRepository } from './mock/notifications';
import { MockSupportRepository } from './mock/support';
import { MockConversationsRepository } from './mock/conversations';
import { MockCouponsRepository } from './mock/coupons';
import { MockFavoritesRepository } from './mock/favorites';
import { MockMembershipsRepository } from './mock/memberships';
import { MockMarketingRepository } from './mock/marketing';
import { MockGroupBuyRepository } from './mock/groupBuy';
import { MockVouchersRepository } from './mock/vouchers';
import { MockDineInRepository } from './mock/dineIn';
import { MockDisputesRepository } from './mock/disputes';
import { MockReservationsRepository } from './mock/reservations';
import { MockShipmentsRepository } from './mock/shipments';
import { MockSplitPaymentsRepository } from './mock/splits';
import { MockRedPacketRepository } from './mock/redPackets';
import { MockGroupOrdersRepository } from './mock/groupOrders';
import { MockRewardsRepository } from './mock/rewards';
import { MockTravelRepository } from './mock/travel';
import { MockBusRepository } from './mock/bus';
import { MockRideRepository } from './mock/ride';
import { MockBikeRepository } from './mock/bike';

import { ApiAuthRepository } from './api/auth';
import { ApiAssistantRepository } from './api/assistant';
import { ApiHomeRepository } from './api/home';
import { ApiHotelsRepository } from './api/hotels';
import { ApiEventsRepository } from './api/events';
import { ApiListsRepository } from './api/lists';
import { ApiSearchRepository } from './api/search';
import { ApiMerchantsRepository } from './api/merchants';
import { ApiProvidersRepository } from './api/providers';
import { ApiOrdersRepository } from './api/orders';
import { ApiPaymentsRepository } from './api/payments';
import { ApiWalletRepository } from './api/wallet';
import { ApiFinanceRepository } from './api/finance';
import { ApiBookingsRepository } from './api/bookings';
import { ApiReviewsRepository } from './api/reviews';
import { ApiNotificationsRepository } from './api/notifications';
import { ApiSupportRepository } from './api/support';
import { ApiConversationsRepository } from './api/conversations';
import { ApiCouponsRepository } from './api/coupons';
import { ApiFavoritesRepository } from './api/favorites';
import { ApiMembershipsRepository } from './api/memberships';
import { ApiMarketingRepository } from './api/marketing';
import { ApiGroupBuyRepository } from './api/groupBuy';
import { ApiVouchersRepository } from './api/vouchers';
import { ApiDineInRepository } from './api/dineIn';
import { ApiDisputesRepository } from './api/disputes';
import { ApiReservationsRepository } from './api/reservations';
import { ApiShipmentsRepository } from './api/shipments';
import { ApiSplitPaymentsRepository } from './api/splits';
import { ApiRedPacketRepository } from './api/redPackets';
import { ApiGroupOrdersRepository } from './api/groupOrders';
import { ApiRewardsRepository } from './api/rewards';
import { ApiTravelRepository } from './api/travel';
import { ApiBusRepository } from './api/bus';
import { ApiRideRepository } from './api/ride';
import { ApiBikeRepository } from './api/bike';

import type {
  AssistantRepository,
  AuthRepository,
  BikeRepository,
  BookingsRepository,
  BusRepository,
  ConversationsRepository,
  CouponsRepository,
  DineInRepository,
  DisputesRepository,
  EventsRepository,
  FavoritesRepository,
  FinanceRepository,
  GroupBuyRepository,
  GroupOrdersRepository,
  HomeRepository,
  HotelsRepository,
  ListsRepository,
  MembershipsRepository,
  MerchantsRepository,
  MarketingRepository,
  NotificationsRepository,
  OrdersRepository,
  PaymentsRepository,
  ProvidersRepository,
  RedPacketRepository,
  ReservationsRepository,
  ReviewsRepository,
  RewardsRepository,
  RideRepository,
  SearchRepository,
  ShipmentsRepository,
  SplitPaymentsRepository,
  SupportRepository,
  TravelRepository,
  VouchersRepository,
  WalletRepository,
} from './index';

const isProd = process.env.EXPO_PUBLIC_ENV === 'production';
const mock = (v: string | undefined, def = true) => {
  if (isProd) return v === 'true'; // in production, only explicit "true" keeps mock; undefined/false → live
  return v === undefined ? def : v !== 'false';
};

const MOCK_AUTH = mock(process.env.EXPO_PUBLIC_MOCK_AUTH);
const MOCK_HOME = mock(process.env.EXPO_PUBLIC_MOCK_HOME);
const MOCK_ORDERS = mock(process.env.EXPO_PUBLIC_MOCK_ORDERS);
const MOCK_WALLET = mock(process.env.EXPO_PUBLIC_MOCK_WALLET);
const MOCK_ASSISTANT = mock(process.env.EXPO_PUBLIC_MOCK_ASSISTANT);

export function getAssistantRepository(): AssistantRepository {
  return MOCK_ASSISTANT ? new MockAssistantRepository() : new ApiAssistantRepository();
}

export function getAuthRepository(): AuthRepository {
  return MOCK_AUTH ? new MockAuthRepository() : new ApiAuthRepository();
}

export function getHomeRepository(): HomeRepository {
  if (MOCK_HOME) {
    // Hybrid: home feed + cities stay mock for static export (no live DB needed at build),
    // but recommendations are always live (time/place/session/cold/warm engine).
    const mock = new MockHomeRepository();
    const api = new ApiHomeRepository();
    return {
      getHomeFeed: () => mock.getHomeFeed(),
      listCities: () => mock.listCities(),
      getRecommendations: (opts) => api.getRecommendations(opts),
    };
  }
  return new ApiHomeRepository();
}

export function getHotelsRepository(): HotelsRepository {
  return MOCK_ORDERS ? new MockHotelsRepository() : new ApiHotelsRepository();
}

export function getEventsRepository(): EventsRepository {
  return MOCK_ORDERS ? new MockEventsRepository() : new ApiEventsRepository();
}

export function getSearchRepository(): SearchRepository {
  return MOCK_HOME ? new MockSearchRepository() : new ApiSearchRepository();
}

export function getMerchantsRepository(): MerchantsRepository {
  return MOCK_ORDERS ? new MockMerchantsRepository() : new ApiMerchantsRepository();
}

export function getProvidersRepository(): ProvidersRepository {
  return MOCK_ORDERS ? new MockProvidersRepository() : new ApiProvidersRepository();
}

export function getOrdersRepository(): OrdersRepository {
  return MOCK_ORDERS ? new MockOrdersRepository() : new ApiOrdersRepository();
}

export function getPaymentsRepository(): PaymentsRepository {
  return MOCK_ORDERS ? new MockPaymentsRepository() : new ApiPaymentsRepository();
}

export function getBookingsRepository(): BookingsRepository {
  return MOCK_ORDERS ? new MockBookingsRepository() : new ApiBookingsRepository();
}

export function getReviewsRepository(): ReviewsRepository {
  return MOCK_ORDERS ? new MockReviewsRepository() : new ApiReviewsRepository();
}

export function getNotificationsRepository(): NotificationsRepository {
  return MOCK_ORDERS ? new MockNotificationsRepository() : new ApiNotificationsRepository();
}

export function getSupportRepository(): SupportRepository {
  return MOCK_ORDERS ? new MockSupportRepository() : new ApiSupportRepository();
}

export function getConversationsRepository(): ConversationsRepository {
  return MOCK_ORDERS ? new MockConversationsRepository() : new ApiConversationsRepository();
}

export function getWalletRepository(): WalletRepository {
  return MOCK_WALLET ? new MockWalletRepository() : new ApiWalletRepository();
}

/** Invoices & receipts (GET /finance/invoices + detail + download — contract,
 * READ-ONLY). The wallet screen hosts the entry row, so the switch rides the
 * wallet env var. */
export function getFinanceRepository(): FinanceRepository {
  return MOCK_WALLET ? new MockFinanceRepository() : new ApiFinanceRepository();
}

export function getCouponsRepository(): CouponsRepository {
  return MOCK_WALLET ? new MockCouponsRepository() : new ApiCouponsRepository();
}

export function getFavoritesRepository(): FavoritesRepository {
  return MOCK_WALLET ? new MockFavoritesRepository() : new ApiFavoritesRepository();
}

/** Curated lists (必吃榜-lite, GET /lists + /lists/{id}) — mock-only-until-
 * adopted paths (docs/CONTRACT-ADDITIONS.md #14). The home rail renders the
 * same seed from src/lib/lists.ts; the switch rides the marketing/content
 * env var (same as live deals). */
export function getListsRepository(): ListsRepository {
  return MOCK_ORDERS ? new MockListsRepository() : new ApiListsRepository();
}

export function getMembershipsRepository(): MembershipsRepository {
  return MOCK_WALLET ? new MockMembershipsRepository() : new ApiMembershipsRepository();
}

export function getMarketingRepository(): MarketingRepository {
  return MOCK_ORDERS ? new MockMarketingRepository() : new ApiMarketingRepository();
}

export function getGroupBuyRepository(): GroupBuyRepository {
  return MOCK_WALLET ? new MockGroupBuyRepository() : new ApiGroupBuyRepository();
}

export function getGroupOrdersRepository(): GroupOrdersRepository {
  return MOCK_ORDERS ? new MockGroupOrdersRepository() : new ApiGroupOrdersRepository();
}

export function getVouchersRepository(): VouchersRepository {
  return MOCK_WALLET ? new MockVouchersRepository() : new ApiVouchersRepository();
}

export function getDineInRepository(): DineInRepository {
  return MOCK_WALLET ? new MockDineInRepository() : new ApiDineInRepository();
}

export function getShipmentsRepository(): ShipmentsRepository {
  return MOCK_ORDERS ? new MockShipmentsRepository() : new ApiShipmentsRepository();
}

export function getDisputesRepository(): DisputesRepository {
  return MOCK_ORDERS ? new MockDisputesRepository() : new ApiDisputesRepository();
}

/** Split payments ride the orders env switch (they build on orders +
 * payments — same bucket as the group-order vertical). */
export function getSplitPaymentsRepository(): SplitPaymentsRepository {
  return MOCK_ORDERS ? new MockSplitPaymentsRepository() : new ApiSplitPaymentsRepository();
}

export function getReservationsRepository(): ReservationsRepository {
  return MOCK_WALLET ? new MockReservationsRepository() : new ApiReservationsRepository();
}

export function getRedPacketRepository(): RedPacketRepository {
  return MOCK_WALLET ? new MockRedPacketRepository() : new ApiRedPacketRepository();
}

export function getRewardsRepository(): RewardsRepository {
  return MOCK_WALLET ? new MockRewardsRepository() : new ApiRewardsRepository();
}

export function getTravelRepository(): TravelRepository {
  return MOCK_ORDERS ? new MockTravelRepository() : new ApiTravelRepository();
}

export function getBusRepository(): BusRepository {
  return MOCK_ORDERS ? new MockBusRepository() : new ApiBusRepository();
}

export function getRideRepository(): RideRepository {
  return MOCK_ORDERS ? new MockRideRepository() : new ApiRideRepository();
}

export function getBikeRepository(): BikeRepository {
  return MOCK_ORDERS ? new MockBikeRepository() : new ApiBikeRepository();
}
