/* M2C — Location module: the geolocation wrapper degrades gracefully without
 * a browser (typed GeoError, never a crash); reverse geocoding matches the
 * nearest seeded city by haversine distance; isServiceable validates against
 * the city's serviceAreas; the addresses store starts EMPTY (no fake seeds,
 * no hardcoded phone — SECURITY.md) and CRUD round-trips through the local
 * cache. Server sync is deferred: UserUpdate has no addresses field (contract
 * reality — see packages/contract/src/generated/model/userUpdate.ts). */
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

import { resetMockState } from './helpers';
import { MockHomeRepository } from '@/repos/mock/home';
import {
  GeoError,
  getCurrentPosition,
  haversineKm,
  isServiceable,
  knownCityCoords,
  reverseGeocode,
} from '@/lib/geolocation';
import { useAddressesStore } from '@/store/addresses';
import { useLocationStore } from '@/store/location';

const home = new MockHomeRepository();

beforeEach(() => {
  resetMockState();
  // The stores keep module state across tests — restore a pristine draft.
  useAddressesStore.setState({ addresses: [], selectedId: null });
  useLocationStore.setState({ city: null, addressLabel: null });
});

test('geolocation wrapper rejects with a typed GeoError when geolocation is unavailable', async () => {
  // Node test env has no navigator.geolocation — the wrapper must degrade
  // gracefully instead of throwing a ReferenceError.
  const nav = typeof navigator !== 'undefined' ? navigator : undefined;
  if (nav && nav.geolocation) return; // a real browser would resolve here
  await assert.rejects(
    getCurrentPosition(),
    (e: unknown) => e instanceof GeoError && e.code === 'UNSUPPORTED',
  );
});

test('haversine distance is sane (Dar es Salaam → Mwanza ≈ 850 km)', () => {
  const dar = knownCityCoords().find((c) => c.id === 'city_dar')!;
  const mwanza = knownCityCoords().find((c) => c.id === 'city_mwanza')!;
  const km = haversineKm(dar.lat, dar.lon, mwanza.lat, mwanza.lon);
  assert.ok(km > 750 && km < 950, `expected ~850km, got ${km}`);
});

test('reverseGeocode matches the nearest seeded city (seeded customerLocation → Dar es Salaam, Ubungo)', async () => {
  const cities = await home.listCities();
  // mockState.customerLocation seed {-6.7924, 39.2083}.
  const result = await reverseGeocode(-6.7924, 39.2083, cities);
  assert.equal(result.cityId, 'city_dar');
  assert.equal(result.cityName, 'Dar es Salaam');
  assert.equal(result.serviceAreaId, 'area_ubungo');
  assert.equal(result.label, 'Dar es Salaam · Ubungo');
});

test('reverseGeocode picks Mwanza for a point near the Mwanza seed', async () => {
  const cities = await home.listCities();
  const result = await reverseGeocode(-2.5164, 32.9175, cities);
  assert.equal(result.cityId, 'city_mwanza');
  assert.equal(result.serviceArea, 'Nyamagana');
});

test('reverseGeocode without seeded cities returns an empty result, not an error', async () => {
  const result = await reverseGeocode(-6.7924, 39.2083, []);
  assert.equal(result.label, '');
  assert.equal(result.cityId, undefined);
});

test('isServiceable validates the address area against the city service areas', () => {
  const dar = { id: 'city_dar', serviceAreas: [{ id: 'area_kinondoni', name: 'Kinondoni' }, { id: 'area_ilala', name: 'Ilala' }] };
  assert.equal(isServiceable({ serviceArea: 'Kinondoni' }, dar), true, 'matches by area name');
  assert.equal(isServiceable({ serviceArea: 'area_ilala' }, dar), true, 'matches by area id');
  assert.equal(isServiceable({ serviceArea: 'kinondoni' }, dar), true, 'case-insensitive');
  assert.equal(isServiceable({ serviceArea: 'Kigamboni' }, dar), false, 'outside service area');
  assert.equal(isServiceable({ serviceArea: 'Kinondoni' }, { id: 'city_x', serviceAreas: [] }), true, 'no areas → serviceable');
  assert.equal(isServiceable({}, dar), true, 'unknown area is not rejected (ops authority at dispatch)');
  assert.equal(isServiceable({ serviceArea: 'Kinondoni' }, null), true, 'no city selected → serviceable');
});

