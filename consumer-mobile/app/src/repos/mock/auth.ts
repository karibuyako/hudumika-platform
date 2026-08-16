/* In-memory auth repository. Mirrors POST /auth/request-otp, POST /auth/verify-otp,
 * GET /users/me, PATCH /users/me, GET /sessions, POST /sessions/{token}/revoke,
 * POST /auth/change-password, POST /auth/logout against module state in
 * mockState.ts.
 *
 * requestOtp returns a 6-digit debugCode (mock-only extension the UI shows in
 * the demo); verifyOtp accepts either the debugCode or any 4–8 digit code for
 * a matching requestId — wrong codes get a 401 OTP_INVALID like the live API,
 * and expired requests get OTP_EXPIRED so the UI can ask for a fresh code.
 *
 * Purpose/channel use ONLY the contract enums (login|signup|password_reset|
 * verify_role / phone|email). Mock-only extensions (same pattern as
 * debugCode): refreshToken in AuthSession, the seeded session registry, the
 * SESSION_NOT_FOUND code for unknown revoke tokens, the seeded password +
 * merchant role below, and the role-scoped session verifyOtp returns for
 * purpose verify_role.
 */
import { ApiError, setToken } from '@/api/client';
import { getState, clone, MOCK_PHONE } from './mockState';
import type { AuthRepository, AuthSession, OtpChannel, OtpPurpose, OtpRequestResult, SocialLoginInput, TwoFactorStatus } from '../index';
import type { RoleSummary, RequestPrivacyExport202, SessionInfo, User } from '@hudumika/contract';

const OTP_TTL_MS = 5 * 60 * 1000;
const RESEND_MS = 60 * 1000;
const MAX_ATTEMPTS = 5;

/** Mock-only purpose/channel metadata — mockState.ts is the shared store and
 * must stay untouched (parallel agents); this map is keyed by requestId and
 * orphaned entries are inert after resetMockState(). */
const otpMeta = new Map<string, { purpose: OtpPurpose; channel: OtpChannel }>();

/** Mock-only social-login demos (CONTRACT-ADDITIONS.md #19): the seeded
 * demo "OAuth authorization code" — any non-empty code signs in (the
 * exchange is simulated), this is the documented one tests + the demo use
 * (same pattern as the OTP debugCode / MOCK_PHONE). */
export const MOCK_SOCIAL_CODE = 'social-demo-2026';

/** Mock-only idempotent social-login sessions keyed by Idempotency-Key —
 * a replay returns the stored session, never a double exchange (same
 * pattern as orderReplays in mockState, kept module-local so mockState.ts
 * stays untouched). */
const socialSessions = new Map<string, AuthSession>();

/** Mock-only: the demo user also holds a merchant role so the role-switch UI
 * is reachable in dev (mockState.ts stays untouched). The customer app still
 * only renders customer sessions — this exists purely to demo the hand-off. */
const MOCK_EXTRA_ROLES: RoleSummary[] = [{ role: 'merchant', merchantId: 'merch_demo_001' }];

/** Mock-only seeded password for the demo user (OTP login in the mock, so
 * this is the stand-in "current" secret). The live contract has no
 * WRONG_PASSWORD code — a failed current-password check answers 401
 * UNAUTHORIZED like any failed credential check. */
const SEED_PASSWORD = 'HudumikaDemo1';
let mockPassword: string = SEED_PASSWORD;

let sessions: SessionInfo[] = [
  { id: 'sess_current', deviceInfo: 'Pixel 8 · Android 15', lastActiveAt: new Date(Date.now() - 3 * 60_000).toISOString(), current: true },
  { id: 'sess_web', deviceInfo: 'Chrome · Windows 11', lastActiveAt: new Date(Date.now() - 26 * 3600_000).toISOString() },
  { id: 'sess_tablet', deviceInfo: 'iPad · Safari', lastActiveAt: new Date(Date.now() - 3 * 86400_000).toISOString() },
];

