# HUDumika Merchant — Earnings

Earnings dashboard: payout history, ledger statement, commission, payout cycle, dispute holds, bank cards, invoices, daily settlements, reconciliation, and payment tools. Money is TZS integer minor units everywhere. Enterprise/multi-store financial views (chain dashboard, consolidated exports, corporate payment controls) live in ENTERPRISE-FINANCE.md. Staff commission rules are a separate concept (ENTERPRISE-STAFF.md) and never appear on this screen.

## Payout history (`GET /payouts/me`)

`PayoutSummary[]`: id, `amountTZS`, `status`, `method`, `createdAt`, `paidAt`.

| Status | UI meaning | Action |
| --- | --- | --- |
| `pending` | Amount queued for the next cycle | info pill |
| `processing` | In the nightly batch, funds being sent | spinner pill |
| `paid` | Funds sent to the payout account | success pill, shows `paidAt` + method |
| `failed` | Transfer failed | danger pill; retry is finance-driven; support ticket from UI |
| `exception` | Batch exception, needs finance review | danger pill + "under review" banner; contact support |

Balance summary on top: sum of open (pending/processing) amounts, derived from list + statement.

## Ledger statement (`GET /payouts/me/statement?from&to`)

`LedgerStatement`: `from`, `to`, `openingBalanceTZS`, `closingBalanceTZS`, `entries[]`. Entry types (`LedgerEntry.type`) and signs:

| Type | Meaning | Sign |
| --- | --- | --- |
| `order_earning` | Merchant share of a completed order | + |
| `delivery_fee` | (rider fee; shown if merchant-visible only) | + |
| `commission` | Platform share, deducted at settlement | - |
| `adjustment` | Manual correction (reason shown) | +/- |
| `payout` | Cash-out to bank/mobile money | - |
| `refund` | Returned money | - |
| `bonus` | Promo or incentive | + |

Statement view: date-range picker (default current cycle), running `amountTZS`/`balanceTZS` per entry, `referenceType`/`referenceId` deep links. The ledger is immutable — corrections arrive as `adjustment` entries, never edits.

## Commission explanation and payout cycle

- `commissionRateBps` (basis points from `MerchantPrivate.commercial`) is the platform's share of each completed order, deducted at settlement time, not at order time (PAYOUTS-LEDGER.md) — the ledger entry `commission` appears beside the matching `order_earning`. Example at 850 bps (8.50%): an order earning of `TZS 100,000` nets `TZS 91,500` credited. The rate is backend-configured (PRODUCT.md); the UI renders "Commission 8.50%" from the API value and never recomputes totals client-side.
- `payoutCycleDays` (default 3) is the cadence: each cycle, the nightly batch sweeps all positive balances (draft → processing → settled; failures → exception). UI: "Next payout in X days", cadence, pending amount. The batch lifecycle is finance-owned; the merchant sees only its own `PayoutSummary` records.

## Dispute holds

- When an order is `disputed`, the related payout amount is held and not batchable (PAYOUTS-LEDGER.md — a view over ledger references). UI: held amount card "held — dispute in review"; `dispute.opened` / `dispute.resolved` in-app notifications update it. Release: dispute resolves → payout proceeds or a `refund` entry is added.

## Merchant wallet (`GET /wallet`)

`Wallet`: `withdrawableTZS`, `pendingTZS`, `totalTZS` — a projection of the ledger, never a second source of truth (backend/PAYMENTS.md). Wallet card sits above the statement; any mismatch against the statement is a bug (dashboard-reconciliation rule, ANALYTICS.md).

## Withdrawals

| Method | Path | Purpose | Request | Response |
| --- | --- | --- | --- | --- |
| POST | `/wallet/withdrawals` | Request cash-out | `amountTZS` ≥1 | `Withdrawal` / 201 / 409 |
| GET | `/wallet/withdrawals` | Withdrawal history | — | `Withdrawal[]` |

`Withdrawal`: `amountTZS`, `status`, `method`, `createdAt`, `paidAt`, `reason`.

| Status | UI meaning |
| --- | --- |
| `pending` | queued, not yet in a batch |
| `processing` | in the nightly batch |
| `paid` | sent to the payout account (`paidAt`, method) |
| `failed` | transfer failed (`reason` shown; raise a ticket) |
| `exception` | batch exception, finance review (banner) |

Rules and errors:

