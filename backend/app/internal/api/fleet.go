package api

import (
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/hudumika/api-backend/internal/auth"
	"github.com/hudumika/api-backend/internal/gen"
)

// FLEET-ACCOUNTS (API-CONTRACT.yaml /fleet/accounts; ERROR-CODES.md §Fleet
// accounts). A fleet master account is owned by exactly one users row and a
// user may own at most one (UNIQUE owner_user_id → 409). The contract
// carries the account as gen.FleetAccount (name, vehicles, regions); the
// storage row keeps the milestone projection fleet_name, vehicle_count, city:
//
//	name           -> fleet_name
//	len(vehicles)  -> vehicle_count
//	first region   -> city
//
// Staff sessions (admin/finance/ops/compliance, rbac.go) see every account;
// any other authenticated session sees only its own.

// fleetAccountRow is the storage projection of a fleet master account.
type fleetAccountRow struct {
	id           uuid.UUID
	ownerUserID  uuid.UUID
	fleetName    string
	vehicleCount int
	status       string
	city         *string
	createdAt    time.Time
}

// fleetAccountColumns is the shared SELECT list for fleet_accounts reads.
const fleetAccountColumns = `id, owner_user_id, fleet_name, vehicle_count, status, city, created_at`

// scanFleetAccount scans one fleetAccountRow from the shared column order.
func scanFleetAccount(row pgx.Row) (fleetAccountRow, error) {
	var a fleetAccountRow
	err := row.Scan(&a.id, &a.ownerUserID, &a.fleetName, &a.vehicleCount, &a.status, &a.city, &a.createdAt)
	return a, err
}

// toFleetAccount maps the storage row onto the contract FleetAccount.
func toFleetAccount(a fleetAccountRow) gen.FleetAccount {
	status := gen.FleetAccountStatus(a.status)
	owner := newUUID(a.ownerUserID.String())
	return gen.FleetAccount{
		Id:          newUUID(a.id.String()),
		Name:        a.fleetName,
		OwnerUserId: &owner,
		Status:      status,
		CreatedAt:   &a.createdAt,
	}
}

// fleetOwnerID resolves the authenticated session to their users row id.
// Every authenticated session may pass (rider fleet-owners, customers and
// staff alike); a missing database is a 500 (same convention as walletUser),
// and a missing users row is a 404.
func (s *Server) fleetOwnerID(w http.ResponseWriter, r *http.Request) (uuid.UUID, bool) {
	claims, ok := ClaimsFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing or invalid bearer token")
		return uuid.Nil, false
	}
	if s.db == nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return uuid.Nil, false
	}
	user, err := auth.NewRepo(s.db.Pool()).GetUserByPhone(r.Context(), claims.Subject)
	if err != nil {
		s.logger.Error("fleet owner lookup failed", "subject", claims.Subject, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return uuid.Nil, false
	}
	if user == nil {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "No account for this session")
		return uuid.Nil, false
	}
	return user.ID, true
}

// ListFleetAccounts returns the fleet master accounts the session may see
// (GET /fleet/accounts). Staff sessions see every account; any other
// authenticated session sees only the accounts it owns (an empty list when
// it owns none).
func (s *Server) ListFleetAccounts(w http.ResponseWriter, r *http.Request) {
	claims, ok := ClaimsFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing or invalid bearer token")
		return
	}
	if s.db == nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if !isStaffRole(claims.Role) {
		ownerID, ok := s.fleetOwnerID(w, r)
		if !ok {
			return
		}
		rows, err := s.db.Pool().Query(r.Context(),
			`SELECT `+fleetAccountColumns+`
			 FROM fleet_accounts WHERE owner_user_id = $1
			 ORDER BY created_at DESC`, ownerID)
		if err != nil {
			s.logger.Error("fleet accounts list failed", "owner", ownerID, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		defer rows.Close()
		accounts := make([]gen.FleetAccount, 0)
		for rows.Next() {
			a, err := scanFleetAccount(rows)
			if err != nil {
				s.logger.Error("fleet accounts scan failed", "error", err)
				writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
				return
			}
			accounts = append(accounts, toFleetAccount(a))
		}
		if err := rows.Err(); err != nil {
			s.logger.Error("fleet accounts rows failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		writeJSON(w, http.StatusOK, accounts)
		return
	}
	rows, err := s.db.Pool().Query(r.Context(),
		`SELECT `+fleetAccountColumns+` FROM fleet_accounts ORDER BY created_at DESC`)
	if err != nil {
		s.logger.Error("fleet accounts list failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer rows.Close()
	accounts := make([]gen.FleetAccount, 0)
	for rows.Next() {
		a, err := scanFleetAccount(rows)
		if err != nil {
			s.logger.Error("fleet accounts scan failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		accounts = append(accounts, toFleetAccount(a))
	}
	if err := rows.Err(); err != nil {
		s.logger.Error("fleet accounts rows failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, accounts)
}

// CreateFleetAccount creates a fleet master account (POST /fleet/accounts).
// The body is the contract FleetAccount: name is required (422
// VALIDATION_FAILED when blank), ownerUserId defaults to the session user —
// a non-staff session may only create its own (403), staff may assign any
// owner. At most one account per owner: the unique owner_user_id constraint
// surfaces as 409.
func (s *Server) CreateFleetAccount(w http.ResponseWriter, r *http.Request) {
	ownerID, ok := s.fleetOwnerID(w, r)
	if !ok {
		return
	}
	claims, _ := ClaimsFromContext(r.Context())

	body := gen.CreateFleetAccountJSONRequestBody{}
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	name := strings.TrimSpace(body.Name)
	if name == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "name is required")
		return
	}
	if len(name) > 120 {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "name must be at most 120 characters")
		return
	}
	if body.OwnerUserId != nil {
		requested := uuid.MustParse(body.OwnerUserId.String())
		if requested != ownerID && !isStaffRole(claims.Role) {
			writeError(w, http.StatusForbidden, "FORBIDDEN",
				"A fleet account can only be created for the session user")
			return
		}
		ownerID = requested
	}
	status := "active"
	if body.Status != "" {
		switch body.Status {
		case gen.FleetAccountStatusActive, gen.FleetAccountStatusSuspended:
			status = string(body.Status)
		default:
			writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "status is invalid")
			return
		}
	}
	vehicleCount := 0
	if body.Vehicles != nil {
		vehicleCount = len(*body.Vehicles)
	}
	var city *string
	if body.Regions != nil && len(*body.Regions) > 0 {
		c := strings.TrimSpace((*body.Regions)[0])
		if c != "" {
			city = &c
		}
	}

	var id uuid.UUID
	var createdAt time.Time
	err := s.db.Pool().QueryRow(r.Context(),
		`INSERT INTO fleet_accounts (owner_user_id, fleet_name, vehicle_count, status, city)
		 VALUES ($1, $2, $3, $4, $5)
		 RETURNING id, created_at`,
		ownerID, name, vehicleCount, status, city).Scan(&id, &createdAt)
	if err != nil {
		if isUniqueViolation(err) {
			writeError(w, http.StatusConflict, "CONFLICT",
				"The session user already owns a fleet account")
			return
		}
		s.logger.Error("fleet account insert failed", "owner", ownerID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	created := toFleetAccount(fleetAccountRow{
		id:           id,
		ownerUserID:  ownerID,
		fleetName:    name,
		vehicleCount: vehicleCount,
		status:       status,
		city:         city,
		createdAt:    createdAt,
	})
	writeJSON(w, http.StatusCreated, created)
}
