/* Live API auth repository. Thin typed wrapper over the hardened client.
 *
 * Paths (API-CONTRACT.yaml):
 *   POST /auth/request-otp  {channel:'phone', destination, purpose} → OtpDelivery
 *   POST /auth/verify-otp   {requestId, code}                       → Session
 *   POST /auth/refresh      {refreshToken}                          → Session
 *   GET  /users/me                                                  → User
 *   GET  /users/me/roles                                            → RoleSummary[]
 *   GET  /providers/me                                              → ProviderPrivate
 *   GET  /providers/me/capabilities                                 → ListProviderCapabilities200
 *   POST /auth/logout
 */
import { api, setRefreshToken, setToken } from '@/api/client';
import { loadStoredRefreshToken } from '@/lib/tokenStore';
import type { AuthRepository, AuthSession, OtpRequestResult } from '../index';
import type {
  ListProviderCapabilities200,
  OtpDelivery,
  ProviderPrivate,
  RequestOtpBody,
  RoleSummary,
  Session,
  User,
} from '@hudumika/contract';

export class ApiAuthRepository implements AuthRepository {
  async requestOtp(destination: string, purpose: 'login' | 'register' | 'verify_role' = 'login'): Promise<OtpRequestResult> {
    const body: RequestOtpBody = { channel: 'phone', destination, purpose: purpose === 'register' ? 'signup' : purpose };
    const res = await api.post<OtpDelivery>('/auth/request-otp', body);
    return { requestId: res.requestId, expiresInSeconds: res.expiresInSeconds, demo: false };
  }

  async verifyOtp(requestId: string, code: string, _purpose?: 'login' | 'register' | 'verify_role'): Promise<AuthSession> {
    const res = await api.post<Session>('/auth/verify-otp', { requestId, code });
    setToken(res.accessToken);
    setRefreshToken(res.refreshToken);
    return {
      accessToken: res.accessToken,
      refreshToken: res.refreshToken,
      user: { id: res.user.id, name: res.user.fullName, phone: res.user.phone, role: res.user.activeRole ?? 'provider' },
      provider: undefined,
    };
  }

  async refresh(): Promise<AuthSession> {
    const refreshToken = loadStoredRefreshToken();
    const res = await api.post<Session>('/auth/refresh', { refreshToken });
    setToken(res.accessToken);
    setRefreshToken(res.refreshToken);
    return {
      accessToken: res.accessToken,
      refreshToken: res.refreshToken,
      user: { id: res.user.id, name: res.user.fullName, phone: res.user.phone, role: res.user.activeRole ?? 'provider' },
      provider: undefined,
    };
  }

  async me(): Promise<{ user: { id: string; name?: string; phone: string; role: string }; provider: ProviderPrivate | null }> {
    const user = await api.get<User>('/users/me');
    let provider: ProviderPrivate | null = null;
    try {
      provider = (await api.get<ProviderPrivate>('/providers/me')) ?? null;
    } catch {
      provider = null;
    }
    return {
      user: { id: user.id, name: user.fullName, phone: user.phone, role: user.activeRole ?? 'provider' },
      provider,
    };
  }

  async capabilities(): Promise<ListProviderCapabilities200> {
    return api.get<ListProviderCapabilities200>('/providers/me/capabilities');
  }

  async roles(): Promise<RoleSummary[]> {
    return api.get<RoleSummary[]>('/users/me/roles');
  }

  async logout(): Promise<void> {
    await api.post<void>('/auth/logout');
    setRefreshToken(null);
  }
}