- Minimum amount and daily rate limits are server-enforced (backend/PAYMENTS.md); exact values are env/config-driven, never hardcoded. Errors: `WITHDRAWAL_BELOW_MINIMUM`, `WITHDRAWAL_RATE_LIMITED` (retry card with wait time), `WITHDRAWAL_ACCOUNT_MISSING` (link to payout-account setup — STORE-MANAGEMENT.md), `WALLET_INSUFFICIENT_BALANCE` (amount > withdrawable — pre-validated against the wallet card). Duplicate submissions: `WITHDRAWAL_ALREADY_PROCESSED` (409) — button disabled in flight, refetch on conflict. Withdrawal creates signed ledger (`payout`) and wallet-transaction entries; both immutable.
- Screen: amount input with withdrawable hint → confirm (shows method) → spinner → success card (id, status pill) → error + retry; history list (loading / empty "No withdrawals yet" / error + retry).

## Wallet transactions (`GET /wallet/transactions`)

`WalletTransaction[]`: `id`, `type`, `amountTZS` (signed), `balanceTZS`, `referenceType`/`referenceId`, `createdAt`.

| Type | Sign | Meaning |
| --- | --- | --- |
| `settlement` | + | order/booking settlement |
| `withdrawal` | - | cash-out |
| `refund` | - | returned money |
| `adjustment` | +/- | manual correction (reason in reference) |
| `coupon_cost` | - | coupon campaign redemptions |
| `promotion_spend` | - | campaign spend |
| `group_buy_settlement` | + | group buy settled on voucher redemption |

- `amountTZS` is signed; the UI renders + green / - ink with `TZS 1,234` separators, running `balanceTZS` per row; rows deep-link to their `referenceType` target. States: loading skeleton → empty ("No transactions yet") → error + retry → list.

## Collection QR (counter payments)

| Method | Path | Purpose | Response |
| --- | --- | --- | --- |
| POST | `/payments/qr` | Generate a fixed or variable collection QR code | `PaymentQr` / 201 |

- Request (`PaymentQrCreate`): `provider` enum `mpesa` / `tigo_pesa` / `airtel_money`; `amountTZS` integer or `null` (null = variable); optional `description` ≤120, `orderId`. Response (`PaymentQr`): `qrPayload`, `provider`, `amountTZS`, `merchantRef`, `expiresAt` — render as a scannable code on the counter display; expired codes reject scans (`PAYMENT_QR_EXPIRED` — regenerate).
- Errors: `PAYMENT_QR_PROVIDER_UNSUPPORTED`, `PAYMENT_QR_EXPIRED`. Matching: the QR is a collection tool only — funds land via provider webhooks and appear as order payment or wallet `settlement` entries; `merchantRef` links payment to QR. The merchant never creates payment intents. States: provider picker + amount toggle (fixed integer / variable) → generating spinner → QR card with `merchantRef` and expiry countdown → expired banner with regenerate → error + retry.

## Bank cards (`/finance/bank-cards`)

| Method | Path | Purpose | Response |
| --- | --- | --- | --- |
| GET | `/finance/bank-cards` | Linked cards | `BankCard[]` |
| POST | `/finance/bank-cards` | Add a card | `BankCard` / 201 |
| DELETE | `/finance/bank-cards/{cardId}` | Remove a card | 204 |
| PUT | `/finance/bank-cards/{cardId}/default` | Set default | 204 |

- `BankCard`: `id`, `bankName`, `last4`, `accountHolderName`, `isDefault`, `createdAt` — cards are masked by design; full numbers never reach the client (SECURITY.md masking).
- Errors: `BANK_CARD_NOT_FOUND` (404), `BANK_CARD_LIMIT_REACHED` (max cards — the add form blocks with the limit banner). Removing the default card: pick a new default first (server-enforced order). List: loading → empty ("No bank cards — add one") → error + retry → card rows with default badge; add form → saving spinner → masked card; set-default is optimistic with rollback.

## Invoices (`/finance/invoices`)

| Method | Path | Purpose | Response |
| --- | --- | --- | --- |
| GET | `/finance/invoices` | Invoice list | `Invoice[]` |
| POST | `/finance/invoices` | Request an invoice | `Invoice` / 201 |
| POST | `/finance/invoices/{invoiceId}/issue` | Issue an invoice | `Invoice` |
| GET | `/finance/invoices/{invoiceId}/download` | Download PDF | `{downloadUrl, expiresInSeconds}` (900) |

