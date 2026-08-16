/* Headless render smoke for the Entertainment vertical — /events (list with
 * category chips + from-price), /events/{eventId} (detail + tier cards) and
 * /events/tickets (code + status pill). Mirrors TravelSmoke: repos mocked at
 * the factory boundary, screens required lazily. */
import React from 'react';
import { render } from '@testing-library/react-native';
import { t } from '@/i18n';

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn() }),
  useLocalSearchParams: () => ({ eventId: 'evt_concert_001' }),
}));
jest.mock('@expo/vector-icons', () => {
  const React = require('react');
  const { Text } = require('react-native');
  const FakeIcon = ({ name }: { name: string }) => React.createElement(Text, null, `icon:${name}`);
  return { Ionicons: FakeIcon };
});
jest.mock('@/repos', () => {
  const listing = {
    id: 'evt_concert_001',
    title: 'Sauti za Bongo Night',
    cityId: 'city_dar',
    cityName: 'Dar es Salaam',
    category: 'music',
    venue: 'Uhuru Stadium, Dar es Salaam',
    startsAt: '2026-09-01T19:30:00.000Z',
    imageUrl: null,
    startingPriceTZS: 30000,
  };
  const tickets = [
    {
      id: 'tkt_1',
      eventId: 'evt_concert_001',
      eventTitle: 'Sauti za Bongo Night',
      venue: 'Uhuru Stadium, Dar es Salaam',
      startsAt: '2026-09-01T19:30:00.000Z',
      tierName: 'VIP',
      priceTZS: 80000,
      code: 'EV-9K2M',
      status: 'active',
    },
    {
      id: 'tkt_2',
      eventId: 'evt_concert_001',
      eventTitle: 'Sauti za Bongo Night',
      venue: 'Uhuru Stadium, Dar es Salaam',
      startsAt: '2026-08-20T19:30:00.000Z',
      tierName: 'Regular',
      priceTZS: 30000,
      code: 'EV-3Q7X',
      status: 'used',
    },
  ];
  return {
    getEventsRepository: () => ({
      list: async () => ({ results: [listing], nextCursor: null }),
      get: async () => ({
        event: listing,
        description: 'A night of live bongo flava under the stars.',
        tiers: [
          { id: 'tier_regular', name: 'Regular', priceTZS: 30000, available: true, remaining: 240 },
          { id: 'tier_vip', name: 'VIP', priceTZS: 80000, available: true, remaining: 60 },
          { id: 'tier_vvip', name: 'VVIP', priceTZS: 150000, available: false, remaining: 0 },
        ],
      }),
      purchase: jest.fn(),
      listMyTickets: async () => tickets,
    }),
  };
});

describe('events headless', () => {
  it('events list renders title, category chips and the from-price', async () => {
    const Screen = require('@/app/events').default;
    const { getByText, getAllByText, findByText } = await render(React.createElement(Screen));
    expect(getByText(t('events.title'))).toBeTruthy();
    expect(getByText(t('events.all'))).toBeTruthy();
    expect(getAllByText(t('events.category.music')).length).toBeGreaterThanOrEqual(1);
    expect(await findByText('Sauti za Bongo Night', {}, { timeout: 8000 })).toBeTruthy();
    expect(getByText(t('events.from'))).toBeTruthy();
    expect(getByText('TZS 30,000')).toBeTruthy();
  }, 30000);

  it('event detail renders tiers with prices and remaining; sold-out tier is disabled', async () => {
    const Screen = require('@/app/events/[eventId]').default;
    const { getByText, findByText, getAllByText } = await render(React.createElement(Screen));
    expect(await findByText('Sauti za Bongo Night', {}, { timeout: 8000 })).toBeTruthy();
    expect(getByText('Uhuru Stadium, Dar es Salaam')).toBeTruthy();
    expect(getByText('VIP')).toBeTruthy();
    expect(getByText('TZS 80,000')).toBeTruthy();
    expect(getByText(t('events.remaining', { n: 240 }))).toBeTruthy();
    expect(getAllByText(t('events.select')).length).toBe(2);
    // "Sold out" renders twice — the remaining label AND the disabled CTA.
    expect(getAllByText(t('events.soldOut')).length).toBe(2);
  }, 30000);

  it('my tickets renders codes prominently with status pills', async () => {
    const Screen = require('@/app/events/tickets').default;
    const { getByText, findByText } = await render(React.createElement(Screen));
    expect(getByText(t('events.myTickets'))).toBeTruthy();
    expect(await findByText('EV-9K2M', {}, { timeout: 8000 })).toBeTruthy();
    expect(getByText(t('status.active'))).toBeTruthy();
    expect(getByText(t('status.used'))).toBeTruthy();
  }, 30000);
});
