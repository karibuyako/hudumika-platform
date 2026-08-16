package api

// ORDER-ISSUE REASONS + REFUNDS surfaces (backend/API-CONTRACT.yaml
// /orders/issue-reasons, /refunds/reasons, /refunds): the static reason
// catalogs (code-served, no database) and the refund request queue.
//
// REFUND DATA MODEL (documented deviation): the refund pipeline in this
// milestone is the payments ApplyRefund path — a paid intent transitions
// directly to 'refunded'/'partially_refunded' and the refund is appended to
// payment_intents.refunds (jsonb [{amount, reason, at}]). There is no
// pending/approved/rejected workflow and no refund_requests table, so
// /refunds maps each refunds-jsonb entry onto the contract RefundRequest:
//   - id: the jsonb entry has no id; a stable UUID v5 over the entry's
//     immutable content (intent id + amount + reason + at) stands in
//     (identical entries yield identical ids, same convention as the admin
//     audit log mapping).
//   - status: every entry was applied immediately, so it maps to 'approved';
//     a 'pending' filter therefore matches nothing ([]) — honest, there is
//     no pending step.
//   - customerName/decisionReason: not stored anywhere; left absent.
//
// Error codes follow ERROR-CODES.md "Payments" (PAYMENT_INTENT_NOT_FOUND);
// unknown orders surface nothing (ownership is never revealed).

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/hudumika/api-backend/internal/gen"
	openapi_types "github.com/oapi-codegen/runtime/types"
)

// orderIssueReasons is the static rider order-issue report catalog served by
// /orders/issue-reasons. The contract pins no values; the list mirrors the
// rider-side issue vocabulary (wrong/missing/quality/delivery/damage).
var orderIssueReasons = []string{
	"wrong_items",
	"missing_items",
	"quality",
	"late_delivery",
	"damaged",
	"other",
}

// refundReasons is the static refund reason catalog served by
// /refunds/reasons. The contract pins no values; the list mirrors the
// customer-side refund vocabulary.
var refundReasons = []string{
	"duplicate_charge",
	"cancelled",
	"not_received",
	"damaged",
	"service_not_as_described",
	"other",
}

// ListOrderIssueReasons returns the static order-issue report catalog (GET
// /orders/issue-reasons, contract string[], 200). The catalog is
// code-served and needs no database.
func (s *Server) ListOrderIssueReasons(w http.ResponseWriter, r *http.Request) {
	out := make([]string, len(orderIssueReasons))
	copy(out, orderIssueReasons)
	writeJSON(w, http.StatusOK, out)
}

// ListRefundReasons returns the static refund reason catalog (GET
// /refunds/reasons, contract string[], 200). The catalog is code-served and
// needs no database.
func (s *Server) ListRefundReasons(w http.ResponseWriter, r *http.Request) {
	out := make([]string, len(refundReasons))
	copy(out, refundReasons)
	writeJSON(w, http.StatusOK, out)
}

const (
	// refundListDefaultLimit is the contract default page size for /refunds;
	// refundListMaxLimit caps it (same convention as the payment history).
	refundListDefaultLimit = 20
	refundListMaxLimit     = 100
)

// refundEntry is one entry of the payment_intents.refunds jsonb array
// ({amount, reason, at}, written by payments.ApplyRefund).
type refundEntry struct {
	Amount int64     `json:"amount"`
	Reason string    `json:"reason"`
	At     time.Time `json:"at"`
}

// refundedIntent is the projection of a payment_intents row carrying at
// least one refund entry.
type refundedIntent struct {
	ID        uuid.UUID
	OrderID   *uuid.UUID
	Status    string
	Refunds   json.RawMessage
	CreatedAt time.Time
}

