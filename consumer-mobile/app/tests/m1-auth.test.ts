/* M1 — Auth + onboarding: OTP states (wrong code, max attempts, 429 resend,
 * OTP_EXPIRED, purpose/channel support), real resend semantics (new
 * requestId), session store transitions, persisted token pair, session
 * registry (list/revoke). (Endpoint parity: consumer-contract.test.ts) */
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

import { rejectsApiError, resetMockState, resetMockAuthState, MOCK_PHONE, auth } from './helpers';
import { MOCK_SOCIAL_CODE } from '@/repos/mock/auth';
import { twoFactorStateForTests } from '@/repos/mock/auth';
import { useSessionStore } from '@/store/session';
import { MockHomeRepository } from '@/repos/mock/home';
import { getStoredSession } from '@/lib/secureStorage';

const home = new MockHomeRepository();

/* localStorage shim — the session store persists through it (node has no
 * storage; secureStorage falls back to localStorage like the web demo). */
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
  useSessionStore.setState({ status: 'boot', token: null, user: null });
});

test('requestOtp is rate-limited to one per 60 s (429 RATE_LIMITED with retryAfterSeconds)', async () => {
  const first = await auth.requestOtp(MOCK_PHONE, 'login');
  assert.ok(first.requestId.length > 0);
  const err = await rejectsApiError(auth.requestOtp(MOCK_PHONE, 'login'), 429, 'RATE_LIMITED');
  assert.ok(err.details?.retryAfterSeconds !== undefined);
});

test('a second destination is not blocked by the first one’s cooldown', async () => {
  await auth.requestOtp('+255711111111', 'login');
  const other = await auth.requestOtp('+255722222222', 'login');
  assert.ok(other.requestId.length > 0);
});

test('resend within the cooldown throws 429 RATE_LIMITED with retryAfterSeconds', async () => {
  const first = await auth.requestOtp(MOCK_PHONE, 'login');
  assert.ok((first.resendInSeconds ?? 0) > 0, 'OtpRequestResult carries the server resendInSeconds');
  const err = await rejectsApiError(auth.requestOtp(MOCK_PHONE, 'login'), 429, 'RATE_LIMITED');
  assert.ok(err.details?.retryAfterSeconds !== undefined);
});

test('after the resend window a new requestId is issued and the old one is invalid', async () => {
  const first = await auth.requestOtp(MOCK_PHONE, 'login');
  const state = (await import('@/repos/mock/mockState')).getState();
  // Expire the cooldown window (mock server state, like the live 429 → wait).
  state.lastOtpRequestAt.set(MOCK_PHONE, Date.now() - 61_000);
  const second = await auth.requestOtp(MOCK_PHONE, 'login');
  assert.notEqual(second.requestId, first.requestId, 'resend issues a fresh requestId');
  assert.notEqual(second.debugCode, first.debugCode);
  await rejectsApiError(auth.verifyOtp(first.requestId, first.debugCode ?? '', 'login'), 401, 'OTP_INVALID');
  const session = await auth.verifyOtp(second.requestId, second.debugCode ?? '', 'login');
  assert.ok(session.accessToken.length > 0);
});

test('session store: verify → onboarding (city picker) → complete → authed → logout → anon', async () => {
  const req = await useSessionStore.getState().requestOtp(MOCK_PHONE);
  await useSessionStore.getState().verifyOtp(req.requestId, req.debugCode ?? '');
  assert.equal(useSessionStore.getState().status, 'onboarding');

  const user = useSessionStore.getState().user;
  assert.ok(user, 'user should be set');
  useSessionStore.getState().completeOnboarding(user!);
  assert.equal(useSessionStore.getState().status, 'authed');

  await useSessionStore.getState().logout();
  assert.equal(useSessionStore.getState().status, 'anon');
  assert.equal(useSessionStore.getState().token, null);
});

test('session restore without a persisted city lands on onboarding', async () => {
  try {
    localStorage.removeItem('consumer.city');
  } catch {
    /* storage unavailable */
  }
  const req = await auth.requestOtp(MOCK_PHONE, 'login');
  await auth.verifyOtp(req.requestId, req.debugCode ?? '', 'login');
  await useSessionStore.getState().restore();
  assert.equal(useSessionStore.getState().status, 'onboarding');
});

