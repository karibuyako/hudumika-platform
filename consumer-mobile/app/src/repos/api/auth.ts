/* Live API auth repository. Thin typed wrapper over the hardened client. */
import { api, setToken } from '@/api/client';
import type { AuthRepository, AuthSession, OtpChannel, OtpPurpose, OtpRequestResult, SocialLoginInput, TwoFactorStatus } from '../index';
import type { ChangePasswordBody, OtpDelivery, RequestOtpBody, RequestPrivacyExport202, RoleSummary, Session, SessionInfo, User, UserUpdate } from '@hudumika/contract';

export class ApiAuthRepository implements AuthRepository {
  async requestOtp(destination: string, purpose: OtpPurpose = 'login', channel: OtpChannel = 'phone'): Promise<OtpRequestResult> {
    const body: RequestOtpBody = { channel, destination, purpose };
    const res = await api.post<OtpDelivery>('/auth/request-otp', body);
    return { requestId: res.requestId, expiresInSeconds: res.expiresInSeconds, resendInSeconds: res.resendInSeconds, demo: false };
  }

  async verifyOtp(requestId: string, code: string, _purpose?: OtpPurpose): Promise<AuthSession> {
    // VerifyOtpBody carries {requestId, code} only — purpose scopes the
    // request-otp, the server returns the role-scoped session.
    const res = await api.post<Session>('/auth/verify-otp', { requestId, code });
    setToken(res.accessToken);
    return { accessToken: res.accessToken, refreshToken: res.refreshToken, user: res.user };
  }

  async me(): Promise<User> {
    return api.get<User>('/users/me');
  }

  // Mock-only-until-adopted (docs/CONTRACT-ADDITIONS.md #19): POST /auth/social
  // is NOT in the generated contract yet (grep of the generated endpoints:
  // no oauth/social/google paths under /auth) — the parity harness allow-lists
  // it until Team 6 ships the social-login endpoint. A live backend that has
  // not adopted the path answers 404/405 and the login screen renders its
  // inline error (same degradation as the push-token and red-packet paths).
  async socialLogin(input: SocialLoginInput, idempotencyKey: string): Promise<AuthSession> {
    const res = await api.post<Session>('/auth/social', input, { idempotencyKey });
    setToken(res.accessToken);
    return { accessToken: res.accessToken, refreshToken: res.refreshToken, user: res.user };
  }

  async listRoles(): Promise<RoleSummary[]> {
    return api.get<RoleSummary[]>('/users/me/roles');
  }

  async listSessions(): Promise<SessionInfo[]> {
    return api.get<SessionInfo[]>('/sessions');
  }

  async revokeSession(token: string): Promise<void> {
    await api.post<void>(`/sessions/${encodeURIComponent(token)}/revoke`);
  }

  async deleteAccount(): Promise<void> {
    await api.post<void>('/privacy/delete');
    setToken(null);
  }

  async exportData(): Promise<RequestPrivacyExport202> {
    return api.post<RequestPrivacyExport202>('/privacy/export');
  }

  async changePassword(currentPassword: string, newPassword: string, idempotencyKey: string): Promise<void> {
    const body: ChangePasswordBody = { currentPassword, newPassword };
    await api.post<void>('/auth/change-password', body, { idempotencyKey });
  }

  async updateProfile(patch: UserUpdate): Promise<User> {
    return api.patch<User>('/users/me', patch);
  }

  // Mock-only-until-adopted (docs/CONTRACT-ADDITIONS.md #2): POST /push/tokens
  // and DELETE /push/tokens/{token} are NOT in the generated contract yet — the
  // parity harness allow-lists them until Team 6 ships the consumer push-token
  // endpoint. src/lib/push.ts catches failures and keeps the device-local
  // SecureStore persistence as the fallback, so a live backend that has not
  // adopted the paths degrades to the current behavior instead of erroring.
  async registerPushToken(token: string, idempotencyKey: string): Promise<void> {
    await api.post<void>('/push/tokens', { token }, { idempotencyKey });
  }

  async unregisterPushToken(token: string, idempotencyKey: string): Promise<void> {
    await api.delete<void>(`/push/tokens/${encodeURIComponent(token)}`, { idempotencyKey });
  }

  // Mock-only-until-adopted 2FA surface (docs/CONTRACT-ADDITIONS.md #23):
  // GET/POST/DELETE /users/me/2fa and POST /auth/2fa/verify are NOT in the
  // generated contract yet (OPERATIONS-COVERAGE #9 PLANNED; grep of the
  // generated endpoints finds no 2fa/mfa/totp paths) — the parity harness
  // allow-lists them until Team 6 ships the endpoints. A live backend that
  // has not adopted the paths errors the security screen into its error/
  // retry state (same degradation rule as the red-packet paths).
  async getTwoFactorStatus(): Promise<TwoFactorStatus> {
    return api.get<TwoFactorStatus>('/users/me/2fa');
  }

  async enableTwoFactor(idempotencyKey: string): Promise<{ enabled: true; demoCode?: string }> {
    return api.post<{ enabled: true }>('/users/me/2fa', undefined, { idempotencyKey });
  }

  async disableTwoFactor(code: string, idempotencyKey: string): Promise<{ enabled: false }> {
    return api.delete<{ enabled: false }>('/users/me/2fa', { body: { code }, idempotencyKey });
  }

  async verifyTwoFactor(code: string): Promise<{ valid: boolean }> {
    return api.post<{ valid: boolean }>('/auth/2fa/verify', { code });
  }

  async logout(): Promise<void> {
    try {
      await api.post<void>('/auth/logout');
    } finally {
      setToken(null);
    }
  }
}
