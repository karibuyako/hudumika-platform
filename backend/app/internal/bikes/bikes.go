// Package bikes implements the shared-bike (bike-share) bounded context:
// bikes and customer rides. Handlers live in internal/api/bikes.go.
package bikes

import (
	"context"
	"errors"
	"fmt"
	"math"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	ErrBikeNotFound       = errors.New("bike not found")
	ErrBikeNotAvailable   = errors.New("bike not available")
	ErrRideNotFound       = errors.New("ride not found")
	ErrRideAlreadyActive  = errors.New("ride already active")
	ErrRideNotActive      = errors.New("ride not active")
)

// Store wraps the connection pool for bike persistence.
type Store struct{ pool *pgxpool.Pool }

func NewStore(pool *pgxpool.Pool) *Store { return &Store{pool: pool} }

// BikeRow is one row of bikes. DistanceM is computed at query time, never
// persisted.
type BikeRow struct {
	ID                 uuid.UUID `json:"id"`
	Code               string    `json:"code"`
	Type               string    `json:"type"`
	Status             string    `json:"status"`
	Lat                *float64  `json:"lat,omitempty"`
	Lon                *float64  `json:"lon,omitempty"`
	BatteryPct         *int      `json:"batteryPct,omitempty"`
	DistanceM          *int      `json:"distanceM,omitempty"`
	PricePerMinuteTZS  int64     `json:"pricePerMinuteTZS"`
	UnlockFeeTZS       int64     `json:"unlockFeeTZS"`
}

// FareBreakdown is the nested fare detail of a completed ride.
type FareBreakdown struct {
	UnlockFeeTZS         int64 `json:"unlockFeeTZS"`
	RideFeeTZS           int64 `json:"rideFeeTZS"`
	GeofenceSurchargeTZS int64 `json:"geofenceSurchargeTZS"`
	TotalTZS             int64 `json:"totalTZS"`
}

// RideRow is one row of bike_rides.
type RideRow struct {
	ID                 uuid.UUID     `json:"id"`
	BikeID             uuid.UUID     `json:"bikeId"`
	BikeCode           string        `json:"bikeCode"`
	BikeType           string        `json:"bikeType"`
	Status             string        `json:"status"`
	LockStatus         string        `json:"lockStatus"`
	StartAt            string        `json:"startAt"`
	EndAt              *string       `json:"endAt,omitempty"`
	StartLat           *float64      `json:"startLat,omitempty"`
	StartLon           *float64      `json:"startLon,omitempty"`
	EndLat             *float64      `json:"endLat,omitempty"`
	EndLon             *float64      `json:"endLon,omitempty"`
	DurationMinutes    *int          `json:"durationMinutes,omitempty"`
	DistanceKm         *float64      `json:"distanceKm,omitempty"`
	FareTZS            *int64        `json:"fareTZS,omitempty"`
	GeofenceViolation  bool          `json:"geofenceViolation"`
	PaymentStatus      *string       `json:"paymentStatus,omitempty"`
	PaymentMethod      *string       `json:"paymentMethod,omitempty"`
	FareBreakdown      *FareBreakdown `json:"fareBreakdown,omitempty"`
}

const rideSelect = `SELECT id, bike_id, bike_code, bike_type, status, lock_status,
	to_char(start_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), to_char(end_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
	start_lat, start_lon, end_lat, end_lon, duration_minutes, distance_km, fare_tzs,
	geofence_violation, payment_status, payment_method,
	fare_unlock_fee_tzs, fare_ride_fee_tzs, fare_geofence_surcharge_tzs
	FROM bike_rides`

func scanRide(rows pgx.Rows, r *RideRow) error {
	var startAt string
	var endAt *string
	var startLat, startLon, endLat, endLon, distKm *float64
	var dur *int
	var fare, fareUnlock, fareRide, fareGeo *int64
	var paymentStatus, paymentMethod *string
	if err := rows.Scan(&r.ID, &r.BikeID, &r.BikeCode, &r.BikeType, &r.Status, &r.LockStatus,
		&startAt, &endAt, &startLat, &startLon, &endLat, &endLon, &dur, &distKm, &fare,
		&r.GeofenceViolation, &paymentStatus, &paymentMethod, &fareUnlock, &fareRide, &fareGeo); err != nil {
		return err
	}
	r.StartAt = startAt
	r.EndAt = endAt
	r.StartLat = startLat
	r.StartLon = startLon
	r.EndLat = endLat
	r.EndLon = endLon
	r.DurationMinutes = dur
	r.DistanceKm = distKm
	r.FareTZS = fare
	r.PaymentStatus = paymentStatus
	r.PaymentMethod = paymentMethod
	if fareUnlock != nil || fareRide != nil || fareGeo != nil {
		fb := &FareBreakdown{}
		if fareUnlock != nil {
			fb.UnlockFeeTZS = *fareUnlock
		}
		if fareRide != nil {
			fb.RideFeeTZS = *fareRide
		}
		if fareGeo != nil {
			fb.GeofenceSurchargeTZS = *fareGeo
		}
		fb.TotalTZS = fb.UnlockFeeTZS + fb.RideFeeTZS + fb.GeofenceSurchargeTZS
		r.FareBreakdown = fb
	}
	return nil
}

