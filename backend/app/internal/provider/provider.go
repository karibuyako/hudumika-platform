// Package provider is the bounded context for the provider self-service
// surfaces (backend/DATA-MODEL.md provider sections): the provider service
// catalog, weekly availability, team (technicians, certifications, staff),
// parts/equipment inventory, recurring service plans, B2B service
// contracts, documents, portfolio and capabilities. Every row is scoped by
// provider_id — callers resolve the provider from the authenticated session
// before calling in. All SQL is parameterized; sentinel errors carry the
// ERROR-CODES.md codes the API layer maps to HTTP.
package provider

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Sentinel errors surfaced by the store, named after ERROR-CODES.md.
var (
	ErrServiceNotFound        = errors.New("provider: service not found")
	ErrServiceInUse           = errors.New("provider: service is referenced by bookings or plans")
	ErrServiceInvalid         = errors.New("provider: service pricing is invalid")
	ErrTechnicianNotFound     = errors.New("provider: technician not found")
	ErrTechnicianBusy         = errors.New("provider: technician is on a job") // reserved; booking coupling is a later milestone
	ErrCertificationNotFound  = errors.New("provider: certification not found")
	ErrCertificationInvalid   = errors.New("provider: certification dates are invalid")
	ErrStaffNotFound          = errors.New("provider: staff member not found")
	ErrStaffLastOwner         = errors.New("provider: cannot remove the last active owner")
	ErrCapabilityForbidden    = errors.New("provider: unknown capability")
	ErrInventoryItemNotFound  = errors.New("provider: inventory item not found")
	ErrInventoryNegativeStock = errors.New("provider: adjustment would drive stock below zero")
	ErrReasonRequired         = errors.New("provider: adjustment reason required")
	ErrPlanNotFound           = errors.New("provider: service plan not found")
	ErrPlanInUse              = errors.New("provider: plan is referenced by a contract")
	ErrContractNotFound       = errors.New("provider: contract not found")
	ErrDocumentNotFound       = errors.New("provider: document not found")
	ErrDocumentExpired        = errors.New("provider: document is already expired")
	ErrPortfolioInvalid       = errors.New("provider: portfolio is invalid")
	ErrExportInProgress       = errors.New("provider: an export is already in progress")
	ErrInvalidCursor          = errors.New("provider: cursor is invalid")
)

// KnownCapabilities is the documented capability catalog (DATA-MODEL
// §provider_staff). Capability-based permissions are never inherited across
// roles; anything outside this set is rejected with ErrCapabilityForbidden.
var knownCapabilities = []string{
	"view_assigned_jobs", "accept_job", "submit_quote", "assign_technician",
	"complete_job", "view_all_jobs", "view_schedule", "contact_customer",
	"monitor_live_jobs",
}

// KnownCapabilities returns the capability catalog the API advertises on
// GET /providers/me/capabilities.
func KnownCapabilities() []string {
	out := make([]string, len(knownCapabilities))
	copy(out, knownCapabilities)
	return out
}

// ValidateCapabilities rejects any capability outside the documented set.
func ValidateCapabilities(caps []string) error {
	for _, c := range caps {
		ok := false
		for _, known := range knownCapabilities {
			if c == known {
				ok = true
				break
			}
		}
		if !ok {
			return fmt.Errorf("provider: validate capabilities: %w (%q)", ErrCapabilityForbidden, c)
		}
	}
	return nil
}

// Store wraps the connection pool for all provider sub-resource persistence.
type Store struct {
	pool *pgxpool.Pool
}

// NewStore returns a Store bound to the given pool.
func NewStore(pool *pgxpool.Pool) *Store {
	return &Store{pool: pool}
}

// Service is one provider service listing (provider_services).
type Service struct {
	ID          uuid.UUID
	ProviderID  uuid.UUID
	Name        string
	Description *string
	Trade       *string
	DurationMin int
	Pricing     []byte
	Active      bool
	CreatedAt   time.Time
	UpdatedAt   time.Time
}

const serviceColumns = `id, provider_id, name, description, trade, duration_minutes, pricing, active, created_at, updated_at`

func scanService(row pgx.Row) (Service, error) {
	var s Service
	err := row.Scan(&s.ID, &s.ProviderID, &s.Name, &s.Description, &s.Trade,
		&s.DurationMin, &s.Pricing, &s.Active, &s.CreatedAt, &s.UpdatedAt)
	return s, err
}

