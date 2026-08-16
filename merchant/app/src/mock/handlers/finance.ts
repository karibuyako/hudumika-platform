
import { http } from 'msw';

import type {
  BankCard,
  DisputeHold,
  ExpenseCategory,
  ExpenseRecord,
  FinanceExtEvent,
  FinanceInvoice,
  Invoice,
  LedgerEntry,
  NotificationDto,
  OrderDto,
  PaymentHistoryItem,
  PaymentHistoryStatus,
  PaymentQr,
  PaymentQrProvider,
  PayoutSummary,
  Payment,
  ReconciliationDay,
  Settlement,
  ServerEvent,
  TransactionIssueTicket,
  TransactionIssueType,
  Wallet,
  WalletTransaction,
  Withdrawal,
} from '@/api/types';
import { db, uid } from '@/mock/db';
import { emit } from '@/mock/events';
import { audit, json, ok, rateLimit, requirePerm, requireSession } from '@/mock/security';
import { ApiHttpError, h, readJson } from '@/mock/handlers/common';
import { COMMISSION_RATE } from '@/data/seed';

const TAX_RATE = 0.06;

/** Withdrawal minimum — server-enforced, env/config-driven in prod
 * (EARNINGS.md); the mock carries a default so the contract codes
 * WITHDRAWAL_BELOW_MINIMUM are exercisable. */
const MIN_WITHDRAWAL_TZS = 1000;

/** Withdrawal rows are scoped to the merchant server-side; the response strips it. */
type WithdrawalRow = Withdrawal & { merchantId: string };

/** Raw JSON body — the shared `ok()` spreads objects, so array responses go through here. */
const raw = (body: unknown, status = 200) => Response.json(body, { status });

/** Merchant balance (integer TZS): total = ledger balance, pending = unsettled net.
 * Commercial cadence (commissionRateBps / payoutCycleDays) is computed
 * server-side from the seeded rate — the client renders, never recomputes
 * (EARNINGS.md — MerchantPrivate.commercial). */
function walletOf(merchantId: string): Wallet {
  const balance = db.table<LedgerEntry>('ledger').where((e) => e.merchantId === merchantId).sort((a, b) => b.ts - a.ts)[0]?.balance ?? 0;
  const pending = db.table<Settlement>('settlements').where((s) => s.merchantId === merchantId && s.payoutStatus === 'pending').reduce((sum, s) => sum + s.net, 0);
  const totalTZS = Math.round(balance);
  const pendingTZS = Math.round(pending);
  return {
    withdrawableTZS: totalTZS - pendingTZS,
    pendingTZS,
    totalTZS,
    commissionRateBps: Math.round(COMMISSION_RATE * 10000),
    payoutCycleDays: 3,
  };
}

const TX_TYPE: Record<string, WalletTransaction['type']> = {
  order: 'settlement',
  withdraw: 'withdrawal',
  refund: 'refund',
  commission: 'adjustment',
  tax: 'adjustment',
};

/** Contract GET /payments/history status mapping (app Payment → history enum). */
const HISTORY_STATUS: Record<Payment['status'], PaymentHistoryStatus> = {
  pending: 'pending',
  captured: 'paid',
  refunded: 'refunded',
  failed: 'failed',
  reversed: 'reversed',
};

function walletTransactions(merchantId: string): WalletTransaction[] {
  return db
    .table<LedgerEntry>('ledger')
    .where((e) => e.merchantId === merchantId)
    .map((e) => ({
      id: e.id,
      type: TX_TYPE[e.type] ?? 'adjustment',
      amountTZS: Math.round(e.amount),
      balanceTZS: Math.round(e.balance ?? 0),
      referenceType: e.refType,
      referenceId: e.refId,
      createdAt: e.ts,
    }))
    .sort((a, b) => b.createdAt - a.createdAt);
}

/* ================= P5: finance ops helpers (contract /payouts/me, /finance/*) ================= */

type BankCardRow = BankCard & { merchantId: string };
type ExpenseRow = ExpenseRecord & { merchantId: string };
type FinanceInvoiceRow = FinanceInvoice & { merchantId: string };

/** PUT/DELETE wrappers — same error filter as the shared `h` helpers in common.ts. */
const BASE_URL = typeof location !== 'undefined' ? location.origin : 'http://localhost';

function method(m: 'PUT' | 'DELETE') {
  return (
    path: string,
    fn: (args: { request: Request; params: Record<string, string> }) => Promise<Response> | Response,
  ) =>
    http[m === 'PUT' ? 'put' : 'delete'](`${BASE_URL}${path}`, async (info) => {
      try {
        return await fn({ request: info.request, params: (info.params ?? {}) as Record<string, string> });
      } catch (e) {
        if (e instanceof ApiHttpError) {
          return json(e.status, { error: { code: e.code, message: e.message, retriable: e.retriable, details: e.details } });
        }
        throw e;
      }
    });
}
const put = method('PUT');
const del = method('DELETE');

/** P5 events live on the FinanceExtEvent union; ServerEvent is shared with
 * parallel agents, so emit through a cast (house pattern, cf. staff-ops). */
const emitExt = (event: FinanceExtEvent) => emit(event as unknown as ServerEvent);

const EXPENSE_CATEGORIES: readonly ExpenseCategory[] = [
  'ingredients', 'delivery', 'packaging', 'platform_fees', 'rent',
  'utilities', 'staff', 'marketing', 'equipment', 'other',
];
const BANK_CARD_LIMIT = 5;

function bankCardRows(merchantId: string): BankCardRow[] {
  return db.table<BankCardRow>('bankCards').where((c) => c.merchantId === merchantId).sort((a, b) => b.createdAt - a.createdAt);
}
const stripCard = ({ merchantId: _m, ...card }: BankCardRow): BankCard => card;

function expenseRows(merchantId: string): ExpenseRow[] {
  return db.table<ExpenseRow>('expenses').where((e) => e.merchantId === merchantId).sort((a, b) => b.incurredAt - a.incurredAt);
}
const stripExpense = ({ merchantId: _m, ...e }: ExpenseRow): ExpenseRecord => e;

function financeInvoiceRows(merchantId: string): FinanceInvoiceRow[] {
  return db.table<FinanceInvoiceRow>('financeInvoices').where((i) => i.merchantId === merchantId).sort((a, b) => b.createdAt - a.createdAt);
}
const stripInvoice = ({ merchantId: _m, ...i }: FinanceInvoiceRow): FinanceInvoice => i;

/* Earnings pass (gap-09) — QR provider registry + TTL (module scope). */
const QR_PROVIDERS: readonly PaymentQrProvider[] = ['mpesa', 'tigo_pesa', 'airtel_money'];
const QR_TTL_MS = 10 * 60 * 1000;

