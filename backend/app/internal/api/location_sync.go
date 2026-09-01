package api

import (
	"context"
	"encoding/json"
	"log/slog"
	"math"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
)

// LocationSync bridges rider locations from Redis to PostgreSQL.
// It runs as a background goroutine, polling Redis every 5 seconds
// and upserting into live_locations.
func (s *Server) LocationSync(ctx context.Context) {
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.syncLocations(ctx)
		}
	}
}

func (s *Server) syncLocations(ctx context.Context) {
	if s.db == nil || s.stores == nil || s.stores.Redis == nil {
		return
	}

	client := s.stores.Redis.Client()

	// Scan for rider location keys stored by OnlineRegistry: "rider:loc:{uuid}"
	iter := client.Scan(ctx, 0, "rider:loc:*", 100).Iterator()
	var positions []RiderPosition

	for iter.Next(ctx) {
		key := iter.Val()
		riderIDStr := strings.TrimPrefix(key, "rider:loc:")
		riderID, err := uuid.Parse(riderIDStr)
		if err != nil {
			continue
		}

		vals, err := client.HMGet(ctx, key, "lat", "lon", "speed", "heading", "accuracy", "activity").Result()
		if err != nil || len(vals) < 2 || vals[0] == nil || vals[1] == nil {
			continue
		}

		lat, err := strconv.ParseFloat(vals[0].(string), 64)
		if err != nil {
			continue
		}
		lon, err := strconv.ParseFloat(vals[1].(string), 64)
		if err != nil {
			continue
		}

		pos := RiderPosition{
			EntityID:  riderID,
			Lat:       lat,
			Lon:       lon,
			UpdatedAt: time.Now(),
		}
		if len(vals) > 2 && vals[2] != nil {
			if v, err := strconv.ParseFloat(vals[2].(string), 32); err == nil {
				f := float32(v)
				pos.SpeedKmh = &f
			}
		}
		if len(vals) > 3 && vals[3] != nil {
			if v, err := strconv.ParseFloat(vals[3].(string), 32); err == nil {
				f := float32(v)
				pos.Heading = &f
			}
		}
		if len(vals) > 4 && vals[4] != nil {
			if v, err := strconv.ParseFloat(vals[4].(string), 32); err == nil {
				f := float32(v)
				pos.AccuracyM = &f
			}
		}
		if len(vals) > 5 && vals[5] != nil {
			if activity, ok := vals[5].(string); ok && activity != "" {
				pos.Activity = activity
			}
		}
		positions = append(positions, pos)
	}

	if err := iter.Err(); err != nil {
		slog.Error("location sync: scan failed", "error", err)
		return
	}

	if len(positions) == 0 {
		return
	}

	// Batch upsert into live_locations
	tx, err := s.db.Pool().Begin(ctx)
	if err != nil {
		slog.Error("location sync: begin tx failed", "error", err)
		return
	}
	defer tx.Rollback(ctx)

	for _, pos := range positions {
		_, err := tx.Exec(ctx, `
			INSERT INTO live_locations (entity_type, entity_id, lat, lon, speed_kmh, heading, accuracy_m, updated_at)
			VALUES ('rider', $1, $2, $3, $4, $5, $6, now())
			ON CONFLICT (entity_type, entity_id)
			DO UPDATE SET lat = EXCLUDED.lat, lon = EXCLUDED.lon,
			             speed_kmh = EXCLUDED.speed_kmh, heading = EXCLUDED.heading,
			             accuracy_m = EXCLUDED.accuracy_m,
			             updated_at = EXCLUDED.updated_at`,
			pos.EntityID, pos.Lat, pos.Lon, pos.SpeedKmh, pos.Heading, pos.AccuracyM)
		if err != nil {
			slog.Error("location sync: upsert failed", "riderId", pos.EntityID, "error", err)
		}
	}

	if err := tx.Commit(ctx); err != nil {
		slog.Error("location sync: commit failed", "error", err)
	}

	// Broadcast to WebSocket subscribers
	if hub != nil {
		hub.BroadcastRiderPositions(positions)
	}

	// Check geofences
	s.checkGeofences(ctx, positions)
}