// ListServices returns the provider's service catalog, oldest first.
func (s *Store) ListServices(ctx context.Context, providerID uuid.UUID) ([]Service, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT `+serviceColumns+` FROM provider_services WHERE provider_id = $1 ORDER BY created_at, id`,
		providerID)
	if err != nil {
		return nil, fmt.Errorf("provider: list services: %w", err)
	}
	defer rows.Close()
	out := make([]Service, 0)
	for rows.Next() {
		svc, err := scanService(rows)
		if err != nil {
			return nil, fmt.Errorf("provider: scan service: %w", err)
		}
		out = append(out, svc)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("provider: iterate services: %w", err)
	}
	return out, nil
}

// GetService loads one service owned by the provider; ErrServiceNotFound
// when it is absent or belongs to another provider.
func (s *Store) GetService(ctx context.Context, providerID, serviceID uuid.UUID) (Service, error) {
	svc, err := scanService(s.pool.QueryRow(ctx,
		`SELECT `+serviceColumns+` FROM provider_services WHERE id = $1 AND provider_id = $2`,
		serviceID, providerID))
	if errors.Is(err, pgx.ErrNoRows) {
		return Service{}, fmt.Errorf("provider: get service %s: %w", serviceID, ErrServiceNotFound)
	}
	if err != nil {
		return Service{}, fmt.Errorf("provider: get service %s: %w", serviceID, err)
	}
	return svc, nil
}

// CreateService inserts a listing. pricing carries the contract's
// {baseTZS, perHourTZS, tripFeeTZS, partsIncluded} object; a negative base
// price is rejected with ErrServiceInvalid.
func (s *Store) CreateService(ctx context.Context, providerID uuid.UUID, name string, description *string, trade string, durationMinutes int, pricing []byte) (Service, error) {
	if err := validatePricing(pricing); err != nil {
		return Service{}, err
	}
	svc, err := scanService(s.pool.QueryRow(ctx,
		`INSERT INTO provider_services (provider_id, name, description, trade, duration_minutes, pricing)
		 VALUES ($1, $2, $3, $4, $5, $6) RETURNING `+serviceColumns,
		providerID, name, description, trade, durationMinutes, pricing))
	if err != nil {
		return Service{}, fmt.Errorf("provider: create service: %w", err)
	}
	return svc, nil
}

// UpdateService patches a listing owned by the provider. active nil keeps
// the stored value. ErrServiceNotFound when the row is missing.
func (s *Store) UpdateService(ctx context.Context, providerID, serviceID uuid.UUID, name string, description *string, trade string, durationMinutes int, pricing []byte, active *bool) (Service, error) {
	if err := validatePricing(pricing); err != nil {
		return Service{}, err
	}
	svc, err := scanService(s.pool.QueryRow(ctx,
		`UPDATE provider_services
		 SET name = $3, description = $4, trade = $5, duration_minutes = $6, pricing = $7,
		     active = COALESCE($8, active), updated_at = now()
		 WHERE id = $1 AND provider_id = $2 RETURNING `+serviceColumns,
		serviceID, providerID, name, description, trade, durationMinutes, pricing, active))
	if errors.Is(err, pgx.ErrNoRows) {
		return Service{}, fmt.Errorf("provider: update service %s: %w", serviceID, ErrServiceNotFound)
	}
	if err != nil {
		return Service{}, fmt.Errorf("provider: update service %s: %w", serviceID, err)
	}
	return svc, nil
}

// DeleteService removes a listing. A service referenced by active bookings
// (bookings.service_id) or by a service plan is protected with
// ErrServiceInUse. (bookings.service_id foreign keys to the catalogue
// services table today, so the booking arm is a forward guard.)
func (s *Store) DeleteService(ctx context.Context, providerID, serviceID uuid.UUID) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("provider: begin delete service tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var exists bool
	if err := tx.QueryRow(ctx,
		`SELECT EXISTS(
			SELECT 1 FROM provider_services WHERE id = $1 AND provider_id = $2)`,
		serviceID, providerID).Scan(&exists); err != nil {
		return fmt.Errorf("provider: lookup service %s: %w", serviceID, err)
	}
	if !exists {
		return fmt.Errorf("provider: delete service %s: %w", serviceID, ErrServiceNotFound)
	}
	var inUse bool
	if err := tx.QueryRow(ctx,
		`SELECT EXISTS(
			SELECT 1 FROM bookings WHERE service_id = $1
			UNION ALL
			SELECT 1 FROM provider_service_plans WHERE service_id = $1)`,
		serviceID).Scan(&inUse); err != nil {
		return fmt.Errorf("provider: service in-use check %s: %w", serviceID, err)
	}
	if inUse {
		return fmt.Errorf("provider: delete service %s: %w", serviceID, ErrServiceInUse)
	}
	if _, err := tx.Exec(ctx,
		`DELETE FROM provider_services WHERE id = $1 AND provider_id = $2`, serviceID, providerID); err != nil {
		return fmt.Errorf("provider: delete service %s: %w", serviceID, err)
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("provider: commit delete service: %w", err)
	}
	return nil
}

// validatePricing enforces non-negative base price on the contract pricing
// object. Missing baseTZS (a fresh zero object) is tolerated as zero.
func validatePricing(pricing []byte) error {
	if len(pricing) == 0 {
		return nil
	}
	var p struct {
		BaseTZS *int `json:"baseTZS"`
	}
	if err := json.Unmarshal(pricing, &p); err != nil {
		return fmt.Errorf("provider: pricing: %w", ErrServiceInvalid)
	}
	if p.BaseTZS != nil && *p.BaseTZS < 0 {
		return fmt.Errorf("provider: pricing: %w", ErrServiceInvalid)
	}
	return nil
}

// SetAvailability merges one weekly window into the provider's availability
// map (keyed by day "0".."6"). window carries the contract AvailabilityWindow
// shape; a window with active=false is still stored so the day reads as
// intentionally closed.
func (s *Store) SetAvailability(ctx context.Context, providerID uuid.UUID, day int, window []byte) error {
	if day < 0 || day > 6 {
		return fmt.Errorf("provider: set availability: day %d out of range", day)
	}
	_, err := s.pool.Exec(ctx,
		`INSERT INTO provider_availability (provider_id, weekly)
		 VALUES ($1, jsonb_build_object($2::text, $3::jsonb))
		 ON CONFLICT (provider_id) DO UPDATE SET
		   weekly = provider_availability.weekly || jsonb_build_object($2::text, $3::jsonb),
		   updated_at = now()`,
		providerID, strconv.Itoa(day), window)
	if err != nil {
		return fmt.Errorf("provider: set availability: %w", err)
	}
	return nil
}

// GetAvailability returns the provider's weekly map (day -> window) as raw
// jsonb; a provider without a row yields an empty map.
func (s *Store) GetAvailability(ctx context.Context, providerID uuid.UUID) ([]byte, error) {
	var weekly []byte
	err := s.pool.QueryRow(ctx,
		`SELECT COALESCE(weekly, '{}'::jsonb) FROM provider_availability WHERE provider_id = $1`,
		providerID).Scan(&weekly)
	if errors.Is(err, pgx.ErrNoRows) {
		return []byte("{}"), nil
	}
	if err != nil {
		return nil, fmt.Errorf("provider: get availability: %w", err)
	}
	return weekly, nil
}

// Technician is one contractor/fleet team member (provider_technicians).
type Technician struct {
	ID             uuid.UUID
	ProviderID     uuid.UUID
	Name           string
	Phone          string
	Trade          string
	Skills         []byte
	Status         string
	CurrentBooking *uuid.UUID
	Rating         *float64
	CreatedAt      time.Time
}

const technicianColumns = `id, provider_id, name, phone, trade, skills, status, current_booking_id, rating, created_at`

func scanTechnician(row pgx.Row) (Technician, error) {
	var t Technician
	err := row.Scan(&t.ID, &t.ProviderID, &t.Name, &t.Phone, &t.Trade, &t.Skills,
		&t.Status, &t.CurrentBooking, &t.Rating, &t.CreatedAt)
	return t, err
}

// ListTechnicians returns the provider's team, oldest first.
func (s *Store) ListTechnicians(ctx context.Context, providerID uuid.UUID) ([]Technician, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT `+technicianColumns+` FROM provider_technicians WHERE provider_id = $1 ORDER BY created_at, id`,
		providerID)
	if err != nil {
		return nil, fmt.Errorf("provider: list technicians: %w", err)
	}
	defer rows.Close()
	out := make([]Technician, 0)
	for rows.Next() {
		t, err := scanTechnician(rows)
		if err != nil {
			return nil, fmt.Errorf("provider: scan technician: %w", err)
		}
		out = append(out, t)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("provider: iterate technicians: %w", err)
	}
	return out, nil
}

