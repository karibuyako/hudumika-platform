-- +goose Up
-- Hotels bounded context (CONTRACT-ADDITIONS.md "Hotels — /hotels
-- resource"): city-scoped hotel search, room-level detail, and customer
-- hotel bookings with server-computed TZS totals. The city reference is a
-- denormalized (id, name) snapshot — the consumer contract exposes cityId
-- as a string and cityName for display, and seed/demo data may reference
-- cities outside the core cities table.
CREATE TABLE hotels (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id        uuid,
    name               text NOT NULL,
    city_id            text NOT NULL,
    city_name          text NOT NULL,
    star_rating        int CHECK (star_rating BETWEEN 1 AND 5),
    rating             numeric(2, 1) NOT NULL DEFAULT 4.5,
    review_count       int NOT NULL DEFAULT 0,
    address_line       text,
    description        text,
    amenities          jsonb NOT NULL DEFAULT '[]'::jsonb,
    -- Starting price = cheapest room's per-night rate (the server derives
    -- it; clients never supply money).
    starting_price_tzs int NOT NULL CHECK (starting_price_tzs >= 0),
    available_rooms    int NOT NULL DEFAULT 0 CHECK (available_rooms >= 0),
    image_url          text,
    created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_hotels_city ON hotels (city_id, created_at, id);

CREATE TABLE hotel_rooms (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    hotel_id           uuid NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
    name               text NOT NULL,
    price_per_night_tzs int NOT NULL CHECK (price_per_night_tzs >= 0),
    capacity           int NOT NULL DEFAULT 2 CHECK (capacity >= 1),
    available          boolean NOT NULL DEFAULT true,
    amenities          jsonb NOT NULL DEFAULT '[]'::jsonb
);

CREATE INDEX idx_hotel_rooms_hotel ON hotel_rooms (hotel_id);

CREATE TABLE hotel_bookings (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    hotel_id         uuid NOT NULL REFERENCES hotels(id),
    room_id          uuid NOT NULL REFERENCES hotel_rooms(id),
    user_id          uuid NOT NULL REFERENCES users(id),
    -- Denormalized snapshots for the contract projection (hotelName,
    -- roomName, nights are derived at booking time).
    hotel_name       text NOT NULL,
    room_name        text NOT NULL,
    check_in         date NOT NULL,
    check_out        date NOT NULL CHECK (check_out > check_in),
    nights           int NOT NULL CHECK (nights >= 1),
    guests           int NOT NULL CHECK (guests BETWEEN 1 AND 10),
    contact_phone    text,
    total_tzs        bigint NOT NULL CHECK (total_tzs >= 0),
    status           text NOT NULL DEFAULT 'pending_payment' CHECK (status IN ('pending_payment', 'confirmed', 'cancelled', 'completed')),
    idempotency_key  text,
    created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_hotel_bookings_user_created ON hotel_bookings (user_id, created_at DESC, id DESC);
CREATE UNIQUE INDEX idx_hotel_bookings_user_idempotency ON hotel_bookings (user_id, idempotency_key);

-- +goose Down
DROP TABLE IF EXISTS hotel_bookings;
DROP TABLE IF EXISTS hotel_rooms;
DROP TABLE IF EXISTS hotels;