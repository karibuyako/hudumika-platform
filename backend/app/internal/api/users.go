package api

import (
	"errors"
	"net/http"

	"github.com/hudumika/api-backend/internal/auth"
	"github.com/hudumika/api-backend/internal/gen"
	"github.com/jackc/pgx/v5/pgconn"
)

// Sentinel errors from currentUser, mapped to HTTP envelopes by
// writeCurrentUserError.
var (
	errNoBearerToken = errors.New("missing bearer token")
	errBadToken      = errors.New("invalid bearer token")
	errNoDatabase    = errors.New("database not configured")
	errUserNotFound  = errors.New("user not found")
)

// currentUser resolves the authenticated caller: bearer token → JWT claims
// (subject = phone) → users row. It returns a sentinel error when the
// request maps to 401/404 and the raw error when it must be a 500.
func (s *Server) currentUser(r *http.Request) (*auth.UserRow, *auth.Repo, error) {
	token := bearerToken(r)
	if token == "" {
		return nil, nil, errNoBearerToken
	}
	claims, err := s.parseToken(token)
	if err != nil {
		return nil, nil, errBadToken
	}
	if s.db == nil {
		return nil, nil, errNoDatabase
	}
	repo := auth.NewRepo(s.db.Pool())
	user, err := repo.GetUserByPhone(r.Context(), claims.Subject)
	if err != nil {
		return nil, nil, err
	}
	if user == nil {
		return nil, nil, errUserNotFound
	}
	return user, repo, nil
}

// writeCurrentUserError maps currentUser failures to the documented error
// envelopes; details of internal failures are never leaked.
func (s *Server) writeCurrentUserError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, errNoBearerToken), errors.Is(err, errBadToken):
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing or invalid bearer token")
	case errors.Is(err, errNoDatabase), errors.Is(err, errUserNotFound):
		// A missing database (dev, no DATABASE_URL) and a missing user row
		// both surface as NOT_FOUND; production always has a database.
		writeError(w, http.StatusNotFound, "NOT_FOUND", "User not found")
	default:
		s.logger.Error("current user lookup failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
	}
}

// GetMe returns the caller's profile with their active role and roles.
func (s *Server) GetMe(w http.ResponseWriter, r *http.Request) {
	user, repo, err := s.currentUser(r)
	if err != nil {
		s.writeCurrentUserError(w, err)
		return
	}

	roles, err := repo.ListRolesByUser(r.Context(), user.ID)
	if err != nil {
		s.logger.Error("list roles failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, toGenUser(user, roles))
}

// UpdateMe patches the caller's mutable profile fields (email, full name,
// avatar URL, locale) and returns the refreshed profile.
func (s *Server) UpdateMe(w http.ResponseWriter, r *http.Request) {
	user, repo, err := s.currentUser(r)
	if err != nil {
		s.writeCurrentUserError(w, err)
		return
	}

	var body gen.UpdateMeJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}

	// PATCH semantics: absent fields keep their current value; an explicit
	// empty email clears the column; full_name and avatar_url only change
	// when a non-empty value is supplied.
	email := user.Email
	if body.Email != nil {
		v := string(*body.Email)
		if v == "" {
			email = nil
		} else {
			email = &v
		}
	}
	fullName := user.FullName
	if body.FullName != nil && *body.FullName != "" {
		fullName = *body.FullName
	}
	avatarURL := user.AvatarURL
	if body.AvatarUrl != nil && *body.AvatarUrl != "" {
		v := *body.AvatarUrl
		avatarURL = &v
	}
	locale := user.Locale
	if body.Locale != nil {
		if !body.Locale.Valid() {
			writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "locale must be one of en, sw, ar")
			return
		}
		locale = string(*body.Locale)
	}

	if err := repo.UpdateUserProfile(r.Context(), user.ID, email, &fullName, avatarURL, locale); err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			writeError(w, http.StatusConflict, "EMAIL_ALREADY_IN_USE", "That email is already in use")
			return
		}
		s.logger.Error("update user profile failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	updated, err := repo.GetUserByPhone(r.Context(), user.Phone)
	if err != nil {
		s.logger.Error("reload user profile failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if updated == nil {
		s.logger.Error("user row missing after profile update", "phone", user.Phone)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	roles, err := repo.ListRolesByUser(r.Context(), updated.ID)
	if err != nil {
		s.logger.Error("list roles failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, toGenUser(updated, roles))
}

// ListMyRoles returns the roles available to the caller for role switching;
// an empty array (never null) when the user has no active roles.
func (s *Server) ListMyRoles(w http.ResponseWriter, r *http.Request) {
	user, repo, err := s.currentUser(r)
	if err != nil {
		s.writeCurrentUserError(w, err)
		return
	}

	roles, err := repo.ListRolesByUser(r.Context(), user.ID)
	if err != nil {
		s.logger.Error("list roles failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, toRoleSummaries(roles))
}

// toGenUser maps the DB user row plus active roles onto the contract User.
func toGenUser(u *auth.UserRow, roles []auth.RoleRow) gen.User {
	locale := u.Locale
	if locale == "" {
		locale = "en"
	}
	activeRole := ""
	if len(roles) > 0 {
		activeRole = roles[0].Role
	}
	for _, role := range roles {
		if role.Role == "customer" {
			activeRole = "customer"
			break
		}
	}
	fullName := u.FullName
	return gen.User{
		Id:         newUUID(u.ID.String()),
		Phone:      u.Phone,
		Email:      u.Email,
		FullName:   &fullName,
		AvatarUrl:  u.AvatarURL,
		ActiveRole: &activeRole,
		Roles:      toRoleSummaries(roles),
		Locale:     &locale,
		CreatedAt:  u.CreatedAt,
	}
}

// toRoleSummaries maps role rows onto the contract RoleSummary; the result
// is never nil so it serializes as [] rather than null.
func toRoleSummaries(roles []auth.RoleRow) []gen.RoleSummary {
	out := make([]gen.RoleSummary, 0, len(roles))
	for _, role := range roles {
		out = append(out, gen.RoleSummary{
			Role:       gen.RoleSummaryRole(role.Role),
			MerchantId: role.MerchantID,
			ProviderId: role.ProviderID,
			RiderId:    role.RiderID,
		})
	}
	return out
}