// CreateTechnician adds a team member; status defaults to idle.
func (s *Store) CreateTechnician(ctx context.Context, providerID uuid.UUID, name, phone, trade string, skills []byte, status string) (Technician, error) {
	if status == "" {
		status = "idle"
	}
	t, err := scanTechnician(s.pool.QueryRow(ctx,
		`INSERT INTO provider_technicians (provider_id, name, phone, trade, skills, status)
		 VALUES ($1, $2, $3, $4, $5, $6) RETURNING `+technicianColumns,
		providerID, name, phone, trade, skills, status))
	if err != nil {
		return Technician{}, fmt.Errorf("provider: create technician: %w", err)
	}
	return t, nil
}

// UpdateTechnician patches a team member owned by the provider; the new
// skills replace the stored set. ErrTechnicianNotFound when missing.
func (s *Store) UpdateTechnician(ctx context.Context, providerID, technicianID uuid.UUID, name, phone, trade string, skills []byte, status string) (Technician, error) {
	t, err := scanTechnician(s.pool.QueryRow(ctx,
		`UPDATE provider_technicians
		 SET name = $3, phone = $4, trade = $5, skills = $6, status = $7
		 WHERE id = $1 AND provider_id = $2 RETURNING `+technicianColumns,
		technicianID, providerID, name, phone, trade, skills, status))
	if errors.Is(err, pgx.ErrNoRows) {
		return Technician{}, fmt.Errorf("provider: update technician %s: %w", technicianID, ErrTechnicianNotFound)
	}
	if err != nil {
		return Technician{}, fmt.Errorf("provider: update technician %s: %w", technicianID, err)
	}
	return t, nil
}

// DeleteTechnician removes a team member. Bookings assign technicians via
// technician_id in a later milestone, so TECHNICIAN_BUSY (ErrTechnicianBusy)
// is not enforced yet — deletes always succeed here.
func (s *Store) DeleteTechnician(ctx context.Context, providerID, technicianID uuid.UUID) error {
	tag, err := s.pool.Exec(ctx,
		`DELETE FROM provider_technicians WHERE id = $1 AND provider_id = $2`,
		technicianID, providerID)
	if err != nil {
		return fmt.Errorf("provider: delete technician %s: %w", technicianID, err)
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("provider: delete technician %s: %w", technicianID, ErrTechnicianNotFound)
	}
	return nil
}

// Certification is one professional license (provider_certifications).
type Certification struct {
	ID          uuid.UUID
	ProviderID  uuid.UUID
	Type        string
	Number      string
	Issuer      *string
	IssuedAt    *time.Time
	ExpiryDate  *time.Time
	DocumentURL *string
	Verified    bool
	Status      string
	CreatedAt   time.Time
}

// CertificationInput carries the mutable fields of a certification.
type CertificationInput struct {
	Type        string
	Number      string
	Issuer      *string
	IssuedAt    *time.Time
	ExpiryDate  *time.Time
	DocumentURL *string
}

const certificationColumns = `id, provider_id, type, number, issuer, issued_at, expiry_date, document_url, verified, status, created_at`

func scanCertification(row pgx.Row) (Certification, error) {
	var c Certification
	err := row.Scan(&c.ID, &c.ProviderID, &c.Type, &c.Number, &c.Issuer,
		&c.IssuedAt, &c.ExpiryDate, &c.DocumentURL, &c.Verified, &c.Status, &c.CreatedAt)
	if err == nil && c.ExpiryDate != nil && c.ExpiryDate.Before(time.Now()) {
		c.Status = "expired"
	}
	return c, err
}

// validateCertificationDates enforces the CHECK-equivalent rule: expiry must
// come after issue when both are present (CERTIFICATION_INVALID).
func validateCertificationDates(in CertificationInput) error {
	if in.ExpiryDate != nil && in.IssuedAt != nil && !in.ExpiryDate.After(*in.IssuedAt) {
		return fmt.Errorf("provider: certification %s: %w", in.Number, ErrCertificationInvalid)
	}
	return nil
}