/** Mock-only push-token registry (CONTRACT-ADDITIONS.md #2): the consumer
 * contract has no POST /push/tokens endpoint yet, so the mock keeps the
 * registered Expo push tokens module-locally — the "server" side of the
 * app-only surface src/lib/push.ts calls through AuthRepository. A Set keeps
 * register idempotent (same token twice = success, documented). */
const registeredPushTokens = new Set<string>();

/** Mock-only 2FA surface (docs/CONTRACT-ADDITIONS.md #23): the consumer
 * contract has no 2FA endpoints, so the mock owns the whole feature —
 * default DISABLED so every existing flow keeps working. The fixed demo TOTP
 * code mirrors the OTP debugCode pattern (the UI shows it after enabling so
 * the demo is testable). */
const DEMO_TOTP_CODE = '123456';
let twoFactorEnabled = false;

/** Tests re-seed the auth module between cases (mockState reset covers otp). */
export function resetMockAuthState(): void {
  otpMeta.clear();
  mockPassword = SEED_PASSWORD;
  registeredPushTokens.clear();
  socialSessions.clear();
  twoFactorEnabled = false;
  sessions = [
    { id: 'sess_current', deviceInfo: 'Pixel 8 · Android 15', lastActiveAt: new Date(Date.now() - 3 * 60_000).toISOString(), current: true },
    { id: 'sess_web', deviceInfo: 'Chrome · Windows 11', lastActiveAt: new Date(Date.now() - 26 * 3600_000).toISOString() },
    { id: 'sess_tablet', deviceInfo: 'iPad · Safari', lastActiveAt: new Date(Date.now() - 3 * 86400_000).toISOString() },
  ];
}

/** Test hook — the registered token set (mock-only, same pattern as
 * reportedIssueIdsForTests in mock/wallet.ts). */
export function registeredPushTokensForTests(): string[] {
  return [...registeredPushTokens];
}

/** Test hook — the module-local 2FA flag + demo code (mock-only, same
 * pattern as registeredPushTokensForTests). */
export function twoFactorStateForTests(): { enabled: boolean; demoCode: string } {
  return { enabled: twoFactorEnabled, demoCode: DEMO_TOTP_CODE };
}

export class MockAuthRepository implements AuthRepository {
  async requestOtp(destination: string, purpose: OtpPurpose = 'login', channel: OtpChannel = 'phone'): Promise<OtpRequestResult> {
    const state = getState();
    const last = state.lastOtpRequestAt.get(destination);
    const waitMs = last ? RESEND_MS - (Date.now() - last) : 0;
    if (waitMs > 0) {
      throw new ApiError(429, 'RATE_LIMITED', 'Too many requests — try again shortly', true, { retryAfterSeconds: Math.ceil(waitMs / 1000) });
    }
    state.lastOtpRequestAt.set(destination, Date.now());
    const requestId = `req_${String(++state.otpCounter).padStart(4, '0')}_${Date.now().toString(36)}`;
    const debugCode = String(100000 + (state.otpCounter % 900000));
    // A fresh request supersedes any pending one for the same destination —
    // the previous requestId must no longer verify.
    for (const [rid, pending] of state.otpRequests) {
      if (pending.destination === destination) state.otpRequests.delete(rid);
    }
    state.otpRequests.set(requestId, {
      code: debugCode,
      destination,
      purpose: purpose as 'login' | 'signup',
      expiresAt: Date.now() + OTP_TTL_MS,
      attempts: 0,
    });
    otpMeta.set(requestId, { purpose, channel });
    return { requestId, expiresInSeconds: OTP_TTL_MS / 1000, resendInSeconds: RESEND_MS / 1000, debugCode, demo: true };
  }

