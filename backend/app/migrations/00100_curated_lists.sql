-- +goose Up
-- Curated merchant lists (Meituan 必吃榜-lite): editorial, server-owned ranked
-- collections (titleKey/taglineKey are i18n keys, not freeform). The app
-- previously rendered these from a constant (src/lib/lists.ts); this table
-- makes them server-authored and live. merchant_ids is a jsonb array of
-- ranked merchant uuids (rank 0 = best). No FK to merchants — the resolvers
-- filter to present merchants (graceful drift).

CREATE TABLE curated_lists (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    title_key   text NOT NULL,
    tagline_key text NOT NULL,
    merchant_ids jsonb NOT NULL DEFAULT '[]',
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (title_key)
);

CREATE INDEX idx_curated_lists_created ON curated_lists (created_at DESC);

-- Seed with the three demo lists that mirror src/lib/lists.ts so the home
-- rail degrades identically before and after migration.
INSERT INTO curated_lists (id, title_key, tagline_key, merchant_ids) VALUES
    ('11111111-1111-1111-1111-111111111111', 'lists.darTopRated', 'lists.darTopRatedTagline',
     '["d1f206e6-bb6a-455f-b437-ccf8aa274808","14ce25f5-f8e2-43ba-9161-457fc471cd17","a26cd7cd-652a-4e76-8be7-26b02d09fa54"]'::jsonb),
    ('22222222-2222-2222-2222-222222222222', 'lists.fastestDelivery', 'lists.fastestDeliveryTagline',
     '["f5cc61c3-a431-4b32-95e5-7c329944c6e5","a26cd7cd-652a-4e76-8be7-26b02d09fa54","bec77d23-7a83-438d-aff7-d88a4e222273"]'::jsonb),
    ('33333333-3333-3333-3333-333333333333', 'lists.mwanzaPopular', 'lists.mwanzaPopularTagline',
     '["f9baf8bb-1c6e-4998-b6f6-992b803bda89","9fb7f83f-fe1b-492f-941a-84210795f140","d1f206e6-bb6a-455f-b437-ccf8aa274808"]'::jsonb)
ON CONFLICT (title_key) DO NOTHING;

-- +goose Down
DROP TABLE IF EXISTS curated_lists;
