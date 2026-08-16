/* In-memory wallet repository — GET /wallet/me, /wallet/me/transactions,
 * POST /wallet/me/top-up, POST /finance/transactions/{id}/issue,
 * POST /wallet/withdrawals, GET /wallet/withdrawals.
 *
 * Top-up credits the wallet and appends a WalletTransaction. The contract's
 * WalletTransactionType has no `topup` value, so the row uses `adjustment`
 * with referenceType `topup` (contract-first: type values stay verbatim).
 *
 * Withdrawals (contract requestWithdrawal/listWithdrawals) debit the
 * withdrawable balance and append a signed `withdrawal` transaction
 * (WalletTransactionType.withdrawal IS a contract value). Requests are
 * idempotent per key: the same idempotency key replays the SAME withdrawal —
 * never a double debit.
 */
import { ApiError } from '@/api/client';
import { uid } from '@/lib/format';
import { clone, getState, nowIso } from './mockState';
import type { WalletPayoutDestination, WalletRepository, WalletWithdrawInput, WithdrawalRecord } from '../index';
import { TopUpMyWalletBodyMethod as TopUpMethods, WithdrawalStatus } from '@hudumika/contract';
import type {
  ReportTransactionIssueBody,
  TopUpMyWalletBodyMethod,
  Wallet,
  WalletTransaction,
} from '@hudumika/contract';

/** Reported transaction ids (module-level; the contract WalletTransaction has
 * no issue field — record the report here and treat re-reports as idempotent). */
const reportedIssueIds = new Set<string>();

/** Module-local withdrawal registry (mockState.ts stays untouched — same
 * pattern as the red-packet registry in mock/redPackets.ts). One seeded
 * completed withdrawal + every withdrawal this session created. */
let withdrawals: WithdrawalRecord[] = [];
let withdrawalsSeeded = false;

/** Per-idempotency-key replay ledger: same key → same withdrawal (the mock is
 * the server — a retried POST must never double-debit). */
const withdrawalByIdempotencyKey = new Map<string, WithdrawalRecord>();

/** The linked payout destination (mock-only until the contract ships the
 * endpoint): M-Pesa, the same vocabulary as the top-up methods. */
const PAYOUT_METHOD = TopUpMethods.mpesa;
const PAYOUT_MASKED_ACCOUNT = '2557**0000';

/** Mobile-money payout methods take a Tanzanian phone destination; the
 * contract's bank/card take an account reference. */
const MOBILE_MONEY_METHODS = new Set<string>(['mpesa', 'tigo_pesa', 'airtel_money', 'ezy_pesa', 'halotel']);

/** Light mirror of the login phone rule (PHONE_RE in src/app/(auth)/login.tsx):
 * a Tanzanian number as +255[67]XXXXXXXX or 0[67]XXXXXXXX. */
const TZ_PHONE_RE = /^(?:\+255|0)[67]\d{8}$/;

/** Server-side account masking for the withdrawal destination (the mock is
 * the server — a live payout system never echoes the full account, same rule
 * as PAYOUT_MASKED_ACCOUNT above): keeps the last 4 digits. */
export function maskAccountRef(destination: string): string {
  const digits = destination.replace(/\D/g, '');
  return digits.length >= 4 ? `****${digits.slice(-4)}` : '****';
}

/** Test hook: transaction ids with an open issue report. */
export function reportedIssueIdsForTests(): string[] {
  return [...reportedIssueIds];
}

/** Tests re-seed the module-local withdrawal registry between cases
 * (resetMockState() covers the shared wallet store; this clears the
 * withdrawals list + idempotency ledger). */
export function resetMockWithdrawalState(): void {
  withdrawals = [];
  withdrawalsSeeded = false;
  withdrawalByIdempotencyKey.clear();
}

/** Test hook — the module-local withdrawal registry. */
export function withdrawalsForTests(): WithdrawalRecord[] {
  ensureWithdrawalSeeds();
  return clone(withdrawals);
}

function ensureWithdrawalSeeds(): void {
  if (withdrawalsSeeded) return;
  withdrawalsSeeded = true;
  withdrawals = [
    {
      id: 'wdr_seed_001',
      amountTZS: 50000,
      feeTZS: 0,
      status: WithdrawalStatus.paid,
      method: PAYOUT_METHOD,
      estimatedArrivalDays: 1,
      createdAt: new Date(Date.now() - 3 * 86400_000).toISOString(),
      paidAt: new Date(Date.now() - 3 * 86400_000 + 3600_000).toISOString(),
      reason: null,
      // Mock-only extension (the generated Withdrawal model has no destination
      // field): the seed was paid to the linked payout account, masked.
      destination: '****0000',
    },
  ];
}

export class MockWalletRepository implements WalletRepository {
  async getWallet(): Promise<Wallet> {
    return clone(getState().wallet);
  }

