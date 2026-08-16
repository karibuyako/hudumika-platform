/* Headless render smoke for Preferred Providers (OPERATIONS-COVERAGE #140,
 * mock-first until the contract ships the surface —
 * docs/CONTRACT-ADDITIONS.md #21).
 *
 * Renders through the REAL mock repos (no @/repos mock): the seeded provider
 * detail screen must show the "Preferred provider" toggle (listPreferred
 * resolves → preferred !== null) and the services tab must show the
 * "Your preferred providers" section above the provider list (the mock seeds
 * one preferred provider). No unmatched i18n keys — every rendered string is
 * a t() key present in en/sw/ar. */
import React from 'react';
import { render } from '@testing-library/react-native';
import { getState } from '@/repos/mock/mockState';
import { t } from '@/i18n';

jest.mock('expo-router', () => {
  const { getState } = require('@/repos/mock/mockState');
  return {
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn() }),
    useLocalSearchParams: () => ({ providerId: (getState().home.providers ?? [])[0]?.id }),
  };
});
jest.mock('@expo/vector-icons', () => {
  const { Text } = require('react-native');
  const FakeIcon = ({ name }: { name: string }) => require('react').createElement(Text, null, `icon:${name}`);
  return { Ionicons: FakeIcon };
});

describe('preferred providers headless', () => {
  it('provider detail renders the preferred toggle for the seeded provider', async () => {
    const Screen = require('@/app/provider/[providerId]').default;
    const { findByText, getByText } = await render(React.createElement(Screen));
    const seeded = (getState().home.providers ?? [])[0];
    expect(seeded).toBeTruthy();
    expect(await findByText(seeded!.name, {}, { timeout: 8000 })).toBeTruthy();
    expect(getByText(t('providers.preferred'))).toBeTruthy();
  }, 30000);

  it('services tab renders the preferred-providers section with the seeded provider', async () => {
    const Screen = require('@/app/(tabs)/services/index').default;
    const { findByText, getAllByText } = await render(React.createElement(Screen));
    const seeded = (getState().home.providers ?? [])[0];
    expect(seeded).toBeTruthy();
    expect(await findByText(t('providers.preferredSection'), {}, { timeout: 8000 })).toBeTruthy();
    // The star marker renders only on preferred cards (never in the main list).
    expect(getAllByText('icon:star').length).toBeGreaterThanOrEqual(1);
    // The seeded preferred provider appears twice: the preferred card AND the
    // main provider list card (the seed is the first seeded provider).
    expect(getAllByText(seeded!.name).length).toBeGreaterThanOrEqual(2);
  }, 30000);
});
