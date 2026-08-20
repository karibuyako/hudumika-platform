package api

import (
	"net/http"
	"strings"
)

// Role constants (AUTH.md RBAC). Values are lower-case to match JWT role
// claims.
const (
	RoleCustomer   = "customer"
	RoleMerchant   = "merchant"
	RoleProvider   = "provider"
	RoleRider      = "rider"
	RoleAdmin      = "admin"
	// RoleStaff is the generic platform-staff marker stored in the roles
	// table (migrations/00090_admin_role.sql). It has no dedicated route
	// policy: a staff login resolves to RoleAdmin (resolveLoginRole).
	RoleStaff      = "staff"
	RoleFinance    = "finance"
	RoleOps        = "ops"
	RoleCompliance = "compliance"
)

// routePolicy maps URL prefixes to the role sets permitted on those routes.
// Longer prefixes win when several match; paths matching no prefix are open
// to every authenticated session.
var routePolicy = map[string][]string{
	"/admin/":                  {RoleAdmin, RoleFinance, RoleOps, RoleCompliance},
	"/wallet/me":               {}, // customer wallet: any authenticated role (longest prefix wins)
	"/wallet/":                 {RoleMerchant, RoleProvider, RoleRider},
	"/riders/":                 {RoleRider, RoleAdmin, RoleFinance, RoleOps, RoleCompliance},
	"/providers/available":     {}, // consumer discovery: open to every authenticated role (longest prefix wins)
	"/providers/me/preferred":  {}, // consumer preferred providers: open to every authenticated role
	"/providers":               {RoleCustomer, RoleProvider, RoleAdmin, RoleFinance, RoleOps, RoleCompliance},
	"/providers/":              {RoleCustomer, RoleProvider, RoleAdmin, RoleFinance, RoleOps, RoleCompliance},
	"/merchants/":              {RoleMerchant, RoleAdmin, RoleFinance, RoleOps, RoleCompliance},
}

// allowedRoles returns the role set for the longest route-policy prefix that
// matches path, and false when the path is unconstrained.
func allowedRoles(path string) ([]string, bool) {
	best := ""
	for prefix := range routePolicy {
		if len(prefix) > len(best) && strings.HasPrefix(path, prefix) {
			best = prefix
		}
	}
	if best == "" {
		return nil, false
	}
	// An empty role set marks the route unconstrained (open to every
	// authenticated session) — used to widen a longer prefix.
	if len(routePolicy[best]) == 0 {
		return nil, false
	}
	return routePolicy[best], true
}

// enforcePolicy applies routePolicy to an authenticated session. On denial it
// writes the error envelope and returns false; otherwise the request may
// proceed. Role checks come first (403 FORBIDDEN); staff routes additionally
// require an MFA-verified session (401 MFA_REQUIRED, AUTH.md).
func enforcePolicy(w http.ResponseWriter, path string, c *Claims) bool {
	roles, ok := allowedRoles(path)
	if !ok {
		return true
	}
	allowed := false
	for _, r := range roles {
		if r == c.Role {
			allowed = true
			break
		}
	}
	if !allowed {
		writeError(w, http.StatusForbidden, "FORBIDDEN", "This role is not permitted on this route")
		return false
	}
	if strings.HasPrefix(path, "/admin/") && !c.MFAVerified {
		writeError(w, http.StatusUnauthorized, "MFA_REQUIRED", "Staff session requires MFA verification")
		return false
	}
	return true
}
