-- +goose Up
-- CUSTOMER WITHDRAWALS (API-CONTRACT.yaml /wallet/withdrawals/me): the
-- earner cash-out surface (/wallet/withdrawals, POST + GET) already lives on
-- payout_entries for merchant/provider/rider wallets (00010, wallet.go);
-- CUSTOMER wallet withdrawals have no table of their own (wallet_transactions
-- does not exist — the wallet is a projection of ledger_entries), so this
-- milestone adds the customer request ledger. Requests are created by a
-- customer withdrawal flow (a future POST /wallet/withdrawals/me request
-- surface, mock-first today: mock/wallet.ts) and read by GET
-- /wallet/withdrawals/me. completed_at is the cash-out settlement moment
-- (contract Withdrawal.paidAt); the contract status enum projects
-- 'completed' as 'paid'.

CREATE TABLE IF NOT EXISTS customer_withdrawals (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    amount_tzs   bigint NOT NULL CHECK (amount_tzs > 0),
    method       text NOT NULL CHECK (method IN ('mpesa', 'tigo', 'airtel', 'bank')),
    destination  text NOT NULL,
    status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
    created_at   timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_customer_withdrawals_user ON customer_withdrawals (user_id, created_at DESC, id DESC);

-- +goose Down
DROP TABLE IF EXISTS customer_withdrawals;