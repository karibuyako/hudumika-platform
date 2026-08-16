/* Live API auth repository. Thin typed wrapper over the hardened client.
 *
 * Paths (API-CONTRACT.yaml):
 *   POST /auth/request-otp  {channel:'phone', destination, purpose} → OtpDelivery
 *   POST /auth/verify-otp   {requestId, code}                       → Session
 *   GET  /users/me                                                   → User
 *   POST /auth/logout
 */
import { api } from '@/api/client';
import { setTokenPair } from '@/api/tokenStore';
import type { AuthRepository, AuthSession, OtpRequestResult } from '../index';
import type { OtpDelivery, RequestOtpBody, RiderPrivate, Session, User } from '@hudumika/contract';

export class ApiAuthRepository implements AuthRepository {
  async requestOtp(destination: string, purpose: 'login' | 'register' = 'login'): Promise<OtpRequestResult> {
    const body: RequestOtpBody = { channel: 'phone', destination, purpose: purpose === 'register' ? 'signup' : 'login' };
    const res = await api.post<OtpDelivery>('/auth/request-otp', body);
    return { requestId: res.requestId, expiresInSeconds: res.expiresInSeconds, demo: false };
  }

  async verifyOtp(requestId: string, code: string, _purpose?: 'login' | 'register'): Promise<AuthSession> {
    const res = await api.post<Session>('/auth/verify-otp', { requestId, code });
    await setTokenPair({ accessToken: res.accessToken, refreshToken: res.refreshToken });
    return {
      accessToken: res.accessToken,
      refreshToken: res.refreshToken,
      user: {
        id: res.user.id,
        name: res.user.fullName,
        phone: res.user.phone,
        role: res.user.activeRole ?? 'rider',
      },
    };
  }

  async me(): Promise<{ user: { id: string; name?: string; phone: string; role: string }; rider: RiderPrivate | null }> {
    const user = await api.get<User>('/users/me');
    let rider: RiderPrivate | null = null;
    try {
      rider = (await api.get<RiderPrivate>('/riders/me')) ?? null;
    } catch {
      rider = null;
    }
    return {
      user: { id: user.id, name: user.fullName, phone: user.phone, role: user.activeRole ?? 'rider' },
      rider,
    };
  }

  async logout(): Promise<void> {
    await api.post<void>('/auth/logout');
  }
}