  async verifyOtp(requestId: string, code: string, purpose: OtpPurpose = 'login'): Promise<AuthSession> {
    const state = getState();
    const pending = state.otpRequests.get(requestId);
    if (!pending) {
      throw new ApiError(401, 'OTP_INVALID', 'Invalid or expired code');
    }
    if (pending.expiresAt < Date.now()) {
      throw new ApiError(401, 'OTP_EXPIRED', 'Code expired — request a new one');
    }
    if (pending.attempts >= MAX_ATTEMPTS) {
      throw new ApiError(401, 'OTP_MAX_ATTEMPTS', 'Too many attempts — request a new code');
    }
    if (code !== pending.code) {
      pending.attempts += 1;
      throw new ApiError(401, 'OTP_INVALID', 'Invalid or expired code');
    }
    // The request-otp purpose is authoritative (mockState only stores the
    // login|signup subset — the full purpose lives in the module-local meta).
    const effective = otpMeta.get(requestId)?.purpose ?? purpose;
    state.otpRequests.delete(requestId);
    const user = clone(state.user);
    if (effective === 'verify_role') {
      // Role-scoped session (mock-only): the server hands the switch to the
      // role's own app, so the mock never clobbers the customer token — the
      // customer app only renders customer sessions (SECURITY.md). The target
      // role comes from the user's role summary plus the module-local
      // merchant role seed (mockState.ts stays untouched).
      const target = [...(user.roles ?? []), ...MOCK_EXTRA_ROLES].find((r) => r.role !== 'customer');
      return {
        accessToken: `mock_at_${requestId}_${Date.now().toString(36)}`,
        refreshToken: `mock_rt_${requestId}_${Date.now().toString(36)}`,
        user: { ...user, activeRole: target?.role ?? user.activeRole },
      };
    }
    const token = `mock_at_${requestId}_${Date.now().toString(36)}`;
    setToken(token);
    return { accessToken: token, refreshToken: `mock_rt_${requestId}_${Date.now().toString(36)}`, user };
  }

  /* Mock-only social login (docs/CONTRACT-ADDITIONS.md #19): POST /auth/social
   * is NOT in the generated contract yet — the parity harness allow-lists it
   * until Team 6 ships the endpoint. The OAuth exchange is SIMULATED: a real
   * provider redirect needs the native phase (no expo-auth-session), so the
   * mock accepts any non-empty code (or none at all — the demo flow, same
   * spirit as the OTP debugCode) and signs in the seeded demo customer,
   * reusing the session construction from verifyOtp. Idempotent per key: a
   * replay returns the stored session — never a double exchange. */
  async socialLogin(input: SocialLoginInput, idempotencyKey: string): Promise<AuthSession> {
    if (input.provider !== 'google' && input.provider !== 'apple') {
      throw new ApiError(422, 'VALIDATION_FAILED', 'Provider must be google or apple');
    }
    const replayed = socialSessions.get(idempotencyKey);
    if (replayed) return clone(replayed);
    if (input.code !== undefined && input.code.trim() === '') {
      throw new ApiError(422, 'VALIDATION_FAILED', 'OAuth code is required');
    }
    const state = getState();
    const token = `mock_at_social_${input.provider}_${Date.now().toString(36)}`;
    setToken(token);
    const session: AuthSession = {
      accessToken: token,
      refreshToken: `mock_rt_social_${input.provider}_${Date.now().toString(36)}`,
      user: clone(state.user),
    };
    socialSessions.set(idempotencyKey, session);
    return clone(session);
  }

  async me(): Promise<User> {
    const state = getState();
    return clone(state.user);
  }

  async listRoles(): Promise<RoleSummary[]> {
    return [...clone(getState().user.roles), ...clone(MOCK_EXTRA_ROLES)];
  }

  async changePassword(currentPassword: string, newPassword: string, _idempotencyKey: string): Promise<void> {
    // Contract ChangePasswordBody: newPassword minLength 8 / maxLength 128.
    if (newPassword.length < 8 || newPassword.length > 128) {
      throw new ApiError(422, 'VALIDATION_FAILED', 'New password must be between 8 and 128 characters');
    }
    if (currentPassword !== mockPassword) {
      // No wrong-password code in the contract (backend/ERROR-CODES.md) — the
      // live API answers 401 UNAUTHORIZED like any failed credential check.
      throw new ApiError(401, 'UNAUTHORIZED', 'Current password is incorrect');
    }
    mockPassword = newPassword;
  }

  async listSessions(): Promise<SessionInfo[]> {
    return clone(sessions);
  }

