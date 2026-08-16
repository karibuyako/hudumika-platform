/* Live API wallet repository — GET /wallet/me, /wallet/me/transactions,
 * POST /wallet/me/top-up, POST /finance/transactions/{id}/issue,
 * POST /wallet/withdrawals (requestWithdrawal), GET /wallet/withdrawals
 * (listWithdrawals). */
import { api } from '@/api/client';
import type { WalletPayoutDestination, WalletRepository, WalletWithdrawInput, WithdrawalRecord } from '../index';
import type { ReportTransactionIssueBody, RequestWithdrawalBody, TopUpMyWalletBody, Wallet, WalletTransaction, Withdrawal } from '@hudumika/contract';

export class ApiWalletRepository implements WalletRepository {
  async getWallet(): Promise<Wallet> {
    return api.get<Wallet>('/wallet/me');
  }

  async getTransactions(params?: { cursor?: string; limit?: number }): Promise<WalletTransaction[]> {
    const qs = new URLSearchParams(
      Object.entries(params ?? {}).filter(([, v]) => v !== undefined) as [string, string][],
    ).toString();
    return api.get<WalletTransaction[]>(`/wallet/me/transactions${qs ? `?${qs}` : ''}`);
  }

  async topUp(input: { amountTZS: number; method: TopUpMyWalletBody['method'] }, idempotencyKey: string): Promise<Wallet> {
    return api.post<Wallet>('/wallet/me/top-up', input as TopUpMyWalletBody, { idempotencyKey });
  }

  async reportIssue(transactionId: string, input: ReportTransactionIssueBody, idempotencyKey: string): Promise<void> {
    await api.post<void>(`/finance/transactions/${transactionId}/issue`, input, { idempotencyKey });
  }

  async withdraw(input: WalletWithdrawInput, idempotencyKey: string): Promise<WithdrawalRecord> {
    // destination/method are mock-only extensions until the contract ships
    // them on RequestWithdrawalBody (the generated body carries {amountTZS}
    // only): the extra fields ride the body and a backend that has not
    // shipped them ignores them — the contract-live parity path is unchanged.
    const body: RequestWithdrawalBody & { destination?: string; method?: string } = { amountTZS: input.amountTZS };
    if (input.destination !== undefined) body.destination = input.destination;
    if (input.method !== undefined) body.method = input.method;
    return api.post<Withdrawal>('/wallet/withdrawals', body, { idempotencyKey });
  }

  async listWithdrawals(): Promise<WithdrawalRecord[]> {
    return api.get<Withdrawal[]>('/wallet/withdrawals');
  }

  async getPayoutDestination(): Promise<WalletPayoutDestination | null> {
    // No contract endpoint exposes the linked payout account yet — the
    // screen degrades to omitting the destination note on a live backend.
    return null;
  }
}
