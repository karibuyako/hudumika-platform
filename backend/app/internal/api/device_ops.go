package api

// DEVICE PAIRING and TESTING bounded context (backend/ERROR-CODES.md §staff
// operations; backend/DATA-MODEL.md §merchant staff and devices): pairing a
// device with a code and queueing test print/ping jobs. Both handlers are
// merchant-gated exactly like the staff-ops device handlers: the device must
// belong to the authenticated merchant, and unknown or foreign ids surface
// DEVICE_NOT_FOUND.
//
// Pairing contract (backend/API-CONTRACT.yaml §/devices/{deviceId}/pair):
// the body carries the pairingCode the merchant entered; the handler records
// it on the devices row and publishes it to Redis `device:pair:{deviceId}`
// with a 10-minute TTL so any instance (and the device itself) can verify
// it. Redis is best-effort — without it the column remains the source of
// truth. A device with a paired_at timestamp is already paired and answers
// 409 CONFLICT; the conditional UPDATE is the single-winner guarantee across
// instances.
//
// Testing contract (§/devices/{deviceId}/test): the handler queues a
// device_tests job row (the durable record — there is no worker at this
// milestone) and answers the contract status; disabled devices answer
// 409 DEVICE_OFFLINE.

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/hudumika/api-backend/internal/gen"
	openapi_types "github.com/oapi-codegen/runtime/types"
)

// pairCodeTTL is how long a pairing code stays verifiable in Redis.
const pairCodeTTL = 10 * time.Minute

// pairRedisKey is the Redis key holding a device's current pairing code.
func pairRedisKey(deviceID openapi_types.UUID) string {
	return "device:pair:" + deviceID.String()
}

// pairDeviceRow is a devices row projection for the pairing/testing context.
type pairDeviceRow struct {
	id          openapi_types.UUID
	typeVal     string
	name        string
	status      string
	pairingCode *string
	pairedAt    *time.Time
}

// loadPairDevice reads one device row of the merchant by id.
func (s *Server) loadPairDevice(ctx context.Context, merchantID openapi_types.UUID, deviceID openapi_types.UUID) (*pairDeviceRow, error) {
	var d pairDeviceRow
	if err := s.db.Pool().QueryRow(ctx,
		`SELECT id, type, name, status, pairing_code, paired_at
		 FROM devices WHERE id = $1 AND merchant_id = $2`,
		deviceID, merchantID).
		Scan(&d.id, &d.typeVal, &d.name, &d.status, &d.pairingCode, &d.pairedAt); err != nil {
		return nil, fmt.Errorf("load pair device: %w", err)
	}
	return &d, nil
}

// newPairingCode generates an 8-character hex pairing code.
func newPairingCode() string {
	var b [4]byte
	if _, err := rand.Read(b[:]); err != nil {
		// crypto/rand is never expected to fail; the nano suffix keeps the
		// fallback hex too.
		return fmt.Sprintf("%08x", time.Now().UnixNano()&0xffffffff)
	}
	return hex.EncodeToString(b[:])
}

// publishPairingCode writes the pairing code to Redis so any API instance
// (and the device itself) can verify it within pairCodeTTL. Best-effort:
// failures are logged and the request still succeeds — the devices column
// remains the source of truth.
func (s *Server) publishPairingCode(ctx context.Context, deviceID openapi_types.UUID, code string) {
	if s.stores == nil || s.stores.Redis == nil {
		return
	}
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	if err := s.stores.Redis.Client().Set(ctx, pairRedisKey(deviceID), code, pairCodeTTL).Err(); err != nil {
		s.logger.Warn("pairing code not published to redis", "device", deviceID, "error", err)
	}
}