// refundRequestsFromIntent flattens one intent's refunds-jsonb entries onto
// contract RefundRequest rows (see the package comment for the mapping
// rules). Intents without an order are skipped: the contract requires
// orderId and there is no order to attribute a wallet top-up refund to.
func refundRequestsFromIntent(i refundedIntent) []gen.RefundRequest {
	var entries []refundEntry
	if err := json.Unmarshal(i.Refunds, &entries); err != nil || len(entries) == 0 {
		return nil
	}
	if i.OrderID == nil {
		return nil
	}
	out := make([]gen.RefundRequest, 0, len(entries))
	status := gen.RefundRequestStatusApproved // direct-apply pipeline, see package comment
	for _, e := range entries {
		id := refundEntryID(i.ID, e)
		out = append(out, gen.RefundRequest{
			Id:        id,
			OrderId:   newUUID(i.OrderID.String()),
			AmountTZS: int(e.Amount),
			Reason:    e.Reason,
			Status:    status,
			CreatedAt: e.At.UTC(),
		})
	}
	return out
}

// refundEntryID derives the stable UUID v5 surrogate for a refunds-jsonb
// entry; the jsonb array carries no id (see package comment).
func refundEntryID(intentID uuid.UUID, e refundEntry) openapi_types.UUID {
	sum := uuid.NewSHA1(uuid.NameSpaceOID, []byte(strings.Join([]string{
		intentID.String(),
		time.Unix(0, e.At.UnixNano()).UTC().Format(time.RFC3339Nano),
		e.Reason,
		jsonInt(e.Amount),
	}, "|")))
	return newUUID(sum.String())
}

func jsonInt(n int64) string {
	return strconv.FormatInt(n, 10)
}

// ListRefundRequests returns the refund request queue (GET /refunds,
// contract RefundRequest[], 200). Customers see the refunds on their own
// orders' intents; staff roles (admin, finance, ops, compliance) see all
// intents with refunds; any other role is FORBIDDEN. The status filter maps
// on the derived status (see package comment: only 'approved' ever matches),
// limit defaults to 20 and is capped at 100. An empty queue serializes as [].
func (s *Server) ListRefundRequests(w http.ResponseWriter, r *http.Request, params gen.ListRefundRequestsParams) {
	user, claims, ok := s.paymentUser(w, r)
	if !ok {
		return
	}
	if claims.Role != RoleCustomer && !staffRoles[claims.Role] {
		writeError(w, http.StatusForbidden, "FORBIDDEN", "Only customers or staff can list refund requests")
		return
	}
	limit := refundListDefaultLimit
	if params.Limit != nil && *params.Limit > 0 {
		limit = *params.Limit
		if limit > refundListMaxLimit {
			limit = refundListMaxLimit
		}
	}

	query := `SELECT id, order_id, status, refunds, created_at
		FROM payment_intents
		WHERE jsonb_array_length(refunds) > 0`
	args := make([]any, 0, 2)
	if claims.Role == RoleCustomer {
		args = append(args, user.ID)
		query += fmt.Sprintf(" AND order_id IN (SELECT id FROM orders WHERE customer_user_id = $%d)", len(args))
	}
	args = append(args, limit)
	query += fmt.Sprintf(" ORDER BY created_at DESC, id DESC LIMIT $%d", len(args))

	rows, err := s.db.Pool().Query(r.Context(), query, args...)
	if err != nil {
		s.logger.Error("list refund requests failed", "user", user.ID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer rows.Close()

	out := make([]gen.RefundRequest, 0, limit)
	for rows.Next() {
		if len(out) >= limit {
			break
		}
		var i refundedIntent
		if err := rows.Scan(&i.ID, &i.OrderID, &i.Status, &i.Refunds, &i.CreatedAt); err != nil {
			s.logger.Error("refund request scan failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		for _, req := range refundRequestsFromIntent(i) {
			if params.Status != nil && req.Status != gen.RefundRequestStatus(*params.Status) {
				continue
			}
			out = append(out, req)
			if len(out) >= limit {
				break
			}
		}
	}
	if err := rows.Err(); err != nil {
		s.logger.Error("refund request iterate failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, out)
}