func haversine(aLat, aLon, bLat, bLon float64) float64 {
	const R = 6371.0
	dLat := (bLat - aLat) * math.Pi / 180
	dLon := (bLon - aLon) * math.Pi / 180
	a := math.Sin(dLat/2)*math.Sin(dLat/2) +
		math.Cos(aLat*math.Pi/180)*math.Cos(bLat*math.Pi/180)*math.Sin(dLon/2)*math.Sin(dLon/2)
	return R * 2 * math.Atan2(math.Sqrt(a), math.Sqrt(1-a))
}

// ListNearby returns available bikes, optionally ordered by straight-line
// distance (meters) from the supplied coordinates.
func (s *Store) ListNearby(ctx context.Context, lat, lon, radiusKm float64) ([]BikeRow, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT id, code, type, status, lat, lon, battery_pct, price_per_minute_tzs, unlock_fee_tzs
		 FROM bikes WHERE status = 'available' ORDER BY code`)
	if err != nil {
		return nil, fmt.Errorf("bikes: list nearby: %w", err)
	}
	defer rows.Close()
	out := make([]BikeRow, 0)
	for rows.Next() {
		var b BikeRow
		if err := rows.Scan(&b.ID, &b.Code, &b.Type, &b.Status, &b.Lat, &b.Lon, &b.BatteryPct, &b.PricePerMinuteTZS, &b.UnlockFeeTZS); err != nil {
			return nil, fmt.Errorf("bikes: scan bike: %w", err)
		}
		if lat != 0 && lon != 0 && b.Lat != nil && b.Lon != nil {
			d := int(haversine(lat, lon, *b.Lat, *b.Lon) * 1000)
			if radiusKm > 0 && float64(d)/1000 > radiusKm {
				continue
			}
			b.DistanceM = &d
		}
		out = append(out, b)
	}
	return out, rows.Err()
}

// GetBike returns a bike by id; ErrBikeNotFound if absent.
func (s *Store) GetBike(ctx context.Context, id uuid.UUID) (*BikeRow, error) {
	var b BikeRow
	if err := s.pool.QueryRow(ctx,
		`SELECT id, code, type, status, lat, lon, battery_pct, price_per_minute_tzs, unlock_fee_tzs
		 FROM bikes WHERE id = $1`, id).
		Scan(&b.ID, &b.Code, &b.Type, &b.Status, &b.Lat, &b.Lon, &b.BatteryPct, &b.PricePerMinuteTZS, &b.UnlockFeeTZS); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, fmt.Errorf("bikes: get %s: %w", id, ErrBikeNotFound)
		}
		return nil, fmt.Errorf("bikes: get %s: %w", id, err)
	}
	return &b, nil
}

// GetByCode returns a bike by its QR/Bluetooth code; ErrBikeNotFound if absent.
func (s *Store) GetByCode(ctx context.Context, code string) (*BikeRow, error) {
	var b BikeRow
	if err := s.pool.QueryRow(ctx,
		`SELECT id, code, type, status, lat, lon, battery_pct, price_per_minute_tzs, unlock_fee_tzs
		 FROM bikes WHERE code = $1`, code).
		Scan(&b.ID, &b.Code, &b.Type, &b.Status, &b.Lat, &b.Lon, &b.BatteryPct, &b.PricePerMinuteTZS, &b.UnlockFeeTZS); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, fmt.Errorf("bikes: code %s: %w", code, ErrBikeNotFound)
		}
		return nil, fmt.Errorf("bikes: code %s: %w", code, err)
	}
	return &b, nil
}

// GetActiveRide returns the caller's in-progress ride (riding/locked) or
// (nil, nil) when none is active.
func (s *Store) GetActiveRide(ctx context.Context, userID uuid.UUID) (*RideRow, error) {
	rows, err := s.pool.Query(ctx, rideSelect+` WHERE user_id = $1 AND status IN ('riding','locked') ORDER BY start_at DESC LIMIT 1`, userID)
	if err != nil {
		return nil, fmt.Errorf("bikes: active ride: %w", err)
	}
	defer rows.Close()
	if !rows.Next() {
		return nil, rows.Err()
	}
	var r RideRow
	if err := scanRide(rows, &r); err != nil {
		return nil, fmt.Errorf("bikes: scan active ride: %w", err)
	}
	return &r, nil
}

// Unlock starts a ride on an available bike. It rejects an already-active ride
// (ErrRideAlreadyActive) and an unavailable bike (ErrBikeNotAvailable).
func (s *Store) Unlock(ctx context.Context, userID, bikeID uuid.UUID) (*RideRow, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("bikes: unlock tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var bike BikeRow
	if err := tx.QueryRow(ctx,
		`SELECT id, code, type, status, lat, lon, battery_pct, price_per_minute_tzs, unlock_fee_tzs
		 FROM bikes WHERE id = $1 FOR UPDATE`, bikeID).
		Scan(&bike.ID, &bike.Code, &bike.Type, &bike.Status, &bike.Lat, &bike.Lon, &bike.BatteryPct, &bike.PricePerMinuteTZS, &bike.UnlockFeeTZS); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, fmt.Errorf("bikes: unlock %s: %w", bikeID, ErrBikeNotFound)
		}
		return nil, fmt.Errorf("bikes: unlock lookup %s: %w", bikeID, err)
	}
	if bike.Status != "available" {
		return nil, ErrBikeNotAvailable
	}
	var active bool
	if err := tx.QueryRow(ctx,
		`SELECT EXISTS(SELECT 1 FROM bike_rides WHERE user_id = $1 AND status IN ('riding','locked'))`, userID).Scan(&active); err != nil {
		return nil, fmt.Errorf("bikes: active check: %w", err)
	}
	if active {
		return nil, ErrRideAlreadyActive
	}
	if _, err := tx.Exec(ctx, `UPDATE bikes SET status = 'riding', updated_at = now() WHERE id = $1`, bikeID); err != nil {
		return nil, fmt.Errorf("bikes: set riding %s: %w", bikeID, err)
	}
	var rideID uuid.UUID
	if err := tx.QueryRow(ctx,
		`INSERT INTO bike_rides (user_id, bike_id, bike_code, bike_type, status, lock_status, start_lat, start_lon)
		 VALUES ($1, $2, $3, $4, 'riding', 'unlocked', $5, $6) RETURNING id`,
		userID, bikeID, bike.Code, bike.Type, bike.Lat, bike.Lon).Scan(&rideID); err != nil {
		return nil, fmt.Errorf("bikes: insert ride: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("bikes: unlock commit: %w", err)
	}
	return s.GetRide(ctx, userID, rideID)
}

func (s *Store) loadRide(ctx context.Context, userID, rideID uuid.UUID, mustOwn bool) (*RideRow, error) {
	q := rideSelect + ` WHERE id = $1`
	var args []any = []any{rideID}
	if mustOwn {
		q += ` AND user_id = $2`
		args = append(args, userID)
	}
	rows, err := s.pool.Query(ctx, q, args...)
	if err != nil {
		return nil, fmt.Errorf("bikes: load ride: %w", err)
	}
	defer rows.Close()
	if !rows.Next() {
		if err := rows.Err(); err != nil {
			return nil, err
		}
		return nil, fmt.Errorf("bikes: ride %s: %w", rideID, ErrRideNotFound)
	}
	var r RideRow
	if err := scanRide(rows, &r); err != nil {
		return nil, fmt.Errorf("bikes: scan ride: %w", err)
	}
	return &r, nil
}

// GetRide returns a ride owned by the user; ErrRideNotFound if absent.
func (s *Store) GetRide(ctx context.Context, userID, rideID uuid.UUID) (*RideRow, error) {
	return s.loadRide(ctx, userID, rideID, true)
}

// ListRides returns the user's ride history, newest first.
func (s *Store) ListRides(ctx context.Context, userID uuid.UUID) ([]RideRow, error) {
	rows, err := s.pool.Query(ctx, rideSelect+` WHERE user_id = $1 ORDER BY start_at DESC`, userID)
	if err != nil {
		return nil, fmt.Errorf("bikes: list rides: %w", err)
	}
	defer rows.Close()
	out := make([]RideRow, 0)
	for rows.Next() {
		var r RideRow
		if err := scanRide(rows, &r); err != nil {
			return nil, fmt.Errorf("bikes: scan ride: %w", err)
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// Lock marks an active ride temporarily locked (bike parked).
func (s *Store) Lock(ctx context.Context, userID, rideID uuid.UUID) (*RideRow, error) {
	ride, err := s.loadRide(ctx, userID, rideID, true)
	if err != nil {
		return nil, err
	}
	if ride.Status == "completed" {
		return nil, ErrRideNotActive
	}
	if _, err := s.pool.Exec(ctx,
		`UPDATE bike_rides SET lock_status = 'locked', updated_at = now() WHERE id = $1`,
		rideID); err != nil {
		return nil, fmt.Errorf("bikes: lock ride: %w", err)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE bikes SET status = 'reserved', updated_at = now() WHERE id = $1`, ride.BikeID); err != nil {
		return nil, fmt.Errorf("bikes: reserve bike: %w", err)
	}
	return s.GetRide(ctx, userID, rideID)
}