// ListCertifications returns the provider's certifications, newest first.
func (s *Store) ListCertifications(ctx context.Context, providerID uuid.UUID) ([]Certification, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT `+certificationColumns+` FROM provider_certifications WHERE provider_id = $1 ORDER BY created_at DESC, id`,
		providerID)
	if err != nil {
		return nil, fmt.Errorf("provider: list certifications: %w", err)
	}
	defer rows.Close()
	out := make([]Certification, 0)
	for rows.Next() {
		c, err := scanCertification(rows)
		if err != nil {
			return nil, fmt.Errorf("provider: scan certification: %w", err)
		}
		out = append(out, c)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("provider: iterate certifications: %w", err)
	}
	return out, nil
}

// CreateCertification adds a license in the pending state. Expiry before
// issue yields ErrCertificationInvalid.
func (s *Store) CreateCertification(ctx context.Context, providerID uuid.UUID, in CertificationInput) (Certification, error) {
	if err := validateCertificationDates(in); err != nil {
		return Certification{}, err
	}
	c, err := scanCertification(s.pool.QueryRow(ctx,
		`INSERT INTO provider_certifications (provider_id, type, number, issuer, issued_at, expiry_date, document_url)
		 VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING `+certificationColumns,
		providerID, in.Type, in.Number, in.Issuer, in.IssuedAt, in.ExpiryDate, in.DocumentURL))
	if err != nil {
		return Certification{}, fmt.Errorf("provider: create certification: %w", err)
	}
	return c, nil
}

// UpdateCertification patches a license owned by the provider; a missing or
// cross-provider row yields ErrCertificationNotFound. The read-only fields
// verified/status are untouched.
func (s *Store) UpdateCertification(ctx context.Context, providerID, certificationID uuid.UUID, in CertificationInput) (Certification, error) {
	if err := validateCertificationDates(in); err != nil {
		return Certification{}, err
	}
	c, err := scanCertification(s.pool.QueryRow(ctx,
		`UPDATE provider_certifications
		 SET type = $3, number = $4, issuer = $5, issued_at = $6, expiry_date = $7, document_url = $8
		 WHERE id = $1 AND provider_id = $2 RETURNING `+certificationColumns,
		certificationID, providerID, in.Type, in.Number, in.Issuer, in.IssuedAt, in.ExpiryDate, in.DocumentURL))
	if errors.Is(err, pgx.ErrNoRows) {
		return Certification{}, fmt.Errorf("provider: update certification %s: %w", certificationID, ErrCertificationNotFound)
	}
	if err != nil {
		return Certification{}, fmt.Errorf("provider: update certification %s: %w", certificationID, err)
	}
	return c, nil
}

// Staff is one provider team member (provider_staff) with explicit,
// never-inherited capabilities.
type Staff struct {
	ID           uuid.UUID
	ProviderID   uuid.UUID
	Name         string
	Phone        string
	Role         string
	Capabilities []byte
	Status       string
	CreatedAt    time.Time
}

// StaffInput carries the mutable fields of a staff member.
type StaffInput struct {
	Name         string
	Phone        string
	Role         string
	Capabilities []byte
	Status       string
}

const staffColumns = `id, provider_id, name, phone, role, capabilities, status, created_at`

func scanStaff(row pgx.Row) (Staff, error) {
	var st Staff
	err := row.Scan(&st.ID, &st.ProviderID, &st.Name, &st.Phone, &st.Role,
		&st.Capabilities, &st.Status, &st.CreatedAt)
	return st, err
}

// ListStaff returns the provider's team, oldest first.
func (s *Store) ListStaff(ctx context.Context, providerID uuid.UUID) ([]Staff, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT `+staffColumns+` FROM provider_staff WHERE provider_id = $1 ORDER BY created_at, id`,
		providerID)
	if err != nil {
		return nil, fmt.Errorf("provider: list staff: %w", err)
	}
	defer rows.Close()
	out := make([]Staff, 0)
	for rows.Next() {
		st, err := scanStaff(rows)
		if err != nil {
			return nil, fmt.Errorf("provider: scan staff: %w", err)
		}
		out = append(out, st)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("provider: iterate staff: %w", err)
	}
	return out, nil
}

// CreateStaff adds a team member; status defaults to invited. Capabilities
// outside the documented set yield ErrCapabilityForbidden.
func (s *Store) CreateStaff(ctx context.Context, providerID uuid.UUID, in StaffInput) (Staff, error) {
	if err := ValidateCapabilities(capStrings(in.Capabilities)); err != nil {
		return Staff{}, err
	}
	if in.Status == "" {
		in.Status = "invited"
	}
	if len(in.Capabilities) == 0 {
		in.Capabilities = []byte("[]")
	}
	st, err := scanStaff(s.pool.QueryRow(ctx,
		`INSERT INTO provider_staff (provider_id, name, phone, role, capabilities, status)
		 VALUES ($1, $2, $3, $4, $5, $6) RETURNING `+staffColumns,
		providerID, in.Name, in.Phone, in.Role, in.Capabilities, in.Status))
	if err != nil {
		return Staff{}, fmt.Errorf("provider: create staff: %w", err)
	}
	return st, nil
}

// UpdateStaff patches a team member owned by the provider. Downgrading or
// deactivating the last active owner is blocked with ErrStaffLastOwner.
// ErrStaffNotFound when missing.
func (s *Store) UpdateStaff(ctx context.Context, providerID, staffID uuid.UUID, in StaffInput) (Staff, error) {
	if err := ValidateCapabilities(capStrings(in.Capabilities)); err != nil {
		return Staff{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Staff{}, fmt.Errorf("provider: begin update staff tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	cur, err := scanStaff(tx.QueryRow(ctx,
		`SELECT `+staffColumns+` FROM provider_staff WHERE id = $1 AND provider_id = $2 FOR UPDATE`,
		staffID, providerID))
	if errors.Is(err, pgx.ErrNoRows) {
		return Staff{}, fmt.Errorf("provider: update staff %s: %w", staffID, ErrStaffNotFound)
	}
	if err != nil {
		return Staff{}, fmt.Errorf("provider: lock staff %s: %w", staffID, err)
	}
	if err := s.guardLastActiveOwner(ctx, tx, providerID, staffID, cur.Role, cur.Status, in.Role, in.Status); err != nil {
		return Staff{}, err
	}
	if len(in.Capabilities) == 0 {
		in.Capabilities = []byte("[]")
	}
	st, err := scanStaff(tx.QueryRow(ctx,
		`UPDATE provider_staff
		 SET name = $3, phone = $4, role = $5, capabilities = $6, status = $7
		 WHERE id = $1 AND provider_id = $2 RETURNING `+staffColumns,
		staffID, providerID, in.Name, in.Phone, in.Role, in.Capabilities, in.Status))
	if err != nil {
		return Staff{}, fmt.Errorf("provider: update staff %s: %w", staffID, err)
	}
	if err := tx.Commit(ctx); err != nil {
		return Staff{}, fmt.Errorf("provider: commit update staff: %w", err)
	}
	return st, nil
}

// DeleteStaff removes a team member. Removing the last active owner is
// blocked with ErrStaffLastOwner; a missing row yields ErrStaffNotFound.
func (s *Store) DeleteStaff(ctx context.Context, providerID, staffID uuid.UUID) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("provider: begin delete staff tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	cur, err := scanStaff(tx.QueryRow(ctx,
		`SELECT `+staffColumns+` FROM provider_staff WHERE id = $1 AND provider_id = $2 FOR UPDATE`,
		staffID, providerID))
	if errors.Is(err, pgx.ErrNoRows) {
		return fmt.Errorf("provider: delete staff %s: %w", staffID, ErrStaffNotFound)
	}
	if err != nil {
		return fmt.Errorf("provider: lock staff %s: %w", staffID, err)
	}
	if err := s.guardLastActiveOwner(ctx, tx, providerID, staffID, cur.Role, cur.Status, "", ""); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx,
		`DELETE FROM provider_staff WHERE id = $1 AND provider_id = $2`, staffID, providerID); err != nil {
		return fmt.Errorf("provider: delete staff %s: %w", staffID, err)
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("provider: commit delete staff: %w", err)
	}
	return nil
}

