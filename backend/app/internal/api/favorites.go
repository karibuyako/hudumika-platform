package api

import (
	"net/http"

	"github.com/google/uuid"
	openapi_types "github.com/oapi-codegen/runtime/types"

	"github.com/hudumika/api-backend/internal/auth"
	"github.com/hudumika/api-backend/internal/gen"
)

// resolveUser returns the caller's durable user row from the claims injected
// by RequireAuth (subject = phone). Unlike currentUser (users.go), a missing
// database is a 500 here: every handler on this surface writes rows and has
// no dev-mode fallback. A missing user row stays a 404, matching the users
// surface. On error the response envelope is already written and nil is
// returned.
func (s *Server) resolveUser(w http.ResponseWriter, r *http.Request) (*auth.UserRow, *auth.Repo) {
	claims, ok := ClaimsFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing or invalid bearer token")
		return nil, nil
	}
	if s.db == nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return nil, nil
	}
	repo := auth.NewRepo(s.db.Pool())
	user, err := repo.GetUserByPhone(r.Context(), claims.Subject)
	if err != nil {
		s.logger.Error("current user lookup failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return nil, nil
	}
	if user == nil {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "User not found")
		return nil, nil
	}
	return user, repo
}

// ListFavorites returns the caller's favorite merchants as MerchantPublic
// entries. The merchants table does not exist yet (merchants milestone), so
// each entry honestly carries only the merchant id with empty public details
// (no name, city, rating, … to invent).
func (s *Server) ListFavorites(w http.ResponseWriter, r *http.Request) {
	user, _ := s.resolveUser(w, r)
	if user == nil {
		return
	}

	rows, err := s.db.Pool().Query(r.Context(),
		`SELECT merchant_id FROM favorites WHERE user_id = $1 ORDER BY created_at DESC`, user.ID)
	if err != nil {
		s.logger.Error("list favorites failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer rows.Close()

	favorites := make([]gen.MerchantPublic, 0)
	for rows.Next() {
		var merchantID uuid.UUID
		if err := rows.Scan(&merchantID); err != nil {
			s.logger.Error("scan favorite failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		favorites = append(favorites, gen.MerchantPublic{
			Id:           newUUID(merchantID.String()),
			BusinessName: "",
			City:         "",
			IsOpen:       false,
			Rating:       0,
			ReviewCount:  0,
		})
	}
	if err := rows.Err(); err != nil {
		s.logger.Error("iterate favorites failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, favorites)
}

// AddFavorite records a favorite merchant for the caller. Duplicates are
// silently ignored (ON CONFLICT DO NOTHING) so the endpoint is idempotent.
func (s *Server) AddFavorite(w http.ResponseWriter, r *http.Request) {
	user, _ := s.resolveUser(w, r)
	if user == nil {
		return
	}

	var body gen.AddFavoriteJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if body.MerchantId == uuid.Nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "merchantId is required")
		return
	}

	if _, err := s.db.Pool().Exec(r.Context(),
		`INSERT INTO favorites (user_id, merchant_id) VALUES ($1, $2)
		 ON CONFLICT (user_id, merchant_id) DO NOTHING`,
		user.ID, body.MerchantId); err != nil {
		s.logger.Error("add favorite failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// RemoveFavorite removes a favorite merchant. Deletion is scoped to the
// caller and idempotent: an absent row still answers 204.
func (s *Server) RemoveFavorite(w http.ResponseWriter, r *http.Request, merchantId openapi_types.UUID) {
	user, _ := s.resolveUser(w, r)
	if user == nil {
		return
	}

	if _, err := s.db.Pool().Exec(r.Context(),
		`DELETE FROM favorites WHERE user_id = $1 AND merchant_id = $2`,
		user.ID, merchantId); err != nil {
		s.logger.Error("remove favorite failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