// UnlockRide re-unlocks a temporarily locked ride.
func (s *Store) UnlockRide(ctx context.Context, userID, rideID uuid.UUID) (*RideRow, error) {
	ride, err := s.loadRide(ctx, userID, rideID, true)
	if err != nil {
		return nil, err
	}
	if ride.Status == "completed" {
		return nil, ErrRideNotActive
	}
	if _, err := s.pool.Exec(ctx,
		`UPDATE bike_rides SET lock_status = 'unlocked', updated_at = now() WHERE id = $1`,
		rideID); err != nil {
		return nil, fmt.Errorf("bikes: unlock ride: %w", err)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE bikes SET status = 'riding', updated_at = now() WHERE id = $1`, ride.BikeID); err != nil {
		return nil, fmt.Errorf("bikes: ride bike: %w", err)
	}
	return s.GetRide(ctx, userID, rideID)
}

// Finish ends a ride, computing duration, distance and fare, and frees the
// bike. The ride becomes completed with payment pending.
func (s *Store) Finish(ctx context.Context, userID, rideID uuid.UUID, endLat, endLon float64) (*RideRow, error) {
	ride, err := s.loadRide(ctx, userID, rideID, true)
	if err != nil {
		return nil, err
	}
	if ride.Status == "completed" {
		return nil, ErrRideNotActive
	}
	bike, err := s.GetBike(ctx, ride.BikeID)
	if err != nil {
		return nil, err
	}
	start := parseTime(ride.StartAt)
	end := time.Now().UTC()
	minutes := int(math.Max(1, math.Round(end.Sub(start).Minutes())))
	dist := 0.0
	if ride.StartLat != nil && ride.StartLon != nil {
		dist = haversine(*ride.StartLat, *ride.StartLon, endLat, endLon)
	}
	unlockFee := bike.UnlockFeeTZS
	rideFee := bike.PricePerMinuteTZS * int64(minutes)
	total := unlockFee + rideFee
	if _, err := s.pool.Exec(ctx,
		`UPDATE bike_rides
		 SET status = 'completed', lock_status = 'locked', end_at = now(),
		     end_lat = $2, end_lon = $3, duration_minutes = $4, distance_km = $5,
		     fare_tzs = $6, payment_status = 'pending',
		     fare_unlock_fee_tzs = $7, fare_ride_fee_tzs = $8, fare_geofence_surcharge_tzs = 0,
		     updated_at = now()
		 WHERE id = $1`,
		rideID, endLat, endLon, minutes, dist, total, unlockFee, rideFee); err != nil {
		return nil, fmt.Errorf("bikes: finish ride: %w", err)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE bikes SET status = 'available', updated_at = now() WHERE id = $1`, ride.BikeID); err != nil {
		return nil, fmt.Errorf("bikes: free bike: %w", err)
	}
	return s.GetRide(ctx, userID, rideID)
}

// Pay settles a completed ride's fare.
func (s *Store) Pay(ctx context.Context, userID, rideID uuid.UUID, method string) (*RideRow, error) {
	ride, err := s.loadRide(ctx, userID, rideID, true)
	if err != nil {
		return nil, err
	}
	if ride.Status != "completed" {
		return nil, ErrRideNotActive
	}
	if _, err := s.pool.Exec(ctx,
		`UPDATE bike_rides SET payment_status = 'paid', payment_method = $2, updated_at = now() WHERE id = $1`,
		rideID, method); err != nil {
		return nil, fmt.Errorf("bikes: pay ride: %w", err)
	}
	return s.GetRide(ctx, userID, rideID)
}

func parseTime(s string) time.Time {
	t, err := time.Parse(time.RFC3339, s)
	if err != nil {
		return time.Time{}
	}
	return t
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
