/* Headless render smoke for the UNIVERSAL CHECKOUT SHELL (MASTER-BLUEPRINT
 * §12): /checkout?transactionType=booking renders the type chip + shared
 * payment section + the booking's own price breakdown + pay dispatch; the
 * hotel type resolves the entity and honestly defers to its detail screen;
 * the absent param keeps the existing commerce order flow (no chip). Repos
 * mocked at the factory boundary; screens required lazily. */
import React from 'react';
import { render } from '@testing-library/react-native';
import { t } from '@/i18n';
import { formatTZS } from '@/lib/format';
import { useAddressesStore } from '@/store/addresses';
import { useCartStore } from '@/store/cart';

let mockSearchParams: Record<string, string> = { transactionType: 'booking', bookingId: 'bk_active_001' };

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn() }),
  useLocalSearchParams: () => mockSearchParams,
}));
jest.mock('expo-haptics', () => ({
  notificationAsync: jest.fn(),
  NotificationFeedbackType: { Success: 'success' },
}));
jest.mock('@expo/vector-icons', () => {
  const React = require('react');
  const { Text } = require('react-native');
  const FakeIcon = ({ name }: { name: string }) => React.createElement(Text, null, `icon:${name}`);
  return { Ionicons: FakeIcon };
});
jest.mock('@/repos', () => {
  const booking = {
    id: 'bk_active_001',
    status: 'pending_payment',
    providerId: 'prov_001',
    serviceId: 'svc_001',
    scheduledFor: '2026-08-20T09:00:00.000Z',
    address: { label: 'Home', lines: '12 Makunganya St', contactPhone: '+255700000000' },
    description: 'Kitchen sink leak',
    price: { subtotalTZS: 60000, deliveryFeeTZS: 5000, platformFeeTZS: 0, taxTZS: 0, discountTZS: 0, totalTZS: 65000 },
    events: [],
    createdAt: '2026-08-15T10:00:00.000Z',
    intentId: 'intent_bk_1',
    paymentMethod: 'mpesa',
  };
  const hotelBooking = {
    id: 'hbk_001',
    hotelId: 'hotel_sf',
    hotelName: 'Serena Hotel',
    roomId: 'room_sf_std',
    roomName: 'Standard Room',
    checkIn: '2026-09-01',
    checkOut: '2026-09-03',
    guests: 2,
    nights: 2,
    totalTZS: 290000,
    status: 'pending_payment',
  };
  const methods = [
    { id: 'pm_1', method: 'mpesa', label: 'M-Pesa', available: true, isDefault: true },
    { id: 'pm_2', method: 'tigo_pesa', label: 'Tigo Pesa', available: true },
    { id: 'pm_5', method: 'cod', label: 'Cash on delivery', available: true },
  ];
  return {
    getBookingsRepository: () => ({ get: async () => booking }),
    getHotelsRepository: () => ({ listMyBookings: async () => [hotelBooking] }),
    getPaymentsRepository: () => ({ getPaymentMethods: async () => methods }),
    getCouponsRepository: () => ({ list: async () => [] }),
    getOrdersRepository: () => ({ create: jest.fn() }),
  };
});

describe('checkout universal shell headless', () => {
  beforeEach(() => {
    useCartStore.getState().clear();
    useAddressesStore.setState({ addresses: [], selectedId: null });
  });

  it('booking shell renders the type chip, shared payment methods and the booking total with pay', async () => {
    mockSearchParams = { transactionType: 'booking', bookingId: 'bk_active_001' };
    const Screen = require('@/app/checkout').default;
    const { getByText, findByText } = await render(React.createElement(Screen));
    expect(getByText(t('checkout.title'))).toBeTruthy();
    expect(getByText(t('checkout.type.booking'))).toBeTruthy();
    expect(getByText(t('checkout.payment'))).toBeTruthy();
    expect(await findByText('M-Pesa', {}, { timeout: 8000 })).toBeTruthy();
    expect(getByText(t('checkout.reviewTotal'))).toBeTruthy();
    expect(getByText(t('breakdown.subtotal'))).toBeTruthy();
    expect(await findByText(t('booking.pay', { amount: formatTZS(65000) }), {}, { timeout: 8000 })).toBeTruthy();
  }, 30000);

  it('hotel shell resolves the booking and honestly defers to its detail screen', async () => {
    mockSearchParams = { transactionType: 'hotel', hotelBookingId: 'hbk_001' };
    const Screen = require('@/app/checkout').default;
    const { getByText, findByText, getAllByText } = await render(React.createElement(Screen));
    expect(getByText(t('checkout.type.hotel'))).toBeTruthy();
    expect(await findByText('Serena Hotel — 2 nights', {}, { timeout: 8000 })).toBeTruthy();
    expect(getAllByText('TZS 290,000').length).toBeGreaterThanOrEqual(1);
    expect(getByText(t('checkout.fromDetail'))).toBeTruthy();
    expect(getByText(t('common.view'))).toBeTruthy();
  }, 30000);

  it('absent transactionType keeps the commerce order flow with no type chip', async () => {
    mockSearchParams = { merchantId: 'm_1' };
    useCartStore
      .getState()
      .addItem({ merchantId: 'm_1', merchantName: 'Demo Kitchen' }, { catalogueItemId: 'i_1', name: 'Chicken & Chips', unitPriceTZS: 12000, quantity: 1 });
    useAddressesStore.getState().addAddress({ label: 'Home', lines: '12 Makunganya St', contactPhone: '+255700000000' });
    const Screen = require('@/app/checkout').default;
    const { getByText, queryByText } = await render(React.createElement(Screen));
    expect(getByText(t('checkout.title'))).toBeTruthy();
    expect(getByText(t('checkout.address'))).toBeTruthy();
    expect(queryByText(t('checkout.type.commerce'))).toBeNull();
  }, 30000);
});
