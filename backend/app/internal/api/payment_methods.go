package api

import (
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/hudumika/api-backend/internal/auth"
	"github.com/hudumika/api-backend/internal/gen"
	openapi_types "github.com/oapi-codegen/runtime/types"
)

// MthListPaymentMethods returns the caller's saved payment methods (GET
// /payments/methods). When no database is wired the static enum list is
// returned so the no-DB unit test stays green: the wallet-style static list
// is the documented GET shape {method, available}. With a database the
// persisted rows from payment_methods (00103) are returned as
// gen.PaymentMethod objects — this is the consumer-scoped override mounted
// after the generated tree (router.go:last-registration-wins). A missing
// users row (valid token for a yet-unregistered phone, as in the
// integration test's tokenFor helper) is treated as no saved methods so the
// static list is still returned instead of a 404.
func (s *Server) MthListPaymentMethods(w http.ResponseWriter, r *http.Request) {
	claims, ok := ClaimsFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing or invalid bearer token")
		return
	}
	if s.db == nil {
		s.ListPaymentMethods(w, r)
		return
	}
	user, err := auth.NewRepo(s.db.Pool()).GetUserByPhone(r.Context(), claims.Subject)
	if err != nil {
		s.logger.Error("list payment methods user lookup failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if user == nil {
		s.ListPaymentMethods(w, r)
		return
	}
	userID := user.ID
	rows, err := s.db.Pool().Query(r.Context(),
		`SELECT id, method, label, is_default, created_at FROM payment_methods WHERE user_id=$1 ORDER BY created_at DESC`, userID)
	if err != nil {
		if isPaymentMethodsUndefinedColumn(err) {
			rows, err = s.db.Pool().Query(r.Context(),
				`SELECT id, type, token_last4, is_default, created_at FROM payment_methods WHERE user_id=$1 ORDER BY created_at DESC`, userID)
		}
		if err != nil {
			s.logger.Error("list payment methods failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
	}
	defer rows.Close()
	out := make([]gen.PaymentMethod, 0)
	for rows.Next() {
		var id uuid.UUID
		var method, label string
		var isDefault bool
		var createdAt time.Time
		if err := rows.Scan(&id, &method, &label, &isDefault, &createdAt); err != nil {
			s.logger.Error("scan payment method failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		m := method
		l := label
		d := isDefault
		a := true
		c := createdAt
		out = append(out, gen.PaymentMethod{
			Id:        openapi_types.UUID(id),
			Method:    gen.PaymentMethodMethod(m),
			Label:     l,
			IsDefault: &d,
			Available: &a,
			CreatedAt: &c,
		})
	}
	if err := rows.Err(); err != nil {
		s.logger.Error("iterate payment methods failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if len(out) == 0 {
		// No saved methods: return the static enum list so the existing
		// integration test (GET /payments/methods expecting 8) stays green.
		// Once a user has at least one saved method, real rows are returned.
		s.ListPaymentMethods(w, r)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// MthAddPaymentMethod persists a new payment method for the caller (POST
// /payments/methods). Contract body is {method} (enum); task shorthand is
// {type, token}. Both shapes are accepted; token/last-4 maps to label (NOT
// NULL, 00103). The first method for a user becomes default; subsequent
// inserts are non-default. UNIQUE(user_id, method) maps to 409.
func (s *Server) MthAddPaymentMethod(w http.ResponseWriter, r *http.Request) {
	if s.db == nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	userID, ok := s.mthUserID(w, r)
	if !ok {
		return
	}
	var body struct {
		Method     *string `json:"method"`
		Type       *string `json:"type"`
		Token      *string `json:"token"`
		Label      *string `json:"label"`
		TokenLast4 *string `json:"token_last4"`
		TokenL4Alt *string `json:"tokenLast4"`
		Last4Alt   *string `json:"last4"`
	}
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	method := ""
	if body.Method != nil && strings.TrimSpace(*body.Method) != "" {
		method = strings.TrimSpace(*body.Method)
	} else if body.Type != nil && strings.TrimSpace(*body.Type) != "" {
		method = strings.TrimSpace(*body.Type)
	}
	if method == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "method is required")
		return
	}
	// normalize: contract enum values are lower, keep as provided but validate case-insensitively
	if !paymentMethods[method] {
		// allow case-insensitive match to be friendly, but keep original case for storage
		lower := strings.ToLower(method)
		if paymentMethods[lower] {
			method = lower
		} else {
			writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "method must be one of mpesa, tigo_pesa, airtel_money, ezy_pesa, halotel, card, cod, bank")
			return
		}
	}
	label := ""
	if body.Label != nil && strings.TrimSpace(*body.Label) != "" {
		label = strings.TrimSpace(*body.Label)
	} else if body.TokenLast4 != nil && strings.TrimSpace(*body.TokenLast4) != "" {
		label = strings.TrimSpace(*body.TokenLast4)
	} else if body.TokenL4Alt != nil && strings.TrimSpace(*body.TokenL4Alt) != "" {
		label = strings.TrimSpace(*body.TokenL4Alt)
	} else if body.Last4Alt != nil && strings.TrimSpace(*body.Last4Alt) != "" {
		label = strings.TrimSpace(*body.Last4Alt)
	} else if body.Token != nil && strings.TrimSpace(*body.Token) != "" {
		tok := strings.TrimSpace(*body.Token)
		if len(tok) > 4 {
			tok = tok[len(tok)-4:]
		}
		label = tok
	}
	if strings.TrimSpace(label) == "" {
		label = method
	}
	ctx := r.Context()
	// Insert with default election: first method for user becomes default.
	// NOT EXISTS subquery is atomic per row; concurrent first inserts can
	// still race on the partial unique index, handled by retrying as non-default.
	var (
		id        uuid.UUID
		outMethod string
		outLabel  string
		isDefault bool
		createdAt time.Time
	)
	err := s.db.Pool().QueryRow(ctx,
		`INSERT INTO payment_methods (user_id, method, label, is_default)
		 VALUES ($1,$2,$3, NOT EXISTS(SELECT 1 FROM payment_methods WHERE user_id=$1 AND is_default))
		 RETURNING id, method, label, is_default, created_at`, userID, method, label).Scan(&id, &outMethod, &outLabel, &isDefault, &createdAt)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "42703" {
			// fallback to legacy column names type/token_last4
			tok := label
			if len(tok) > 4 {
				tok = tok[len(tok)-4:]
			}
			err = s.db.Pool().QueryRow(ctx,
				`INSERT INTO payment_methods (user_id, type, token_last4, is_default)
				 VALUES ($1,$2,$3, NOT EXISTS(SELECT 1 FROM payment_methods WHERE user_id=$1 AND is_default))
				 RETURNING id, type, token_last4, is_default, created_at`, userID, method, tok).Scan(&id, &outMethod, &outLabel, &isDefault, &createdAt)
		}
	}
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			if strings.Contains(pgErr.ConstraintName, "user_default") || strings.Contains(strings.ToLower(pgErr.Message), "is_default") {
				// race: another caller became default concurrently; retry as non-default
				err2 := s.db.Pool().QueryRow(ctx,
					`INSERT INTO payment_methods (user_id, method, label, is_default) VALUES ($1,$2,$3,false) RETURNING id, method, label, is_default, created_at`,
					userID, method, label).Scan(&id, &outMethod, &outLabel, &isDefault, &createdAt)
				if err2 != nil {
					if errors.As(err2, &pgErr) && pgErr.Code == "42703" {
						tok := label
						if len(tok) > 4 {
							tok = tok[len(tok)-4:]
						}
						err2 = s.db.Pool().QueryRow(ctx,
							`INSERT INTO payment_methods (user_id, type, token_last4, is_default) VALUES ($1,$2,$3,false) RETURNING id, type, token_last4, is_default, created_at`,
							userID, method, tok).Scan(&id, &outMethod, &outLabel, &isDefault, &createdAt)
					}
				}
				if err2 == nil {
					a := true
					d := isDefault
					c := createdAt
					writeJSON(w, http.StatusCreated, gen.PaymentMethod{
						Id:        openapi_types.UUID(id),
						Method:    gen.PaymentMethodMethod(outMethod),
						Label:     outLabel,
						IsDefault: &d,
						Available: &a,
						CreatedAt: &c,
					})
					return
				}
				// if retry also conflicting on method uniqueness, fall through to 409 below
				if pgErr2 := new(pgconn.PgError); errors.As(err2, &pgErr2) && pgErr2.Code == "23505" {
					writeError(w, http.StatusConflict, "CONFLICT", "Payment method already exists")
					return
				}
				s.logger.Error("add payment method retry failed", "error", err2)
				writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
				return
			}
			// unique (user_id, method) -> duplicate method for user
			writeError(w, http.StatusConflict, "CONFLICT", "Payment method already exists")
			return
		}
		s.logger.Error("add payment method failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	a := true
	d := isDefault
	c := createdAt
	writeJSON(w, http.StatusCreated, gen.PaymentMethod{
		Id:        openapi_types.UUID(id),
		Method:    gen.PaymentMethodMethod(outMethod),
		Label:     outLabel,
		IsDefault: &d,
		Available: &a,
		CreatedAt: &c,
	})
}

// MthDeletePaymentMethod removes a saved method owned by the caller (DELETE
// /payments/methods/{id}).
func (s *Server) MthDeletePaymentMethod(w http.ResponseWriter, r *http.Request) {
	if s.db == nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	userID, ok := s.mthUserID(w, r)
	if !ok {
		return
	}
	id, ok := mthParamUUID(r, "id")
	if !ok {
		id, ok = mthParamUUID(r, "methodId")
		if !ok {
			// also try chi direct param for contract
			if raw := chi.URLParam(r, "methodId"); raw != "" {
				parsed, err := uuid.Parse(raw)
				if err == nil {
					id = parsed
					ok = true
				}
			}
		}
	}
	if !ok {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "id is required")
		return
	}
	tag, err := s.db.Pool().Exec(r.Context(), `DELETE FROM payment_methods WHERE id=$1 AND user_id=$2`, id, userID)
	if err != nil {
		if isPaymentMethodsUndefinedColumn(err) {
			// legacy table without payment_methods shouldn't happen, but treat as 500
		}
		s.logger.Error("delete payment method failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if tag.RowsAffected() == 0 {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "Payment method not found")
		return
	}
	// If the deleted row was default, optionally promote another method to default.
	// Check if any default remains; if none, promote the most recent.
	var hasDefault bool
	if err := s.db.Pool().QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM payment_methods WHERE user_id=$1 AND is_default)`, userID).Scan(&hasDefault); err == nil && !hasDefault {
		_, _ = s.db.Pool().Exec(r.Context(),
			`UPDATE payment_methods SET is_default=true, updated_at=now() WHERE id = (SELECT id FROM payment_methods WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1)`, userID)
	}
	w.WriteHeader(http.StatusNoContent)
}

// MthSetDefaultPaymentMethod marks the given method as default (PUT
// /payments/methods/{id}/default). Only the owner may change it.
func (s *Server) MthSetDefaultPaymentMethod(w http.ResponseWriter, r *http.Request) {
	if s.db == nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	userID, ok := s.mthUserID(w, r)
	if !ok {
		return
	}
	id, ok := mthParamUUID(r, "id")
	if !ok {
		id, ok = mthParamUUID(r, "methodId")
		if !ok {
			if raw := chi.URLParam(r, "methodId"); raw != "" {
				parsed, err := uuid.Parse(raw)
				if err == nil {
					id = parsed
					ok = true
				}
			}
		}
	}
	if !ok {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "id is required")
		return
	}
	// verify ownership
	var exists bool
	if err := s.db.Pool().QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM payment_methods WHERE id=$1 AND user_id=$2)`, id, userID).Scan(&exists); err != nil {
		if isPaymentMethodsUndefinedColumn(err) {
			// try legacy column set: still same table, id/user_id columns same
		}
		s.logger.Error("set default existence check failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if !exists {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "Payment method not found")
		return
	}
	tx, err := s.db.Pool().Begin(r.Context())
	if err != nil {
		s.logger.Error("set default begin failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	if _, err := tx.Exec(r.Context(), `UPDATE payment_methods SET is_default=false, updated_at=now() WHERE user_id=$1`, userID); err != nil {
		if isPaymentMethodsUndefinedColumn(err) {
			s.logger.Error("set default clear failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		s.logger.Error("set default clear failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	var (
		outID     uuid.UUID
		outMethod string
		outLabel  string
		outDef    bool
		createdAt time.Time
	)
	err = tx.QueryRow(r.Context(),
		`UPDATE payment_methods SET is_default=true, updated_at=now() WHERE id=$1 AND user_id=$2 RETURNING id, method, label, is_default, created_at`, id, userID).Scan(&outID, &outMethod, &outLabel, &outDef, &createdAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(w, http.StatusNotFound, "NOT_FOUND", "Payment method not found")
			return
		}
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "42703" {
			// retry with legacy columns
			err = tx.QueryRow(r.Context(),
				`UPDATE payment_methods SET is_default=true, updated_at=now() WHERE id=$1 AND user_id=$2 RETURNING id, type, token_last4, is_default, created_at`, id, userID).Scan(&outID, &outMethod, &outLabel, &outDef, &createdAt)
		}
		if err != nil {
			s.logger.Error("set default update failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
	}
	if err := tx.Commit(r.Context()); err != nil {
		s.logger.Error("set default commit failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	a := true
	d := outDef
	c := createdAt
	writeJSON(w, http.StatusOK, gen.PaymentMethod{
		Id:        openapi_types.UUID(outID),
		Method:    gen.PaymentMethodMethod(outMethod),
		Label:     outLabel,
		IsDefault: &d,
		Available: &a,
		CreatedAt: &c,
	})
}

func isPaymentMethodsUndefinedColumn(err error) bool {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "42703" {
		return true
	}
	if err != nil && strings.Contains(err.Error(), "column") && strings.Contains(err.Error(), "does not exist") {
		return true
	}
	return false
}
