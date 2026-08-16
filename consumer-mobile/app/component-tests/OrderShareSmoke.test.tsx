/* Headless render smoke for SHARE ORDER/BOOKING (OPERATIONS-COVERAGE #138):
 * the order detail /order/ord_active_001 renders with the Share button
 * (label t('share.order'), accessibilityRole button) wired to the share
 * payload builder — the seeded order id is used so every string resolves
 * (no unmatched i18n keys). Pressing Share in the jest env (no share
 * surface) resolves node-safe and surfaces the share.failed toast. Repos
 * mocked at the factory boundary; screens required lazily (CheckoutSmoke
 * pattern). */
import React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react-native';
import { t } from '@/i18n';
import { formatTZS } from '@/lib/format';
import { useUiStore } from '@/store/ui';

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn() }),
  useLocalSearchParams: () => ({ orderId: 'ord_active_001' }),
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
  const order = {
    id: 'ord_active_001',
    no: 'HD-OR-482913',
    status: 'delivering',
    merchantId: 'm_1',
    version: 1,
    createdAt: '2026-08-15T10:00:00.000Z',
    totals: { subtotalTZS: 24000, deliveryFeeTZS: 2500, platformFeeTZS: 800, taxTZS: 0, discountTZS: 0, totalTZS: 27300 },
    items: [{ catalogueItemId: 'citem_000_0', name: 'Chicken & Chips', quantity: 1, unitPriceTZS: 12000 }],
    events: [
      { status: 'paid', at: '2026-08-15T10:00:00.000Z', by: 'system', note: 'Order paid via mobile money' },
      { status: 'delivering', at: '2026-08-15T10:15:00.000Z', by: 'rider', note: 'On the way' },
    ],
    deliveryAddress: { label: 'Home', lines: '12 Makunganya St', landmark: 'Near the clock tower' },
  };
  return {
    getOrdersRepository: () => ({ get: async () => order }),
    getPaymentsRepository: () => ({ getHistory: async () => [] }),
    getConversationsRepository: () => ({ create: jest.fn() }),
  };
});

describe('order detail share headless', () => {
  it('/order/ord_active_001 renders the Share button with the order ref and total', async () => {
    useUiStore.setState({ toast: null });
    const Screen = require('@/app/order/[orderId]').default;
    const { getByText, getAllByText, findByText, getByLabelText } = await render(React.createElement(Screen));
    expect(await findByText('HD-OR-482913', {}, { timeout: 8000 })).toBeTruthy();
    expect(getAllByText(t('status.delivering')).length).toBeGreaterThan(0);
    expect(getByText(formatTZS(27300))).toBeTruthy();
    const share = getByLabelText(t('share.order'));
    expect(share).toBeTruthy();
    expect(share.props.accessibilityRole).toBe('button');
  }, 30000);

  it('pressing Share is node-safe in the jest env and reports the fallback', async () => {
    useUiStore.setState({ toast: null });
    const Screen = require('@/app/order/[orderId]').default;
    const { findByLabelText } = await render(React.createElement(Screen));
    const share = await findByLabelText(t('share.order'), {}, { timeout: 8000 });
    fireEvent.press(share);
    await waitFor(
      () => expect(useUiStore.getState().toast?.message).toBe(t('share.failed')),
      { timeout: 8000 },
    );
  }, 30000);
});
