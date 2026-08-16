/* In-memory auth repository. Mirrors POST /auth/request-otp, POST /auth/verify-otp,
 * GET /users/me, POST /auth/logout against module state in mockState.ts.
 *
 * requestOtp returns a 6-digit debugCode (mock-only extension the UI shows in
 * the demo); verifyOtp accepts either the debugCode or any 6-digit code for a
 * matching requestId — wrong codes get a 401 OTP_INVALID like the live API.
 */
import { ApiError } from '@/api/client';
import { getState, MOCK_PHONE, clone } from './mockState';
import type { AuthRepository, AuthSession, OtpRequestResult } from '../index';
import type { RiderPrivate } from '@hudumika/contract';

const OTP_TTL_MS = 5 * 60 * 1000;
const OTP_RESEND_MS = 60 * 1000;

export class MockAuthRepository implements AuthRepository {
  async requestOtp(destination: string, purpose: 'login' | 'register' = 'login'): Promise<OtpRequestResult> {
    const state = getState();
    const last = state.otpLastRequestAt.get(destination) ?? 0;
    const elapsed = Date.now() - last;
    if (elapsed < OTP_RESEND_MS) {
      const retryAfterSeconds = Math.ceil((OTP_RESEND_MS - elapsed) / 1000);
      throw new ApiError(429, 'RATE_LIMITED', 'Too many OTP requests — wait before resending', false, { retryAfterSeconds });
    }
    state.otpLastRequestAt.set(destination, Date.now());
    const requestId = `req_${String(++state.otpCounter).padStart(4, '0')}_${Date.now().toString(36)}`;
    const debugCode = String(100000 + (state.otpCounter % 900000));
    state.otpRequests.set(requestId, {
      code: debugCode,
      destination,
      purpose,
      expiresAt: Date.now() + OTP_TTL_MS,
    });
    return { requestId, expiresInSeconds: OTP_TTL_MS / 1000, resendAfterSeconds: OTP_RESEND_MS / 1000, debugCode, demo: true };
  }

  async verifyOtp(requestId: string, code: string, _purpose?: 'login' | 'register'): Promise<AuthSession> {
    const state = getState();
    const pending = state.otpRequests.get(requestId);
    if (!pending || pending.expiresAt < Date.now()) {
      throw new ApiError(401, 'OTP_INVALID', 'Invalid or expired code');
    }
    if (code !== pending.code) {
      throw new ApiError(401, 'OTP_INVALID', 'Invalid or expired code');
    }
    state.otpRequests.delete(requestId);
    const token = `mock_at_${requestId}_${Date.now().toString(36)}`;
    const rider = clone(state.profile);
    return {
      accessToken: token,
      refreshToken: `mock_rt_${requestId}`,
      user: { id: rider.id, name: rider.name, phone: MOCK_PHONE, role: 'rider' },
      rider,
    };
  }

  async me(): Promise<{ user: { id: string; name?: string; phone: string; role: string }; rider: RiderPrivate | null }> {
    const state = getState();
    return {
      user: { id: state.profile.id, name: state.profile.name, phone: MOCK_PHONE, role: 'rider' },
      rider: clone(state.profile),
    };
  }

  async logout(): Promise<void> {
    /* no-op — mock session is in-memory; the store wipes tokens */
  }
}