// PairMerchantDevice pairs one of the merchant's devices with a pairing
// code (POST /devices/{deviceId}/pair). The contract body requires
// pairingCode; the code is recorded on the devices row and published to
// Redis for the device to verify. Unknown or foreign devices answer 404
// DEVICE_NOT_FOUND; an already-paired device answers 409 CONFLICT. The
// conditional UPDATE (paired_at IS NULL) is the multi-instance single-winner
// guarantee: concurrent pair requests race and exactly one records the code.
func (s *Server) PairMerchantDevice(w http.ResponseWriter, r *http.Request, deviceId openapi_types.UUID) {
	merchantID, ok := s.staffOpsMerchantID(w, r)
	if !ok {
		return
	}
	var body gen.PairMerchantDeviceJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	code := strings.TrimSpace(body.PairingCode)
	if code == "" {
		// Defensive fallback: the contract body requires pairingCode, but a
		// generated code keeps the flow usable when the client omits it.
		code = newPairingCode()
	}
	if len(code) > 20 {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "pairingCode must be at most 20 characters")
		return
	}

	ctx := r.Context()
	dev, err := s.loadPairDevice(ctx, merchantID, deviceId)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "DEVICE_NOT_FOUND", "Device not found")
		return
	}
	if err != nil {
		s.logger.Error("pair device lookup failed", "device", deviceId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if dev.pairedAt != nil {
		writeError(w, http.StatusConflict, "CONFLICT", "device already paired")
		return
	}

	tag, err := s.db.Pool().Exec(ctx,
		`UPDATE devices SET pairing_code = $1, paired_at = now(), updated_at = now()
		 WHERE id = $2 AND merchant_id = $3 AND paired_at IS NULL`,
		code, deviceId, merchantID)
	if err != nil {
		s.logger.Error("pair device failed", "device", deviceId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if tag.RowsAffected() == 0 {
		// Lost the race to another instance: the device is paired now.
		writeError(w, http.StatusConflict, "CONFLICT", "device already paired")
		return
	}
	s.publishPairingCode(ctx, deviceId, code)

	writeJSON(w, http.StatusOK, toMerchantDevice(deviceRow{
		id:      dev.id,
		typeVal: dev.typeVal,
		name:    dev.name,
		status:  dev.status,
	}))
}

// TestMerchantDevice queues a test job for one of the merchant's devices
// (POST /devices/{deviceId}/test). The device_tests row is the durable
// record — status queued until a worker delivers it — and last_tested_at
// tracks the most recent attempt. Unknown or foreign devices answer 404
// DEVICE_NOT_FOUND; a disabled device answers 409 DEVICE_OFFLINE. The
// contract 200 answers the status ok.
func (s *Server) TestMerchantDevice(w http.ResponseWriter, r *http.Request, deviceId openapi_types.UUID) {
	merchantID, ok := s.staffOpsMerchantID(w, r)
	if !ok {
		return
	}
	ctx := r.Context()
	dev, err := s.loadPairDevice(ctx, merchantID, deviceId)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "DEVICE_NOT_FOUND", "Device not found")
		return
	}
	if err != nil {
		s.logger.Error("test device lookup failed", "device", deviceId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if dev.status == "disabled" {
		writeError(w, http.StatusConflict, "DEVICE_OFFLINE", "Device is disabled and cannot be tested")
		return
	}

	var jobID openapi_types.UUID
	if err := s.db.Pool().QueryRow(ctx,
		`INSERT INTO device_tests (device_id, status) VALUES ($1, 'queued') RETURNING id`,
		deviceId).Scan(&jobID); err != nil {
		s.logger.Error("queue device test failed", "device", deviceId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if _, err := s.db.Pool().Exec(ctx,
		`UPDATE devices SET last_tested_at = now(), updated_at = now() WHERE id = $1`,
		deviceId); err != nil {
		s.logger.Error("record device test timestamp failed", "device", deviceId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	writeJSON(w, http.StatusOK, testDeviceResponse{
		Status: gen.Ok,
	})
}

// testDeviceResponse is the contract 200 body for /devices/{deviceId}/test.
type testDeviceResponse struct {
	Status gen.TestMerchantDevice200JSONResponseBodyStatus `json:"status"`
}
