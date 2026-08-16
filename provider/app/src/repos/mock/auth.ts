/* In-memory auth repository. Mirrors POST /auth/request-otp, POST /auth/verify-otp,
 * GET /users/me, GET /providers/me/capabilities, POST /auth/logout against module
 * state in mockState.ts.
 *
 * requestOtp returns a 6-digit debugCode (mock-only extension the UI shows in
 * the demo) and is rate-limited per destination: the 3rd request inside a 60s
 * window throws 429 RATE_LIMITED. verifyOtp accepts the debugCode for a matching
 * requestId — missing, expired or wrong codes get 401 OTP_INVALID like the live
 * API. A successful verify persists the session token via setToken().
 */
import { ApiError, setRefreshToken, setToken } from '@/api/client';
import { getState, MOCK_PHONE, clone } from './mockState';
import type { AuthRepository, AuthSession, OtpRequestResult } from '../index';
import type { ListProviderCapabilities200, ProviderPrivate, RoleSummary } from '@hudumika/contract';

const OTP_TTL_MS = 5 * 60 * 1000;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 2;

export class MockAuthRepository implements AuthRepository {
  async requestOtp(destination: string, purpose: 'login' | 'register' | 'verify_role' = 'login'): Promise<OtpRequestResult> {
    const state = getState();
    const now = Date.now();
    const attempts = (state.otpAttempts.get(destination) ?? []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
    if (attempts.length >= RATE_LIMIT_MAX_REQUESTS) {
      throw new ApiError(429, 'RATE_LIMITED', 'Too many requests', true, undefined, RATE_LIMIT_WINDOW_MS / 1000);
    }
    attempts.push(now);
    state.otpAttempts.set(destination, attempts);
    const requestId = `req_${String(++state.otpCounter).padStart(4, '0')}_${Date.now().toString(36)}`;
    const debugCode = String(100000 + (state.otpCounter % 900000));
    state.otpRequests.set(requestId, {
      code: debugCode,
      destination,
      purpose,
      expiresAt: now + OTP_TTL_MS,
    });
    return { requestId, expiresInSeconds: OTP_TTL_MS / 1000, debugCode, demo: true };
  }

  async verifyOtp(requestId: string, code: string, _purpose?: 'login' | 'register' | 'verify_role'): Promise<AuthSession> {
    const state = getState();
    const pending = state.otpRequests.get(requestId);
    if (!pending || pending.expiresAt < Date.now() || code !== pending.code) {
      throw new ApiError(401, 'OTP_INVALID', 'Invalid or expired code');
    }
    state.otpRequests.delete(requestId);
    const token = `mock_at_${requestId}_${Date.now().toString(36)}`;
    const refreshToken = `mock_rt_${requestId}_${Date.now().toString(36)}`;
    setToken(token);
    setRefreshToken(refreshToken);
    return {
      accessToken: token,
      refreshToken,
      user: { id: state.profile.id, name: state.profile.name, phone: MOCK_PHONE, role: 'provider' },
      provider: clone(state.profile),
    };
  }

  async refresh(): Promise<AuthSession> {
    const state = getState();
    const token = `mock_at_ref_${Date.now().toString(36)}`;
    const refreshToken = `mock_rt_${Date.now().toString(36)}`;
    setToken(token);
    setRefreshToken(refreshToken);
    return {
      accessToken: token,
      refreshToken,
      user: { id: state.profile.id, name: state.profile.name, phone: MOCK_PHONE, role: 'provider' },
      provider: clone(state.profile),
    };
  }

  async me(): Promise<{ user: { id: string; name?: string; phone: string; role: string }; provider: ProviderPrivate | null }> {
    const state = getState();
    return {
      user: { id: state.profile.id, name: state.profile.name, phone: MOCK_PHONE, role: 'provider' },
      provider: clone(state.profile),
    };
  }

  async capabilities(): Promise<ListProviderCapabilities200> {
    return { capabilities: clone(getState().capabilities) };
  }

  async roles(): Promise<RoleSummary[]> {
    const state = getState();
    return [{ role: 'provider', providerId: state.profile.id }];
  }

  async logout(): Promise<void> {
    setToken(null);
    setRefreshToken(null);
  }
}
