/* In-memory earnings repository. Mirrors GET /providers/me/payouts,
 * GET /providers/me/ledger/statement, GET /providers/me/wallet and
 * POST /providers/me/payouts against module state in mockState.ts.
 *
 * Statements return entries newest-first with balances recomputed as a running
 * sum from the opening balance (opening = closing - sum of filtered entries) so
 * the statement is internally consistent. requestPayout validates the amount
 * (422 INVALID_AMOUNT / 422 INSUFFICIENT_BALANCE), creates a pending Mobile
 * Money payout, debits the wallet and posts a negative payout ledger entry.
 */
import { ApiError } from '@/api/client';
import { getState, clone, nowIso, requireCapability } from './mockState';
import { uid } from '@/lib/format';
import type { EarningsRepository } from '../index';
import type { LedgerEntry, LedgerStatement, PayoutSummary, Wallet } from '@hudumika/contract';

const LAST_30_DAYS = 30 * 24 * 3600_000;

export class MockEarningsRepository implements EarningsRepository {
  async listPayouts(): Promise<PayoutSummary[]> {
    const payouts = getState().payouts;
    return clone([...payouts].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)));
  }

  async getStatement(from?: string, to?: string): Promise<LedgerStatement> {
    const state = getState();
    const fromMs = from ? Date.parse(from) : -Infinity;
    const toMs = to ? Date.parse(to) : Infinity;
    const filtered = state.ledger.filter((e) => {
      const t = Date.parse(e.createdAt);
      return t >= fromMs && t <= toMs;
    });
    const closingEntry = [...state.ledger].reverse().find((e) => Date.parse(e.createdAt) <= toMs);
    const closing = closingEntry?.balanceTZS ?? 0;
    const sum = filtered.reduce((s, e) => s + e.amountTZS, 0);
    const opening = closing - sum;
    const newestFirst = [...filtered].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    let running = opening;
    const entries: LedgerEntry[] = newestFirst.map((e) => {
      running += e.amountTZS;
      return { ...e, balanceTZS: running };
    });
    return {
      from: from ?? new Date(Date.now() - LAST_30_DAYS).toISOString(),
      to: to ?? nowIso(),
      openingBalanceTZS: opening,
      closingBalanceTZS: closing,
      entries: clone(entries),
    };
  }

  async getWallet(): Promise<Wallet> {
    return clone(getState().wallet);
  }

  async requestPayout(amountTZS: number): Promise<void> {
    requireCapability('request_payout');
    const state = getState();
    if (!Number.isInteger(amountTZS) || amountTZS <= 0) {
      throw new ApiError(422, 'INVALID_AMOUNT', 'Amount must be a positive integer');
    }
    if (amountTZS > (state.wallet.withdrawableTZS ?? 0)) {
      throw new ApiError(422, 'INSUFFICIENT_BALANCE', 'Amount exceeds the withdrawable balance');
    }
    const payout: PayoutSummary = {
      id: uid('po'),
      amountTZS,
      status: 'pending',
      method: 'Mobile Money',
      createdAt: nowIso(),
      paidAt: null,
    };
    state.payouts.push(payout);
    state.wallet.withdrawableTZS -= amountTZS;
    state.wallet.totalTZS -= amountTZS;
    const balance = state.ledger.length > 0 ? state.ledger[state.ledger.length - 1].balanceTZS : 0;
    state.ledger.push({
      id: uid('led'),
      type: 'payout',
      amountTZS: -amountTZS,
      balanceTZS: balance - amountTZS,
      referenceType: 'payout',
      referenceId: payout.id,
      createdAt: nowIso(),
    });
  }
}