// guardLastActiveOwner blocks any change (role downgrade, deactivation or
// removal) that would leave the provider without an active owner. nextRole
// and nextStatus of "" mean the row is being deleted.
func (s *Store) guardLastActiveOwner(ctx context.Context, tx pgx.Tx, providerID, staffID uuid.UUID, curRole, curStatus, nextRole, nextStatus string) error {
	becomesOwner := curRole == "owner" && nextRole == "owner" && curStatus == "active" && nextStatus == "active"
	if becomesOwner {
		return nil
	}
	var count int
	if err := tx.QueryRow(ctx,
		`SELECT count(*) FROM provider_staff WHERE provider_id = $1 AND id <> $2 AND role = 'owner' AND status = 'active'`,
		providerID, staffID).Scan(&count); err != nil {
		return fmt.Errorf("provider: count active owners: %w", err)
	}
	if count == 0 {
		return fmt.Errorf("provider: staff %s: %w", staffID, ErrStaffLastOwner)
	}
	return nil
}

// InventoryItem is one part/equipment row (provider_inventory).
type InventoryItem struct {
	ID                   uuid.UUID
	ProviderID           uuid.UUID
	Name                 string
	Category             string
	StockOnHand          int
	LowStockThreshold    int
	UnitCostTZS          *int64
	AssignedTechnicianID *uuid.UUID
	UpdatedAt            time.Time
}

const inventoryColumns = `id, provider_id, name, category, stock_on_hand, low_stock_threshold, unit_cost_tzs, assigned_technician_id, updated_at`

func scanInventoryItem(row pgx.Row) (InventoryItem, error) {
	var it InventoryItem
	err := row.Scan(&it.ID, &it.ProviderID, &it.Name, &it.Category, &it.StockOnHand,
		&it.LowStockThreshold, &it.UnitCostTZS, &it.AssignedTechnicianID, &it.UpdatedAt)
	return it, err
}

// ListInventory returns the provider's inventory, oldest first.
func (s *Store) ListInventory(ctx context.Context, providerID uuid.UUID) ([]InventoryItem, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT `+inventoryColumns+` FROM provider_inventory WHERE provider_id = $1 ORDER BY created_at, id`,
		providerID)
	if err != nil {
		return nil, fmt.Errorf("provider: list inventory: %w", err)
	}
	defer rows.Close()
	out := make([]InventoryItem, 0)
	for rows.Next() {
		it, err := scanInventoryItem(rows)
		if err != nil {
			return nil, fmt.Errorf("provider: scan inventory item: %w", err)
		}
		out = append(out, it)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("provider: iterate inventory: %w", err)
	}
	return out, nil
}

// CreateInventoryItem adds a parts/equipment row; stock defaults to zero.
func (s *Store) CreateInventoryItem(ctx context.Context, providerID uuid.UUID, name, category string, stock, threshold int, unitCost *int64, technicianID *uuid.UUID) (InventoryItem, error) {
	if category == "" {
		category = "part"
	}
	it, err := scanInventoryItem(s.pool.QueryRow(ctx,
		`INSERT INTO provider_inventory (provider_id, name, category, stock_on_hand, low_stock_threshold, unit_cost_tzs, assigned_technician_id)
		 VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING `+inventoryColumns,
		providerID, name, category, stock, threshold, unitCost, technicianID))
	if err != nil {
		return InventoryItem{}, fmt.Errorf("provider: create inventory item: %w", err)
	}
	return it, nil
}

// GetInventoryItem loads one item owned by the provider.
func (s *Store) GetInventoryItem(ctx context.Context, providerID, itemID uuid.UUID) (InventoryItem, error) {
	it, err := scanInventoryItem(s.pool.QueryRow(ctx,
		`SELECT `+inventoryColumns+` FROM provider_inventory WHERE id = $1 AND provider_id = $2`,
		itemID, providerID))
	if errors.Is(err, pgx.ErrNoRows) {
		return InventoryItem{}, fmt.Errorf("provider: get inventory item %s: %w", itemID, ErrInventoryItemNotFound)
	}
	if err != nil {
		return InventoryItem{}, fmt.Errorf("provider: get inventory item %s: %w", itemID, err)
	}
	return it, nil
}

// AdjustInventory applies a signed stock delta inside a transaction. A blank
// reason yields ErrReasonRequired, a result below zero ErrInventoryNegativeStock
// and a missing item ErrInventoryItemNotFound; nothing is written on error.
func (s *Store) AdjustInventory(ctx context.Context, providerID, itemID uuid.UUID, delta int, reason string) (InventoryItem, error) {
	if strings.TrimSpace(reason) == "" {
		return InventoryItem{}, fmt.Errorf("provider: adjust item %s: %w", itemID, ErrReasonRequired)
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return InventoryItem{}, fmt.Errorf("provider: begin adjust tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var stock int
	err = tx.QueryRow(ctx,
		`SELECT stock_on_hand FROM provider_inventory WHERE id = $1 AND provider_id = $2 FOR UPDATE`,
		itemID, providerID).Scan(&stock)
	if errors.Is(err, pgx.ErrNoRows) {
		return InventoryItem{}, fmt.Errorf("provider: adjust item %s: %w", itemID, ErrInventoryItemNotFound)
	}
	if err != nil {
		return InventoryItem{}, fmt.Errorf("provider: lock item %s: %w", itemID, err)
	}
	newStock := stock + delta
	if newStock < 0 {
		return InventoryItem{}, fmt.Errorf("provider: adjust item %s: %w", itemID, ErrInventoryNegativeStock)
	}
	it, err := scanInventoryItem(tx.QueryRow(ctx,
		`UPDATE provider_inventory SET stock_on_hand = $3, updated_at = now()
		 WHERE id = $1 AND provider_id = $2 RETURNING `+inventoryColumns,
		itemID, providerID, newStock))
	if err != nil {
		return InventoryItem{}, fmt.Errorf("provider: update item %s: %w", itemID, err)
	}
	if err := tx.Commit(ctx); err != nil {
		return InventoryItem{}, fmt.Errorf("provider: commit adjust item %s: %w", itemID, err)
	}
	return it, nil
}

// ServicePlan is one recurring plan (provider_service_plans).
type ServicePlan struct {
	ID            uuid.UUID
	ProviderID    uuid.UUID
	Name          string
	ServiceID     uuid.UUID
	Frequency     string
	PriceTZS      int64
	Active        bool
	CustomerCount int
	CreatedAt     time.Time
}

const planColumns = `id, provider_id, name, service_id, frequency, price_tzs, active, customer_count, created_at`

func scanPlan(row pgx.Row) (ServicePlan, error) {
	var p ServicePlan
	err := row.Scan(&p.ID, &p.ProviderID, &p.Name, &p.ServiceID, &p.Frequency,
		&p.PriceTZS, &p.Active, &p.CustomerCount, &p.CreatedAt)
	return p, err
}

// ListPlans returns the provider's recurring plans, oldest first.
func (s *Store) ListPlans(ctx context.Context, providerID uuid.UUID) ([]ServicePlan, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT `+planColumns+` FROM provider_service_plans WHERE provider_id = $1 ORDER BY created_at, id`,
		providerID)
	if err != nil {
		return nil, fmt.Errorf("provider: list plans: %w", err)
	}
	defer rows.Close()
	out := make([]ServicePlan, 0)
	for rows.Next() {
		p, err := scanPlan(rows)
		if err != nil {
			return nil, fmt.Errorf("provider: scan plan: %w", err)
		}
		out = append(out, p)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("provider: iterate plans: %w", err)
	}
	return out, nil
}