  async getTransactions(params?: { cursor?: string; limit?: number }): Promise<WalletTransaction[]> {
    const state = getState();
    const offset = params?.cursor ? Number(params.cursor) : 0;
    const limit = params?.limit ?? 20;
    return clone(state.walletTransactions.slice(offset, offset + limit));
  }

  async topUp(input: { amountTZS: number; method: TopUpMyWalletBodyMethod }, _idempotencyKey: string): Promise<Wallet> {
    if (!Number.isInteger(input.amountTZS) || input.amountTZS < 1) {
      throw new ApiError(422, 'VALIDATION_FAILED', 'Top-up amount must be a positive whole number of TZS');
    }
    const state = getState();
    state.wallet.totalTZS += input.amountTZS;
    state.wallet.withdrawableTZS += input.amountTZS;
    state.walletTransactions.unshift({
      id: uid('wtx'),
      type: 'adjustment',
      amountTZS: input.amountTZS,
      balanceTZS: state.wallet.totalTZS,
      referenceType: 'topup',
      referenceId: `${input.method}_${Date.now().toString(36)}`,
      createdAt: nowIso(),
    });
    return clone(state.wallet);
  }

  async reportIssue(transactionId: string, input: ReportTransactionIssueBody, _idempotencyKey: string): Promise<void> {
    const state = getState();
    if (!state.walletTransactions.some((tx) => tx.id === transactionId)) {
      throw new ApiError(404, 'NOT_FOUND', `Transaction ${transactionId} not found`);
    }
    const description = input.description.trim();
    if (!description || description.length > 500) {
      throw new ApiError(422, 'VALIDATION_FAILED', 'Issue description must be between 1 and 500 characters');
    }
    reportedIssueIds.add(transactionId);
  }

  async withdraw(input: WalletWithdrawInput, idempotencyKey: string): Promise<WithdrawalRecord> {
    ensureWithdrawalSeeds();
    const replay = withdrawalByIdempotencyKey.get(idempotencyKey);
    if (replay) return clone(replay);
    if (!Number.isInteger(input.amountTZS) || input.amountTZS < 1) {
      throw new ApiError(422, 'VALIDATION_FAILED', 'Withdrawal amount must be a positive whole number of TZS');
    }
    // destination (mock-only extension — the contract body only carries
    // amountTZS): required only when provided; a mobile-money method must
    // reference a Tanzanian phone number, anything else just non-empty.
    if (input.destination !== undefined) {
      const destination = input.destination.trim();
      if (!destination) {
        throw new ApiError(422, 'VALIDATION_FAILED', 'Withdrawal destination must not be empty');
      }
      const method = input.method ?? PAYOUT_METHOD;
      if (MOBILE_MONEY_METHODS.has(method) && !TZ_PHONE_RE.test(destination)) {
        throw new ApiError(422, 'VALIDATION_FAILED', 'Withdrawal destination must be a Tanzanian mobile money number, e.g. +2557…');
      }
    }
    const state = getState();
    if (input.amountTZS > state.wallet.withdrawableTZS) {
      throw new ApiError(422, 'WALLET_INSUFFICIENT_BALANCE', 'Withdrawal amount exceeds your withdrawable balance');
    }
    const withdrawal: WithdrawalRecord = {
      id: uid('wdr'),
      amountTZS: input.amountTZS,
      feeTZS: 0,
      status: WithdrawalStatus.pending,
      method: input.method ?? PAYOUT_METHOD,
      estimatedArrivalDays: 1,
      createdAt: nowIso(),
      paidAt: null,
      reason: null,
      // Mock-only extension: the payout destination, masked server-side
      // (the generated Withdrawal model has no destination field).
      destination: input.destination !== undefined ? maskAccountRef(input.destination) : undefined,
    };
    state.wallet.withdrawableTZS -= input.amountTZS;
    state.wallet.totalTZS -= input.amountTZS;
    state.walletTransactions.unshift({
      id: uid('wtx'),
      type: 'withdrawal',
      amountTZS: -input.amountTZS,
      balanceTZS: state.wallet.totalTZS,
      referenceType: 'withdrawal',
      referenceId: withdrawal.id,
      createdAt: nowIso(),
    });
    withdrawals.unshift(withdrawal);
    withdrawalByIdempotencyKey.set(idempotencyKey, withdrawal);
    return clone(withdrawal);
  }

  async listWithdrawals(): Promise<WithdrawalRecord[]> {
    ensureWithdrawalSeeds();
    return clone(withdrawals);
  }

  async getPayoutDestination(): Promise<WalletPayoutDestination | null> {
    ensureWithdrawalSeeds();
    return { method: PAYOUT_METHOD, maskedAccount: PAYOUT_MASKED_ACCOUNT };
  }
}
