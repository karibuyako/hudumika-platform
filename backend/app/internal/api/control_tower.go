package api

// CONTROL-TOWER bounded context (API-CONTRACT.yaml /admin/control-tower and
// /admin/fleet/control-tower): staff read surfaces over the orders, reviews,
// merchants and riders tables.
//
// Gating: /admin/* route policy restricts these routes to MFA-verified staff
// before the handler runs; the handlers still resolve the session and fail
// hard (500 INTERNAL_ERROR) when no database is wired. Optional-context
// tables (reviews 00008, merchants 00017, riders 00006) are guarded with
// to_regclass and contribute honest zeros until they land.
//
// Mapping notes: the OperationsControlTower shape exposes totals,
// networkHealth and criticalActions; the pending-reviews, pending-merchants,
// unassigned-paid and webhook-backlog aggregates specified for this surface
// have no OperationsControlTower field in this contract revision and are
// omitted (documented deviation). FleetOverview is hub-oriented; the riders
// table carries no fleet_type column, so byFleetType carries the rider
// vehicle values (motorcycle/bicycle/car) as a documented substitution, and
// each city becomes a hub.

import (
	"net/http"
	"time"

	"github.com/google/uuid"

	"github.com/hudumika/api-backend/internal/gen"
	openapi_types "github.com/oapi-codegen/runtime/types"
)

// fleetOpenStatuses are the in-flight order statuses that count as active
// deliveries in the control towers.
var fleetOpenStatuses = []string{
	"paid", "merchant_accepted", "preparing", "rider_assigned",
	"picked_up", "delivering",
}

