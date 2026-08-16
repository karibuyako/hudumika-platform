/* Headless render smoke for the dine-in split-bill flow (mock-first,
 * docs/CONTRACT-ADDITIONS.md #25).
 *
 * Renders through mocked repos (the split registry is module-local and empty
 * on a fresh process, so a fixed split is served): the /dine-in list renders
 * the seeded bill, tapping it opens the bill detail with the live "Split the
 * bill" action, the sheet renders its diner presets, and the split summary
 * (/dine-in-splits/[splitId]) renders the bill ref, share rows with paid
 * pills, "Mark my share paid" and the honest co-diner note. No unmatched i18n
 * keys — every rendered string is a t() key present in en/sw/ar. */
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { ApiError } from '@/api/client';
import { t } from '@/i18n';
import { formatTZS } from '@/lib/format';

const mockBill = {
  id: 'dine_open_001',
  merchantId: 'merch_001',
  tableId: 'table_0',
  status: 'open',
  items: [{ catalogueItemId: 'citem_1', name: 'Chicken & Chips', quantity: 2, unitPriceTZS: 12000 }],
  totals: { subtotalTZS: 33000, deliveryFeeTZS: 0, platformFeeTZS: 0, taxTZS: 0, discountTZS: 0, totalTZS: 33000 },
  createdAt: '2026-08-15T10:00:00.000Z',
};

const mockSplit = {
  id: 'dins_001',
  dineInOrderId: 'dine_open_001',
  totalTZS: 33000,
  shares: [
    { id: 'share_1', label: 'You', amountTZS: 20000, status: 'pending' },
    { id: 'share_2', label: 'Amina', amountTZS: 13000, status: 'paid' },
  ],
  myShareId: 'share_1',
  status: 'open',
  createdAt: '2026-08-15T10:00:00.000Z',
};

const mockPush = jest.fn();
const mockGetSplit = jest.fn(async () => mockSplit);
const mockSplitBill = jest.fn(async () => mockSplit);

jest.mock('expo-router', () => {
  const React = require('react');
  return {
    useRouter: () => ({ back: jest.fn(), push: mockPush, replace: jest.fn() }),
    useLocalSearchParams: () => ({ splitId: 'dine_open_001' }),
    useFocusEffect: (cb: () => void) => React.useEffect(() => cb(), []),
  };
});
jest.mock('@expo/vector-icons', () => {
  const React = require('react');
  const { Text } = require('react-native');
  const FakeIcon = ({ name }: { name: string }) => React.createElement(Text, null, `icon:${name}`);
  return { Ionicons: FakeIcon };
});
jest.mock('@/repos', () => ({
  getDineInRepository: () => ({
    listMyOrders: async () => [mockBill],
    getOrder: async () => mockBill,
    getSplit: mockGetSplit,
    splitBill: mockSplitBill,
  }),
  getMerchantsRepository: () => ({ list: async () => [] }),
}));

describe('dine-in split bill headless', () => {
  beforeEach(() => {
    mockPush.mockClear();
    mockSplitBill.mockClear();
    mockGetSplit.mockClear();
    mockGetSplit.mockResolvedValue(mockSplit);
  });

  it('/dine-in renders the bill history; tapping the open bill shows the split action', async () => {
    const Screen = require('@/app/dine-in').default;
    await render(React.createElement(Screen));
    expect(await screen.findByText(t('dineIn.title'), {}, { timeout: 8000 })).toBeTruthy();
    expect(screen.getByText(t('dineIn.history'))).toBeTruthy();
    expect(screen.getByText(t('dineIn.table', { table: 'table_0' }))).toBeTruthy();
    expect(screen.getByText(formatTZS(33000))).toBeTruthy();

    // Tap the open bill → detail renders the live split action + pay.
    fireEvent.press(screen.getByText(t('dineIn.table', { table: 'table_0' })));
    expect(await screen.findByText(t('dineIn.billTitle'), {}, { timeout: 8000 })).toBeTruthy();
    expect(screen.getAllByText(t('dineIn.split')).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(t('dineIn.requestBill'))).toBeTruthy();
  }, 30000);

  it('the split sheet renders even-split presets and confirms into the summary route', async () => {
    mockGetSplit.mockRejectedValue(new ApiError(404, 'NOT_FOUND', 'No split yet'));
    const Screen = require('@/app/dine-in').default;
    await render(React.createElement(Screen));
    fireEvent.press(await screen.findByText(t('dineIn.table', { table: 'table_0' }), {}, { timeout: 8000 }));
    fireEvent.press(await screen.findByText(t('dineIn.split'), {}, { timeout: 8000 }));

    // The sheet: preset/custom toggle, 2/3/4 diner chips and the even shares.
    await waitFor(() => expect(screen.getByText(t('dineIn.splitDiners'))).toBeTruthy());
    expect(screen.getByText(t('dineIn.splitCustom'))).toBeTruthy();
    expect(screen.getByText('2')).toBeTruthy();
    expect(screen.getByText('3')).toBeTruthy();
    expect(screen.getByText('4')).toBeTruthy();
    expect(screen.getByText(t('split.you'))).toBeTruthy();
    expect(screen.getAllByText(formatTZS(16500)).length).toBeGreaterThanOrEqual(2);

    fireEvent.press(screen.getAllByText(t('dineIn.split')).at(-1)!);
    await waitFor(() => expect(mockSplitBill).toHaveBeenCalled());
    expect(mockSplitBill).toHaveBeenCalledWith('dine_open_001', expect.anything(), expect.any(String));
    expect(mockPush).toHaveBeenCalledWith({ pathname: '/dine-in-splits/[splitId]', params: { splitId: 'dine_open_001' } });
  }, 30000);

  it('/dine-in/splits/{id} renders the bill ref, share rows, my share and the copayer note', async () => {
    const Screen = require('@/app/dine-in-splits/[splitId]').default;
    await render(React.createElement(Screen));
    expect(await screen.findByText(t('dineIn.splitTitle'), {}, { timeout: 8000 })).toBeTruthy();
    expect(screen.getByText(t('dineIn.table', { table: 'table_0' }))).toBeTruthy();
    expect(screen.getByText(formatTZS(33000))).toBeTruthy();
    expect(screen.getByText('You')).toBeTruthy();
    expect(screen.getByText('Amina')).toBeTruthy();
    expect(screen.getByText(formatTZS(20000))).toBeTruthy();
    expect(screen.getByText(formatTZS(13000))).toBeTruthy();
    expect(screen.getAllByText(t('dineIn.splitMyShare')).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(t('dineIn.splitMarkPaid'))).toBeTruthy();
    expect(screen.getByText(t('dineIn.splitPaid'))).toBeTruthy();
    expect(screen.getByText(t('split.pending'))).toBeTruthy();
    expect(screen.getByText(t('dineIn.splitCopayerNote'))).toBeTruthy();
  }, 30000);
});
