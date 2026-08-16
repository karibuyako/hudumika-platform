/* Live API earnings repository. Thin typed wrapper over the hardened client.
 *
 * Paths (API-CONTRACT.yaml):
 *   GET  /payouts/me/statement?from&to → LedgerStatement
 *   GET  /wallet/me                    → Wallet ({withdrawableTZS,pendingTZS,totalTZS})
 *   GET  /payouts/me                   → PayoutSummary[]
 *   POST /wallet/withdrawals           {amountTZS}
 *
 * getTodaySummary() is a client-side derivation from today's statement.
 */
import { api } from '@/api/client';
import type { EarningsRepository, PayoutSummary } from '../index';
import type { LedgerEntry, LedgerStatement, PayoutSummary as ContractPayoutSummary, Wallet } from '@hudumika/contract';

export class ApiEarningsRepository implements EarningsRepository {
  async getTodaySummary(): Promise<{ earningsTZS: number; deliveries: number; onlineMinutes: number }> {
    const today = new Date().toISOString().slice(0, 10);
    const statement = await api.get<LedgerStatement>(`/payouts/me/statement?from=${today}&to=${today}`);
    let earningsTZS = 0;
    let deliveries = 0;
    for (const entry of statement.entries) {
      if (entry.amountTZS > 0) earningsTZS += entry.amountTZS;
      if (entry.type === 'order_earning' || entry.type === 'delivery_fee') deliveries += 1;
    }
    return { earningsTZS, deliveries, onlineMinutes: 0 };
  }

  async getStatement(from?: string, to?: string): Promise<LedgerEntry[]> {
    const qs = [from ? `from=${encodeURIComponent(from)}` : '', to ? `to=${encodeURIComponent(to)}` : ''].filter(Boolean).join('&');
    const statement = await api.get<LedgerStatement>(`/payouts/me/statement${qs ? `?${qs}` : ''}`);
    return statement.entries;
  }

  async getWallet(): Promise<{ balanceTZS: number; availableTZS: number }> {
    const wallet = await api.get<Wallet>('/wallet/me');
    return { balanceTZS: wallet.totalTZS, availableTZS: wallet.withdrawableTZS };
  }

  async listPayouts(): Promise<PayoutSummary['payouts']> {
    const payouts = await api.get<ContractPayoutSummary[]>('/payouts/me');
    return payouts.map((p) => ({
      id: p.id,
      status: p.status,
      amountTZS: p.amountTZS,
      method: p.method ?? 'Mobile Money',
      createdAt: p.createdAt,
    }));
  }

  async requestPayout(amountTZS: number): Promise<void> {
    await api.post<void>('/wallet/withdrawals', { amountTZS });
  }
}