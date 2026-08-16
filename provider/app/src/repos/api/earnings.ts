/* Live API earnings repository. Thin typed wrapper over the hardened client.
 *
 * Paths (API-CONTRACT.yaml):
 *   GET  /payouts/me/statement?from&to → LedgerStatement
 *   GET  /payouts/me                   → PayoutSummary[]
 *   GET  /wallet/me                    → Wallet
 *   POST /wallet/withdrawals           → Withdrawal
 */
import { api } from '@/api/client';
import { idemKey } from '@/lib/booking';
import type { EarningsRepository } from '../index';
import type { LedgerStatement, PayoutSummary, RequestWithdrawalBody, Wallet } from '@hudumika/contract';

export class ApiEarningsRepository implements EarningsRepository {
  async listPayouts(): Promise<PayoutSummary[]> {
    return api.get<PayoutSummary[]>('/payouts/me');
  }

  async getStatement(from?: string, to?: string): Promise<LedgerStatement> {
    const qs = [from ? `from=${encodeURIComponent(from)}` : '', to ? `to=${encodeURIComponent(to)}` : '']
      .filter(Boolean)
      .join('&');
    return api.get<LedgerStatement>(`/payouts/me/statement${qs ? `?${qs}` : ''}`);
  }

  async getWallet(): Promise<Wallet> {
    return api.get<Wallet>('/wallet/me');
  }

  async requestPayout(amountTZS: number): Promise<void> {
    const body: RequestWithdrawalBody = { amountTZS };
    // Payment mutation — idempotency key so retries never double-apply.
    await api.post<void>('/wallet/withdrawals', body, { idempotencyKey: idemKey('payout') });
  }
}
