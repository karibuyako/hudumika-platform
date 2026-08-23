// Package bus implements the city-bus transport bounded context: routes,
// stops, vehicles and passenger stop reminders. Handlers live in
// internal/api/bus.go.
package bus

import (
	"context"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	ErrRouteNotFound  = errors.New("bus route not found")
	ErrVehicleNotFound = errors.New("bus vehicle not found")
)

// Store wraps the connection pool for bus persistence.
type Store struct {
	pool *pgxpool.Pool
}

func NewStore(pool *pgxpool.Pool) *Store { return &Store{pool: pool} }

// StopRow is one row of bus_stops.
type StopRow struct {
	ID       uuid.UUID `json:"id"`
	Name     string    `json:"name"`
	Sequence int       `json:"sequence"`
	Lat      *float64  `json:"lat,omitempty"`
	Lon      *float64  `json:"lon,omitempty"`
}

// RouteRow is a bus route with its stops loaded.
type RouteRow struct {
	ID                uuid.UUID `json:"id"`
	RouteNumber       string    `json:"routeNumber"`
	RouteName         string    `json:"routeName"`
	Origin            string    `json:"origin"`
	Destination       string    `json:"destination"`
	FareTZS           int64     `json:"fareTZS"`
	DurationMinutes   int       `json:"durationMinutes"`
	FrequencyMinutes  int       `json:"frequencyMinutes"`
	OperatingHours    string    `json:"operatingHours"`
	Stops             []StopRow `json:"stops"`
}

// VehicleRow is one row of bus_vehicles.
type VehicleRow struct {
	ID                 uuid.UUID `json:"id"`
	RouteID            uuid.UUID `json:"routeId"`
	RouteNumber        string    `json:"routeNumber"`
	PlateNumber        string    `json:"plateNumber"`
	Lat                *float64  `json:"lat,omitempty"`
	Lon                *float64  `json:"lon,omitempty"`
	Heading            float64   `json:"heading"`
	NextStopID         *uuid.UUID `json:"nextStopId,omitempty"`
	NextStopName       *string   `json:"nextStopName,omitempty"`
	NextStopSequence   *int      `json:"nextStopSequence,omitempty"`
	Occupancy          string    `json:"occupancy"`
	LastUpdatedAt      string    `json:"lastUpdatedAt"`
}

// ReminderRow is one row of bus_reminders.
type ReminderRow struct {
	ID          uuid.UUID `json:"id"`
	RouteID     uuid.UUID `json:"routeId"`
	RouteNumber string    `json:"routeNumber"`
	StopID      uuid.UUID `json:"stopId"`
	StopName    string    `json:"stopName"`
	Enabled     bool      `json:"enabled"`
	CreatedAt   string    `json:"createdAt"`
}

func scanRoute(row pgx.Row, r *RouteRow) error {
	return row.Scan(&r.ID, &r.RouteNumber, &r.RouteName, &r.Origin, &r.Destination,
		&r.FareTZS, &r.DurationMinutes, &r.FrequencyMinutes, &r.OperatingHours)
}

func (s *Store) loadStops(ctx context.Context, routeID uuid.UUID) ([]StopRow, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT id, name, sequence, lat, lon FROM bus_stops WHERE route_id = $1 ORDER BY sequence`, routeID)
	if err != nil {
		return nil, fmt.Errorf("bus: load stops %s: %w", routeID, err)
	}
	defer rows.Close()
	out := make([]StopRow, 0)
	for rows.Next() {
		var st StopRow
		if err := rows.Scan(&st.ID, &st.Name, &st.Sequence, &st.Lat, &st.Lon); err != nil {
			return nil, fmt.Errorf("bus: scan stop: %w", err)
		}
		out = append(out, st)
	}
	return out, rows.Err()
}

// ListRoutes returns routes matching origin/destination (case-insensitive
// contains); empty parameters skip that filter. Stops are loaded for each.
func (s *Store) ListRoutes(ctx context.Context, origin, destination string) ([]RouteRow, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT id, route_number, route_name, origin, destination, fare_tzs, duration_minutes, frequency_minutes, operating_hours
		 FROM bus_routes
		 WHERE ($1 = '' OR origin ILIKE '%' || $1 || '%')
		   AND ($2 = '' OR destination ILIKE '%' || $2 || '%')
		 ORDER BY route_number`, origin, destination)
	if err != nil {
		return nil, fmt.Errorf("bus: list routes: %w", err)
	}
	defer rows.Close()
	out := make([]RouteRow, 0)
	for rows.Next() {
		var r RouteRow
		if err := scanRoute(rows, &r); err != nil {
			return nil, err
		}
		stops, err := s.loadStops(ctx, r.ID)
		if err != nil {
			return nil, err
		}
		r.Stops = stops
		out = append(out, r)
	}
	return out, rows.Err()
}

// GetRoute returns a single route with its stops; ErrRouteNotFound if absent.
func (s *Store) GetRoute(ctx context.Context, id uuid.UUID) (*RouteRow, error) {
	var r RouteRow
	if err := scanRoute(s.pool.QueryRow(ctx,
		`SELECT id, route_number, route_name, origin, destination, fare_tzs, duration_minutes, frequency_minutes, operating_hours
		 FROM bus_routes WHERE id = $1`, id), &r); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, fmt.Errorf("bus: get route %s: %w", id, ErrRouteNotFound)
		}
		return nil, fmt.Errorf("bus: get route %s: %w", id, err)
	}
	stops, err := s.loadStops(ctx, id)
	if err != nil {
		return nil, err
	}
	r.Stops = stops
	return &r, nil
}

