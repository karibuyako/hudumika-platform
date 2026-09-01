package api

import (
	"context"
	"net/http"

	"github.com/google/uuid"
)

// PolicyEffect represents the effect of an ABAC policy.
type PolicyEffect string

const (
	PolicyAllow PolicyEffect = "allow"
	PolicyDeny  PolicyEffect = "deny"
)

// AdminPolicy represents an ABAC policy from the admin_policies table.
type AdminPolicy struct {
	ID        uuid.UUID
	Type      string
	Resource  string
	Action    string
	Effect    PolicyEffect
	CreatedBy uuid.UUID
}

// EvaluatePolicies checks if the given action is allowed by the admin's policies.
// Returns true if allowed, false if denied. Deny always wins.
// Default: return true (allow if no policies match).
func (s *Server) EvaluatePolicies(ctx context.Context, adminID uuid.UUID, resource, action string) (bool, error) {
	if s.db == nil {
		return true, nil
	}
	rows, err := s.db.Pool().Query(ctx,
		`SELECT id, type, resource, action, effect, created_by
		 FROM admin_policies
		 WHERE resource = $1 AND (action = $2 OR action = '*')`,
		resource, action)
	if err != nil {
		return true, err
	}
	defer rows.Close()

	var hasAllow bool
	for rows.Next() {
		var p AdminPolicy
		var effect string
		if err := rows.Scan(&p.ID, &p.Type, &p.Resource, &p.Action, &effect, &p.CreatedBy); err != nil {
			continue
		}
		p.Effect = PolicyEffect(effect)
		if p.Effect == PolicyDeny {
			return false, nil
		}
		if p.Effect == PolicyAllow {
			hasAllow = true
		}
	}
	if hasAllow {
		return true, nil
	}
	return true, nil
}

// RequireABAC is a middleware that checks both RBAC and ABAC policies.
func (s *Server) RequireABAC(resource, action string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			claims, ok := ClaimsFromContext(r.Context())
			if !ok {
				writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing or invalid bearer token")
				return
			}
			if s.db != nil {
				adminID, err := uuid.Parse(claims.Subject)
				if err == nil {
					allowed, err := s.EvaluatePolicies(r.Context(), adminID, resource, action)
					if err != nil {
						s.logger.Error("abac evaluation failed", "error", err)
						writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not evaluate policies")
						return
					}
					if !allowed {
						writeError(w, http.StatusForbidden, "FORBIDDEN", "Access denied by policy")
						return
					}
				}
			}
			next.ServeHTTP(w, r)
		})
	}
}