- `Invoice`: `id`, `number`, `amountTZS`, `status` (`draft`/`requested`/`issued`/`paid`), `buyerDetails`, `periodFrom`/`periodTo`, `createdAt`, `issuedAt`.
- Request carries the invoice draft (amount, buyer details, period); issue flips `requested` → `issued` and emits `invoice.issued` (in-app). Errors: `INVOICE_NOT_FOUND`, `INVOICE_NOT_ISSUABLE` (wrong state — banner + refetch). Download: opening `downloadUrl` (never hardcoded) with the expiry countdown; list shows status pills (`draft`/`requested`/`issued`/`paid`).

## Daily settlements (`/finance/settlements/daily`, `run`, `payout`)

| Method | Path | Purpose | Response |
| --- | --- | --- | --- |
| GET | `/finance/settlements/daily?from&to` | Daily records | `DailySettlement[]` |
| POST | `/finance/settlements/run` | Manual run (finance role) — body `{date, reason ≤500}` | `DailySettlement` / 202 |
| POST | `/finance/settlements/{settlementId}/payout` | Pay out (finance role) | `DailySettlement` |

- `DailySettlement`: `id`, `date`, `revenueTZS`, `feesTZS`, `payoutTZS`, `orderCount`, `status` (`open`/`settled`/`paid`), `paidAt` — money rendered with separators.
- Errors: `SETTLEMENT_NOT_FOUND`, `SETTLEMENT_ALREADY_PAID` (double payout blocked — banner). `settlement.paid` (in-app) notifies on payout. Owner/manager view is read-only; run and payout CTAs render only for the finance staff role (server-authorized; 403 surfaces as "no permission", never hidden client-side).

## Reconciliation (`GET /finance/reconciliation?from&to`)

- `ReconciliationSummary`: `from`, `to`, `orderTotalTZS`, `paymentTotalTZS`, `matched`, `exceptions`. Summary card with an exceptions count > 0 → support-ticket CTA prefilled with the range; `RECONCILIATION_EXCEPTION` surfaces as a banner with retry. Cross-check: settlement entries should aggregate to `paymentTotalTZS` — the client never recomputes totals.

## Payment methods, history, reversal (`/payments/*`)

| Method | Path | Purpose | Response |
| --- | --- | --- | --- |
| GET | `/payments/methods` | Supported methods with availability | `[{method, available}]` |
| GET | `/payments/history?limit&cursor` | Payment transactions | `[{id, method, amountTZS, status, reference, createdAt}]` |
| POST | `/payments/{intentId}/reverse` | Reverse a payment (finance role); body `reason` ≤500 | `PaymentIntent` |

- Method enum: `mpesa` / `tigo_pesa` / `airtel_money` / `ezy_pesa` / `halotel` / `card` / `cod` / `bank`; history status enum: `created`/`pending`/`paid`/`failed`/`refunded`/`reversed`. Methods render as trust chips with availability dots (DESIGN-SYSTEM); history rows show method, `amountTZS`, status pill, `reference` (masked where applicable), local time.
- Reversal is finance-role only (403 otherwise): confirm dialog with reason → spinner → intent status `reversed`; the merchant surfaces it in history, never triggers it.

## Revenue composition

- `GET /analytics/revenue?from&to` splits total by channel: `delivery` / `dine_in` / `group_buy` / `pickup` (ANALYTICS.md).
- Reconciliation habit: wallet `settlement` + `group_buy_settlement` transactions should aggregate to the same money as the analytics revenue chart minus commission/refunds — both surfaces render server values only; the client never recomputes.

## Screen states and rules

- Every finance surface (history, statement, withdrawals, transactions, collection QR, bank cards, invoices, settlements, reconciliation, payment history) implements loading skeleton → empty state → error + retry → success content; 429 honored; money always `TZS 1,234` with separators.
- Earners see only their own entries (account-owner scoping enforced server-side). MSW parity: payout statuses, `exception` payloads, ledger entry types, `commission` entries, wallet projection, withdrawal statuses/errors, `WalletTransaction.type` values, `PaymentQr` payloads, `BankCard` masking + `BANK_CARD_LIMIT_REACHED`, invoice statuses + `INVOICE_NOT_ISSUABLE`, settlement statuses + `SETTLEMENT_ALREADY_PAID`, reconciliation summary, payment methods/history enums, and reversal 403 paths must match the contract.

# Round-2 additions (deep survey — `docs/REFERENCE-SURVEY.md`)