test('cities seed is deterministic and empty-state safe', async () => {
  const cities = await home.listCities();
  assert.ok(cities.length >= 3);
  const first = cities[0];
  assert.ok(first.name.length > 0);
  assert.ok((first.serviceAreas ?? []).length >= 1);
});

test('OTP_INVALID / OTP_MAX_ATTEMPTS map to distinct codes', async () => {
  const req = await auth.requestOtp(MOCK_PHONE, 'login');
  for (let i = 0; i < 5; i += 1) {
    await rejectsApiError(auth.verifyOtp(req.requestId, '000000', 'login'), 401, 'OTP_INVALID');
  }
  await rejectsApiError(auth.verifyOtp(req.requestId, req.debugCode ?? '', 'login'), 401, 'OTP_MAX_ATTEMPTS');
});

test('an expired request throws OTP_EXPIRED (mock matches live 401 envelope)', async () => {
  const req = await auth.requestOtp(MOCK_PHONE, 'login');
  const state = (await import('@/repos/mock/mockState')).getState();
  state.otpRequests.get(req.requestId)!.expiresAt = Date.now() - 1000;
  const err = await rejectsApiError(auth.verifyOtp(req.requestId, req.debugCode ?? '', 'login'), 401, 'OTP_EXPIRED');
  assert.ok(err.message.length > 0, 'expired code carries a human message');
});

test('an unknown request id is OTP_INVALID (never OTP_EXPIRED)', async () => {
  await rejectsApiError(auth.verifyOtp('req_does_not_exist', '000000', 'login'), 401, 'OTP_INVALID');
});

test('requestOtp supports the contract purposes password_reset and signup', async () => {
  const resetReq = await auth.requestOtp(MOCK_PHONE, 'password_reset');
  assert.ok(resetReq.requestId.length > 0);
  const resetSession = await auth.verifyOtp(resetReq.requestId, resetReq.debugCode ?? '', 'login');
  assert.ok(resetSession.accessToken.length > 0);

  const signupReq = await auth.requestOtp('+255711111111', 'signup');
  assert.ok(signupReq.requestId.length > 0);
  const signupSession = await auth.verifyOtp(signupReq.requestId, signupReq.debugCode ?? '', 'signup');
  assert.ok(signupSession.accessToken.length > 0);
});

test('email channel is accepted (contract RequestOtpBodyChannel)', async () => {
  const req = await auth.requestOtp('demo@hudumika.co', 'login', 'email');
  assert.ok(req.requestId.length > 0);
  const session = await auth.verifyOtp(req.requestId, req.debugCode ?? '', 'login');
  assert.ok(session.accessToken.length > 0);
});

test('verifyOtp returns a refreshToken (contract Session field)', async () => {
  const req = await auth.requestOtp(MOCK_PHONE, 'login');
  const session = await auth.verifyOtp(req.requestId, req.debugCode ?? '', 'login');
  assert.ok(session.refreshToken && session.refreshToken.length > 0);
});

test('persisted session carries the real refresh token after verifyOtp', async () => {
  const req = await useSessionStore.getState().requestOtp(MOCK_PHONE);
  await useSessionStore.getState().verifyOtp(req.requestId, req.debugCode ?? '');
  const stored = await getStoredSession();
  assert.ok(stored, 'session is persisted');
  assert.ok(stored!.accessToken.length > 0);
  assert.ok(stored!.refreshToken && stored!.refreshToken.length > 0, 'refreshToken is persisted, not blank');
});

test('sessions: seeded registry marks the current device; revoke removes; unknown token 404s', async () => {
  const before = await auth.listSessions();
  assert.ok(before.length >= 3, 'demo user has 2–3 seeded sessions');
  assert.equal(before.filter((s) => s.current === true).length, 1, 'exactly one session is the current device');
  const target = before.find((s) => s.current !== true)!;
  await auth.revokeSession(target.id);
  const after = await auth.listSessions();
  assert.ok(!after.some((s) => s.id === target.id), 'revoked session disappears');
  await rejectsApiError(auth.revokeSession('token_unknown'), 404, 'SESSION_NOT_FOUND');
});

