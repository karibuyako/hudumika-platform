import React from 'react';
import { render, screen } from '@testing-library/react-native';
import { t } from '@/i18n';
import { formatTZS } from '@/lib/format';

jest.mock('expo-router', () => ({ useRouter: () => ({ back: jest.fn(), push: jest.fn(), replace: jest.fn() }) }));
jest.mock('@/repos', () => {
  const withdrawals = [
    {
      id: 'wdr_new_001',
      amountTZS: 20000,
      feeTZS: 0,
      status: 'processing',
      method: 'mpesa',
      estimatedArrivalDays: 1,
      createdAt: '2026-08-15T09:00:00.000Z',
      paidAt: null,
      reason: null,
    },
    {
      id: 'wdr_seed_001',
      amountTZS: 50000,
      feeTZS: 0,
      status: 'paid',
      method: 'mpesa',
      estimatedArrivalDays: 1,
      createdAt: '2026-08-12T08:00:00.000Z',
      paidAt: '2026-08-12T09:00:00.000Z',
      reason: null,
    },
  ];
  return {
    getWalletRepository: () => ({ listWithdrawals: async () => withdrawals }),
  };
});

describe('withdrawals smoke', () => {
  it('withdrawals screen renders rows with amount, status pill and method', async () => {
    const Screen = require('@/app/withdrawals').default;
    await render(React.createElement(Screen));
    expect(screen.getByText(t('wallet.withdrawals'))).toBeTruthy();
    await screen.findByText(formatTZS(20000), {}, { timeout: 8000 });
    expect(screen.getByText(formatTZS(50000))).toBeTruthy();
    expect(screen.getByText(t('status.processing'))).toBeTruthy();
    expect(screen.getByText(t('status.paid'))).toBeTruthy();
    expect(screen.getAllByText(/Mpesa/).length).toBe(2);
  }, 30000);
});