export const financeHandlers = [
  /* ---- Ledger (paginated) ---- */
  h.get('/api/ledger', ({ request }) => {
    const session = requireSession(request);
    requirePerm(session, 'finance:view');
    const url = new URL(request.url);
    const type = url.searchParams.get('type');
    const from = Number(url.searchParams.get('from') ?? 0);
    const to = Number(url.searchParams.get('to') ?? Date.now());
    const page = Number(url.searchParams.get('page') ?? 1);
    const size = Math.min(100, Number(url.searchParams.get('size') ?? 30));
    let rows = db.table<LedgerEntry>('ledger').where((e) => e.merchantId === session.merchantId && e.ts >= from && e.ts <= to);
    if (type) rows = rows.filter((e) => e.type === type);
    rows = [...rows].sort((a, b) => b.ts - a.ts);
    const total = rows.length;
    const start = (page - 1) * size;
    const balance = rows[0]?.balance ?? 0;
    return ok({ entries: rows.slice(start, start + size), total, page, size, balance });
  }),

  /* ---- Run daily settlement batch (server-side job, merchant-triggerable in demo) ---- */
  h.post('/api/settlements/run', async ({ request }) => {
    const session = requireSession(request);
    requirePerm(session, 'finance:view');
    const body = await readJson(request);
    const m = session.merchantId;
    const dayStart = Number(body.periodStart ?? new Date().setHours(0, 0, 0, 0));
    const dayEnd = dayStart + 86400000;

    const orders = db.table('orders').where(
      (o) => o.merchantId === m && o.status === 'completed' && o.completedAt >= dayStart && o.completedAt < dayEnd && o.settledAt,
    );
    if (!orders.length) throw new ApiHttpError(409, 'NOTHING_TO_SETTLE', 'No completed orders in this period');

    const gross = Math.round(orders.reduce((s, o) => s + o.total, 0) * 100) / 100;
    const commission = Math.round(gross * COMMISSION_RATE * 100) / 100;
    const tax = Math.round(gross * TAX_RATE * 100) / 100;
    const net = Math.round((gross - commission - tax) * 100) / 100;
    const existing = db.table<Settlement>('settlements').where((s) => s.merchantId === m && s.periodStart === dayStart);
    if (existing.length) throw new ApiHttpError(409, 'ALREADY_SETTLED', 'This period is already settled');

    const settlement: Settlement = {
      id: uid('set'),
      merchantId: m,
      batchNo: `S${new Date(dayStart).toISOString().slice(0, 10).replace(/-/g, '')}`,
      periodStart: dayStart,
      periodEnd: dayEnd,
      gross,
      commission,
      tax,
      net,
      payoutStatus: 'pending',
      orderCount: orders.length,
      createdAt: Date.now(),
    };
    db.table<Settlement>('settlements').insert(settlement);

    const invoice: Invoice = {
      id: uid('inv'),
      merchantId: m,
      settlementId: settlement.id,
      no: `EV${new Date(dayStart).toISOString().slice(0, 10).replace(/-/g, '')}${String(Math.floor(Math.random() * 900) + 100)}`,
      amount: gross,
      taxRate: TAX_RATE,
      taxAmount: tax,
      status: 'draft',
      createdAt: Date.now(),
    };
    db.table<Invoice>('invoices').insert(invoice);

    db.table<LedgerEntry>('ledger').insert({
      id: uid('l'),
      merchantId: m,
      type: 'settlement',
      amount: net,
      title: `Settlement ${settlement.batchNo} · ${orders.length} orders`,
      ts: Date.now(),
      status: 'pending',
      refType: 'settlement',
      refId: settlement.id,
    });

    const note: NotificationDto = {
      id: uid('n'),
      merchantId: m,
      type: 'system',
      category: 'important',
      title: `Settlement ${settlement.batchNo} ready`,
      body: `Net ${net.toFixed(2)} after commission & VAT. Invoice draft created.`,
      ts: Date.now(),
      read: false,
    };
    db.table<NotificationDto>('notifications').insert(note);
    emit({ type: 'notification.created', notification: note, at: Date.now() });
    emit({ type: 'settlement.created', settlement, at: Date.now() });
    audit(m, session.staffId, session.role, 'finance:settlement', 'settlement', settlement.id, `ran settlement ${settlement.batchNo} net ${net.toFixed(2)}`);
    return ok({ settlement, invoice });
  }),

  /* ---- Payout settlement (mock bank transfer) ---- */
  h.post('/api/settlements/:id/payout', async ({ request, params }) => {
    const session = requireSession(request);
    requirePerm(session, 'finance:view');
    rateLimit(`payout:${session.merchantId}`, 3, 600 * 1000);
    const s = db.table<Settlement>('settlements').find(String(params.id));
    if (!s || s.merchantId !== session.merchantId) throw new ApiHttpError(404, 'NOT_FOUND', 'Settlement not found');
    if (s.payoutStatus === 'paid') throw new ApiHttpError(409, 'SETTLEMENT_ALREADY_PAID', 'This settlement is already paid out');
    const paidAt = Date.now();
    const updated = db.table<Settlement>('settlements').update(s.id, { payoutStatus: 'paid', paidAt })!;
    db.table<LedgerEntry>('ledger').insert({
      id: uid('l'),
      merchantId: session.merchantId,
      type: 'withdraw',
      amount: -s.net,
      title: `Payout ${s.batchNo} → bank`,
      ts: Date.now(),
      status: 'completed',
      refType: 'settlement',
      refId: s.id,
    });
    const payout: PayoutSummary = { id: s.id, amountTZS: Math.round(s.net), status: 'paid', method: 'bank', createdAt: s.createdAt, paidAt };
    emitExt({ type: 'settlement.paid', settlement: updated, at: paidAt });
    emitExt({ type: 'payout.paid', payout, at: paidAt });
    audit(session.merchantId, session.staffId, session.role, 'finance:payout', 'settlement', s.id, `payout ${s.batchNo} ${s.net.toFixed(2)}`);
    return ok({ payout: 'paid', settlement: updated });
  }),

  /* ---- Revenue composition (channels + payment methods) ----
   * Contract channel enum (EARNINGS.md /analytics/revenue): delivery / dine_in
   * / group_buy / pickup. Channels are served as enum keys only — labels are
   * i18n keys on the client (LOCALIZATION.md: user-facing labels never ship
   * hardcoded English from the server). */
  h.get('/api/finance/revenue-composition', ({ request }) => {
    const session = requireSession(request);
    requirePerm(session, 'finance:view');
    const url = new URL(request.url);
    const days = Math.min(90, Math.max(1, Number(url.searchParams.get('days') ?? 7)));
    const cutoff = Date.now() - days * 86400000;
    const m = session.merchantId;

    const completed = db.table<OrderDto>('orders').where(
      (o) => o.merchantId === m && o.status === 'completed' && (o.completedAt ?? 0) >= cutoff,
    );
    const byChannel = new Map<string, { amount: number; orders: number }>();
    const add = (key: string, amount: number, orders: number) => {
      const agg = byChannel.get(key) ?? { amount: 0, orders: 0 };
      agg.amount += amount;
      agg.orders += orders;
      byChannel.set(key, agg);
    };
    for (const o of completed) add(o.scheduledAt ? 'preorder' : o.deliveryType, o.total, 1);
    const dineIn = db.table<{ id: string; merchantId: string; status: string; totals: { totalTZS: number }; paidAt?: number | null }>('dineInOrders').where(
      (b) => b.merchantId === m && b.status === 'paid' && (b.paidAt ?? 0) >= cutoff,
    );
    for (const b of dineIn) add('dine_in', b.totals.totalTZS, 1);
    const redeemedVouchers = db.table<{ id: string; redeemedByMerchantId?: string | null; redeemedAt?: number | null; priceTZS: number; status: string }>('vouchers').where(
      (v) => v.status === 'redeemed' && v.redeemedByMerchantId === m && (v.redeemedAt ?? 0) >= cutoff,
    );
    for (const v of redeemedVouchers) add('group_buy', v.priceTZS, 1);
    const total = [...byChannel.values()].reduce((s, a) => s + a.amount, 0);
    const channels = [...byChannel.entries()].map(([key, agg]) => ({
      key,
      label: key,
      amount: Math.round(agg.amount * 100) / 100,
      orders: agg.orders,
      share: total ? Math.round((agg.amount / total) * 1000) / 10 : 0,
    }));

    const payments = db.table<Payment>('payments').where(
      (p) => p.merchantId === m && (p.status === 'captured' || p.status === 'refunded') && (p.capturedAt ?? 0) >= cutoff,
    );
    const METHOD_LABELS: Record<string, string> = { mpesa: 'M-Pesa', tigo_pesa: 'Tigo Pesa', airtel_money: 'Airtel Money', ezy_pesa: 'Ezy Pesa', halotel: 'Halotel' };
    const byMethod = new Map<string, { amount: number }>();
    const payTotal = payments.reduce((s, p) => s + p.amount, 0);
    for (const p of payments) {
      const agg = byMethod.get(p.method) ?? { amount: 0 };
      agg.amount += p.amount;
      byMethod.set(p.method, agg);
    }
    const methods = [...byMethod.entries()].map(([method, agg]) => ({
      method,
      label: METHOD_LABELS[method] ?? method,
      amount: Math.round(agg.amount * 100) / 100,
      share: payTotal ? Math.round((agg.amount / payTotal) * 1000) / 10 : 0,
    }));

    return ok({ channels, methods });
  }),

  /* ---- Settlements list ---- */
  h.get('/api/settlements', ({ request }) => {
    const session = requireSession(request);
    requirePerm(session, 'finance:view');
    const list = db.table<Settlement>('settlements').where((s) => s.merchantId === session.merchantId).sort((a, b) => b.periodStart - a.periodStart);
    return ok({ settlements: list });
  }),

  /* ---- Invoices ---- */
  h.get('/api/invoices', ({ request }) => {
    const session = requireSession(request);
    requirePerm(session, 'finance:view');
    const list = db.table<Invoice>('invoices').where((i) => i.merchantId === session.merchantId).sort((a, b) => b.createdAt - a.createdAt);
    return ok({ invoices: list });
  }),

  h.post('/api/invoices/:id/issue', async ({ request, params }) => {
    const session = requireSession(request);
    requirePerm(session, 'finance:view');
    const inv = db.table<Invoice>('invoices').find(String(params.id));
    if (!inv || inv.merchantId !== session.merchantId) throw new ApiHttpError(404, 'NOT_FOUND', 'Invoice not found');
    if (inv.status === 'issued') return ok({ invoice: inv });
    if (inv.status !== 'draft') throw new ApiHttpError(409, 'INVOICE_NOT_ISSUABLE', 'Only draft settlement invoices can be issued');
    const updated = db.table<Invoice>('invoices').update(inv.id, { status: 'issued' })!;
    audit(session.merchantId, session.staffId, session.role, 'finance:invoice', 'invoice', inv.id, `issued e-invoice ${inv.no}`);
    return ok({ invoice: updated });
  }),

  /* ---- Wallet (P6d, contract /wallet*) ---- */
  h.get('/api/wallet', ({ request }) => {
    const session = requireSession(request);
    requirePerm(session, 'finance:view');
    return ok(walletOf(session.merchantId));
  }),

  h.get('/api/wallet/transactions', ({ request }) => {
    const session = requireSession(request);
    requirePerm(session, 'finance:view');
    const url = new URL(request.url);
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') ?? 20)));
    const cursor = url.searchParams.get('cursor');
    let rows = walletTransactions(session.merchantId);
    if (cursor) rows = rows.filter((r) => r.id.localeCompare(cursor) < 0);
    return raw(rows.slice(0, limit));
  }),

  h.get('/api/wallet/withdrawals', ({ request }) => {
    const session = requireSession(request);
    requirePerm(session, 'finance:view');
    const list = db.table<WithdrawalRow>('walletWithdrawals').where((w) => w.merchantId === session.merchantId).sort((a, b) => b.createdAt - a.createdAt);
    return raw(list.map(({ merchantId: _m, ...w }) => w));
  }),

  /* ---- Withdrawal request (rate-limited; integer TZS) ----
   * Error parity (EARNINGS.md): WITHDRAWAL_BELOW_MINIMUM (400),
   * WITHDRAWAL_ALREADY_PROCESSED (409), WALLET_INSUFFICIENT_BALANCE (409),
   * WITHDRAWAL_RATE_LIMITED (429 — via security.rateLimit). The in-flight
   * 60s window keeps the legacy WITHDRAWAL_PENDING alias (p6d-gaps locks it);
   * pre-existing duplicate rows surface the contract WITHDRAWAL_ALREADY_PROCESSED. */
  h.post('/api/wallet/withdrawals', async ({ request }) => {
    const session = requireSession(request);
    requirePerm(session, 'finance:view');
    rateLimit(`withdraw:${session.merchantId}`, 5, 3600 * 1000);
    const body = await readJson(request);
    const amountTZS = Number(body.amountTZS);
    if (!Number.isInteger(amountTZS)) {
      throw new ApiHttpError(400, 'INVALID_AMOUNT', 'amountTZS must be a positive integer');
    }
    if (amountTZS < MIN_WITHDRAWAL_TZS) {
      throw new ApiHttpError(400, 'WITHDRAWAL_BELOW_MINIMUM', `Withdrawals must be at least TZS ${MIN_WITHDRAWAL_TZS} (server-enforced minimum)`);
    }
    const existing = db.table<WithdrawalRow>('walletWithdrawals').where(
      (w) => w.merchantId === session.merchantId && w.status === 'pending' && w.amountTZS === amountTZS && w.createdAt > Date.now() - 60000,
    );
    if (existing.length) throw new ApiHttpError(409, 'WITHDRAWAL_PENDING', 'A matching withdrawal is already pending');
    const processed = db.table<WithdrawalRow>('walletWithdrawals').where(
      (w) => w.merchantId === session.merchantId && w.amountTZS === amountTZS,
    );
    if (processed.length) throw new ApiHttpError(409, 'WITHDRAWAL_ALREADY_PROCESSED', 'A withdrawal for this amount was already processed');
    const wallet = walletOf(session.merchantId);
    if (amountTZS > wallet.withdrawableTZS) {
      throw new ApiHttpError(409, 'WALLET_INSUFFICIENT_BALANCE', 'Withdrawal exceeds the withdrawable balance', false, { legacyCode: 'INSUFFICIENT' });
    }

    const withdrawal: WithdrawalRow = {
      id: uid('wd'),
      merchantId: session.merchantId,
      amountTZS,
      feeTZS: 0,
      status: 'pending',
      method: 'bank',
      estimatedArrivalDays: 1,
      createdAt: Date.now(),
      paidAt: null,
      reason: null,
    };
    db.table<WithdrawalRow>('walletWithdrawals').insert(withdrawal);
    db.table<LedgerEntry>('ledger').insert({
      id: uid('l'),
      merchantId: session.merchantId,
      type: 'withdraw',
      amount: -amountTZS,
      balance: Math.round(wallet.totalTZS - amountTZS),
      title: `Withdrawal ${withdrawal.id.slice(0, 8).toUpperCase()}`,
      ts: Date.now(),
      status: 'pending',
      refType: 'withdrawal',
      refId: withdrawal.id,
    });
    emit({ type: 'wallet.withdrawal_requested', withdrawal, at: Date.now() });
    audit(session.merchantId, session.staffId, session.role, 'finance:withdraw', 'withdrawal', withdrawal.id, `requested withdrawal of TZS ${amountTZS}`);
    return raw({ id: withdrawal.id, amountTZS: withdrawal.amountTZS, feeTZS: withdrawal.feeTZS, status: withdrawal.status, method: withdrawal.method, estimatedArrivalDays: withdrawal.estimatedArrivalDays, createdAt: withdrawal.createdAt, paidAt: withdrawal.paidAt, reason: withdrawal.reason }, 201);
  }),

  /* ================= P5: finance ops (contract /payouts/me, /finance/bank-cards,
   * /finance/expenses, /finance/invoices, /finance/transactions/{id}/issue) ================= */
  h.get('/api/payouts/me', ({ request }) => {
    const session = requireSession(request);
    requirePerm(session, 'finance:view');
    const url = new URL(request.url);
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') ?? 20)));
    const cursor = url.searchParams.get('cursor');
    let rows = db.table<WithdrawalRow>('walletWithdrawals')
      .where((w) => w.merchantId === session.merchantId)
      .sort((a, b) => b.createdAt - a.createdAt);
    if (cursor) rows = rows.filter((r) => r.id.localeCompare(cursor) < 0);
    const payouts: PayoutSummary[] = rows.slice(0, limit).map((w) => ({
      id: w.id,
      amountTZS: w.amountTZS,
      status: w.status,
      method: w.method ?? 'bank',
      createdAt: w.createdAt,
      paidAt: w.paidAt ?? null,
    }));
    return raw(payouts);
  }),

  /* ---- Bank cards (contract /finance/bank-cards) ---- */
  h.get('/api/finance/bank-cards', ({ request }) => {
    const session = requireSession(request);
    requirePerm(session, 'finance:view');
    return raw(bankCardRows(session.merchantId).map(stripCard));
  }),

  h.post('/api/finance/bank-cards', async ({ request }) => {
    const session = requireSession(request);
    requirePerm(session, 'finance:view');
    const body = await readJson(request);
    const bankName = typeof body.bankName === 'string' ? body.bankName.trim() : '';
    const last4 = typeof body.last4 === 'string' ? body.last4.trim() : '';
    const accountHolderName = typeof body.accountHolderName === 'string' ? body.accountHolderName.trim() : undefined;
    if (!bankName || !/^\d{4}$/.test(last4)) {
      throw new ApiHttpError(400, 'INVALID_BANK_CARD', 'bankName is required and last4 must be 4 digits');
    }
    const existing = bankCardRows(session.merchantId);
    if (existing.length >= BANK_CARD_LIMIT) throw new ApiHttpError(409, 'BANK_CARD_LIMIT_REACHED', 'Bank card limit reached');
    if (existing.some((c) => c.bankName.toLowerCase() === bankName.toLowerCase() && c.last4 === last4)) {
      throw new ApiHttpError(409, 'BANK_CARD_EXISTS', 'This card is already linked');
    }
    const card: BankCardRow = {
      id: uid('bc'),
      merchantId: session.merchantId,
      bankName,
      last4,
      accountHolderName,
      isDefault: existing.length === 0,
      createdAt: Date.now(),
    };
    db.table<BankCardRow>('bankCards').insert(card);
    emitExt({ type: 'finance.bank_card_added', card: stripCard(card), at: Date.now() });
    audit(session.merchantId, session.staffId, session.role, 'finance:bank-card', 'bankCard', card.id, `added bank card ${bankName} ****${last4}`);
    return raw(stripCard(card), 201);
  }),

  del('/api/finance/bank-cards/:cardId', ({ request, params }) => {
    const session = requireSession(request);
    requirePerm(session, 'finance:view');
    const card = db.table<BankCardRow>('bankCards').find(String(params.cardId));
    if (!card || card.merchantId !== session.merchantId) throw new ApiHttpError(404, 'BANK_CARD_NOT_FOUND', 'Bank card not found');
    if (card.isDefault && bankCardRows(session.merchantId).length > 1) {
      throw new ApiHttpError(409, 'BANK_CARD_LAST_DEFAULT', 'Set another card as default before removing the default card');
    }
    db.table<BankCardRow>('bankCards').remove(card.id);
    emitExt({ type: 'finance.bank_card_removed', cardId: card.id, at: Date.now() });
    audit(session.merchantId, session.staffId, session.role, 'finance:bank-card', 'bankCard', card.id, `removed bank card ${card.bankName} ****${card.last4}`);
    return new Response(null, { status: 204 });
  }),

  put('/api/finance/bank-cards/:cardId/default', ({ request, params }) => {
    const session = requireSession(request);
    requirePerm(session, 'finance:view');
    const card = db.table<BankCardRow>('bankCards').find(String(params.cardId));
    if (!card || card.merchantId !== session.merchantId) throw new ApiHttpError(404, 'BANK_CARD_NOT_FOUND', 'Bank card not found');
    if (!card.isDefault) {
      for (const c of bankCardRows(session.merchantId)) {
        if (c.isDefault) db.table<BankCardRow>('bankCards').update(c.id, { isDefault: false });
      }
      const updated = db.table<BankCardRow>('bankCards').update(card.id, { isDefault: true })!;
      emitExt({ type: 'finance.bank_card_default_changed', card: stripCard(updated), at: Date.now() });
      audit(session.merchantId, session.staffId, session.role, 'finance:bank-card', 'bankCard', card.id, `set default bank card ${card.bankName} ****${card.last4}`);
    }
    return new Response(null, { status: 204 });
  }),

  /* ---- Expenses (contract /finance/expenses) ---- */
  h.get('/api/finance/expenses', ({ request }) => {
    const session = requireSession(request);
    requirePerm(session, 'finance:view');
    const url = new URL(request.url);
    const from = Number(url.searchParams.get('from') ?? 0);
    const to = Number(url.searchParams.get('to') ?? Date.now());
    const rows = expenseRows(session.merchantId).filter((e) => e.incurredAt >= from && e.incurredAt <= to);
    return raw(rows.map(stripExpense));
  }),

  h.post('/api/finance/expenses', async ({ request }) => {
    const session = requireSession(request);
    requirePerm(session, 'finance:view');
    const body = await readJson(request);
    const category = body.category as ExpenseCategory;
    const amountTZS = Number(body.amountTZS);
    if (!EXPENSE_CATEGORIES.includes(category)) {
      throw new ApiHttpError(400, 'INVALID_CATEGORY', 'Unknown expense category');
    }
    if (!Number.isInteger(amountTZS) || amountTZS < 1) {
      throw new ApiHttpError(400, 'INVALID_AMOUNT', 'amountTZS must be a positive integer');
    }
    const note = typeof body.note === 'string' ? body.note.trim() : undefined;
    if (note && note.length > 500) throw new ApiHttpError(400, 'NOTE_TOO_LONG', 'note must be at most 500 characters');
    const incurredAt = Number(body.incurredAt ?? Date.now());
    const expense: ExpenseRow = {
      id: uid('exp'),
      merchantId: session.merchantId,
      category,
      amountTZS,
      note,
      incurredAt,
      createdAt: Date.now(),
    };
    db.table<ExpenseRow>('expenses').insert(expense);
    emitExt({ type: 'finance.expense_created', expense: stripExpense(expense), at: Date.now() });
    audit(session.merchantId, session.staffId, session.role, 'finance:expense', 'expense', expense.id, `recorded ${category} expense TZS ${amountTZS}`);
    return raw(stripExpense(expense), 201);
  }),

  del('/api/finance/expenses/:expenseId', ({ request, params }) => {
    const session = requireSession(request);
    requirePerm(session, 'finance:view');
    const expense = db.table<ExpenseRow>('expenses').find(String(params.expenseId));
    if (!expense || expense.merchantId !== session.merchantId) throw new ApiHttpError(404, 'EXPENSE_NOT_FOUND', 'Expense not found');
    db.table<ExpenseRow>('expenses').remove(expense.id);
    emitExt({ type: 'finance.expense_deleted', expenseId: expense.id, at: Date.now() });
    audit(session.merchantId, session.staffId, session.role, 'finance:expense', 'expense', expense.id, `deleted ${expense.category} expense TZS ${expense.amountTZS}`);
    return new Response(null, { status: 204 });
  }),

  /* ---- Invoices (contract /finance/invoices + download) ---- */
  h.get('/api/finance/invoices', ({ request }) => {
    const session = requireSession(request);
    requirePerm(session, 'finance:view');
    return raw(financeInvoiceRows(session.merchantId).map(stripInvoice));
  }),

  h.post('/api/finance/invoices', async ({ request }) => {
    const session = requireSession(request);
    requirePerm(session, 'finance:view');
    const body = await readJson(request);
    const amountTZS = Number(body.amountTZS);
    if (!Number.isInteger(amountTZS) || amountTZS < 1) {
      throw new ApiHttpError(400, 'INVALID_AMOUNT', 'amountTZS must be a positive integer');
    }
    const kind = body.kind === 'standard' ? 'standard' : 'vat';
    const taxRateBps = Number.isInteger(body.taxRateBps) ? Number(body.taxRateBps) : kind === 'vat' ? 1800 : null;
    const invoice: FinanceInvoiceRow = {
      id: uid('finv'),
      merchantId: session.merchantId,
      number: `INV-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${String(Math.floor(Math.random() * 9000) + 1000)}`,
      amountTZS,
      kind,
      taxRateBps: kind === 'vat' ? taxRateBps : null,
      taxAmountTZS: kind === 'vat' && taxRateBps ? Math.round((amountTZS * taxRateBps) / 10000) : null,
      taxId: typeof body.taxId === 'string' ? body.taxId : null,
      buyerDetails: body.buyerDetails && typeof body.buyerDetails === 'object' ? (body.buyerDetails as Record<string, unknown>) : undefined,
      periodFrom: typeof body.periodFrom === 'string' ? body.periodFrom : null,
      periodTo: typeof body.periodTo === 'string' ? body.periodTo : null,
      status: 'requested',
      createdAt: Date.now(),
      issuedAt: null,
    };
    db.table<FinanceInvoiceRow>('financeInvoices').insert(invoice);
    emitExt({ type: 'finance.invoice_requested', invoice: stripInvoice(invoice), at: Date.now() });
    audit(session.merchantId, session.staffId, session.role, 'finance:invoice', 'invoice', invoice.id, `requested e-invoice ${invoice.number} TZS ${amountTZS}`);
    return raw(stripInvoice(invoice), 201);
  }),

  h.get('/api/finance/invoices/:invoiceId/download', ({ request, params }) => {
    const session = requireSession(request);
    requirePerm(session, 'finance:view');
    const id = String(params.invoiceId);
    const inv = db.table<FinanceInvoiceRow>('financeInvoices').find(id) ?? db.table<Invoice>('invoices').find(id);
    if (!inv || inv.merchantId !== session.merchantId) throw new ApiHttpError(404, 'INVOICE_NOT_FOUND', 'Invoice not found');
    const expiresInSeconds = 900;
    return ok({
      downloadUrl: `https://mock.hudumika.co.tz/invoices/${id}/pdf?expires=${Math.floor(Date.now() / 1000) + expiresInSeconds}`,
      expiresInSeconds,
    });
  }),

  /* ---- Transaction issue (contract POST /finance/transactions/{id}/issue) ---- */
  h.post('/api/finance/transactions/:transactionId/issue', async ({ request, params }) => {
    const session = requireSession(request);
    requirePerm(session, 'finance:view');
    const txId = String(params.transactionId);
    const tx = walletTransactions(session.merchantId).find((t) => t.id === txId);
    if (!tx) throw new ApiHttpError(404, 'TRANSACTION_NOT_FOUND', 'Transaction not found');
    const body = await readJson(request);
    const issueType = body.issueType as TransactionIssueType;
    const description = typeof body.description === 'string' ? body.description.trim() : '';
    if (!['amount_mismatch', 'missing_items', 'other'].includes(issueType)) {
      throw new ApiHttpError(400, 'INVALID_ISSUE_TYPE', 'issueType must be amount_mismatch, missing_items or other');
    }
    if (!description || description.length > 500) {
      throw new ApiHttpError(400, 'DESCRIPTION_REQUIRED', 'description is required (≤500 characters)');
    }
    const existing = db.table<{ id: string; merchantId: string; transactionId: string }>('transactionIssues').where((t) => t.transactionId === txId && t.merchantId === session.merchantId);
    if (existing.length) throw new ApiHttpError(409, 'ISSUE_ALREADY_REPORTED', 'An issue is already reported for this transaction');
    const ticket: TransactionIssueTicket = { ticketId: uid('ti'), status: 'open' };
    db.table('transactionIssues').insert({ id: ticket.ticketId, merchantId: session.merchantId, transactionId: txId, issueType, description, createdAt: Date.now() });
    emitExt({ type: 'finance.transaction_issue_reported', ticket, transactionId: txId, at: Date.now() });
    audit(session.merchantId, session.staffId, session.role, 'finance:issue', 'transaction', txId, `reported ${issueType} issue on transaction`);
    return raw(ticket, 201);
  }),

  /* ============ Contract-path aliases (drift resolution — SAME behavior as the
   * legacy paths above; legacy aliases stay for contract.test.ts) ============ */

  /* ---- Contract GET /payouts/me/statement — ledger statement. Alias of the
   * /api/ledger handler above (same {entries,total,page,size,balance} shape);
   * from/to accept both legacy epoch ms and contract YYYY-MM-DD dates. ---- */
  h.get('/api/payouts/me/statement', ({ request }) => {
    const session = requireSession(request);
    requirePerm(session, 'finance:view');
    const url = new URL(request.url);
    const type = url.searchParams.get('type');
    const bound = (v: string | null, fallback: number): number => {
      if (v === null) return fallback;
      const num = Number(v);
      return Number.isFinite(num) ? num : new Date(`${v}T00:00:00`).getTime();
    };
    const from = bound(url.searchParams.get('from'), 0);
    const to = bound(url.searchParams.get('to'), Date.now());
    const page = Number(url.searchParams.get('page') ?? 1);
    const size = Math.min(100, Number(url.searchParams.get('size') ?? 30));
    let rows = db.table<LedgerEntry>('ledger').where((e) => e.merchantId === session.merchantId && e.ts >= from && e.ts <= to);
    if (type) rows = rows.filter((e) => e.type === type);
    rows = [...rows].sort((a, b) => b.ts - a.ts);
    const total = rows.length;
    const start = (page - 1) * size;
    const balance = rows[0]?.balance ?? 0;
    return ok({ entries: rows.slice(start, start + size), total, page, size, balance });
  }),

  /* ---- Contract GET /finance/settlements/daily — daily settlement records.
   * Alias of /api/settlements (same {settlements} shape). ---- */
  h.get('/api/finance/settlements/daily', ({ request }) => {
    const session = requireSession(request);
    requirePerm(session, 'finance:view');
    const list = db.table<Settlement>('settlements').where((s) => s.merchantId === session.merchantId).sort((a, b) => b.periodStart - a.periodStart);
    return ok({ settlements: list });
  }),

  /* ---- Contract POST /finance/settlements/run — manual settlement. Alias of
   * /api/settlements/run (same {settlement,invoice} shape, same 409s); the body
   * accepts the app's periodStart (ms) and the contract's date (YYYY-MM-DD). ---- */
  h.post('/api/finance/settlements/run', async ({ request }) => {
    const session = requireSession(request);
    requirePerm(session, 'finance:view');
    const body = await readJson(request);
    const m = session.merchantId;
    const rawStart = body.periodStart ?? body.date ?? new Date().setHours(0, 0, 0, 0);
    const parsedStart = Number(rawStart);
    const dayStart = Number.isFinite(parsedStart) ? parsedStart : new Date(`${String(rawStart)}T00:00:00`).getTime();
    const dayEnd = dayStart + 86400000;

    const orders = db.table('orders').where(
      (o) => o.merchantId === m && o.status === 'completed' && o.completedAt >= dayStart && o.completedAt < dayEnd && o.settledAt,
    );
    if (!orders.length) throw new ApiHttpError(409, 'NOTHING_TO_SETTLE', 'No completed orders in this period');

    const gross = Math.round(orders.reduce((s, o) => s + o.total, 0) * 100) / 100;
    const commission = Math.round(gross * COMMISSION_RATE * 100) / 100;
    const tax = Math.round(gross * TAX_RATE * 100) / 100;
    const net = Math.round((gross - commission - tax) * 100) / 100;
    const existing = db.table<Settlement>('settlements').where((s) => s.merchantId === m && s.periodStart === dayStart);
    if (existing.length) throw new ApiHttpError(409, 'ALREADY_SETTLED', 'This period is already settled');

    const settlement: Settlement = {
      id: uid('set'),
      merchantId: m,
      batchNo: `S${new Date(dayStart).toISOString().slice(0, 10).replace(/-/g, '')}`,
      periodStart: dayStart,
      periodEnd: dayEnd,
      gross,
      commission,
      tax,
      net,
      payoutStatus: 'pending',
      orderCount: orders.length,
      createdAt: Date.now(),
    };
    db.table<Settlement>('settlements').insert(settlement);

    const invoice: Invoice = {
      id: uid('inv'),
      merchantId: m,
      settlementId: settlement.id,
      no: `EV${new Date(dayStart).toISOString().slice(0, 10).replace(/-/g, '')}${String(Math.floor(Math.random() * 900) + 100)}`,
      amount: gross,
      taxRate: TAX_RATE,
      taxAmount: tax,
      status: 'draft',
      createdAt: Date.now(),
    };
    db.table<Invoice>('invoices').insert(invoice);

    db.table<LedgerEntry>('ledger').insert({
      id: uid('l'),
      merchantId: m,
      type: 'settlement',
      amount: net,
      title: `Settlement ${settlement.batchNo} · ${orders.length} orders`,
      ts: Date.now(),
      status: 'pending',
      refType: 'settlement',
      refId: settlement.id,
    });

    const note: NotificationDto = {
      id: uid('n'),
      merchantId: m,
      type: 'system',
      category: 'important',
      title: `Settlement ${settlement.batchNo} ready`,
      body: `Net ${net.toFixed(2)} after commission & VAT. Invoice draft created.`,
      ts: Date.now(),
      read: false,
    };
    db.table<NotificationDto>('notifications').insert(note);
    emit({ type: 'notification.created', notification: note, at: Date.now() });
    emit({ type: 'settlement.created', settlement, at: Date.now() });
    audit(m, session.staffId, session.role, 'finance:settlement', 'settlement', settlement.id, `ran settlement ${settlement.batchNo} net ${net.toFixed(2)}`);
    return ok({ settlement, invoice });
  }),

  /* ---- Contract POST /finance/settlements/{settlementId}/payout — alias of
   * /api/settlements/:id/payout (same {payout,settlement} shape, same 404). ---- */
  h.post('/api/finance/settlements/:settlementId/payout', async ({ request, params }) => {
    const session = requireSession(request);
    requirePerm(session, 'finance:view');
    rateLimit(`payout:${session.merchantId}`, 3, 600 * 1000);
    const s = db.table<Settlement>('settlements').find(String(params.settlementId));
    if (!s || s.merchantId !== session.merchantId) throw new ApiHttpError(404, 'NOT_FOUND', 'Settlement not found');
    if (s.payoutStatus === 'paid') throw new ApiHttpError(409, 'SETTLEMENT_ALREADY_PAID', 'This settlement is already paid out');
    const paidAt = Date.now();
    const updated = db.table<Settlement>('settlements').update(s.id, { payoutStatus: 'paid', paidAt })!;
    db.table<LedgerEntry>('ledger').insert({
      id: uid('l'),
      merchantId: session.merchantId,
      type: 'withdraw',
      amount: -s.net,
      title: `Payout ${s.batchNo} → bank`,
      ts: Date.now(),
      status: 'completed',
      refType: 'settlement',
      refId: s.id,
    });
    const payout: PayoutSummary = { id: s.id, amountTZS: Math.round(s.net), status: 'paid', method: 'bank', createdAt: s.createdAt, paidAt };
    emitExt({ type: 'settlement.paid', settlement: updated, at: paidAt });
    emitExt({ type: 'payout.paid', payout, at: paidAt });
    audit(session.merchantId, session.staffId, session.role, 'finance:payout', 'settlement', s.id, `payout ${s.batchNo} ${s.net.toFixed(2)}`);
    return ok({ payout: 'paid', settlement: updated });
  }),

  /* ---- Contract POST /finance/invoices/{invoiceId}/issue — alias of
   * /api/invoices/:id/issue (same {invoice} shape, same 404). Serves both the
   * requested e-invoices (financeInvoices) and the legacy settlement invoices,
   * mirroring the download handler's dual-table lookup. ---- */
  h.post('/api/finance/invoices/:invoiceId/issue', async ({ request, params }) => {
    const session = requireSession(request);
    requirePerm(session, 'finance:view');
    const id = String(params.invoiceId);
    const inv = db.table<FinanceInvoiceRow>('financeInvoices').find(id) ?? db.table<Invoice>('invoices').find(id);
    if (!inv || inv.merchantId !== session.merchantId) throw new ApiHttpError(404, 'INVOICE_NOT_FOUND', 'Invoice not found');
    const expect = 'number' in inv ? 'requested' : 'draft';
    if (inv.status === 'issued') return ok({ invoice: inv });
    if (inv.status !== expect) throw new ApiHttpError(409, 'INVOICE_NOT_ISSUABLE', `Only ${expect} invoices can be issued (current: ${inv.status})`);
    const updated = db.table<FinanceInvoiceRow>('financeInvoices').find(id)
      ? db.table<FinanceInvoiceRow>('financeInvoices').update(id, { status: 'issued', issuedAt: Date.now() })!
      : db.table<Invoice>('invoices').update(id, { status: 'issued' })!;
    if ('number' in updated) {
      emitExt({ type: 'invoice.issued', invoice: updated, at: Date.now() });
    }
    audit(session.merchantId, session.staffId, session.role, 'finance:invoice', 'invoice', id, `issued e-invoice ${'number' in updated ? updated.number : updated.no}`);
    return ok({ invoice: updated });
  }),

  /* ---- Contract GET /payments/methods — supported payment methods with status
   * (static optimistic availability, mirroring the backend ListPaymentMethods). ---- */
  h.get('/api/payments/methods', ({ request }) => {
    const session = requireSession(request);
    requirePerm(session, 'finance:view');
    const methods = ['mpesa', 'tigo_pesa', 'airtel_money', 'ezy_pesa', 'halotel', 'card', 'cod', 'bank'].map((method) => ({
      method,
      available: true,
    }));
    return raw(methods);
  }),

  /* ============ Earnings pass (gap-09) — contract /payments/qr, /payments/history,
   * /payments/{intentId}/reverse, /finance/reconciliation, /finance/dispute-holds ============ */

  /* ---- Contract POST /payments/qr — fixed or variable collection QR. ---- */
  h.post('/api/payments/qr', async ({ request }) => {
    const session = requireSession(request);
    requirePerm(session, 'finance:view');
    const body = await readJson(request);
    const provider = String(body.provider ?? '');
    if (!QR_PROVIDERS.includes(provider as PaymentQrProvider)) {
      throw new ApiHttpError(400, 'PAYMENT_QR_PROVIDER_UNSUPPORTED', 'provider must be mpesa, tigo_pesa or airtel_money');
    }
    const amountTZS = body.amountTZS === null || body.amountTZS === undefined ? null : Number(body.amountTZS);
    if (amountTZS !== null && (!Number.isInteger(amountTZS) || amountTZS < 1)) {
      throw new ApiHttpError(400, 'INVALID_AMOUNT', 'amountTZS must be a positive integer or null for a variable amount');
    }
    const description = typeof body.description === 'string' ? body.description.trim() : undefined;
    if (description && description.length > 120) {
      throw new ApiHttpError(400, 'DESCRIPTION_TOO_LONG', 'description must be at most 120 characters');
    }
    if (body.orderId !== undefined && body.orderId !== null) {
      const order = db.table('orders').find(String(body.orderId));
      if (!order || order.merchantId !== session.merchantId) {
        throw new ApiHttpError(404, 'ORDER_NOT_FOUND', 'Order not found');
      }
    }
    const merchantRef = `QR${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
    const qr: PaymentQr = {
      qrPayload: `HUDPAY|${provider}|${merchantRef}|${amountTZS ?? 'V'}|${new Date(Date.now() + QR_TTL_MS).toISOString()}`,
      provider,
      amountTZS,
      merchantRef,
      expiresAt: Date.now() + QR_TTL_MS,
    };
    emitExt({ type: 'payment.qr_created', qr, at: Date.now() });
    audit(session.merchantId, session.staffId, session.role, 'finance:qr', 'paymentQr', merchantRef, `generated ${provider} collection QR (${amountTZS ?? 'variable'})`);
    return raw(qr, 201);
  }),

  /* ---- Contract GET /payments/history — payment transactions (status pills,
   * masked reference, local time). ---- */
  h.get('/api/payments/history', ({ request }) => {
    const session = requireSession(request);
    requirePerm(session, 'finance:view');
    const url = new URL(request.url);
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') ?? 20)));
    const cursor = url.searchParams.get('cursor');
    let rows = db.table<Payment>('payments')
      .where((p) => p.merchantId === session.merchantId)
      .sort((a, b) => b.createdAt - a.createdAt);
    if (cursor) rows = rows.filter((r) => r.id.localeCompare(cursor) < 0);
    const items: PaymentHistoryItem[] = rows.slice(0, limit).map((p) => ({
      id: p.id,
      method: p.method,
      amountTZS: Math.round(p.amount),
      status: HISTORY_STATUS[p.status],
      reference: `****${p.id.slice(-4).toUpperCase()}`,
      createdAt: p.createdAt,
    }));
    return raw(items);
  }),

  /* ---- Contract POST /payments/{intentId}/reverse — finance-role only
   * (403 otherwise); confirm reason ≤500; intent lands as reversed. ---- */
  h.post('/api/payments/:intentId/reverse', async ({ request, params }) => {
    const session = requireSession(request);
    requirePerm(session, 'finance:view');
    const body = await readJson(request);
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    if (!reason || reason.length > 500) {
      throw new ApiHttpError(400, 'REASON_REQUIRED', 'reason is required (≤500 characters)');
    }
    const pay = db.table<Payment>('payments').find(String(params.intentId));
    if (!pay || pay.merchantId !== session.merchantId) throw new ApiHttpError(404, 'PAYMENT_NOT_FOUND', 'Payment intent not found');
    if (pay.status === 'reversed' || pay.status === 'refunded') {
      throw new ApiHttpError(409, 'PAYMENT_ALREADY_REVERSED', 'This payment is already reversed or refunded');
    }
    const updated = db.table<Payment>('payments').update(pay.id, { status: 'reversed' })!;
    const item: PaymentHistoryItem = {
      id: updated.id,
      method: updated.method,
      amountTZS: Math.round(updated.amount),
      status: 'reversed',
      reference: `****${updated.id.slice(-4).toUpperCase()}`,
      createdAt: updated.createdAt,
    };
    emitExt({ type: 'payment.reversed', item, at: Date.now() });
    audit(session.merchantId, session.staffId, session.role, 'finance:reverse', 'payment', updated.id, `reversed payment ${updated.id} — ${reason}`);
    return ok({ id: updated.id, status: 'reversed', amountTZS: Math.round(updated.amount), method: updated.method });
  }),

  /* ---- Contract GET /finance/reconciliation?from&to — ReconciliationSummary
   * (orderTotalTZS vs paymentTotalTZS, matched/exceptions). The legacy per-day
   * `days` rows stay alongside (drift parity — contract.test.ts asserts them);
   * days param (legacy) and from/to (contract dates) are both accepted. ---- */
  h.get('/api/finance/reconciliation', ({ request }) => {
    const session = requireSession(request);
    requirePerm(session, 'finance:view');
    const url = new URL(request.url);
    const daysParam = Number(url.searchParams.get('days') ?? 7);
    const fromRaw = url.searchParams.get('from');
    const toRaw = url.searchParams.get('to');
    let days = Number.isFinite(daysParam) ? Math.min(30, Math.max(1, daysParam)) : 7;
    let fromDate: Date | null = null;
    let toDate: Date | null = null;
    if (fromRaw && toRaw) {
      fromDate = new Date(`${fromRaw}T00:00:00`);
      toDate = new Date(`${toRaw}T00:00:00`);
      if (!Number.isNaN(fromDate.getTime()) && !Number.isNaN(toDate.getTime()) && toDate >= fromDate) {
        days = Math.min(30, Math.max(1, Math.round((toDate.getTime() - fromDate.getTime()) / 86400000) + 1));
      }
    }
    const out: ReconciliationDay[] = [];
    for (let i = days - 1; i >= 0; i--) {
      const start = new Date();
      start.setHours(0, 0, 0, 0);
      const dayStart = start.getTime() - i * 86400000;
      const dayEnd = dayStart + 86400000;
      const orders = db.table<OrderDto>('orders').where((o) => o.merchantId === session.merchantId && o.status === 'completed' && (o.completedAt ?? 0) >= dayStart && (o.completedAt ?? 0) < dayEnd);
      const ledgerGross = orders.reduce((s, o) => s + o.total, 0);
      const settlement = db.table('settlements').where((s) => s.merchantId === session.merchantId && s.periodStart === dayStart)[0];
      const settlementGross = settlement?.gross ?? 0;
      const commission = Math.round(ledgerGross * COMMISSION_RATE * 100) / 100;
      const diff = Math.round((ledgerGross - settlementGross) * 100) / 100;
      out.push({
        day: new Date(dayStart).toISOString().slice(0, 10),
        ledgerGross: Math.round(ledgerGross * 100) / 100,
        settlementGross,
        commission,
        diff,
        ok: Math.abs(diff) < 0.01 || !settlement,
      });
    }
    const matched = out.filter((d) => d.ok).length;
    const exceptions = out.length - matched;
    return ok({
      from: out[0]?.day ?? '',
      to: out[out.length - 1]?.day ?? '',
      orderTotalTZS: Math.round(out.reduce((s, d) => s + d.ledgerGross, 0)),
      paymentTotalTZS: Math.round(out.reduce((s, d) => s + d.settlementGross, 0)),
      matched,
      exceptions,
      days: out,
    });
  }),

  /* ---- GET /finance/dispute-holds — amounts held pending dispute review.
   * App-extension surface (EARNINGS.md dispute-holds card); derived from the
   * requested (undecided) refunds — release resolves to a payout or a `refund`
   * ledger entry. ---- */
  h.get('/api/finance/dispute-holds', ({ request }) => {
    const session = requireSession(request);
    requirePerm(session, 'finance:view');
    const refunds = db.table<{ id: string; merchantId: string; orderId: string; amount: number; reason?: string; status: string; createdAt: number }>('refunds').where(
      (r) => r.merchantId === session.merchantId && r.status === 'requested',
    );
    const holds: DisputeHold[] = refunds.map((r) => ({
      id: `dh_${r.id}`,
      orderId: r.orderId,
      amountTZS: Math.round(r.amount),
      reason: r.reason ?? null,
      status: 'disputed' as const,
      disputedAt: r.createdAt,
    }));
    return ok({ holds, totalTZS: holds.reduce((s, h) => s + h.amountTZS, 0) });
  }),
];