/* ---- Change password (POST /auth/change-password, contract ChangePasswordBody) ---- */

test('changePassword round-trips: the new password becomes the current one', async () => {
  await auth.changePassword('HudumikaDemo1', 'NewPassword789', 'm1-pw-1');
  await rejectsApiError(auth.changePassword('HudumikaDemo1', 'NewPassword789', 'm1-pw-2'), 401, 'UNAUTHORIZED');
  await auth.changePassword('NewPassword789', 'ChangedAgain123', 'm1-pw-3');
});

test('changePassword rejects a too-short new password with the contract validation code', async () => {
  const err = await rejectsApiError(auth.changePassword('HudumikaDemo1', 'short', 'm1-pw-4'), 422, 'VALIDATION_FAILED');
  assert.ok(err.message.length > 0);
  await rejectsApiError(auth.changePassword('HudumikaDemo1', '1234567', 'm1-pw-5'), 422, 'VALIDATION_FAILED');
});

test('changePassword with a wrong current password answers the contract credential code', async () => {
  // No WRONG_PASSWORD code exists in ERROR-CODES.md — failed credential
  // checks answer 401 UNAUTHORIZED (global code).
  await rejectsApiError(auth.changePassword('WrongCurrent1', 'NewPassword789', 'm1-pw-6'), 401, 'UNAUTHORIZED');
});

/* ---- Role switching (GET /users/me/roles, verify_role OTP) ---- */

test('listRoles returns the seeded roles — customer plus the mock merchant role', async () => {
  const roles = await auth.listRoles();
  assert.ok(roles.length >= 2, 'demo user holds more than one role (switch UI reachable)');
  assert.ok(roles.some((r) => r.role === 'customer'));
  const merchant = roles.find((r) => r.role === 'merchant');
  assert.ok(merchant, 'the extra mock role is merchant');
  assert.ok(merchant!.merchantId, 'merchant role carries its merchantId (RoleSummary)');
});

test('verifyOtp with purpose verify_role returns the role-scoped session (mock-level)', async () => {
  const req = await auth.requestOtp(MOCK_PHONE, 'verify_role');
  assert.ok(req.requestId.length > 0);
  const session = await auth.verifyOtp(req.requestId, req.debugCode ?? '', 'verify_role');
  assert.ok(session.accessToken.length > 0);
  assert.equal(session.user.activeRole, 'merchant', 'the session is scoped to the non-customer role');
  assert.ok((session.user.roles ?? []).some((r) => r.role === 'customer'), 'roles stay intact');
});

test('verify_role via the session store leaves the customer session untouched (sessions never mix)', async () => {
  const login = await useSessionStore.getState().requestOtp(MOCK_PHONE);
  await useSessionStore.getState().verifyOtp(login.requestId, login.debugCode ?? '');
  useSessionStore.getState().completeOnboarding(useSessionStore.getState().user!);
  const before = useSessionStore.getState().token;
  assert.equal(useSessionStore.getState().status, 'authed');

  // Skip the 60 s resend cooldown for the fresh verify_role request.
  const state = (await import('@/repos/mock/mockState')).getState();
  state.lastOtpRequestAt.delete(MOCK_PHONE);
  const req = await useSessionStore.getState().requestOtp(MOCK_PHONE, 'verify_role');
  await useSessionStore.getState().verifyOtp(req.requestId, req.debugCode ?? '', 'verify_role');

  const stateAfter = useSessionStore.getState();
  assert.equal(stateAfter.status, 'authed', 'no onboarding/session change after a role hand-off');
  assert.equal(stateAfter.token, before, 'the customer token is never swapped for the role session');
  assert.equal(stateAfter.user?.activeRole, 'customer');
});

/* ---- Social login (POST /auth/social, mock-only-until-adopted #19) ---- */