// CreatePlan adds a recurring plan. The referenced service must belong to
// the provider (ErrServiceNotFound otherwise).
func (s *Store) CreatePlan(ctx context.Context, providerID uuid.UUID, name string, serviceID uuid.UUID, frequency string, priceTZS int64) (ServicePlan, error) {
	var exists bool
	if err := s.pool.QueryRow(ctx,
		`SELECT EXISTS(SELECT 1 FROM provider_services WHERE id = $1 AND provider_id = $2)`,
		serviceID, providerID).Scan(&exists); err != nil {
		return ServicePlan{}, fmt.Errorf("provider: plan service check: %w", err)
	}
	if !exists {
		return ServicePlan{}, fmt.Errorf("provider: create plan %s: %w", name, ErrServiceNotFound)
	}
	p, err := scanPlan(s.pool.QueryRow(ctx,
		`INSERT INTO provider_service_plans (provider_id, name, service_id, frequency, price_tzs)
		 VALUES ($1, $2, $3, $4, $5) RETURNING `+planColumns,
		providerID, name, serviceID, frequency, priceTZS))
	if err != nil {
		return ServicePlan{}, fmt.Errorf("provider: create plan: %w", err)
	}
	return p, nil
}

// UpdatePlan patches a plan owned by the provider (name, frequency,
// price, active). active nil keeps the stored value. ErrPlanNotFound when
// the row is missing or belongs to another provider.
func (s *Store) UpdatePlan(ctx context.Context, providerID, planID uuid.UUID, name string, frequency string, priceTZS int64, active *bool) (ServicePlan, error) {
	p, err := scanPlan(s.pool.QueryRow(ctx,
		`UPDATE provider_service_plans
		 SET name = $3, frequency = $4, price_tzs = $5,
		     active = COALESCE($6, active)
		 WHERE id = $1 AND provider_id = $2 RETURNING `+planColumns,
		planID, providerID, name, frequency, priceTZS, active))
	if errors.Is(err, pgx.ErrNoRows) {
		return ServicePlan{}, fmt.Errorf("provider: update plan %s: %w", planID, ErrPlanNotFound)
	}
	if err != nil {
		return ServicePlan{}, fmt.Errorf("provider: update plan %s: %w", planID, err)
	}
	return p, nil
}

// DeletePlan removes a plan; one still referenced by a service_contracts row
// is protected with ErrPlanInUse (PLAN_IN_USE). ErrPlanNotFound when missing.
func (s *Store) DeletePlan(ctx context.Context, providerID, planID uuid.UUID) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("provider: begin delete plan tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var exists bool
	if err := tx.QueryRow(ctx,
		`SELECT EXISTS(SELECT 1 FROM provider_service_plans WHERE id = $1 AND provider_id = $2)`,
		planID, providerID).Scan(&exists); err != nil {
		return fmt.Errorf("provider: lookup plan %s: %w", planID, err)
	}
	if !exists {
		return fmt.Errorf("provider: delete plan %s: %w", planID, ErrPlanNotFound)
	}
	var inUse bool
	if err := tx.QueryRow(ctx,
		`SELECT EXISTS(SELECT 1 FROM service_contracts WHERE plan_id = $1)`,
		planID).Scan(&inUse); err != nil {
		return fmt.Errorf("provider: plan in-use check %s: %w", planID, err)
	}
	if inUse {
		return fmt.Errorf("provider: delete plan %s: %w", planID, ErrPlanInUse)
	}
	if _, err := tx.Exec(ctx,
		`DELETE FROM provider_service_plans WHERE id = $1 AND provider_id = $2`, planID, providerID); err != nil {
		return fmt.Errorf("provider: delete plan %s: %w", planID, err)
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("provider: commit delete plan: %w", err)
	}
	return nil
}

// Contract is one B2B service contract (service_contracts), read-side only
// in this context (creation belongs to the contracts workstream).
type Contract struct {
	ID                   uuid.UUID
	ProviderID           uuid.UUID
	OrganizationName     string
	Locations            []byte
	CoveredServices      []byte
	SlaResponseMinutes   int
	SlaResolutionMinutes *int
	Pricing              []byte
	CoverageArea         []byte
	WorkingHours         *string
	EscalationRules      *string
	Status               string
	CreatedAt            time.Time
}

const contractColumns = `id, provider_id, organization_name, locations, covered_services,
	sla_response_minutes, sla_resolution_minutes, pricing, coverage_area, working_hours, escalation_rules, status, created_at`

func scanContract(row pgx.Row) (Contract, error) {
	var c Contract
	err := row.Scan(&c.ID, &c.ProviderID, &c.OrganizationName, &c.Locations, &c.CoveredServices,
		&c.SlaResponseMinutes, &c.SlaResolutionMinutes, &c.Pricing, &c.CoverageArea,
		&c.WorkingHours, &c.EscalationRules, &c.Status, &c.CreatedAt)
	return c, err
}

