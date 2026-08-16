/* Headless render smoke for the home feed's personalized recommendations rail
 * (MASTER-BLUEPRINT §5, docs/CONTRACT-ADDITIONS.md #25, mock-only-until-
 * adopted GET /home/recommendations).
 *
 * Renders through the REAL mock repos (same pattern as TrackShareSmoke): the
 * demo user's seeded order history drives the rail. Without the
 * 'personalization' consent the section renders nothing but the honest
 * "Enable recommendations" hint into /privacy (recommendations require
 * consent per the blueprint); with consent it renders the "Recommended for
 * you" rail with the server-owned reason copy verbatim. "No unmatched" is
 * asserted in both states by scanning the rendered tree for raw i18n keys (a
 * missing dict entry would render the key itself); the mock-owned reason is
 * asserted as a literal string, never an i18n key. */
import React from 'react';
import { render, screen } from '@testing-library/react-native';
import { t } from '@/i18n';
import { RECOMMENDATION_REASON_ORDERED } from '@/repos/mock/home';
import { useConsentStore } from '@/store/consent';

jest.mock('expo-router', () => {
  const React = require('react');
  return {
    useRouter: () => ({ back: jest.fn(), push: jest.fn(), replace: jest.fn() }),
    useFocusEffect: (cb: () => void) => React.useEffect(cb, [cb]),
  };
});
jest.mock('@expo/vector-icons', () => {
  const React = require('react');
  const { Text } = require('react-native');
  const FakeIcon = ({ name }: { name: string }) => React.createElement(Text, null, `icon:${name}`);
  return { Ionicons: FakeIcon };
});

/** Collect every leaf text from the rendered tree. FlatList hosts a circular
 * ListHeaderComponent reference, so JSON.stringify cannot scan it — walk the
 * children instead. */
function collectTexts(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const child of node) collectTexts(child, out);
    return out;
  }
  if (node && typeof node === 'object') {
    const children = (node as { children?: unknown }).children;
    if (typeof children === 'string') out.push(children);
    else if (children !== undefined && children !== null) collectTexts(children, out);
  }
  return out;
}

/** A raw i18n key would render as the key itself (t() falls back to the key) —
 * any home.* text is an unmatched dict entry. */
function assertNoUnmatchedHomeKeys(): void {
  const texts = collectTexts(screen.toJSON());
  const unmatched = texts.filter((s) => /^home\.[a-zA-Z.]+$/.test(s));
  expect(unmatched).toEqual([]);
}

describe('home recommendations smoke', () => {
  beforeEach(() => {
    useConsentStore.getState().revoke('personalization');
  });

  it('without personalization consent renders the enable hint, never the rail', async () => {
    const Screen = require('@/app/(tabs)/home').default;
    await render(React.createElement(Screen));

    // The feed still renders; the consent-gated section is an honest hint only.
    expect(screen.getByText(t('home.categories'))).toBeTruthy();
    expect(screen.getByText(t('home.enableRecommendations'))).toBeTruthy();
    expect(screen.queryByText(t('home.recommended'))).toBeNull();

    assertNoUnmatchedHomeKeys();
  }, 30000);

  it('with personalization consent renders the rail from the seeded order history', async () => {
    useConsentStore.getState().grant('personalization');
    const Screen = require('@/app/(tabs)/home').default;
    await render(React.createElement(Screen));

    expect(await screen.findByText(t('home.recommended'), {}, { timeout: 8000 })).toBeTruthy();
    // Server-owned reason copy rendered verbatim (mock-as-server), never i18n.
    expect(screen.getAllByText(RECOMMENDATION_REASON_ORDERED).length).toBeGreaterThan(0);
    expect(screen.queryByText(t('home.enableRecommendations'))).toBeNull();

    assertNoUnmatchedHomeKeys();
  }, 30000);
});
