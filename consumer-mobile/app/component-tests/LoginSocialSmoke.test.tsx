/* Headless render smoke for the SOCIAL LOGIN surface on the login screen
 * (src/app/(auth)/login.tsx — docs/CONTRACT-ADDITIONS.md #19): the
 * "or continue with" divider + Google/Apple buttons render, tapping Google
 * opens the honest mock-first explainer sheet, and the confirm path signs in
 * with the simulated exchange and applies the session (→ /onboarding).
 * Repos mocked at the factory boundary; the screen required lazily. */
import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
import { t } from '@/i18n';

jest.mock('expo-router', () => {
  const router = { push: jest.fn(), replace: jest.fn(), back: jest.fn() };
  return { useRouter: () => router, __loginRouterForTests: () => router };
});
jest.mock('@expo/vector-icons', () => {
  const React = require('react');
  const { Text } = require('react-native');
  const FakeIcon = ({ name }: { name: string }) => React.createElement(Text, null, `icon:${name}`);
  return { Ionicons: FakeIcon };
});
jest.mock('@/repos', () => {
  const session = {
    accessToken: 'mock_at_social_google_test',
    refreshToken: 'mock_rt_social_google_test',
    user: {
      id: 'cus_0001',
      phone: '+255700000000',
      fullName: 'Demo Customer',
      activeRole: 'customer',
      roles: [{ role: 'customer' }],
      locale: 'en',
      createdAt: '2026-08-15T00:00:00.000Z',
    },
  };
  return {
    getAuthRepository: () => ({
      socialLogin: jest.fn().mockResolvedValue(session),
      requestOtp: jest.fn(),
    }),
  };
});

describe('login social surface headless', () => {
  it('renders the divider and both social buttons with no unmatched keys', async () => {
    const Screen = require('@/app/(auth)/login').default;
    const { getByText } = await render(React.createElement(Screen));
    expect(getByText(t('login.title'))).toBeTruthy();
    expect(getByText(t('auth.orContinue'))).toBeTruthy();
    expect(getByText(t('auth.socialGoogle'))).toBeTruthy();
    expect(getByText(t('auth.socialApple'))).toBeTruthy();
    // Keys resolve — a missing key would render the raw key string instead.
    expect(t('auth.socialGoogle')).not.toMatch(/^auth\./);
    expect(t('auth.socialApple')).not.toMatch(/^auth\./);
    expect(t('auth.orContinue')).not.toMatch(/^auth\./);
  });

  it('tapping Google opens the demo explainer sheet and signs in to the city picker', async () => {
    const Screen = require('@/app/(auth)/login').default;
    const { getByLabelText, getByText, queryByText } = await render(React.createElement(Screen));
    expect(queryByText(t('auth.socialExplain', { provider: 'Google' }))).toBeNull();

    await act(async () => {
      fireEvent.press(getByLabelText(t('auth.socialGoogle')));
    });
    const explainer = getByText(t('auth.socialExplain', { provider: 'Google' }));
    expect(explainer).toBeTruthy();
    // Honest mock-first copy — the demo account is disclosed, not hidden.
    expect(explainer.props.children).toContain('demo');

    await act(async () => {
      fireEvent.press(getByLabelText(t('common.continue')));
    });
    const { replace } = require('expo-router').__loginRouterForTests();
    expect(replace).toHaveBeenCalledWith('/onboarding');
  });
});
