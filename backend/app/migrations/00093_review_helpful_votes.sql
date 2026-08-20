-- +goose Up
CREATE TABLE IF NOT EXISTS review_helpful_votes (
    review_id uuid NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (review_id, user_id)
);

-- +goose Down
DROP TABLE IF EXISTS review_helpful_votes;
