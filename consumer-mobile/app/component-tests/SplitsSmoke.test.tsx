/* Headless render smoke for the split summary (mock-first,
 * docs/CONTRACT-ADDITIONS.md #22).
 *
 * Renders through the REAL mock repos (no @/repos mock): the seeded demo
 * split (SEED_SPLIT_ID = spl_seed_001, referencing the seeded rush order —
 * my share pending, co-payer shares pre-paid) must render its share rows,
 * the total, the pay action and the honest co-payer note. No unmatched i18n
 * keys — every rendered string is a t() key present in en/sw/ar. */
import React from 'react';
import { render, screen } from '@testing-library/react-native';
import { t } from '@/i18n';
import { formatTZS } from '@/lib/format';

jest.mock('expo-router', () => ({
  useRouter: () => ({ back: jest.fn(), push: jest.fn(), replace: jest.fn() }),
  useLocalSearchParams: () => ({ splitId: 'spl_seed_001' }),
}));
jest.mock('@expo/vector-icons', () => {
  const React = require('react');
  const { Text } = require('react-native');
  const FakeIcon = ({ name }: { name: string }) => React.createElement(Text, null, `icon:${name}`);
  return { Ionicons: FakeIcon };
});

describe('split summary smoke', () => {
  it('/splits/{seeded-id} renders the share rows, total and pay action', async () => {
    const Screen = require('@/app/splits/[splitId]').default;
    await render(React.createElement(Screen));
    expect(screen.getByText(t('split.title'))).toBeTruthy();
    // The seeded rush order's ref (display-only) loads through the real repo.
    expect(await screen.findByText('HD-OR-482917', {}, { timeout: 8000 })).toBeTruthy();
    expect(screen.getByText(formatTZS(21300))).toBeTruthy();
    expect(screen.getByText('Amina')).toBeTruthy();
    expect(screen.getByText('Juma')).toBeTruthy();
    expect(screen.getAllByText(t('split.yourShare')).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(t('split.pending'))).toBeTruthy();
    expect(screen.getAllByText(t('split.paid')).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(t('split.payMyShare'))).toBeTruthy();
    expect(screen.getByText(t('split.shareLink'))).toBeTruthy();
    expect(screen.getByText(t('split.copayerNote'))).toBeTruthy();
  }, 30000);
});
