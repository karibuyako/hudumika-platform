// Package rides implements the ride-hailing bounded context (taxi / private
// hire). Handlers live in internal/api/rides.go.
package rides

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"hash/fnv"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	ErrRideNotFound      = errors.New("ride not found")
	ErrRideNotCancellable = errors.New("ride not cancellable")
)

// Store wraps the connection pool for ride persistence.
type Store struct{ pool *pgxpool.Pool }

func NewStore(pool *pgxpool.Pool) *Store { return &Store{pool: pool} }

// Coord is a geographic point.
type Coord struct {
	Lat float64 `json:"lat"`
	Lon float64 `json:"lon"`
}

// Driver is the matched driver detail returned on a ride.
type Driver struct {
	ID       string  `json:"id"`
	Name     string  `json:"name"`
	Phone    string  `json:"phone"`
	Plate    string  `json:"plate"`
	CarModel string  `json:"carModel"`
	CarColor string  `json:"carColor"`
	Rating   float64 `json:"rating"`
	Avatar   *string `json:"avatar,omitempty"`
}

// RideRow is one row of rides.
type RideRow struct {
	ID                uuid.UUID  `json:"id"`
	Pickup            string     `json:"pickup"`
	Destination       string     `json:"destination"`
	PickupCoord       *Coord     `json:"pickupCoord,omitempty"`
	DestinationCoord  *Coord     `json:"destinationCoord,omitempty"`
	RideType          string     `json:"rideType"`
	FareTZS           int64      `json:"fareTZS"`
	DistanceKm        float64    `json:"distanceKm"`
	DurationMin       int        `json:"durationMin"`
	Status            string     `json:"status"`
	Driver            *Driver    `json:"driver,omitempty"`
	EtaMin            *int       `json:"etaMin,omitempty"`
	CreatedAt         string     `json:"createdAt"`
	UpdatedAt         string     `json:"updatedAt"`
}

// CreateInput carries the fields needed to open a ride.
type CreateInput struct {
	UserID           uuid.UUID
	Pickup           string
	Destination      string
	PickupCoord      *Coord
	DestinationCoord *Coord
	RideType         string
}

func hashStr(s string) uint32 {
	h := fnv.New32a()
	_, _ = h.Write([]byte(s))
	return h.Sum32()
}

// Estimate computes a deterministic fare, distance and duration from the
// pickup/destination/type. The same inputs always yield the same quote.
func Estimate(pickup, destination, rideType string) (fareTZS int64, distanceKm float64, durationMin int) {
	distanceKm = float64((hashStr(pickup)%25+hashStr(destination)%25)/2 + 1)
	durationMin = int(distanceKm*2) + 5
	var base, perKm int64
	switch rideType {
	case "premier":
		base, perKm = 4000, 1200
	case "taxi":
		base, perKm = 3000, 1000
	default: // express
		base, perKm = 2500, 800
	}
	fareTZS = base + int64(distanceKm*float64(perKm))
	return
}

func syntheticDriver(seed uint32) *Driver {
	models := []string{"Toyota Vitz", "Honda Fit", "Nissan Note", "Suzuki Swift"}
	colors := []string{"White", "Silver", "Black", "Blue"}
	names := []string{"Juma", "Asha", "Moshi", "Neema", "Khalid"}
	n := seed % uint32(len(names))
	return &Driver{
		ID:       fmt.Sprintf("drv-%08d", seed%100000000),
		Name:     names[n],
		Phone:    fmt.Sprintf("+2557%07d", seed%10000000),
		Plate:    fmt.Sprintf("T %d ABC", 100+int(seed%899)),
		CarModel: models[seed%uint32(len(models))],
		CarColor: colors[seed%uint32(len(colors))],
		Rating:   4.2 + float64(seed%8)/10,
	}
}

const rideSelect = `SELECT id, pickup, destination, pickup_coord, destination_coord, ride_type, fare_tzs, distance_km, duration_min, status, driver, eta_min,
	to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), to_char(updated_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
	FROM rides`