func (s *Server) checkGeofences(ctx context.Context, positions []RiderPosition) {
	if s.db == nil {
		return
	}

	rows, err := s.db.Pool().Query(ctx, `SELECT id, name, type, boundary FROM geofences WHERE active = true`)
	if err != nil {
		return
	}
	defer rows.Close()

	type geofenceRow struct {
		ID       uuid.UUID
		Name     string
		Type     string
		Boundary json.RawMessage
	}

	var geofences []geofenceRow
	for rows.Next() {
		var g geofenceRow
		if err := rows.Scan(&g.ID, &g.Name, &g.Type, &g.Boundary); err != nil {
			continue
		}
		geofences = append(geofences, g)
	}

	for _, pos := range positions {
		for _, fence := range geofences {
			inside, err := pointInGeoJSON(fence.Boundary, pos.Lat, pos.Lon)
			if err != nil {
				continue
			}

			var lastEvent string
			_ = s.db.Pool().QueryRow(ctx, `
				SELECT COALESCE(
					(SELECT event_type FROM geofence_events
					 WHERE geofence_id = $1 AND entity_id = $2
					 ORDER BY created_at DESC LIMIT 1), ''
				)`, fence.ID, pos.EntityID).Scan(&lastEvent)

			if inside && lastEvent != "entry" {
				_, _ = s.db.Pool().Exec(ctx, `
					INSERT INTO geofence_events (geofence_id, entity_type, entity_id, event_type, lat, lon)
					VALUES ($1, 'rider', $2, 'entry', $3, $4)`,
					fence.ID, pos.EntityID, pos.Lat, pos.Lon)
				slog.Info("geofence entry", "rider", pos.EntityID, "fence", fence.Name)
			} else if !inside && lastEvent == "entry" {
				_, _ = s.db.Pool().Exec(ctx, `
					INSERT INTO geofence_events (geofence_id, entity_type, entity_id, event_type, lat, lon)
					VALUES ($1, 'rider', $2, 'exit', $3, $4)`,
					fence.ID, pos.EntityID, pos.Lat, pos.Lon)
				slog.Info("geofence exit", "rider", pos.EntityID, "fence", fence.Name)
			}
		}
	}
}

func pointInGeoJSON(geojson json.RawMessage, lat, lon float64) (bool, error) {
	var geom struct {
		Type        string          `json:"type"`
		Coordinates json.RawMessage `json:"coordinates"`
	}
	if err := json.Unmarshal(geojson, &geom); err != nil {
		return false, err
	}

	switch geom.Type {
	case "Polygon":
		return pointInPolygon(geom.Coordinates, lat, lon)
	case "MultiPolygon":
		var multi [][][][]float64
		if err := json.Unmarshal(geom.Coordinates, &multi); err != nil {
			return false, err
		}
		for _, polygon := range multi {
			if len(polygon) == 0 {
				continue
			}
			inside, err := pointInRing(polygon[0], lat, lon)
			if err != nil {
				continue
			}
			if inside {
				return true, nil
			}
		}
		return false, nil
	case "Circle":
		var circle struct {
			Center [2]float64 `json:"center"`
			Radius float64    `json:"radius"`
		}
		if err := json.Unmarshal(geom.Coordinates, &circle); err != nil {
			return false, err
		}
		return haversineDistance(lat, lon, circle.Center[1], circle.Center[0]) <= circle.Radius, nil
	}
	return false, nil
}

func pointInPolygon(coords json.RawMessage, lat, lon float64) (bool, error) {
	var rings [][][]float64
	if err := json.Unmarshal(coords, &rings); err != nil {
		return false, err
	}
	if len(rings) == 0 {
		return false, nil
	}
	return pointInRing(rings[0], lat, lon)
}

func pointInRing(ring [][]float64, lat, lon float64) (bool, error) {
	if len(ring) < 3 {
		return false, nil
	}
	inside := false
	j := len(ring) - 1
	for i := 0; i < len(ring); i++ {
		xi, yi := ring[i][0], ring[i][1]
		xj, yj := ring[j][0], ring[j][1]
		if ((yi > lat) != (yj > lat)) && (lon < (xj-xi)*(lat-yi)/(yj-yi)+xi) {
			inside = !inside
		}
		j = i
	}
	return inside, nil
}

func haversineDistance(lat1, lon1, lat2, lon2 float64) float64 {
	const R = 6371000
	dLat := (lat2 - lat1) * math.Pi / 180
	dLon := (lon2 - lon1) * math.Pi / 180
	a := math.Sin(dLat/2)*math.Sin(dLat/2) +
		math.Cos(lat1*math.Pi/180)*math.Cos(lat2*math.Pi/180)*
			math.Sin(dLon/2)*math.Sin(dLon/2)
	c := 2 * math.Atan2(math.Sqrt(a), math.Sqrt(1-a))
	return R * c
}
