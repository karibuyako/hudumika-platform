/* M1B — Onboarding flow (MASTER-BLUEPRINT §3): profile setup round-trips the
 * entered name + locale through AuthRepository.updateProfile (mock), the
 * carousel skip flag is stored/read through localStorage, the device-local
 * payment default preference persists, the payment step's method list comes
 * from GET /payments/methods, and a persisted city restores authed after
 * onboarding. */
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

import { auth, loginAsDemo, MOCK_PHONE, resetMockAuthState, resetMockState } from './helpers';
import { isOnboardingDone, useOnboardingStore } from '@/store/onboarding';
import { useSessionStore } from '@/store/session';
import { useLocationStore } from '@/store/location';
import { MockPaymentsRepository } from '@/repos/mock/payments';

/* localStorage shim — the onboarding store persists through it (node has no
 * storage; same shim pattern as m1-auth.test.ts). */
const store = new Map<string, string>();
(globalThis as Record<string, unknown>).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, String(v)),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
};
try {
  Object.defineProperty(globalThis, 'sessionStorage', {
    value: (globalThis as Record<string, unknown>).localStorage,
    configurable: true,
  });
} catch {
  /* some runtimes freeze sessionStorage — setToken falls back to localStorage */
}

beforeEach(() => {
  store.clear();
  resetMockState();
  resetMockAuthState();
  useOnboardingStore.setState({ onboardingDone: false, defaultMethodId: null });
});

test('profile setup: updateProfile round-trips the entered name + locale (repo level)', async () => {
  await loginAsDemo();
  const updated = await auth.updateProfile({ fullName: 'Amina Hassan', locale: 'sw' });
  assert.equal(updated.fullName, 'Amina Hassan');
  assert.equal(updated.locale, 'sw');

  // The same repository serves the persisted profile back via me() — what the
  // app's next cold start would see.
  const me = await auth.me();
  assert.equal(me.fullName, 'Amina Hassan');
  assert.equal(me.locale, 'sw');
});

test('updateProfile never touches fields it was not given (contract UserUpdate shape)', async () => {
  const seeded = await auth.me();
  const updated = await auth.updateProfile({ fullName: 'Neema Msemo' });
  assert.equal(updated.fullName, 'Neema Msemo');
  assert.equal(updated.locale, seeded.locale, 'locale untouched by a name-only patch');
});

test('carousel skip flag is stored and read back (storage level)', () => {
  // Fresh install: no flag, the carousel shows.
  assert.equal(isOnboardingDone(), false);

  useOnboardingStore.getState().markOnboardingDone();
  assert.equal(useOnboardingStore.getState().onboardingDone, true);
  assert.equal(localStorage.getItem('consumer.onboardingDone'), '1', 'flag persisted');

  // A returning user reads the flag straight from storage — the same read the
  // screen uses on cold start to jump to the city picker.
  assert.equal(isOnboardingDone(), true);
});

test('carousel skip flag is idempotent and survives a store-state reset', () => {
  useOnboardingStore.getState().markOnboardingDone();
  useOnboardingStore.getState().markOnboardingDone();
  assert.equal(localStorage.getItem('consumer.onboardingDone'), '1');

  // Simulate a new app launch: the in-memory state is recreated, but the
  // storage flag still gates the carousel.
  useOnboardingStore.setState({ onboardingDone: false, defaultMethodId: null });
  assert.equal(useOnboardingStore.getState().onboardingDone, false);
  assert.equal(isOnboardingDone(), true, 'storage still gates the carousel');
});

test('payment default preference is device-local and clears with null', () => {
  useOnboardingStore.getState().setDefaultMethod('pm_1');
  assert.equal(localStorage.getItem('consumer.paymentMethod'), 'pm_1');
  useOnboardingStore.getState().setDefaultMethod(null);
  assert.equal(localStorage.getItem('consumer.paymentMethod'), null);
});

test('payment step lists the seeded methods with availability flags', async () => {
  const methods = await new MockPaymentsRepository().getPaymentMethods();
  assert.ok(methods.length >= 4, 'demo methods are seeded');
  const mpesa = methods.find((m) => m.method === 'mpesa');
  assert.ok(mpesa && mpesa.available !== false, 'M-Pesa is available in the seeded list');
  const cod = methods.find((m) => m.method === 'cod');
  assert.ok(cod && cod.available !== false, 'cash on delivery is available');
});

test('onboarding completes when a city is persisted: restore lands authed', async () => {
  const req = await useSessionStore.getState().requestOtp(MOCK_PHONE);
  await useSessionStore.getState().verifyOtp(req.requestId, req.debugCode ?? '');
  assert.equal(useSessionStore.getState().status, 'onboarding');

  // City step: persist the chosen city (session.restoredStatusFor gates on it).
  useLocationStore.getState().setCity({ id: 'city_dar', name: 'Dar es Salaam', serviceAreas: [{ id: 'area_ilala', name: 'Ilala' }] });
  useSessionStore.getState().completeOnboarding(useSessionStore.getState().user!);
  assert.equal(useSessionStore.getState().status, 'authed');

  // A cold start after onboarding restores authed, not onboarding.
  useSessionStore.setState({ status: 'boot', token: null, user: null });
  await useSessionStore.getState().restore();
  assert.equal(useSessionStore.getState().status, 'authed');
});
