/* Headless render smoke for LIVE STREAMING-LITE — /live/{sessionId} (the
 * live-deals broadcast screen): hero video placeholder (static LIVE dot +
 * honest video-soon note), the deal rail (shared DealCard) and the mock-first
 * live chat (seeded viewer messages + composer). Mirrors EventsSmoke: repos
 * mocked at the factory boundary, screens required lazily. The session id
 * mirrors the seeded live session in src/repos/mock/marketing.ts
 * (lds_live_001), so every string resolves — no unmatched i18n keys. */
import React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react-native';
import { t } from '@/i18n';
import { useUiStore } from '@/store/ui';

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn() }),
  useLocalSearchParams: () => ({ sessionId: 'lds_live_001' }),
}));
jest.mock('@expo/vector-icons', () => {
  const React = require('react');
  const { Text } = require('react-native');
  const FakeIcon = ({ name }: { name: string }) => React.createElement(Text, null, `icon:${name}`);
  return { Ionicons: FakeIcon };
});
jest.mock('@/repos', () => {
  const session = {
    id: 'lds_live_001',
    title: 'Midday Flash Feast',
    startsAt: '2026-08-15T10:00:00.000Z',
    endsAt: '2026-08-15T15:00:00.000Z',
    status: 'live',
    deals: [
      { merchantId: 'm_1', merchantName: 'Kisutu Kitchen', title: 'Chicken & Chips two-for-one', priceTZS: 12000, originalPriceTZS: 24000, quantityLimit: 2 },
    ],
  };
  const seededChat = [
    { id: 'chat_lds_live_001_1', authorName: 'Asha', body: 'That chicken and chips two-for-one is unbeatable', at: '2026-08-15T09:30:00.000Z' },
    { id: 'chat_lds_live_001_2', authorName: 'Juma', body: 'Anyone tried the nyama choma platter yet?', at: '2026-08-15T09:41:00.000Z' },
  ];
  return {
    getMarketingRepository: () => ({
      listLiveDeals: async () => ({ sessions: [session], nextCursor: null }),
      fetchLiveChat: async () => seededChat,
      postLiveChat: jest.fn(async (_sessionId: string, message: string) => ({
        id: 'chat_echo_1',
        authorName: 'Demo Customer',
        body: message,
        at: '2026-08-15T10:00:00.000Z',
      })),
    }),
  };
});

describe('live streaming lite headless', () => {
  it('broadcast screen renders the hero, honest video note, deal card and seeded chat', async () => {
    const Screen = require('@/app/live/[sessionId]').default;
    const { getByText, getByPlaceholderText, findByText } = await render(React.createElement(Screen));
    expect(await findByText('Midday Flash Feast', {}, { timeout: 8000 })).toBeTruthy();
    expect(getByText(t('liveDeals.live'))).toBeTruthy();
    expect(getByText(t('liveDeals.videoSoon'))).toBeTruthy();
    expect(getByText('Chicken & Chips two-for-one')).toBeTruthy();
    expect(getByText('TZS 12,000')).toBeTruthy();
    expect(getByText(t('liveDeals.liveChat'))).toBeTruthy();
    expect(getByText('Asha')).toBeTruthy();
    expect(getByText('That chicken and chips two-for-one is unbeatable')).toBeTruthy();
    expect(getByPlaceholderText(t('liveDeals.chatPlaceholder'))).toBeTruthy();
  }, 30000);

  it('composer sends optimistically and the echo replaces the temp message', async () => {
    const Screen = require('@/app/live/[sessionId]').default;
    const { getByLabelText, getByPlaceholderText, getByText } = await render(React.createElement(Screen));
    const input = getByPlaceholderText(t('liveDeals.chatPlaceholder'));
    await fireEvent.changeText(input, 'Who is buying the pilau bucket?');
    await fireEvent.press(getByLabelText(t('messages.send')));
    await waitFor(() => expect(getByText('Who is buying the pilau bucket?')).toBeTruthy(), { timeout: 8000 });
    expect(getByText('Demo Customer')).toBeTruthy();
    expect(useUiStore.getState().toast?.message).toBe(t('liveDeals.chatSent'));
  }, 30000);
});
