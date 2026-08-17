package api

// CUSTOMER INVOICE DETAIL (API-CONTRACT.yaml /finance/invoices/{invoiceId},
// consumer docs/CONTRACT-ADDITIONS.md "Invoices — /finance/invoices"): the
// merchant invoice list/issue/download surface (finance.go) is merchant-
// scoped on the invoices table (00030); the CUSTOMER invoice detail returns
// the caller's own row from customer_invoices (migrations/00069_invoices.sql)
// — a customer never sees another user's invoice, and the merchant surface
// stays untouched. There is no invoice-create path in this milestone (the
// merchant-side RequestInvoice exists; a customer invoice is issued by a
// future billing flow, so fresh deployments answer INVOICE_NOT_FOUND for
// everything — a defined 404 envelope, never a blank page).

import (
	"errors"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/hudumika/api-backend/internal/gen"
	openapi_types "github.com/oapi-codegen/runtime/types"
)

// customerInvoiceRow is one customer_invoices row.
type customerInvoiceRow struct {
	ID        string
	Number    string
	Kind      *string
	AmountTZS int64
	Status    string
	IssuedAt  *time.Time
	PaidAt    *time.Time
	CreatedAt time.Time
}

// customerInvoiceToContract maps a row onto the contract Invoice: amountTZS
// is the invoice total, status/kind project verbatim, and the buyerDetails /
// tax / period fields are omitted — the row carries no tax breakdown and the
// downloadUrl lives on the separate DownloadInvoice200 surface.
func customerInvoiceToContract(row customerInvoiceRow) gen.Invoice {
	out := gen.Invoice{
		Id:        newUUID(row.ID),
		Number:    row.Number,
		AmountTZS: int(row.AmountTZS),
		Status:    gen.InvoiceStatus(row.Status),
		CreatedAt: row.CreatedAt,
		IssuedAt:  row.IssuedAt,
	}
	if row.Kind != nil {
		kind := gen.InvoiceKind(*row.Kind)
		out.Kind = &kind
	}
	return out
}

// GetInvoice returns the session user's customer invoice detail (GET
// /finance/invoices/{invoiceId}, 200 Invoice). Unknown or another user's
// invoice surfaces INVOICE_NOT_FOUND (404, the finance error-code section —
// ownership is never revealed).
func (s *Server) GetInvoice(w http.ResponseWriter, r *http.Request, invoiceId openapi_types.UUID) {
	user, _, ok := s.customerUser(w, r)
	if !ok {
		return
	}
	var row customerInvoiceRow
	err := s.db.Pool().QueryRow(r.Context(),
		`SELECT id, number, kind, amount_tzs, status, issued_at, paid_at, created_at
		 FROM customer_invoices WHERE id = $1 AND user_id = $2`, invoiceId, user.ID).
		Scan(&row.ID, &row.Number, &row.Kind, &row.AmountTZS, &row.Status,
			&row.IssuedAt, &row.PaidAt, &row.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "INVOICE_NOT_FOUND", "Invoice not found")
		return
	}
	if err != nil {
		s.logger.Error("customer invoice load failed", "user", user.ID, "invoice", invoiceId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, customerInvoiceToContract(row))
}