// ListVehicles returns the live vehicles of a route.
func (s *Store) ListVehicles(ctx context.Context, routeID uuid.UUID) ([]VehicleRow, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT id, route_id, route_number, plate_number, lat, lon, heading, next_stop_id, next_stop_name, next_stop_sequence, occupancy,
		        to_char(last_updated_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
		 FROM bus_vehicles WHERE route_id = $1 ORDER BY plate_number`, routeID)
	if err != nil {
		return nil, fmt.Errorf("bus: list vehicles %s: %w", routeID, err)
	}
	defer rows.Close()
	out := make([]VehicleRow, 0)
	for rows.Next() {
		var v VehicleRow
		if err := rows.Scan(&v.ID, &v.RouteID, &v.RouteNumber, &v.PlateNumber, &v.Lat, &v.Lon, &v.Heading,
			&v.NextStopID, &v.NextStopName, &v.NextStopSequence, &v.Occupancy, &v.LastUpdatedAt); err != nil {
			return nil, fmt.Errorf("bus: scan vehicle: %w", err)
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

// GetVehicle returns a single vehicle; ErrVehicleNotFound if absent.
func (s *Store) GetVehicle(ctx context.Context, id uuid.UUID) (*VehicleRow, error) {
	var v VehicleRow
	if err := s.pool.QueryRow(ctx,
		`SELECT id, route_id, route_number, plate_number, lat, lon, heading, next_stop_id, next_stop_name, next_stop_sequence, occupancy,
		        to_char(last_updated_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
		 FROM bus_vehicles WHERE id = $1`, id).
		Scan(&v.ID, &v.RouteID, &v.RouteNumber, &v.PlateNumber, &v.Lat, &v.Lon, &v.Heading,
			&v.NextStopID, &v.NextStopName, &v.NextStopSequence, &v.Occupancy, &v.LastUpdatedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, fmt.Errorf("bus: get vehicle %s: %w", id, ErrVehicleNotFound)
		}
		return nil, fmt.Errorf("bus: get vehicle %s: %w", id, err)
	}
	return &v, nil
}

// ListReminders returns the caller's stop reminders.
func (s *Store) ListReminders(ctx context.Context, userID uuid.UUID) ([]ReminderRow, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT id, route_id, route_number, stop_id, stop_name, enabled,
		        to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
		 FROM bus_reminders WHERE user_id = $1 ORDER BY created_at DESC`, userID)
	if err != nil {
		return nil, fmt.Errorf("bus: list reminders: %w", err)
	}
	defer rows.Close()
	out := make([]ReminderRow, 0)
	for rows.Next() {
		var r ReminderRow
		if err := rows.Scan(&r.ID, &r.RouteID, &r.RouteNumber, &r.StopID, &r.StopName, &r.Enabled, &r.CreatedAt); err != nil {
			return nil, fmt.Errorf("bus: scan reminder: %w", err)
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// UpsertReminder creates or enables a reminder. When enabled is false the
// reminder is removed and (nil, nil) is returned so the handler can answer
// null. Route and stop metadata is resolved from the referenced rows.
func (s *Store) UpsertReminder(ctx context.Context, userID, routeID, stopID uuid.UUID, enabled bool) (*ReminderRow, error) {
	if !enabled {
		if _, err := s.pool.Exec(ctx,
			`DELETE FROM bus_reminders WHERE user_id = $1 AND route_id = $2 AND stop_id = $3`,
			userID, routeID, stopID); err != nil {
			return nil, fmt.Errorf("bus: delete reminder: %w", err)
		}
		return nil, nil
	}
	var routeNumber string
	if err := s.pool.QueryRow(ctx, `SELECT route_number FROM bus_routes WHERE id = $1`, routeID).Scan(&routeNumber); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, fmt.Errorf("bus: reminder route %s: %w", routeID, ErrRouteNotFound)
		}
		return nil, fmt.Errorf("bus: lookup route: %w", err)
	}
	var stopName string
	if err := s.pool.QueryRow(ctx, `SELECT name FROM bus_stops WHERE id = $1 AND route_id = $2`, stopID, routeID).Scan(&stopName); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, fmt.Errorf("bus: reminder stop %s: %w", stopID, ErrRouteNotFound)
		}
		return nil, fmt.Errorf("bus: lookup stop: %w", err)
	}
	if _, err := s.pool.Exec(ctx,
		`INSERT INTO bus_reminders (user_id, route_id, route_number, stop_id, stop_name, enabled)
		 VALUES ($1, $2, $3, $4, $5, true)
		 ON CONFLICT (user_id, route_id, stop_id) DO UPDATE SET enabled = true, route_number = EXCLUDED.route_number, stop_name = EXCLUDED.stop_name`,
		userID, routeID, routeNumber, stopID, stopName); err != nil {
		return nil, fmt.Errorf("bus: upsert reminder: %w", err)
	}
	var r ReminderRow
	if err := s.pool.QueryRow(ctx,
		`SELECT id, route_id, route_number, stop_id, stop_name, enabled,
		        to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
		 FROM bus_reminders WHERE user_id = $1 AND route_id = $2 AND stop_id = $3`,
		userID, routeID, stopID).
		Scan(&r.ID, &r.RouteID, &r.RouteNumber, &r.StopID, &r.StopName, &r.Enabled, &r.CreatedAt); err != nil {
		return nil, fmt.Errorf("bus: reload reminder: %w", err)
	}
	return &r, nil
}
