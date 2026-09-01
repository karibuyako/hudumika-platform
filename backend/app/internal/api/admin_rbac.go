package api

// ADMIN RBAC: shared permission enforcement for admin handlers.
// Permissions are checked against the staff_roles.permissions JSONB column
// which stores an array of permission strings per role. The "platform-owner"
// role (wildcard '*') bypasses all checks.

import (
	"context"
	"net/http"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ---------------------------------------------------------------------------
// Permission constants — aligned with admin-web/src/lib/permissions.ts
// ---------------------------------------------------------------------------

const (
	PermIAMManage             = "iam.manage"
	PermIAMRead               = "iam.read"
	PermConfigurationManage   = "configuration.manage"
	PermConfigurationRead     = "configuration.read"
	PermFinanceManage         = "finance.manage"
	PermFinanceRead           = "finance.read"
	PermSupportManage         = "support.manage"
	PermContentManage         = "content.manage"
	PermAnalyticsManage       = "analytics.manage"
	PermAnalyticsRead         = "analytics.read"
	PermApprovalDecide        = "approval.decide"
	PermOrderRead             = "order.read"
	PermOrderManage           = "order.manage"
	PermRefundApprove         = "refund.approve"
	PermExportManage          = "export.manage"
	PermCODManage             = "cod.manage"
	PermFleetAdmin            = "fleet.admin"
	PermHubManage             = "hub.manage"
	PermConsignmentManage     = "consignment.manage"
	PermHandoffManage         = "handoff.manage"
	PermAnomalyManage         = "anomaly.manage"
	PermExceptionManage       = "exception.manage"
	PermMerchantApprove       = "merchant.approve"
	PermProviderVerify        = "provider.verify"
	PermSafetyManage          = "safety.manage"
	PermRiskManage            = "risk.manage"
	PermReviewManage          = "review.manage"
	PermVoucherManage         = "voucher.manage"
	PermPromotionModerate     = "promotion.moderate"
	PermGroupBuyModerate      = "group_buy.moderate"
	PermWebhookManage         = "webhook.manage"
	PermFeatureManage         = "feature.manage"
	PermFacilityManage        = "facility.manage"
	PermCarrierManage         = "carrier.manage"
	PermWarehouseManage       = "warehouse.manage"
	PermReconciliationManage  = "reconciliation.manage"
	PermTripManage            = "trip.manage"
	PermWaybillManage         = "waybill.manage"
	PermAuditLogView          = "audit_log.view"
)

// ---------------------------------------------------------------------------
// Permission checking
// ---------------------------------------------------------------------------

// requirePermission checks that the authenticated staff user has at least one
// of the required permissions. Returns false if denied.
// The caller must have a valid DB connection.
func requirePermission(ctx context.Context, pool *pgxpool.Pool, role string, permissions ...string) (bool, error) {
	// Platform-owner wildcard bypasses all checks
	if role == "*" {
		return true, nil
	}

	// Load permissions for this role from staff_roles table
	rolePerms, err := loadRolePermissions(ctx, pool, role)
	if err != nil {
		return false, err
	}

	// Check wildcard
	for _, p := range rolePerms {
		if p == "*" {
			return true, nil
		}
	}

	// Check each required permission
	for _, required := range permissions {
		for _, have := range rolePerms {
			if have == required {
				return true, nil
			}
		}
	}

	return false, nil
}

// loadRolePermissions fetches the permissions JSONB array for a given role name
// from the staff_roles table.
func loadRolePermissions(ctx context.Context, pool *pgxpool.Pool, roleName string) ([]string, error) {
	var permsJSON string
	err := pool.QueryRow(ctx,
		`SELECT COALESCE(permissions::text, '[]') FROM staff_roles WHERE name = $1 LIMIT 1`,
		roleName).Scan(&permsJSON)
	if err != nil {
		if err == pgx.ErrNoRows {
			return nil, nil
		}
		return nil, err
	}

	// Parse JSON array of strings
	var perms []string
	if permsJSON == "" || permsJSON == "null" {
		return nil, nil
	}
	// Simple JSON parsing without importing encoding/json
	permsJSON = trimJSON_array(permsJSON)
	if permsJSON == "" {
		return nil, nil
	}
	perms = parseJSONArray(permsJSON)
	return perms, nil
}

// trimJSON_array trims surrounding brackets and whitespace from a JSON array string.
func trimJSON_array(s string) string {
	s = trimWhitespace(s)
	if len(s) < 2 || s[0] != '[' || s[len(s)-1] != ']' {
		return s
	}
	return s[1 : len(s)-1]
}

// parseJSONArray parses a comma-separated list of quoted strings from a JSON array body.
func parseJSONArray(s string) []string {
	var result []string
	s = trimWhitespace(s)
	if s == "" {
		return result
	}

	inQuote := false
	start := -1
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c == '"' {
			if inQuote {
				// End of string
				if start >= 0 {
					result = append(result, s[start:i])
				}
				start = -1
				inQuote = false
			} else {
				// Start of string
				inQuote = true
				start = i + 1
			}
		}
	}
	return result
}

func trimWhitespace(s string) string {
	start := 0
	end := len(s)
	for start < end && (s[start] == ' ' || s[start] == '\t' || s[start] == '\n' || s[start] == '\r') {
		start++
	}
	for end > start && (s[end-1] == ' ' || s[end-1] == '\t' || s[end-1] == '\n' || s[end-1] == '\r') {
		end--
	}
	return s[start:end]
}

// ---------------------------------------------------------------------------
// RBAC guard wrapper for handlers
// ---------------------------------------------------------------------------

// requireRBAC extracts claims, checks permissions, and writes a 403 error if denied.
// Returns (claims, true) if authorized, (nil, false) if denied (error already written).
func requireRBAC(w http.ResponseWriter, r *http.Request, s *Server, permissions ...string) (*Claims, bool) {
	claims, ok := ClaimsFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing or invalid bearer token")
		return nil, false
	}

	if s.db == nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return nil, false
	}

	allowed, err := requirePermission(r.Context(), s.db.Pool(), claims.Role, permissions...)
	if err != nil {
		s.logger.Error("rbac permission check failed", "role", claims.Role, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not verify permissions")
		return nil, false
	}
	if !allowed {
		writeError(w, http.StatusForbidden, "FORBIDDEN",
			"Your role does not have permission for this operation")
		return nil, false
	}

	return claims, true
}