// AdminOperationsControlTower returns the platform-wide operations snapshot
// (GET /admin/control-tower, OperationsControlTower schema). ordersToday
// counts today's orders, activeDeliveries the in-flight statuses, ridersOnline
// the online rider count (guarded) and pendingDisputes the disputed orders.
// Network health reports all-normal (100/0/0) — no delay detection pipeline
// is wired — and every critical action count is an honest zero.
func (s *Server) AdminOperationsControlTower(w http.ResponseWriter, r *http.Request) {
	if _, ok := ClaimsFromContext(r.Context()); !ok {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing or invalid bearer token")
		return
	}
	if s.db == nil {
		s.logger.Error("operations control tower failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	ctx := r.Context()
	now := time.Now()

	dayStart := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)
	var ordersToday int
	if err := s.db.Pool().QueryRow(ctx,
		`SELECT count(*) FROM orders WHERE created_at >= $1`, dayStart).Scan(&ordersToday); err != nil {
		s.logger.Error("control tower orders today failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	activeDeliveries := 0
	rows, err := s.db.Pool().Query(ctx,
		`SELECT status, count(*) FROM orders WHERE status = ANY($1) GROUP BY status`, fleetOpenStatuses)
	if err != nil {
		s.logger.Error("control tower open orders query failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	for rows.Next() {
		var (
			status string
			count  int
		)
		if err := rows.Scan(&status, &count); err != nil {
			rows.Close()
			s.logger.Error("scan control tower open order failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		activeDeliveries += count
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		s.logger.Error("iterate control tower open orders failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	rows.Close()

	var pendingDisputes int
	if err := s.db.Pool().QueryRow(ctx,
		`SELECT count(*) FROM orders WHERE status = 'disputed'`).Scan(&pendingDisputes); err != nil {
		s.logger.Error("control tower disputes query failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	ridersOnline := 0
	if s.analyticsTableExists(ctx, "riders") {
		if err := s.db.Pool().QueryRow(ctx,
			`SELECT count(*) FROM riders WHERE online`).Scan(&ridersOnline); err != nil {
			s.logger.Error("control tower riders online query failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
	}

	zero, zeroF := 0, float32(0)
	normal := float32(100)
	writeJSON(w, http.StatusOK, gen.OperationsControlTower{
		GeneratedAt: now,
		Totals: &struct {
			ActiveDeliveries  *int `json:"activeDeliveries,omitempty"`
			ActiveServiceJobs *int `json:"activeServiceJobs,omitempty"`
			DelayedShipments  *int `json:"delayedShipments,omitempty"`
			OpenIncidents     *int `json:"openIncidents,omitempty"`
			OrdersToday       *int `json:"ordersToday,omitempty"`
			PendingDisputes   *int `json:"pendingDisputes,omitempty"`
			ProvidersOnline   *int `json:"providersOnline,omitempty"`
			RidersOnline      *int `json:"ridersOnline,omitempty"`
		}{
			OrdersToday:       &ordersToday,
			ActiveDeliveries:  &activeDeliveries,
			ActiveServiceJobs: &zero,
			ProvidersOnline:   &zero,
			RidersOnline:      &ridersOnline,
			OpenIncidents:     &zero,
			DelayedShipments:  &zero,
			PendingDisputes:   &pendingDisputes,
		},
		NetworkHealth: struct {
			DeliveryNetwork *struct {
				CriticalPct *float32 `json:"criticalPct,omitempty"`
				DelayedPct  *float32 `json:"delayedPct,omitempty"`
				NormalPct   *float32 `json:"normalPct,omitempty"`
			} `json:"deliveryNetwork,omitempty"`
			ServiceNetwork *struct {
				CapacityIssuePct *float32 `json:"capacityIssuePct,omitempty"`
				CriticalPct      *float32 `json:"criticalPct,omitempty"`
				NormalPct        *float32 `json:"normalPct,omitempty"`
			} `json:"serviceNetwork,omitempty"`
		}{
			DeliveryNetwork: &struct {
				CriticalPct *float32 `json:"criticalPct,omitempty"`
				DelayedPct  *float32 `json:"delayedPct,omitempty"`
				NormalPct   *float32 `json:"normalPct,omitempty"`
			}{CriticalPct: &zeroF, DelayedPct: &zeroF, NormalPct: &normal},
			ServiceNetwork: &struct {
				CapacityIssuePct *float32 `json:"capacityIssuePct,omitempty"`
				CriticalPct      *float32 `json:"criticalPct,omitempty"`
				NormalPct        *float32 `json:"normalPct,omitempty"`
			}{CapacityIssuePct: &zeroF, CriticalPct: &zeroF, NormalPct: &normal},
		},
		CriticalActions: struct {
			FraudCases          *int `json:"fraudCases,omitempty"`
			HubCapacityWarnings *int `json:"hubCapacityWarnings,omitempty"`
			PaymentFailures     *int `json:"paymentFailures,omitempty"`
			ProviderIncidents   *int `json:"providerIncidents,omitempty"`
			ShipmentExceptions  *int `json:"shipmentExceptions,omitempty"`
			SlaBreaches         *int `json:"slaBreaches,omitempty"`
		}{
			ShipmentExceptions:  &zero,
			ProviderIncidents:   &zero,
			PaymentFailures:     &zero,
			FraudCases:          &zero,
			SlaBreaches:         &zero,
			HubCapacityWarnings: &zero,
		},
	})
}

// AdminFleetControlTower returns the fleet snapshot across riders (GET
// /admin/fleet/control-tower, FleetOverview schema): totals (active and
// online riders, active orders, in-transit), byFleetType carrying the rider
// vehicle distribution (the riders table has no fleet_type column — the
// vehicle values stand in, documented), and hubs keyed by city with rider
// and order counts. The optional hubId param filters by city; fleetType is
// accepted and ignored until the riders table gains a fleet-type column.
func (s *Server) AdminFleetControlTower(w http.ResponseWriter, r *http.Request, params gen.AdminFleetControlTowerParams) {
	if _, ok := ClaimsFromContext(r.Context()); !ok {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing or invalid bearer token")
		return
	}
	if s.db == nil {
		s.logger.Error("fleet control tower failed: database not configured")
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	ctx := r.Context()
	now := time.Now()

	type riderBucket struct {
		cityID   *uuid.UUID
		cityName string
		vehicle  string
		count    int
		online   int
	}

	// cityKey is the stable map key for a bucket's city ("" when unassigned).
	cityKey := func(b riderBucket) string {
		if b.cityID == nil {
			return ""
		}
		return b.cityID.String()
	}
	buckets := make([]riderBucket, 0, 8)
	totalRiders, totalOnline := 0, 0
	if s.analyticsTableExists(ctx, "riders") {
		var hubCityID *uuid.UUID
		if params.HubId != nil {
			id := uuid.UUID(*params.HubId)
			hubCityID = &id
		}
		rows, err := s.db.Pool().Query(ctx,
			`SELECT r.city_id, COALESCE(c.name, ''), r.vehicle, count(*), count(*) FILTER (WHERE r.online)
			 FROM riders r
			 LEFT JOIN cities c ON c.id = r.city_id
			 WHERE ($1::uuid IS NULL OR r.city_id = $1)
			 GROUP BY r.city_id, c.name, r.vehicle
			 ORDER BY c.name, r.vehicle`,
			hubCityID)
		if err != nil {
			s.logger.Error("fleet riders query failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		for rows.Next() {
			var b riderBucket
			if err := rows.Scan(&b.cityID, &b.cityName, &b.vehicle, &b.count, &b.online); err != nil {
				rows.Close()
				s.logger.Error("scan fleet rider row failed", "error", err)
				writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
				return
			}
			buckets = append(buckets, b)
			totalRiders += b.count
			totalOnline += b.online
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			s.logger.Error("iterate fleet rider rows failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		rows.Close()
	}

	// Delivery stats: open orders per rider city, and the in-transit subset
	// (picked_up + delivering) for the totals.
	cityActive := map[string]int{}
	activeOrders, inTransit := 0, 0
	if len(buckets) > 0 {
		rows, err := s.db.Pool().Query(ctx,
			`SELECT r.city_id, o.status, count(*)
			 FROM orders o
			 JOIN riders r ON r.id = o.rider_id
			 WHERE o.status = ANY($1)
			 GROUP BY r.city_id, o.status`,
			fleetOpenStatuses)
		if err != nil {
			s.logger.Error("fleet delivery stats query failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		for rows.Next() {
			var (
				cityID *uuid.UUID
				status string
				count  int
			)
			if err := rows.Scan(&cityID, &status, &count); err != nil {
				rows.Close()
				s.logger.Error("scan fleet delivery row failed", "error", err)
				writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
				return
			}
			key := ""
			if cityID != nil {
				key = cityID.String()
			}
			cityActive[key] += count
			activeOrders += count
			if status == "picked_up" || status == "delivering" {
				inTransit += count
			}
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			s.logger.Error("iterate fleet delivery rows failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		rows.Close()
	}

	byFleetType := make([]struct {
		Count     int                                   `json:"count"`
		FleetType gen.FleetOverviewByFleetTypeFleetType `json:"fleetType"`
	}, 0, len(buckets))
	vehicleTotals := map[string]int{}
	hubs := make([]struct {
		ActiveOrders *int               `json:"activeOrders,omitempty"`
		ActiveRiders *int               `json:"activeRiders,omitempty"`
		Anomalies    *int               `json:"anomalies,omitempty"`
		HubId        openapi_types.UUID `json:"hubId"`
		Name         string             `json:"name"`
		Region       string             `json:"region"`
	}, 0, len(buckets))
	hubIndex := map[string]int{}
	zero := 0
	for _, b := range buckets {
		vehicleTotals[b.vehicle] += b.count
		name := b.cityName
		if name == "" {
			name = "Unassigned"
		}
		idx, seen := hubIndex[name]
		if !seen {
			hubID := uuid.Nil
			if b.cityID != nil {
				hubID = *b.cityID
			}
			hubs = append(hubs, struct {
				ActiveOrders *int               `json:"activeOrders,omitempty"`
				ActiveRiders *int               `json:"activeRiders,omitempty"`
				Anomalies    *int               `json:"anomalies,omitempty"`
				HubId        openapi_types.UUID `json:"hubId"`
				Name         string             `json:"name"`
				Region       string             `json:"region"`
			}{ActiveOrders: &zero, ActiveRiders: &zero, Anomalies: &zero, HubId: newUUID(hubID.String()), Name: name, Region: ""})
			idx = len(hubs) - 1
			hubIndex[name] = idx
			// Attach the city's open-order count once per hub; subsequent
			// vehicle buckets of the same city must not double-count.
			if n, ok := cityActive[cityKey(b)]; ok {
				*hubs[idx].ActiveOrders += n
			}
		}
		*hubs[idx].ActiveRiders += b.count
	}
	for vehicle, count := range vehicleTotals {
		byFleetType = append(byFleetType, struct {
			Count     int                                   `json:"count"`
			FleetType gen.FleetOverviewByFleetTypeFleetType `json:"fleetType"`
		}{Count: count, FleetType: gen.FleetOverviewByFleetTypeFleetType(vehicle)})
	}

	writeJSON(w, http.StatusOK, gen.FleetOverview{
		GeneratedAt: now,
		Totals: struct {
			ActiveOrders *int `json:"activeOrders,omitempty"`
			ActiveRiders *int `json:"activeRiders,omitempty"`
			Anomalies    *int `json:"anomalies,omitempty"`
			InTransit    *int `json:"inTransit,omitempty"`
			OnlineRiders *int `json:"onlineRiders,omitempty"`
			OpenSos      *int `json:"openSos,omitempty"`
		}{
			ActiveRiders: analyticsIntPtr(totalRiders),
			OnlineRiders: analyticsIntPtr(totalOnline),
			ActiveOrders: analyticsIntPtr(activeOrders),
			InTransit:    analyticsIntPtr(inTransit),
			Anomalies:    &zero,
			OpenSos:      &zero,
		},
		ByFleetType: &byFleetType,
		Hubs:        hubs,
	})
}