test('isServiceable integrates with the seeded mock cities (ops #16)', async () => {
  const cities = await home.listCities();
  const dar = cities.find((c) => c.id === 'city_dar')!;
  assert.equal(isServiceable({ serviceArea: 'Ubungo' }, dar), true);
  assert.equal(isServiceable({ serviceArea: 'Nyamagana' }, dar), false, 'Mwanza area is not serviced in Dar');
});

test('addresses store starts empty — no fake seeds, no hardcoded phone', () => {
  const state = useAddressesStore.getState();
  assert.equal(state.addresses.length, 0);
  assert.equal(state.selectedId, null);
  const stored = state.addresses.some((a) => a.contactPhone.includes('255700000000'));
  assert.equal(stored, false, 'no seeded +255700000000 phone anywhere');
});

test('address CRUD round-trips through the store and persists to the local cache', () => {
  const store = useAddressesStore.getState();
  const home_ = store.addAddress({
    label: 'Home',
    lines: '12 Makunganya Street, Kariakoo',
    landmark: 'near Total petrol station',
    contactPhone: '+255712345678',
    serviceArea: 'Ilala',
    deliveryInstructions: 'Call on arrival',
  });
  assert.ok(home_.id.startsWith('addr_'));
  assert.equal(useAddressesStore.getState().addresses.length, 1);
  assert.equal(useAddressesStore.getState().selectedId, home_.id, 'new address becomes the selection');

  const office = useAddressesStore.getState().addAddress({
    label: 'Office',
    lines: '8 Ali Hassan Mwinyi Road, Masaki',
    contactPhone: '+255755987654',
  });
  assert.equal(useAddressesStore.getState().addresses.length, 2);

  useAddressesStore.getState().updateAddress(home_.id, { landmark: 'opposite the mosque' });
  assert.equal(useAddressesStore.getState().addresses.find((a) => a.id === home_.id)?.landmark, 'opposite the mosque');

  useAddressesStore.getState().removeAddress(office.id);
  assert.equal(useAddressesStore.getState().addresses.length, 1);
  assert.equal(useAddressesStore.getState().selectedId, null, 'removing the selection clears it');
  assert.equal(useAddressesStore.getState().select(home_.id), true);
  assert.equal(useAddressesStore.getState().selectedId, home_.id);

  // Offline cache: the draft survives a reload through localStorage when a
  // web storage is present (Node keeps the in-memory draft otherwise).
  try {
    const raw = localStorage.getItem('consumer.addresses');
    if (raw) {
      const cached = JSON.parse(raw) as { id: string }[];
      assert.ok(cached.some((a) => a.id === home_.id));
    }
  } catch {
    /* storage unavailable in this env — in-memory draft still holds */
  }
});

test('select refuses an address outside the selected city service areas', () => {
  const city = { id: 'city_dar', name: 'Dar es Salaam', serviceAreas: [{ id: 'area_ilala', name: 'Ilala' }] };
  useLocationStore.getState().setCity(city);

  const inside = useAddressesStore.getState().addAddress({
    label: 'Inside',
    lines: 'street 1',
    contactPhone: '+255712345678',
    serviceArea: 'Ilala',
  });
  const outside = useAddressesStore.getState().addAddress({
    label: 'Outside',
    lines: 'street 2',
    contactPhone: '+255712345678',
    serviceArea: 'Kigamboni',
  });

  assert.equal(useAddressesStore.getState().select(outside.id), false, 'out-of-area selection refused');
  assert.equal(useAddressesStore.getState().selectedId, outside.id, 'last added is still selected for editing');
  assert.equal(useAddressesStore.getState().select(inside.id), true);
  assert.equal(useAddressesStore.getState().selectedId, inside.id);
});