func scanRide(rows pgx.Rows, r *RideRow) error {
	var pickupCoord, destCoord, driverJSON []byte
	if err := rows.Scan(&r.ID, &r.Pickup, &r.Destination, &pickupCoord, &destCoord, &r.RideType, &r.FareTZS,
		&r.DistanceKm, &r.DurationMin, &r.Status, &driverJSON, &r.EtaMin, &r.CreatedAt, &r.UpdatedAt); err != nil {
		return err
	}
	if len(pickupCoord) > 0 {
		_ = json.Unmarshal(pickupCoord, &r.PickupCoord)
	}
	if len(destCoord) > 0 {
		_ = json.Unmarshal(destCoord, &r.DestinationCoord)
	}
	if len(driverJSON) > 0 {
		_ = json.Unmarshal(driverJSON, &r.Driver)
	}
	return nil
}

// EstimateQuote returns the fare quote for a prospective ride.
func (s *Store) EstimateQuote(pickup, destination, rideType string) (fareTZS int64, distanceKm float64, durationMin int) {
	return Estimate(pickup, destination, rideType)
}

// Create opens a ride: it computes the fare, immediately matches a synthetic
// driver and returns the ride in the 'matched' state.
func (s *Store) Create(ctx context.Context, in CreateInput) (*RideRow, error) {
	if in.Pickup == "" || in.Destination == "" {
		return nil, fmt.Errorf("rides: pickup and destination are required")
	}
	fare, dist, dur := Estimate(in.Pickup, in.Destination, in.RideType)
	driver := syntheticDriver(hashStr(in.Pickup) ^ hashStr(in.Destination))
	driverJSON, _ := json.Marshal(driver)
	pickupJSON, _ := json.Marshal(in.PickupCoord)
	destJSON, _ := json.Marshal(in.DestinationCoord)
	eta := dur
	var id uuid.UUID
	if err := s.pool.QueryRow(ctx,
		`INSERT INTO rides (user_id, pickup, destination, pickup_coord, destination_coord, ride_type, fare_tzs, distance_km, duration_min, status, driver, eta_min)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'matched',$10,$11) RETURNING id`,
		in.UserID, in.Pickup, in.Destination, pickupJSON, destJSON, in.RideType, fare, dist, dur, driverJSON, eta).Scan(&id); err != nil {
		return nil, fmt.Errorf("rides: create: %w", err)
	}
	return s.Get(ctx, in.UserID, id)
}

// Get returns a ride owned by the user; ErrRideNotFound if absent.
func (s *Store) Get(ctx context.Context, userID, id uuid.UUID) (*RideRow, error) {
	rows, err := s.pool.Query(ctx, rideSelect+` WHERE id = $1 AND user_id = $2`, id, userID)
	if err != nil {
		return nil, fmt.Errorf("rides: get: %w", err)
	}
	defer rows.Close()
	if !rows.Next() {
		if err := rows.Err(); err != nil {
			return nil, err
		}
		return nil, fmt.Errorf("rides: %s: %w", id, ErrRideNotFound)
	}
	var r RideRow
	if err := scanRide(rows, &r); err != nil {
		return nil, fmt.Errorf("rides: scan: %w", err)
	}
	return &r, nil
}

// ListMine returns the user's rides, newest first.
func (s *Store) ListMine(ctx context.Context, userID uuid.UUID) ([]RideRow, error) {
	rows, err := s.pool.Query(ctx, rideSelect+` WHERE user_id = $1 ORDER BY created_at DESC`, userID)
	if err != nil {
		return nil, fmt.Errorf("rides: list: %w", err)
	}
	defer rows.Close()
	out := make([]RideRow, 0)
	for rows.Next() {
		var r RideRow
		if err := scanRide(rows, &r); err != nil {
			return nil, fmt.Errorf("rides: scan: %w", err)
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// Cancel cancels a ride that has not yet started; otherwise ErrRideNotCancellable.
func (s *Store) Cancel(ctx context.Context, userID, id uuid.UUID) (*RideRow, error) {
	ride, err := s.Get(ctx, userID, id)
	if err != nil {
		return nil, err
	}
	switch ride.Status {
	case "matching", "matched", "arriving":
		// ok
	default:
		return nil, ErrRideNotCancellable
	}
	if _, err := s.pool.Exec(ctx,
		`UPDATE rides SET status = 'cancelled', updated_at = now() WHERE id = $1 AND user_id = $2`, id, userID); err != nil {
		return nil, fmt.Errorf("rides: cancel: %w", err)
	}
	return s.Get(ctx, userID, id)
}
