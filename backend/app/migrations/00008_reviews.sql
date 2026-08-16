-- +goose Up
-- Reviews (backend/REVIEWS-MODERATION.md): post-completion ratings against
-- merchants, providers, riders or customers. Reviews are created pending and
-- become published through moderation; rating averages are computed over
-- published rows only. Replies are stored inline (one per review), and
-- reports open a moderation case.

CREATE TABLE reviews (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    target_type         text NOT NULL CHECK (target_type IN ('merchant', 'provider', 'rider', 'customer')),
    target_id           uuid NOT NULL,
    author_user_id      uuid REFERENCES users(id),
    order_id            uuid,
    booking_id          uuid,
    rating              int NOT NULL CHECK (rating BETWEEN 1 AND 5),
    body                text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
    state               text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'published', 'hidden', 'deleted')),
    helpful_count       int NOT NULL DEFAULT 0,
    reply_body          text,
    reply_author_user_id uuid,
    reply_created_at    timestamptz,
    created_at          timestamptz NOT NULL DEFAULT now()
);

-- One review per author per target per completion link: the partial index on
-- (author, target, order_id) allows multiple completion links for one target
-- while the partial index on (author, target) keeps a single order-less
-- review per target (Postgres unique indexes treat NULLs as distinct, so
-- order-less rows are only constrained by the order_id IS NULL index).
CREATE UNIQUE INDEX idx_reviews_author_target_order ON reviews (author_user_id, target_type, target_id, order_id) WHERE order_id IS NOT NULL;
CREATE UNIQUE INDEX idx_reviews_author_target ON reviews (author_user_id, target_type, target_id) WHERE order_id IS NULL;
CREATE INDEX idx_reviews_target_state ON reviews (target_type, target_id, state);
CREATE INDEX idx_reviews_state_created ON reviews (state, created_at);

CREATE TABLE review_reports (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    review_id         uuid NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
    reporter_user_id  uuid NOT NULL REFERENCES users(id),
    reason            text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 1000),
    state             text NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'resolved', 'dismissed')),
    created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_review_reports_state ON review_reports (state, created_at);

-- +goose Down
DROP TABLE IF EXISTS review_reports;
DROP TABLE IF EXISTS reviews;
