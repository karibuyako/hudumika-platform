-- +goose Up
-- MEDIA-CATALOGUE bounded context (backend/DATA-MODEL.md §barcode, combo,
-- menu, video; backend/ERROR-CODES.md §print jobs and categories, §barcodes,
-- combos, menus, videos): barcodes, combos, menus, videos and print_jobs.
-- merchant_id is the owning merchant's users row id (same milestone
-- simplification as the catalogues context).

CREATE TABLE barcodes (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id       uuid NOT NULL,
    code              text NOT NULL UNIQUE,
    catalogue_item_id uuid NOT NULL,
    format            text NOT NULL DEFAULT 'ean13'
                      CHECK (format IN ('ean13', 'code128', 'qr')),
    created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_barcodes_merchant_item ON barcodes (merchant_id, catalogue_item_id);

CREATE TABLE combos (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id        uuid NOT NULL,
    name               text NOT NULL,
    description        text,
    price_tzs          bigint NOT NULL DEFAULT 0 CHECK (price_tzs >= 0),
    original_price_tzs bigint NOT NULL DEFAULT 0 CHECK (original_price_tzs >= 0),
    items              jsonb NOT NULL DEFAULT '[]',
    image_url          text,
    active             boolean NOT NULL DEFAULT true,
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_combos_merchant_active ON combos (merchant_id, active);

CREATE TABLE menus (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id uuid NOT NULL,
    name        text NOT NULL,
    category_id uuid,
    items       jsonb NOT NULL DEFAULT '[]',
    active      boolean NOT NULL DEFAULT true,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_menus_merchant_active ON menus (merchant_id, active);

CREATE TABLE videos (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id       uuid NOT NULL,
    title             text NOT NULL,
    url               text NOT NULL,
    thumbnail_url     text,
    catalogue_item_id uuid,
    active            boolean NOT NULL DEFAULT true,
    created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_videos_merchant ON videos (merchant_id);

CREATE TABLE print_jobs (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id uuid NOT NULL,
    device_id   uuid,
    job_type    text NOT NULL DEFAULT 'receipt'
                CHECK (job_type IN ('receipt', 'kitchen_ticket', 'label', 'voucher')),
    content     text NOT NULL,
    label       text,
    copies      int NOT NULL DEFAULT 1 CHECK (copies > 0),
    order_ids   jsonb,
    table_id    uuid,
    status      text NOT NULL DEFAULT 'queued'
                CHECK (status IN ('queued', 'printing', 'printed', 'done', 'failed')),
    error       text,
    created_at  timestamptz NOT NULL DEFAULT now(),
    printed_at  timestamptz
);

CREATE INDEX idx_print_jobs_merchant_status ON print_jobs (merchant_id, status);

-- +goose Down
DROP TABLE IF EXISTS print_jobs;
DROP TABLE IF EXISTS videos;
DROP TABLE IF EXISTS menus;
DROP TABLE IF EXISTS combos;
DROP TABLE IF EXISTS barcodes;
