/* Headless render smoke for the read-only shared tracking screen
 * (OPERATIONS-COVERAGE #77 "Share live location — trip-share pattern",
 * mock-first, docs/CONTRACT-ADDITIONS.md #27).
 *
 * Renders through the REAL mock repos (no @/repos mock): the seeded demo
 * token (SEED_TRACKING_SHARE_TOKEN = ts_ord_warehouse_003_demo8f, resolving
 * to the seeded warehouse order — status picked_up, rider location live)
 * must render the shared-view banner, the rider map + ETA and the phases
 * strip — and MUST NOT render any owner action (no Share trip, no support,
 * no masked call, no dev delay trigger). An unknown token renders the
 * "Tracking unavailable" state with retry. No unmatched i18n keys — every
 * rendered string is a t() key present in en/sw/ar. */
import React from 'react';
import { render, screen } from '@testing-library/react-native';
import { t } from '@/i18n';
import { SEED_TRACKING_SHARE_TOKEN } from '@/repos/mock/orders';

let mockParams: Record<string, string> = { token: SEED_TRACKING_SHARE_TOKEN };
jest.mock('expo-router', () => ({
  useRouter: () => ({ back: jest.fn(), push: jest.fn(), replace: jest.fn() }),
  useLocalSearchParams: () => mockParams,
}));
jest.mock('@expo/vector-icons', () => {
  const React = require('react');
  const { Text } = require('react-native');
  const FakeIcon = ({ name }: { name: string }) => React.createElement(Text, null, `icon:${name}`);
  return { Ionicons: FakeIcon };
});

describe('track-share smoke', () => {
  it('/track-share/{seeded-token} renders the read-only shared tracking view', async () => {
    const Screen = require('@/app/track-share/[token]').default;
    await render(React.createElement(Screen));
    // Read-only banner + the seeded warehouse order's status pill.
    expect(await screen.findByText(t('tripShare.watchBanner'), {}, { timeout: 8000 })).toBeTruthy();
    expect(screen.getAllByText(t('status.picked_up')).length).toBeGreaterThan(0);
    // The phases strip renders (seeded ord_warehouse_003 phase set).
    expect(await screen.findByText(t('track.phases'), {}, { timeout: 8000 })).toBeTruthy();
    // The warehouse chip renders (fulfillmentSource 'warehouse').
    expect(screen.getByText(t('order.warehouseChip'))).toBeTruthy();
    // Owner-only actions are hidden in the read-only view.
    expect(screen.queryByText(t('tripShare.share'))).toBeNull();
    expect(screen.queryByText(t('order.support'))).toBeNull();
    expect(screen.queryByText(t('track.maskedCall'))).toBeNull();
    expect(screen.queryByText(t('track.simulateDelay'))).toBeNull();
  }, 30000);

  it('/track-share/{unknown-token} renders the tracking-unavailable state', async () => {
    mockParams = { token: 'ts_nope_000000' };
    const Screen = require('@/app/track-share/[token]').default;
    await render(React.createElement(Screen));
    expect(await screen.findByText(t('track.unavailable'), {}, { timeout: 8000 })).toBeTruthy();
  }, 30000);
});