test('socialLogin with the demo code returns a valid AuthSession (token + user)', async () => {
  const session = await auth.socialLogin({ provider: 'google', code: MOCK_SOCIAL_CODE }, 'm1-social-1');
  assert.match(session.accessToken, /^mock_at_social_google_/, 'mock exchange issues a social token');
  assert.ok(session.refreshToken && session.refreshToken.length > 0, 'session carries the refresh token pair');
  assert.equal(session.user.id, 'cus_0001');
  assert.equal(session.user.activeRole, 'customer');
  assert.ok((session.user.roles ?? []).some((r) => r.role === 'customer'));

  const apple = await auth.socialLogin({ provider: 'apple', code: MOCK_SOCIAL_CODE }, 'm1-social-2');
  assert.ok(apple.accessToken.length > 0);
  assert.equal(apple.user.id, session.user.id);
});

test('socialLogin rejects an empty code with the contract validation code', async () => {
  const err = await rejectsApiError(auth.socialLogin({ provider: 'google', code: '' }, 'm1-social-3'), 422, 'VALIDATION_FAILED');
  assert.ok(err.message.length > 0, 'validation error carries a human message');
  await rejectsApiError(auth.socialLogin({ provider: 'apple', code: '   ' }, 'm1-social-4'), 422, 'VALIDATION_FAILED');
});

test('socialLogin is idempotent per key — a replay returns the same session', async () => {
  const first = await auth.socialLogin({ provider: 'google', code: MOCK_SOCIAL_CODE }, 'm1-social-5');
  const replayed = await auth.socialLogin({ provider: 'google', code: MOCK_SOCIAL_CODE }, 'm1-social-5');
  assert.equal(replayed.accessToken, first.accessToken, 'a retry replays the stored session, never a double exchange');
  assert.equal(replayed.refreshToken, first.refreshToken);
  assert.deepEqual(replayed.user, first.user);
});

/* ---- Two-factor auth (mock-only-until-adopted, CONTRACT-ADDITIONS.md #23) ---- */

test('getTwoFactorStatus is DISABLED by default (existing flows keep working)', async () => {
  assert.deepEqual(await auth.getTwoFactorStatus(), { enabled: false, method: null });
  assert.equal(twoFactorStateForTests().enabled, false);
});

test('enableTwoFactor turns 2FA on, returns the demo code, and is idempotent per key', async () => {
  const res = await auth.enableTwoFactor('m1-2fa-enable-1');
  assert.equal(res.enabled, true);
  assert.equal(res.demoCode, twoFactorStateForTests().demoCode, 'the demo TOTP code is a mock-only extension');
  assert.deepEqual(await auth.getTwoFactorStatus(), { enabled: true, method: 'otp' });
  // Replay of the same key (retry) succeeds — never an error.
  const replayed = await auth.enableTwoFactor('m1-2fa-enable-1');
  assert.equal(replayed.enabled, true);
  assert.deepEqual(await auth.getTwoFactorStatus(), { enabled: true, method: 'otp' });
});

test('verifyTwoFactor accepts the demo code when enabled and rejects wrong/disabled', async () => {
  assert.deepEqual(await auth.verifyTwoFactor('123456'), { valid: false }, 'disabled 2FA never verifies');
  await auth.enableTwoFactor('m1-2fa-enable-2');
  assert.deepEqual(await auth.verifyTwoFactor('123456'), { valid: true });
  assert.deepEqual(await auth.verifyTwoFactor('654321'), { valid: false }, 'a wrong code is invalid');
});

test('disableTwoFactor requires the valid demo code; wrong code → 401 UNAUTHORIZED', async () => {
  await auth.enableTwoFactor('m1-2fa-enable-3');
  await rejectsApiError(auth.disableTwoFactor('000000', 'm1-2fa-disable-1'), 401, 'UNAUTHORIZED');
  assert.equal((await auth.getTwoFactorStatus()).enabled, true, 'a failed disable leaves 2FA on');
  const res = await auth.disableTwoFactor('123456', 'm1-2fa-disable-2');
  assert.equal(res.enabled, false);
  assert.deepEqual(await auth.getTwoFactorStatus(), { enabled: false, method: null });
  // Same key replays the disable (idempotent).
  assert.deepEqual(await auth.disableTwoFactor('123456', 'm1-2fa-disable-2'), { enabled: false });
});
