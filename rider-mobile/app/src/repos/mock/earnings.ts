/* In-memory earnings repository. Mirrors GET /payouts/me/statement,
 * GET /wallet/me, GET /payouts/me, POST /wallet/withdrawals.
 *
 * getTodaySummary() derives earnings/deliveries from the ledger + delivered
 * orders; requestPayout() validates against the available balance (422
 * INSUFFICIENT_BALANCE beyond it) and writes a payout ledger entry.
 */
import { ApiError } from '@/api/client';
import { getState, clone, nowIso } from './mockState';
import { uid } from '@/lib/format';
import type { EarningsRepository, PayoutSummary } from '../index';
import type { LedgerEntry } from '@hudumika/contract';

export class MockEarningsRepository implements EarningsRepository {
  async getTodaySummary(): Promise<{ earningsTZS: number; deliveries: number; onlineMinutes: number }> {
    const state = getState();
    const today = new Date().toISOString().slice(0, 10);
    let earningsTZS = 0;
    let deliveries = 0;
    for (const entry of state.ledger) {
      if (entry.createdAt.slice(0, 10) === today && entry.amountTZS > 0) earningsTZS += entry.amountTZS;
      if ((entry.type === 'order_earning' || entry.type === 'delivery_fee') && entry.createdAt.slice(0, 10) === today) deliveries += 1;
    }
    return { earningsTZS, deliveries, onlineMinutes: 0 };
  }

  async getStatement(from?: string, to?: string): Promise<LedgerEntry[]> {
    const state = getState();
    const entries = state.ledger.filter((entry) => {
      const at = entry.createdAt.slice(0, 10);
      if (from && at < from) return false;
      if (to && at > to) return false;
      return true;
    });
    return clone(entries.slice().sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)));
  }

  async getWallet(): Promise<{ balanceTZS: number; availableTZS: number }> {
    const state = getState();
    return { balanceTZS: state.balanceTZS, availableTZS: state.availableTZS };
  }

  async listPayouts(): Promise<PayoutSummary['payouts']> {
    return clone(getState().payouts);
  }

  async requestPayout(amountTZS: number): Promise<void> {
    const state = getState();
    if (!Number.isInteger(amountTZS) || amountTZS <= 0) {
      throw new ApiError(422, 'INVALID_AMOUNT', 'Payout amount must be a positive integer');
    }
    if (amountTZS > state.availableTZS) {
      throw new ApiError(422, 'INSUFFICIENT_BALANCE', `Available balance is ${state.availableTZS} TZS`);
    }
    const id = uid('po');
    state.payouts.unshift({
      id,
      status: 'processing',
      amountTZS,
      method: 'Mobile Money',
      createdAt: nowIso(),
    });
    state.availableTZS -= amountTZS;
    state.balanceTZS -= amountTZS;
    state.ledgerBalance -= amountTZS;
    state.ledger.push({
      id: uid('led'),
      type: 'payout',
      amountTZS: -amountTZS,
      balanceTZS: state.ledgerBalance,
      referenceType: 'payout',
      referenceId: id,
      createdAt: nowIso(),
    });
  }
}