## Expense tracking (`/finance/expenses`)

| Method | Path | Purpose | Response |
| --- | --- | --- | --- |
| GET | `/finance/expenses?from&to` | Expense records | `ExpenseRecord[]` |
| POST | `/finance/expenses` | Record an expense | `ExpenseRecord` / 201 |
| DELETE | `/finance/expenses/{expenseId}` | Delete an expense | 204 |

`ExpenseRecord`: `category` enum `ingredients` / `delivery` / `packaging` / `platform_fees` / `rent` / `utilities` / `staff` / `marketing` / `equipment` / `other`, `amountTZS` (integer), `note` <=500, `incurredAt`, `createdAt`.

- UI: expenses list with category chips and a date-range filter; add form (category picker → `amountTZS` integer → note) → saving spinner → success toast; delete is confirm-first (204, row leaves the list; a stale id 404s with a refetch banner).
- Money renders `TZS 1,234` with separators. Expenses are merchant-side bookkeeping — they never touch the wallet/ledger (which stays immutable); they display alongside settlement totals for net-profit reading.
- States: loading skeleton → empty ("No expenses recorded") → error + retry → list with category pills.

## Transaction issue reporting (`/finance/transactions/{transactionId}/issue`)

| Method | Path | Purpose | Response |
| --- | --- | --- | --- |
| POST | `/finance/transactions/{transactionId}/issue` | Report an issue on a transaction | `{ticketId, status}` / 201 |

- Body: `issueType` enum `amount_mismatch` / `missing_items` / `other` (required) + `description` <=500 (required). Response: `{ticketId, status: open}`.
- UI: "Report an issue" action on payment-history and settlement rows → type chips → description → submit → success card with `ticketId` linking into the support ticket thread (EDUCATION-SUPPORT.md). Errors: 404 on stale transaction refs (banner + refetch), 422 field mapping.
- Download receipt per transaction: the merchant-side receipt source is the reprint list (`GET /orders/receipts`, ORDER-FLOW.md); a per-transaction receipt download on finance rows is a contract gap.

## Settlements, invoices, and withdrawals — reference-app extras (contract gaps)

- **VAT line**: the reference settlement breaks gross → commission → VAT → net. `DailySettlement` exposes `revenueTZS` / `feesTZS` / `payoutTZS` only — no VAT field (contract gap). The UI renders the three contract values; the VAT split is not built.
- **T+1 cycle**: the reference app labels settlements "T+1". The contract cycle is `payoutCycleDays` (default 3) from `MerchantPrivate.commercial`; the UI renders the contract value, never a hardcoded T+1 (contract gap note).
- **Withdraw fee + estimated arrival**: the reference app shows "free above threshold, else fixed fee" and an estimated arrival. `Withdrawal` carries no fee or ETA fields (contract gap); fee rules and arrival estimates stay env-driven server-side when added.
- **Invoice type VAT/Standard + taxId + taxRate**: `Invoice` (`draft` / `requested` / `issued` / `paid`) has no type, `taxId`, or `taxRate` fields (contract gap). The invoice request form currently collects `buyerDetails` free-form until the contract grows.

# Round-3 additions — ledger, settlement, reconciliation (reference contract tests)

Behaviors verified against the reference contract suite (`tests/contract.test.ts`) and the server sweeper (`src/mock/sweeper.ts`).

## Ledger balance invariant

- The ledger balances against its entries: `balance` is never negative and is the running sum of signed entries. Any mismatch between the wallet projection and the statement is a bug (dashboard-reconciliation rule).

## Settlement run

- A settlement run is a daily batch: `gross` / `commission` / `tax` all positive, an invoice is created (`draft`) then issued, and payout marks the settlement `paid`.
- A repeat run for the same day → 409 `ALREADY_SETTLED` (reference suite).

## Reconciliation

- `GET /finance/reconciliation` compares daily ledger totals against settlement totals; the reference suite asserts one row per day, each with a boolean `ok`. Exceptions count > 0 feeds the support-ticket path (`RECONCILIATION_EXCEPTION`).

## Payment method breakdown

- The payment-methods surface (`GET /payments/methods`) returns the non-empty method list backing the finance revenue-composition breakdown (channel shares sum to ~100, methods carry amount + share).

## Withdrawal anomaly risk flag

- A withdrawal greater than 80% of the available balance raises a `withdrawal-anomaly` risk event (`medium`), produced by the sweeper risk engine (TASKS-RISK.md).
