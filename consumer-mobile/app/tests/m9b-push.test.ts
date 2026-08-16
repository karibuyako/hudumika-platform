/* M9B — Push wrapper (native-guarded): every export no-ops safely under node
 * (no native modules, no crash); the schedule decision helper honors the
 * unused-only 48 h window; push-token persistence round-trips through the
 * SecureStore/localStorage split; push-payload deep links validate against
 * the allow-list. */
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

import { resetMockState, resetMockAuthState, rejectsApiError } from './helpers';
import {
  cancelExistingReminder,
  getExpoPushToken,
  getStoredPushToken,
  pushResponseDeepLink,
  registerPushForUser,
  registerTokenForUser,
  registerTokenOnServer,
  scheduleVoucherExpiryReminder,
  shouldScheduleReminder,
  unregisterTokenForUser,
  unregisterTokenOnServer,
  voucherReminderId,
  VOUCHER_REMINDER_MS,
} from '@/lib/push';
import { MockAuthRepository, registeredPushTokensForTests } from '@/repos/mock/auth';
import { getStoredPushTokenAsync, setStoredPushTokenAsync } from '@/lib/secureStorage';
import type { Voucher } from '@hudumika/contract';

/* localStorage shim (node has none — secureStorage falls back to it, same
 * shim pattern as m1-auth.test.ts). */
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
});

const voucher = (over: Partial<Voucher>): Voucher => ({
  code: 'GB-ABCD-1234',
  groupBuyId: 'gb_001',
  title: 'Deal',
  priceTZS: 12000,
  status: 'unused',
  purchasedAt: new Date(Date.now() - 86400_000).toISOString(),
  ...over,
});

/* ---------------- Task 1 — native-guarded no-ops under node ---------------- */

test('getExpoPushToken is a null no-op under node (no native modules, no throw)', async () => {
  const result = await getExpoPushToken();
  assert.equal(result.token, null);
  assert.equal(result.error, null);
});

test('registerTokenForUser is a no-op under node: false, nothing persisted, no throw', async () => {
  const ok = await registerTokenForUser('ExponentPushToken[test-token-123]');
  assert.equal(ok, false);
  assert.equal(await getStoredPushTokenAsync(), null);
});

test('unregisterTokenForUser never throws under node', async () => {
  const ok = await unregisterTokenForUser();
  assert.equal(ok, true);
});

test('registerPushForUser pipeline resolves as a null no-op under node', async () => {
  const result = await registerPushForUser();
  assert.equal(result.token, null);
  assert.equal(result.error, null);
});

test('scheduleVoucherExpiryReminder is a no-op under node with a fake voucher', async () => {
  const near = voucher({ expiresAt: new Date(Date.now() + 40 * 3600_000).toISOString() });
  const scheduled = await scheduleVoucherExpiryReminder(near);
  assert.equal(scheduled, false);
});

test('cancelExistingReminder is a no-op under node', async () => {
  const cancelled = await cancelExistingReminder('GB-ABCD-1234');
  assert.equal(cancelled, false);
});

/* ---------------- Task 2 — schedule decision thresholds ---------------- */

test('shouldScheduleReminder schedules only unused vouchers expiring inside the 48 h window', () => {
  const now = Date.now();
  assert.equal(shouldScheduleReminder(voucher({ expiresAt: new Date(now + 40 * 3600_000).toISOString() }), now), true, 'inside the window');
  assert.equal(shouldScheduleReminder(voucher({ expiresAt: new Date(now + 47 * 3600_000).toISOString() }), now), true);
  assert.equal(shouldScheduleReminder(voucher({ expiresAt: new Date(now + VOUCHER_REMINDER_MS).toISOString() }), now), true, 'exactly at the window edge');
  assert.equal(shouldScheduleReminder(voucher({ expiresAt: new Date(now + VOUCHER_REMINDER_MS + 60_000).toISOString() }), now), false, 'just outside the window');
  assert.equal(shouldScheduleReminder(voucher({ expiresAt: new Date(now + 30 * 86400_000).toISOString() }), now), false, 'far from expiry');
});

test('shouldScheduleReminder never schedules non-unused, expired, or malformed vouchers', () => {
  const now = Date.now();
  const near = new Date(now + 40 * 3600_000).toISOString();
  assert.equal(shouldScheduleReminder(voucher({ status: 'redeemed', expiresAt: near }), now), false);
  assert.equal(shouldScheduleReminder(voucher({ status: 'expired', expiresAt: near }), now), false);
  assert.equal(shouldScheduleReminder(voucher({ status: 'void', expiresAt: near }), now), false);
  assert.equal(shouldScheduleReminder(voucher({ expiresAt: new Date(now - 1000).toISOString() }), now), false, 'already expired');
  assert.equal(shouldScheduleReminder(voucher({ expiresAt: undefined }), now), false);
  assert.equal(shouldScheduleReminder(voucher({ expiresAt: 'not-a-date' }), now), false);
});