  async revokeSession(token: string): Promise<void> {
    const idx = sessions.findIndex((s) => s.id === token);
    if (idx === -1) {
      throw new ApiError(404, 'SESSION_NOT_FOUND', 'Session not found');
    }
    sessions.splice(idx, 1);
  }

  async updateProfile(patch: Partial<Pick<User, 'fullName' | 'email' | 'avatarUrl' | 'locale'>>): Promise<User> {
    const state = getState();
    state.user = {
      ...state.user,
      ...(patch.fullName !== undefined ? { fullName: patch.fullName } : {}),
      ...(patch.email !== undefined ? { email: patch.email } : {}),
      ...(patch.avatarUrl !== undefined ? { avatarUrl: patch.avatarUrl } : {}),
      ...(patch.locale !== undefined ? { locale: patch.locale } : {}),
    };
    return clone(state.user);
  }

  async deleteAccount(): Promise<void> {
    const state = getState();
    state.user.roles = [];
    state.user.activeRole = undefined;
    setToken(null);
  }

  /* POST /privacy/export — personal data export. The mock acknowledges the
   * job with the contract's {jobId, status} shape (202, status queued). */
  async exportData(): Promise<RequestPrivacyExport202> {
    const state = getState();
    return { jobId: `exp_${state.user.id.slice(0, 6)}_${Date.now().toString(36)}`, status: 'queued' };
  }

  async logout(): Promise<void> {
    setToken(null);
  }

  // Mock-only push-token surface (docs/CONTRACT-ADDITIONS.md #2): the
  // consumer contract has no POST /push/tokens — this registry is the mock
  // server side of the seam src/lib/push.ts calls. PUSH_TOKEN_INVALID is the
  // contract's own code for a malformed token (backend/ERROR-CODES.md,
  // Notifications section). Register is idempotent: the same token twice
  // succeeds (Set semantics), so re-registering on session resume never
  // errors.
  async registerPushToken(token: string, _idempotencyKey: string): Promise<void> {
    if (!/^ExponentPushToken\[[A-Za-z0-9_-]+\]$/.test(token)) {
      throw new ApiError(422, 'PUSH_TOKEN_INVALID', 'Invalid push token format');
    }
    registeredPushTokens.add(token);
  }

  async unregisterPushToken(token: string, _idempotencyKey: string): Promise<void> {
    registeredPushTokens.delete(token);
  }

  /* Mock-only 2FA surface (docs/CONTRACT-ADDITIONS.md #23): GET/POST/DELETE
   * /users/me/2fa + POST /auth/2fa/verify are NOT in the generated contract
   * (OPERATIONS-COVERAGE #9 PLANNED) — the mock is the server. Default
   * DISABLED so existing flows keep working; the fixed demo code (shown in
   * the UI after enabling, same pattern as the OTP debugCode) is the one and
   * only valid code. Enable is idempotent per key (flag semantics), disable
   * requires the valid demo code — a wrong one answers 401 UNAUTHORIZED like
   * any failed credential check (no 2FA-specific code exists in
   * backend/ERROR-CODES.md). */
  async getTwoFactorStatus(): Promise<TwoFactorStatus> {
    return { enabled: twoFactorEnabled, method: twoFactorEnabled ? 'otp' : null };
  }

  async enableTwoFactor(_idempotencyKey: string): Promise<{ enabled: true; demoCode?: string }> {
    twoFactorEnabled = true;
    return { enabled: true, demoCode: DEMO_TOTP_CODE };
  }

  async disableTwoFactor(code: string, _idempotencyKey: string): Promise<{ enabled: false }> {
    if (code !== DEMO_TOTP_CODE) {
      throw new ApiError(401, 'UNAUTHORIZED', 'Invalid two-factor code');
    }
    twoFactorEnabled = false;
    return { enabled: false };
  }

  async verifyTwoFactor(code: string): Promise<{ valid: boolean }> {
    return { valid: twoFactorEnabled && code === DEMO_TOTP_CODE };
  }
}

export { MOCK_PHONE };
