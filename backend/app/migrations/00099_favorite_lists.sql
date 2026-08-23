-- +goose Up
-- Favorite lists (consumer parity v1, ORGANIZE FAVORITES): user-organized
-- collections of merchant favorites. The simple favorites table (00016) is the
-- flat set; favorite_lists is the named-container layer. favorite_list_merchants
-- is the join (list -> merchant). Merchant rows are referenced by id only
-- (no FK to merchants table to keep consumer migrations independent of merchant
-- onboarding state) but a UUID check guards format. List name is 1-40 chars.
-- Idempotency is enforced by (user_id, name) uniqueness — a retry with same
-- key returns the stored list; a key reuse with different name is rejected
-- at the API layer (422), not here (constraint is informational).

CREATE TABLE favorite_lists (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name       text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 40),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, name)
);

CREATE INDEX idx_favorite_lists_user ON favorite_lists (user_id, created_at DESC);

CREATE TABLE favorite_list_merchants (
    list_id     uuid NOT NULL REFERENCES favorite_lists(id) ON DELETE CASCADE,
    merchant_id uuid NOT NULL,
    added_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (list_id, merchant_id)
);

CREATE INDEX idx_favorite_list_merchants_list ON favorite_list_merchants (list_id);
CREATE INDEX idx_favorite_list_merchants_merchant ON favorite_list_merchants (merchant_id);

-- +goose Down
DROP TABLE IF EXISTS favorite_list_merchants;
DROP TABLE IF EXISTS favorite_lists;