test('voucherReminderId follows the voucher-expiry-{code} scheme', () => {
  assert.equal(voucherReminderId('GB-ABCD-1234'), 'voucher-expiry-GB-ABCD-1234');
});

/* ---------------- Task 3 — push payload deep-link allow-list ---------------- */

const responseWith = (deepLink: unknown) => ({
  notification: { request: { content: { data: { deepLink } } } },
});

test('pushResponseDeepLink validates payload deepLinks against the allow-list', () => {
  assert.equal(pushResponseDeepLink(responseWith('order/ord_1')), 'order/ord_1');
  assert.equal(pushResponseDeepLink(responseWith('https://app.hudumika.tz/booking/bok_1')), 'booking/bok_1');
  assert.equal(pushResponseDeepLink(responseWith('ticket/tic_1')), 'ticket/tic_1');
  assert.equal(pushResponseDeepLink(responseWith('conversation/con_1')), 'conversation/con_1');
});

test('pushResponseDeepLink rejects unknown routes, malformed payloads, and missing data', () => {
  assert.equal(pushResponseDeepLink(responseWith('evil/route')), null, 'route not on the allow-list');
  assert.equal(pushResponseDeepLink(responseWith('order/')), null, 'missing id');
  assert.equal(pushResponseDeepLink(responseWith('order/ord_1/extra')), null, 'too many segments');
  assert.equal(pushResponseDeepLink(responseWith(undefined)), null, 'no deepLink payload');
  assert.equal(pushResponseDeepLink(responseWith(123)), null, 'non-string deepLink');
  assert.equal(pushResponseDeepLink(null), null, 'null response');
  assert.equal(pushResponseDeepLink('garbage'), null, 'not a response object');
});

/* ---------------- Task 4 — push token persistence round-trip ---------------- */

test('push token persistence round-trips through the secure storage split', async () => {
  assert.equal(await getStoredPushTokenAsync(), null);
  await setStoredPushTokenAsync('ExponentPushToken[abc123]');
  assert.equal(await getStoredPushTokenAsync(), 'ExponentPushToken[abc123]');
  assert.equal(await getStoredPushToken(), 'ExponentPushToken[abc123]', 'public helper reads the same slot');
  await setStoredPushTokenAsync(null);
  assert.equal(await getStoredPushTokenAsync(), null);
});

/* ---------------- Task 5 — server push-token registration (CONTRACT-ADDITIONS.md #2) ---------------- */

const auth = new MockAuthRepository();
const VALID_TOKEN = 'ExponentPushToken[test-abc-123]';

test('registerTokenOnServer round-trips through the mock registry', async () => {
  await registerTokenOnServer(VALID_TOKEN);
  assert.deepEqual(registeredPushTokensForTests(), [VALID_TOKEN]);
  await unregisterTokenOnServer(VALID_TOKEN);
  assert.deepEqual(registeredPushTokensForTests(), []);
});

test('duplicate push-token register is idempotent (same token twice = success)', async () => {
  await registerTokenOnServer(VALID_TOKEN);
  await registerTokenOnServer(VALID_TOKEN);
  assert.deepEqual(registeredPushTokensForTests(), [VALID_TOKEN]);
});

test('the mock rejects malformed tokens with the contract PUSH_TOKEN_INVALID code', async () => {
  await rejectsApiError(auth.registerPushToken('garbage', 'k1'), 422, 'PUSH_TOKEN_INVALID');
  await rejectsApiError(auth.registerPushToken('', 'k2'), 422, 'PUSH_TOKEN_INVALID');
  assert.deepEqual(registeredPushTokensForTests(), []);
});

test('registerTokenOnServer degrades gracefully when the repo call fails (stubbed failure)', async () => {
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (msg?: unknown) => {
    warnings.push(String(msg));
  };
  try {
    // The mock repo throws PUSH_TOKEN_INVALID for a malformed token — the
    // wrapper must swallow it and only warn (the session flow never breaks).
    await registerTokenOnServer('bad-token');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /\[push\] server push-token registration failed/);
    assert.deepEqual(registeredPushTokensForTests(), []);
  } finally {
    console.warn = originalWarn;
  }
});

test('unregisterTokenOnServer never throws for an unknown token', async () => {
  await unregisterTokenOnServer('ExponentPushToken[never-registered]');
  assert.deepEqual(registeredPushTokensForTests(), []);
});

test('unregisterTokenForUser still clears the device-local token under node', async () => {
  await setStoredPushTokenAsync(VALID_TOKEN);
  assert.equal(await unregisterTokenForUser(), true);
  assert.equal(await getStoredPushTokenAsync(), null);
});
