import React from 'react';
import { render, screen } from '@testing-library/react-native';
import { t } from '@/i18n';

jest.mock('expo-router', () => ({ useRouter: () => ({ back: jest.fn(), push: jest.fn(), replace: jest.fn() }) }));
jest.mock('@/repos', () => {
  const sessions = [
    {
      id: 'sess_current',
      deviceInfo: 'Pixel 8 · Android 15',
      lastActiveAt: new Date().toISOString(),
      current: true,
    },
  ];
  return {
    getAuthRepository: () => ({
      listSessions: async () => sessions,
      getTwoFactorStatus: async () => ({ enabled: true, method: 'otp' }),
      revokeSession: async () => {},
    }),
  };
});

describe('security smoke', () => {
  it('security screen renders the sessions list and the 2FA section with the enabled pill', async () => {
    const Screen = require('@/app/security').default;
    await render(React.createElement(Screen));
    expect(screen.getByText(t('security.title'))).toBeTruthy();
    await screen.findByText(t('security.twoFactor'), {}, { timeout: 8000 });
    expect(screen.getByText(t('security.twoFactorEnabled'))).toBeTruthy();
    expect(screen.getByText(t('security.disable2fa'))).toBeTruthy();
    expect(screen.getByText(t('security.changePassword'))).toBeTruthy();
    expect(screen.getByText('Pixel 8 · Android 15')).toBeTruthy();
    expect(screen.getByText(t('security.current'))).toBeTruthy();
  }, 30000);
});