// ListContracts returns the provider's contracts, keyset-paginated on
// (created_at, id) with limit+1 lookahead; next is "" on the last page.
// A malformed cursor yields ErrInvalidCursor.
func (s *Store) ListContracts(ctx context.Context, providerID uuid.UUID, limit int, cursor string) ([]Contract, string, error) {
	if limit < 1 {
		limit = 20
	}
	query := `SELECT ` + contractColumns + ` FROM service_contracts WHERE provider_id = $1`
	args := []any{providerID}
	if cursor != "" {
		at, id, err := parseCursor(cursor)
		if err != nil {
			return nil, "", fmt.Errorf("provider: list contracts: %w", ErrInvalidCursor)
		}
		args = append(args, at, id)
		query += fmt.Sprintf(" AND (created_at, id) > ($%d, $%d)", len(args)-1, len(args))
	}
	args = append(args, limit+1)
	query += fmt.Sprintf(" ORDER BY created_at, id LIMIT $%d", len(args))

	rows, err := s.pool.Query(ctx, query, args...)
	if err != nil {
		return nil, "", fmt.Errorf("provider: list contracts: %w", err)
	}
	defer rows.Close()

	out := make([]Contract, 0, limit)
	var last Contract
	sentinel := false
	for rows.Next() {
		c, err := scanContract(rows)
		if err != nil {
			return nil, "", fmt.Errorf("provider: scan contract: %w", err)
		}
		if len(out) == limit {
			sentinel = true
			continue
		}
		out = append(out, c)
		last = c
	}
	if err := rows.Err(); err != nil {
		return nil, "", fmt.Errorf("provider: iterate contracts: %w", err)
	}
	next := ""
	if sentinel {
		next = encodeCursor(last.CreatedAt, last.ID)
	}
	return out, next, nil
}

// Document is one provider document (provider_documents); export jobs share
// the table with type 'export'.
type Document struct {
	ID         uuid.UUID
	ProviderID uuid.UUID
	Type       string
	URL        string
	Status     string
	ExpiryDate *time.Time
	VerifiedAt *time.Time
	CreatedAt  time.Time
}

const documentColumns = `id, provider_id, type, url, status, expiry_date, verified_at, created_at`

func scanDocument(row pgx.Row) (Document, error) {
	var d Document
	err := row.Scan(&d.ID, &d.ProviderID, &d.Type, &d.URL, &d.Status,
		&d.ExpiryDate, &d.VerifiedAt, &d.CreatedAt)
	if err == nil && d.ExpiryDate != nil && d.ExpiryDate.Before(time.Now()) {
		d.Status = "expired"
	}
	return d, err
}

