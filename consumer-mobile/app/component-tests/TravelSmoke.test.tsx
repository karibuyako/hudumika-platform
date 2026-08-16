import React from 'react';
import { render } from '@testing-library/react-native';
import { t } from '@/i18n';

jest.mock('expo-router', () => ({ useRouter: () => ({ push: jest.fn(), replace: jest.fn() }) }));
jest.mock('@expo/vector-icons', () => {
  const React = require('react');
  const { Text } = require('react-native');
  const FakeIcon = ({ name }: { name: string }) => React.createElement(Text, null, `icon:${name}`);
  return { Ionicons: FakeIcon };
});
jest.mock('@/repos', () => {
  const cities = [
    { id: 'city_dar', name: 'Dar es Salaam', country: 'TZ', serviceAreas: [{ id: 'area_kinondoni', name: 'Kinondoni' }] },
    { id: 'city_mwanza', name: 'Mwanza', country: 'TZ', serviceAreas: [{ id: 'area_nyamagana', name: 'Nyamagana' }] },
  ];
  const options = [{
    id: 'topt_dar_mwanza_bus', mode: 'bus', provider: 'Kampala Coach',
    originCityId: 'city_dar', originCityName: 'Dar es Salaam',
    destinationCityId: 'city_mwanza', destinationCityName: 'Mwanza',
    departureAt: '2026-08-18T03:00:00.000Z', arrivalAt: '2026-08-18T16:30:00.000Z',
    priceTZS: 45000, seatsAvailable: 32,
  }];
  const booking = {
    id: 'tb_0001', travelOptionId: 'topt_dar_mwanza_bus', mode: 'bus',
    originCityName: 'Dar es Salaam', destinationCityName: 'Mwanza',
    departureAt: '2026-08-18T03:00:00.000Z', passengers: 2,
    contactPhone: '+255712345678', totalTZS: 90000,
    status: 'pending_payment', createdAt: '2026-08-15T10:00:00.000Z',
  };
  return {
    getHomeRepository: () => ({ listCities: async () => cities }),
    getTravelRepository: () => ({
      search: async () => options,
      book: async () => booking,
      listMyBookings: async () => [booking],
    }),
  };
});

describe('travel smoke', () => {
  it('travel search screen renders with cities', async () => {
    const Screen = require('@/app/travel').default;
    const { getByText, findByText } = await render(React.createElement(Screen));
    expect(getByText(t('travel.title'))).toBeTruthy();
    expect(await findByText('Dar es Salaam', {}, { timeout: 8000 })).toBeTruthy();
    expect(getByText(t('travel.date'))).toBeTruthy();
    expect(getByText(t('travel.mode'))).toBeTruthy();
    expect(getByText(t('travel.today'))).toBeTruthy();
  }, 30000);

  it('travel-bookings screen renders the list', async () => {
    const Screen = require('@/app/travel-bookings').default;
    const { getByText, findByText } = await render(React.createElement(Screen));
    expect(getByText(t('travel.myBookings'))).toBeTruthy();
    expect(await findByText('Dar es Salaam → Mwanza', {}, { timeout: 8000 })).toBeTruthy();
  }, 30000);
});
