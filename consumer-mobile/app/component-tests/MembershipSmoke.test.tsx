/* Headless render smoke for the membership screen: balance card, check-in
 * card, the redeem section (mock-only catalog, docs/CONTRACT-ADDITIONS.md
 * #16), ledger rows and benefits. The seeded balance (240) cannot cover any
 * reward, so every reward renders the "Need X more points" disabled state.
 * "No unmatched" is asserted by scanning the rendered tree for raw i18n
 * keys (a missing dict entry would render the key itself). */
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react-native';
import { t } from '@/i18n';
import { formatTZS } from '@/lib/format';

jest.mock('expo-router', () => ({ useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn() }) }));
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
  const membership = {
    points: 240,
    level: 'bronze',
    memberSince: '2025-01-10T00:00:00.000Z',
    benefits: ['Priority support', 'Member-only offers', 'Birthday reward'],
  };
  const transactions = [
    { id: 'lt_0004', type: 'check_in', points: 10, balance: 240, reference: null, at: '2026-08-14T08:00:00.000Z' },
    { id: 'lt_0003', type: 'redeem', points: -30, balance: 230, reference: 'voucher', at: '2026-08-04T08:00:00.000Z' },
  ];
  return {
    REDEMPTION_CATALOG: [
      { reward: 'wallet_credit', points: 500, valueTZS: 5000 },
      { reward: 'delivery_discount', points: 250, valueTZS: 2500 },
      { reward: 'free_delivery', points: 300, valueTZS: null },
    ],
    getMembershipsRepository: () => ({
      get: async () => JSON.parse(JSON.stringify(membership)),
      listLoyaltyTransactions: async () => JSON.parse(JSON.stringify(transactions)),
      checkIn: async () => ({ pointsEarned: 10, streakDays: 1 }),
      redeemPoints: jest.fn(async () => JSON.parse(JSON.stringify(membership))),
    }),
    getWalletRepository: () => ({
      getWallet: async () => ({ totalTZS: 25000, withdrawableTZS: 25000 }),
    }),
  };
});

describe('membership smoke', () => {
  it('renders balance, redeem catalog with disabled rewards, ledger and benefits without unmatched i18n keys', async () => {
    const Screen = require('@/app/membership').default;
    await render(React.createElement(Screen));

    expect(screen.getByText(t('membership.title'))).toBeTruthy();
    expect(screen.getByText(t('membership.points', { n: formatTZS(240) }))).toBeTruthy();
    expect(screen.getByText(t('membership.redeem'))).toBeTruthy();
    expect(screen.getByText(t('membership.redeemWalletBalance', { amount: formatTZS(25000) }))).toBeTruthy();

    expect(screen.getByText(t('membership.reward.walletCredit'))).toBeTruthy();
    expect(screen.getByText(t('membership.reward.deliveryDiscount'))).toBeTruthy();
    expect(screen.getByText(t('membership.reward.freeDelivery'))).toBeTruthy();
    expect(screen.getByText(t('membership.needMore', { n: 500 - 240 }))).toBeTruthy();
    expect(screen.getByText(t('membership.needMore', { n: 250 - 240 }))).toBeTruthy();
    expect(screen.getByText(t('membership.needMore', { n: 300 - 240 }))).toBeTruthy();

    expect(screen.getByText(t('membership.ledger'))).toBeTruthy();
    expect(screen.getByText(t('membership.ledger.redeem'))).toBeTruthy();

    await waitFor(() => {
      const tree = screen.toJSON();
      const texts = JSON.stringify(tree);
      expect(texts).not.toMatch(/"membership\.[a-zA-Z.]+"/);
    });
  }, 30000);
});