// ListDocuments returns the provider's documents (exports included), newest
// first.
func (s *Store) ListDocuments(ctx context.Context, providerID uuid.UUID) ([]Document, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT `+documentColumns+` FROM provider_documents WHERE provider_id = $1 ORDER BY created_at DESC, id`,
		providerID)
	if err != nil {
		return nil, fmt.Errorf("provider: list documents: %w", err)
	}
	defer rows.Close()
	out := make([]Document, 0)
	for rows.Next() {
		d, err := scanDocument(rows)
		if err != nil {
			return nil, fmt.Errorf("provider: scan document: %w", err)
		}
		out = append(out, d)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("provider: iterate documents: %w", err)
	}
	return out, nil
}

// UploadDocument adds a document in the uploaded state. An expiry date in
// the past yields ErrDocumentExpired (DOCUMENT_EXPIRED).
func (s *Store) UploadDocument(ctx context.Context, providerID uuid.UUID, docType, url string, expiry *time.Time) (Document, error) {
	if expiry != nil && expiry.Before(time.Now()) {
		return Document{}, fmt.Errorf("provider: upload document %s: %w", url, ErrDocumentExpired)
	}
	d, err := scanDocument(s.pool.QueryRow(ctx,
		`INSERT INTO provider_documents (provider_id, type, url, expiry_date)
		 VALUES ($1, $2, $3, $4) RETURNING `+documentColumns,
		providerID, docType, url, expiry))
	if err != nil {
		return Document{}, fmt.Errorf("provider: upload document: %w", err)
	}
	return d, nil
}

// UpdateDocument renews a document (new url and/or expiry). ErrDocumentNotFound
// when missing or cross-provider; a past expiry yields ErrDocumentExpired.
func (s *Store) UpdateDocument(ctx context.Context, providerID, documentID uuid.UUID, url *string, expiry *time.Time) (Document, error) {
	if expiry != nil && expiry.Before(time.Now()) {
		return Document{}, fmt.Errorf("provider: update document %s: %w", documentID, ErrDocumentExpired)
	}
	d, err := scanDocument(s.pool.QueryRow(ctx,
		`UPDATE provider_documents
		 SET url = COALESCE($3, url), expiry_date = COALESCE($4, expiry_date)
		 WHERE id = $1 AND provider_id = $2 RETURNING `+documentColumns,
		documentID, providerID, url, expiry))
	if errors.Is(err, pgx.ErrNoRows) {
		return Document{}, fmt.Errorf("provider: update document %s: %w", documentID, ErrDocumentNotFound)
	}
	if err != nil {
		return Document{}, fmt.Errorf("provider: update document %s: %w", documentID, err)
	}
	return d, nil
}

// Portfolio is the provider's 1:1 portfolio row (provider_portfolio).
type Portfolio struct {
	ProviderID  uuid.UUID
	Bio         *string
	Specialties []byte
	Media       []byte
	UpdatedAt   time.Time
}

func scanPortfolio(row pgx.Row) (Portfolio, error) {
	var p Portfolio
	err := row.Scan(&p.ProviderID, &p.Bio, &p.Specialties, &p.Media, &p.UpdatedAt)
	return p, err
}

// GetPortfolio returns the provider's portfolio; a provider without a row
// yields the empty default (nil media).
func (s *Store) GetPortfolio(ctx context.Context, providerID uuid.UUID) (Portfolio, error) {
	p, err := scanPortfolio(s.pool.QueryRow(ctx,
		`SELECT provider_id, bio, specialties, media, updated_at FROM provider_portfolio WHERE provider_id = $1`,
		providerID))
	if errors.Is(err, pgx.ErrNoRows) {
		return Portfolio{ProviderID: providerID}, nil
	}
	if err != nil {
		return Portfolio{}, fmt.Errorf("provider: get portfolio: %w", err)
	}
	return p, nil
}

// UpsertPortfolio replaces the provider's portfolio. Media beyond 50 items
// or an item without a url yields ErrPortfolioInvalid (PORTFOLIO_INVALID).
func (s *Store) UpsertPortfolio(ctx context.Context, providerID uuid.UUID, bio *string, specialties, media []byte) error {
	if err := validatePortfolioMedia(media); err != nil {
		return err
	}
	if len(specialties) == 0 {
		specialties = []byte("[]")
	}
	if len(media) == 0 {
		media = []byte("[]")
	}
	_, err := s.pool.Exec(ctx,
		`INSERT INTO provider_portfolio (provider_id, bio, specialties, media)
		 VALUES ($1, $2, $3, $4)
		 ON CONFLICT (provider_id) DO UPDATE SET
		   bio = EXCLUDED.bio, specialties = EXCLUDED.specialties, media = EXCLUDED.media,
		   updated_at = now()`,
		providerID, bio, specialties, media)
	if err != nil {
		return fmt.Errorf("provider: upsert portfolio: %w", err)
	}
	return nil
}

func validatePortfolioMedia(media []byte) error {
	if len(media) == 0 {
		return nil
	}
	var items []map[string]any
	if err := json.Unmarshal(media, &items); err != nil {
		return fmt.Errorf("provider: portfolio: %w", ErrPortfolioInvalid)
	}
	if len(items) > 50 {
		return fmt.Errorf("provider: portfolio: %w", ErrPortfolioInvalid)
	}
	for _, it := range items {
		url, _ := it["url"].(string)
		if strings.TrimSpace(url) == "" {
			return fmt.Errorf("provider: portfolio: %w", ErrPortfolioInvalid)
		}
	}
	return nil
}

// GetCapabilities returns the provider's capability set as raw jsonb.
func (s *Store) GetCapabilities(ctx context.Context, providerID uuid.UUID) ([]byte, error) {
	var caps []byte
	err := s.pool.QueryRow(ctx,
		`SELECT COALESCE(capabilities, '[]'::jsonb) FROM provider_capabilities WHERE provider_id = $1`,
		providerID).Scan(&caps)
	if errors.Is(err, pgx.ErrNoRows) {
		return []byte("[]"), nil
	}
	if err != nil {
		return nil, fmt.Errorf("provider: get capabilities: %w", err)
	}
	return caps, nil
}

// UpsertCapabilities replaces the provider's capability set; any capability
// outside the documented catalog yields ErrCapabilityForbidden.
func (s *Store) UpsertCapabilities(ctx context.Context, providerID uuid.UUID, caps []string) error {
	if err := ValidateCapabilities(caps); err != nil {
		return err
	}
	encoded, err := json.Marshal(caps)
	if err != nil {
		return fmt.Errorf("provider: marshal capabilities: %w", err)
	}
	_, err = s.pool.Exec(ctx,
		`INSERT INTO provider_capabilities (provider_id, capabilities)
		 VALUES ($1, $2)
		 ON CONFLICT (provider_id) DO UPDATE SET capabilities = EXCLUDED.capabilities, updated_at = now()`,
		providerID, encoded)
	if err != nil {
		return fmt.Errorf("provider: upsert capabilities: %w", err)
	}
	return nil
}

// RequestExport queues a provider report export: one provider_documents row
// of type 'export' in the queued state. A second export while one is still
// queued or processing yields ErrExportInProgress (PROVIDER_EXPORT_IN_PROGRESS).
// The report file itself is produced by the export worker in a later
// milestone; this context only reserves the job.
func (s *Store) RequestExport(ctx context.Context, providerID uuid.UUID, reportType, format string) (uuid.UUID, error) {
	var inProgress bool
	if err := s.pool.QueryRow(ctx,
		`SELECT EXISTS(
			SELECT 1 FROM provider_documents
			WHERE provider_id = $1 AND type = 'export' AND status IN ('queued', 'processing'))`,
		providerID).Scan(&inProgress); err != nil {
		return uuid.Nil, fmt.Errorf("provider: export in-progress check: %w", err)
	}
	if inProgress {
		return uuid.Nil, fmt.Errorf("provider: export for %s: %w", providerID, ErrExportInProgress)
	}
	var id uuid.UUID
	err := s.pool.QueryRow(ctx,
		`INSERT INTO provider_documents (provider_id, type, url, status)
		 VALUES ($1, 'export', $2, 'queued') RETURNING id`,
		providerID, reportType+"_"+format).Scan(&id)
	if err != nil {
		return uuid.Nil, fmt.Errorf("provider: insert export job: %w", err)
	}
	return id, nil
}

// capStrings decodes a capabilities jsonb payload; a blank payload is an
// empty set.
func capStrings(caps []byte) []string {
	if len(caps) == 0 {
		return nil
	}
	var out []string
	_ = json.Unmarshal(caps, &out)
	return out
}

// encodeCursor packs a (created_at, id) keyset into URL-safe base64.
func encodeCursor(createdAt time.Time, id uuid.UUID) string {
	raw := make([]byte, 0, 24)
	raw = append(raw, []byte(createdAt.UTC().Format(time.RFC3339Nano))...)
	raw = append(raw, '|')
	raw = append(raw, []byte(id.String())...)
	return base64.RawURLEncoding.EncodeToString(raw)
}

// parseCursor decodes a list cursor; a blank cursor yields an error so the
// caller can distinguish "no cursor" from a malformed one.
func parseCursor(cursor string) (*time.Time, *uuid.UUID, error) {
	raw, err := base64.RawURLEncoding.DecodeString(cursor)
	if err != nil {
		return nil, nil, err
	}
	parts := strings.SplitN(string(raw), "|", 2)
	if len(parts) != 2 {
		return nil, nil, errors.New("provider: malformed cursor")
	}
	at, err := time.Parse(time.RFC3339Nano, parts[0])
	if err != nil {
		return nil, nil, err
	}
	id, err := uuid.Parse(parts[1])
	if err != nil {
		return nil, nil, err
	}
	return &at, &id, nil
}
