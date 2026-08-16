import { create } from 'zustand';

import { api, ApiError, getToken } from '@/api/client';
import type {
  ApiErrorBody,
  BankCard,
  BankCardInput,
  DisputeHold,
  ExpenseRecord,
  ExpenseRecordInput,
  FinanceInvoice,
  FinanceInvoiceInput,
  Invoice,
  InvoiceDownload,
  IssueTransactionBody,
  LedgerEntry,
  PaymentHistoryItem,
  PayoutSummary,
  ReconciliationSummary,
  Settlement,
  TransactionIssueTicket,
  Wallet,
  Withdrawal,
} from '@/api/types';
import type { Transaction, TransactionType } from '@/types';

/** PUT — api has no put() and client.ts is frozen; mirrors the local fetch
 *  helper used in store/notifications-settings.ts / store/loyalty.ts. */
async function put<T>(path: string): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${getToken() ?? ''}` },
  });
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    /* non-JSON */
  }
  if (!res.ok) {
    const err = (data as ApiErrorBody | null)?.error;
    throw new ApiError(res.status, err?.code ?? 'HTTP_ERROR', err?.message ?? `Request failed (${res.status})`);
  }
  return data as T;
}

interface FinanceState {
  balance: number;
  pendingSettlement: number;
  transactions: Transaction[];
  settlements: Settlement[];
  invoices: Invoice[];
  wallet: Wallet | null;
  withdrawals: Withdrawal[];
  /* P5: finance ops (contract /payouts/me, /finance/*) */
  payouts: PayoutSummary[];
  bankCards: BankCard[];
  expenses: ExpenseRecord[];
  financeInvoices: FinanceInvoice[];
  loaded: boolean;
  /* Earnings pass (gap-09): every finance hydrate surfaces loading/error so
   * the screen can render skeleton → error + retry (EARNINGS.md screen states). */
  loading: boolean;
  error: boolean;
  /* Earnings pass (gap-09): payments history, reconciliation, dispute holds. */
  payments: PaymentHistoryItem[];
  reconciliation: ReconciliationSummary | null;
  disputeHolds: DisputeHold[];
  hydrate: () => Promise<void>;
  retry: () => Promise<void>;
  hydrateWithdrawals: () => Promise<void>;
  hydratePayouts: () => Promise<void>;
  hydrateBankCards: () => Promise<void>;
  hydrateExpenses: () => Promise<void>;
  hydrateInvoices: () => Promise<void>;
  hydratePayments: () => Promise<void>;
  hydrateReconciliation: () => Promise<void>;
  hydrateDisputeHolds: () => Promise<void>;
  record: (type: TransactionType, amount: number, title: string, status?: Transaction['status']) => void;
  requestWithdrawal: (amountTZS: number) => Promise<{ ok: boolean; code?: string; message?: string }>;
  runSettlement: () => Promise<boolean>;
  payout: (id: string) => Promise<boolean>;
  issueInvoice: (id: string) => Promise<boolean>;
  addBankCard: (input: BankCardInput) => Promise<{ ok: boolean; code?: string; message?: string }>;
  setDefaultBankCard: (id: string) => Promise<boolean>;
  removeBankCard: (id: string) => Promise<boolean>;
  addExpense: (input: ExpenseRecordInput) => Promise<{ ok: boolean; code?: string; message?: string }>;
  removeExpense: (id: string) => Promise<boolean>;
  createInvoice: (input: FinanceInvoiceInput) => Promise<{ ok: boolean; code?: string; message?: string }>;
  downloadInvoice: (id: string) => Promise<{ ok: boolean; download?: InvoiceDownload; code?: string; message?: string }>;
  issueTransaction: (id: string, body: IssueTransactionBody) => Promise<{ ok: boolean; ticket?: TransactionIssueTicket; code?: string; message?: string }>;
  reversePayment: (id: string, reason: string) => Promise<{ ok: boolean; code?: string; message?: string }>;
}

const toTransaction = (e: LedgerEntry): Transaction => ({
  id: e.id,
  type: (e.type === 'settlement' ? 'order' : e.type === 'tax' ? 'commission' : e.type) as TransactionType,
  amount: e.amount,
  title: e.title,
  ts: e.ts,
  status: e.status as Transaction['status'],
});

export const useFinanceStore = create<FinanceState>()((set, get) => ({
  balance: 0,
  pendingSettlement: 0,
  transactions: [],
  settlements: [],
  invoices: [],
  wallet: null,
  withdrawals: [],
  payouts: [],
  bankCards: [],
  expenses: [],
  financeInvoices: [],
  loaded: false,
  loading: false,
  error: false,
  payments: [],
  reconciliation: null,
  disputeHolds: [],

  hydrate: async () => {
    set({ loading: true, error: false });
    try {
      const [ledger, settlementRes, invoiceRes] = await Promise.all([
        api.get<{ entries: LedgerEntry[]; balance: number }>('/payouts/me/statement?size=100', { retries: 1 }),
        api.get<{ settlements: Settlement[] }>('/finance/settlements/daily', { retries: 1 }),
        api.get<{ invoices: Invoice[] }>('/invoices', { retries: 1 }),
      ]);
      const pending = settlementRes.settlements.filter((s) => s.payoutStatus === 'pending').reduce((sum, s) => sum + s.net, 0);
      set({
        balance: ledger.balance,
        pendingSettlement: Math.round(pending * 100) / 100,
        transactions: ledger.entries.map(toTransaction),
        settlements: settlementRes.settlements,
        invoices: invoiceRes.invoices,
        loaded: true,
        loading: false,
      });
      await get().hydrateWithdrawals();
    } catch {
      set({ loading: false, error: true });
    }
  },

  /** Earnings pass (gap-09): re-run every finance surface after an error. */
  retry: async () => {
    set({ error: false, loading: true });
    await Promise.all([
      get().hydrate().catch(() => undefined),
      get().hydratePayouts().catch(() => undefined),
      get().hydrateBankCards().catch(() => undefined),
      get().hydrateExpenses().catch(() => undefined),
      get().hydrateInvoices().catch(() => undefined),
      get().hydratePayments().catch(() => undefined),
      get().hydrateReconciliation().catch(() => undefined),
      get().hydrateDisputeHolds().catch(() => undefined),
    ]);
    set({ loading: false });
  },

  hydrateWithdrawals: async () => {
    set({ loading: true, error: false });
    try {
      const [wallet, withdrawals] = await Promise.all([
        api.get<Wallet>('/wallet', { retries: 1 }),
        api.get<Withdrawal[]>('/wallet/withdrawals', { retries: 1 }),
      ]);
      set({ wallet, withdrawals, loading: false });
    } catch {
      set({ loading: false, error: true });
    }
  },

  /* ---- P5: finance ops (contract /payouts/me, /finance/*) ---- */

  hydratePayouts: async () => {
    set({ loading: true, error: false });
    try {
      const payouts = await api.get<PayoutSummary[]>('/payouts/me', { retries: 1 });
      set({ payouts, loading: false });
    } catch {
      set({ loading: false, error: true });
    }
  },

  hydrateBankCards: async () => {
    set({ loading: true, error: false });
    try {
      const bankCards = await api.get<BankCard[]>('/finance/bank-cards', { retries: 1 });
      set({ bankCards, loading: false });
    } catch {
      set({ loading: false, error: true });
    }
  },

  hydrateExpenses: async () => {
    set({ loading: true, error: false });
    try {
      const expenses = await api.get<ExpenseRecord[]>('/finance/expenses', { retries: 1 });
      set({ expenses, loading: false });
    } catch {
      set({ loading: false, error: true });
    }
  },

  hydrateInvoices: async () => {
    set({ loading: true, error: false });
    try {
      const financeInvoices = await api.get<FinanceInvoice[]>('/finance/invoices', { retries: 1 });
      set({ financeInvoices, loading: false });
    } catch {
      set({ loading: false, error: true });
    }
  },

  /* ---- Earnings pass (gap-09): payments history / reconciliation / holds ---- */

  hydratePayments: async () => {
    set({ loading: true, error: false });
    try {
      const payments = await api.get<PaymentHistoryItem[]>('/payments/history?limit=50', { retries: 1 });
      set({ payments, loading: false });
    } catch {
      set({ loading: false, error: true });
    }
  },

  hydrateReconciliation: async () => {
    set({ loading: true, error: false });
    try {
      const reconciliation = await api.get<ReconciliationSummary>('/finance/reconciliation?days=14', { retries: 1 });
      set({ reconciliation, loading: false });
    } catch {
      set({ loading: false, error: true });
    }
  },

  hydrateDisputeHolds: async () => {
    set({ loading: true, error: false });
    try {
      const res = await api.get<{ holds: DisputeHold[]; totalTZS: number }>('/finance/dispute-holds', { retries: 1 });
      set({ disputeHolds: res.holds, loading: false });
    } catch {
      set({ loading: false, error: true });
    }
  },

  addBankCard: async (input) => {
    try {
      const card = await api.post<BankCard>('/finance/bank-cards', input, { idempotencyKey: `bc:${Date.now()}` });
      set({ bankCards: [...get().bankCards.filter((c) => c.id !== card.id), card].sort((a, b) => b.createdAt - a.createdAt) });
      return { ok: true };
    } catch (e) {
      const err = e as { code?: string; message?: string };
      return { ok: false, code: err.code, message: err.message };
    }
  },

  setDefaultBankCard: async (id) => {
    try {
      await put<never>(`/finance/bank-cards/${id}/default`);
      set({ bankCards: get().bankCards.map((c) => ({ ...c, isDefault: c.id === id })) });
      return true;
    } catch {
      return false;
    }
  },

  removeBankCard: async (id) => {
    try {
      await api.delete<never>(`/finance/bank-cards/${id}`);
      set({ bankCards: get().bankCards.filter((c) => c.id !== id) });
      return true;
    } catch {
      return false;
    }
  },

  addExpense: async (input) => {
    try {
      const expense = await api.post<ExpenseRecord>('/finance/expenses', input, { idempotencyKey: `exp:${Date.now()}` });
      set({ expenses: [expense, ...get().expenses] });
      return { ok: true };
    } catch (e) {
      const err = e as { code?: string; message?: string };
      return { ok: false, code: err.code, message: err.message };
    }
  },

  removeExpense: async (id) => {
    try {
      await api.delete<never>(`/finance/expenses/${id}`);
      set({ expenses: get().expenses.filter((e) => e.id !== id) });
      return true;
    } catch {
      return false;
    }
  },

  createInvoice: async (input) => {
    try {
      const invoice = await api.post<FinanceInvoice>('/finance/invoices', input, { idempotencyKey: `finv:${Date.now()}` });
      set({ financeInvoices: [invoice, ...get().financeInvoices] });
      return { ok: true };
    } catch (e) {
      const err = e as { code?: string; message?: string };
      return { ok: false, code: err.code, message: err.message };
    }
  },

  downloadInvoice: async (id) => {
    try {
      const download = await api.get<InvoiceDownload>(`/finance/invoices/${id}/download`, { retries: 1 });
      return { ok: true, download };
    } catch (e) {
      const err = e as { code?: string; message?: string };
      return { ok: false, code: err.code, message: err.message };
    }
  },

  issueTransaction: async (id, body) => {
    try {
      const ticket = await api.post<TransactionIssueTicket>(`/finance/transactions/${id}/issue`, body, { idempotencyKey: `ti:${id}:${Date.now()}` });
      return { ok: true, ticket };
    } catch (e) {
      const err = e as { code?: string; message?: string };
      return { ok: false, code: err.code, message: err.message };
    }
  },

  reversePayment: async (id, reason) => {
    try {
      await api.post(`/payments/${id}/reverse`, { reason }, { idempotencyKey: `rv:${id}:${Date.now()}` });
      await get().hydratePayments();
      return { ok: true };
    } catch (e) {
      const err = e as { code?: string; message?: string };
      return { ok: false, code: err.code, message: err.message };
    }
  },

  record: () => {
    /* Finance is server-authoritative; local recording is a no-op. */
  },

  requestWithdrawal: async (amountTZS) => {
    try {
      await api.post('/wallet/withdrawals', { amountTZS }, { idempotencyKey: `wd:${Date.now()}` });
      await get().hydrateWithdrawals();
      return { ok: true };
    } catch (e) {
      const err = e as { code?: string; message?: string };
      return { ok: false, code: err.code, message: err.message };
    }
  },

  runSettlement: async () => {
    try {
      await api.post('/finance/settlements/run', { periodStart: new Date().setHours(0, 0, 0, 0) }, { idempotencyKey: `set:${Date.now()}` });
      await get().hydrate();
      return true;
    } catch {
      return false;
    }
  },

  payout: async (id) => {
    try {
      await api.post(`/finance/settlements/${id}/payout`, {}, { idempotencyKey: `pay:${id}:${Date.now()}` });
      await get().hydrate();
      return true;
    } catch {
      return false;
    }
  },

  issueInvoice: async (id) => {
    try {
      await api.post(`/finance/invoices/${id}/issue`, {}, { idempotencyKey: `inv:${id}:${Date.now()}` });
      await get().hydrate();
      return true;
    } catch {
      return false;
    }
  },
}));
