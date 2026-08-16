package api

// FINANCE bounded context (backend/ERROR-CODES.md "Finance", migration
// 00030): tokenized bank cards (PCI-DSS: PANs never stored, only the
// provider token + last-4 digits), merchant invoices, daily settlements that
// release captured escrow to merchants per cycle (backend/PAYMENTS.md) and
// the order-to-account reconciliation summary. Money is int64 TZS only.
//
// Ownership model: bank cards belong to the authenticated user; invoices and
// settlements belong to the authenticated merchant (the users row id, same
// milestone simplification as the store-ops context). Settlement operations
// are finance-ops but the contract guards them with plain bearerAuth, so the
// handlers accept finance staff (admin/finance/ops/compliance) plus the
// settlement's own merchant; other roles get 403 FORBIDDEN.

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/hudumika/api-backend/internal/auth"
	"github.com/hudumika/api-backend/internal/gen"
	"github.com/hudumika/api-backend/internal/payouts"
	openapi_types "github.com/oapi-codegen/runtime/types"
)

// Limits and constants enforced by the finance handlers.
const (
	maxBankCardsPerUser      = 5
	defaultInvoiceListLimit  = 20
	maxInvoiceListLimit      = 100
	settlementReasonMaxLen   = 500
	financePayoutMethod      = "bank" // payout_entries.method for settlement releases
	financePayoutCycleFormat = "2006-01-02"
)

// bankCardLast4Pattern matches the stored last-4 digits (the migration CHECK
// enforces the same shape).
var bankCardLast4Pattern = regexp.MustCompile(`^[0-9]{4}$`)

// errInvalidInvoiceCursor is returned by listInvoices when the keyset cursor
// does not decode to a (created_at, id) pair; the handler maps it to 422
// VALIDATION_FAILED.
var errInvalidInvoiceCursor = errors.New("finance: invalid invoice pagination cursor")

// financeUser resolves the authenticated subject (JWT subject = phone) to
// the users row. A missing database is a 500: money lookups must never
// degrade into a 404 (same convention as paymentUser in payments.go).
func (s *Server) financeUser(w http.ResponseWriter, r *http.Request) (*auth.UserRow, *Claims, bool) {
	claims, ok := ClaimsFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing or invalid bearer token")
		return nil, nil, false
	}
	if s.db == nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return nil, nil, false
	}
	user, err := auth.NewRepo(s.db.Pool()).GetUserByPhone(r.Context(), claims.Subject)
	if err != nil {
		s.logger.Error("finance user lookup failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return nil, nil, false
	}
	if user == nil {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "User not found")
		return nil, nil, false
	}
	return user, claims, true
}

// financeMerchantID resolves the authenticated session to the merchant id:
// only merchant-role sessions may pass (403 FORBIDDEN otherwise) and the
// merchant id is the caller's users row id (milestone convention).
func (s *Server) financeMerchantID(w http.ResponseWriter, r *http.Request) (uuid.UUID, bool) {
	claims, ok := ClaimsFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing or invalid bearer token")
		return uuid.Nil, false
	}
	if claims.Role != RoleMerchant {
		writeError(w, http.StatusForbidden, "FORBIDDEN", "Only merchant sessions may manage invoices")
		return uuid.Nil, false
	}
	user, _, ok := s.financeUser(w, r)
	if !ok {
		return uuid.Nil, false
	}
	return user.ID, true
}

// --- bank cards -----------------------------------------------------------

// bankCardToContract maps a bank_cards row onto the contract BankCard. The
// token is deliberately absent: it is a provider vault reference and must
// never leave the API. bankName is projected from the card brand (the stored
// schema has no bank-name column; the contract requires the field).
func bankCardToContract(id uuid.UUID, last4 string, brand *string, isDefault bool, createdAt time.Time) gen.BankCard {
	bankName := "card"
	if brand != nil && *brand != "" {
		bankName = *brand
	}
	return gen.BankCard{
		Id:        newUUID(id.String()),
		Last4:     last4,
		BankName:  bankName,
		IsDefault: isDefault,
		CreatedAt: &createdAt,
	}
}

// ListBankCards returns the caller's linked bank cards, masked: only last4,
// brand and default flag — the provider token never appears in responses
// (GET /finance/bank-cards).
func (s *Server) ListBankCards(w http.ResponseWriter, r *http.Request) {
	user, _, ok := s.financeUser(w, r)
	if !ok {
		return
	}
	rows, err := s.db.Pool().Query(r.Context(),
		`SELECT id, last4, brand, is_default, created_at FROM bank_cards
		 WHERE user_id = $1 ORDER BY created_at, id`, user.ID)
	if err != nil {
		s.logger.Error("list bank cards failed", "user", user.ID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer rows.Close()
	out := make([]gen.BankCard, 0, 2)
	for rows.Next() {
		var (
			id        uuid.UUID
			last4     string
			brand     *string
			isDefault bool
			createdAt time.Time
		)
		if err := rows.Scan(&id, &last4, &brand, &isDefault, &createdAt); err != nil {
			s.logger.Error("scan bank card failed", "user", user.ID, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		out = append(out, bankCardToContract(id, last4, brand, isDefault, createdAt))
	}
	if err := rows.Err(); err != nil {
		s.logger.Error("iterate bank cards failed", "user", user.ID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// bankCardCreateBody is the shape of POST /finance/bank-cards. The token is
// the provider vault reference (PCI-DSS: the raw PAN never reaches the API);
// the contract BankCard schema has no token field, so the body is decoded
// onto this struct instead of the generated type.
type bankCardCreateBody struct {
	Token       string  `json:"token"`
	Last4       string  `json:"last4"`
	Brand       *string `json:"brand,omitempty"`
	ExpiryMonth *int    `json:"expiryMonth,omitempty"`
	ExpiryYear  *int    `json:"expiryYear,omitempty"`
}

// AddBankCard links a tokenized bank card to the caller (POST
// /finance/bank-cards). Validation order: the body is validated before any
// database access (client errors never touch the database), the caller is
// then resolved DB-gated. A user may own at most 5 cards
// (BANK_CARD_LIMIT_REACHED); the first card becomes the default.
func (s *Server) AddBankCard(w http.ResponseWriter, r *http.Request) {
	var body bankCardCreateBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if strings.TrimSpace(body.Token) == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "token is required")
		return
	}
	if !bankCardLast4Pattern.MatchString(body.Last4) {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "last4 must be exactly 4 digits")
		return
	}
	if body.ExpiryMonth != nil && (*body.ExpiryMonth < 1 || *body.ExpiryMonth > 12) {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "expiryMonth must be between 1 and 12")
		return
	}
	if body.ExpiryYear != nil && (*body.ExpiryYear < 2000 || *body.ExpiryYear > 2100) {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "expiryYear is invalid")
		return
	}

	user, _, ok := s.financeUser(w, r)
	if !ok {
		return
	}
	ctx := r.Context()
	var count int
	if err := s.db.Pool().QueryRow(ctx,
		`SELECT count(*) FROM bank_cards WHERE user_id = $1`, user.ID).Scan(&count); err != nil {
		s.logger.Error("count bank cards failed", "user", user.ID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if count >= maxBankCardsPerUser {
		writeError(w, http.StatusConflict, "BANK_CARD_LIMIT_REACHED", "Bank card limit reached for this user")
		return
	}
	var id uuid.UUID
	if err := s.db.Pool().QueryRow(ctx,
		`INSERT INTO bank_cards (user_id, token, brand, last4, expiry_month, expiry_year, is_default)
		 VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
		user.ID, strings.TrimSpace(body.Token), body.Brand, body.Last4,
		body.ExpiryMonth, body.ExpiryYear, count == 0).Scan(&id); err != nil {
		s.logger.Error("create bank card failed", "user", user.ID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusCreated, bankCardToContract(id, body.Last4, body.Brand, count == 0, time.Now().UTC()))
}

// DeleteBankCard removes one of the caller's bank cards (DELETE
// /finance/bank-cards/{cardId}). When the deleted card was the default, the
// oldest remaining sibling is promoted in the same transaction. Unknown or
// another user's card surfaces BANK_CARD_NOT_FOUND.
func (s *Server) DeleteBankCard(w http.ResponseWriter, r *http.Request, cardId openapi_types.UUID) {
	user, _, ok := s.financeUser(w, r)
	if !ok {
		return
	}
	ctx := r.Context()
	var isDefault bool
	err := s.db.Pool().QueryRow(ctx,
		`SELECT is_default FROM bank_cards WHERE id = $1 AND user_id = $2 FOR UPDATE`,
		cardId, user.ID).Scan(&isDefault)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "BANK_CARD_NOT_FOUND", "Bank card not found")
		return
	}
	if err != nil {
		s.logger.Error("delete bank card load failed", "user", user.ID, "card", cardId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	tx, err := s.db.Pool().Begin(ctx)
	if err != nil {
		s.logger.Error("delete bank card begin failed", "user", user.ID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx,
		`DELETE FROM bank_cards WHERE id = $1 AND user_id = $2`, cardId, user.ID); err != nil {
		s.logger.Error("delete bank card failed", "user", user.ID, "card", cardId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if isDefault {
		if _, err := tx.Exec(ctx,
			`UPDATE bank_cards SET is_default = true
			 WHERE id = (SELECT id FROM bank_cards
			             WHERE user_id = $1 AND id <> $2
			             ORDER BY created_at, id LIMIT 1)`,
			user.ID, cardId); err != nil {
			s.logger.Error("delete bank card promote failed", "user", user.ID, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
	}
	if err := tx.Commit(ctx); err != nil {
		s.logger.Error("delete bank card commit failed", "user", user.ID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// SetDefaultBankCard makes one of the caller's cards the default (PUT
// /finance/bank-cards/{cardId}/default): the flag flips on for the target and
// off for every other card of the user in one transaction. Unknown or
// another user's card surfaces BANK_CARD_NOT_FOUND.
func (s *Server) SetDefaultBankCard(w http.ResponseWriter, r *http.Request, cardId openapi_types.UUID) {
	user, _, ok := s.financeUser(w, r)
	if !ok {
		return
	}
	ctx := r.Context()
	tx, err := s.db.Pool().Begin(ctx)
	if err != nil {
		s.logger.Error("set default bank card begin failed", "user", user.ID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx,
		`UPDATE bank_cards SET is_default = false WHERE user_id = $1`, user.ID); err != nil {
		s.logger.Error("set default bank card clear failed", "user", user.ID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	tag, err := tx.Exec(ctx,
		`UPDATE bank_cards SET is_default = true WHERE id = $1 AND user_id = $2`, cardId, user.ID)
	if err != nil {
		s.logger.Error("set default bank card set failed", "user", user.ID, "card", cardId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if tag.RowsAffected() == 0 {
		writeError(w, http.StatusNotFound, "BANK_CARD_NOT_FOUND", "Bank card not found")
		return
	}
	if err := tx.Commit(ctx); err != nil {
		s.logger.Error("set default bank card commit failed", "user", user.ID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// --- invoices -------------------------------------------------------------

// invoiceToContract maps an invoices row onto the contract Invoice. The
// total is always the server-computed subtotal + tax; the client never
// supplies it.
func invoiceToContract(id uuid.UUID, number string, subtotal, tax int64, status string, issuedAt, paidAt *time.Time, createdAt time.Time) gen.Invoice {
	out := gen.Invoice{
		Id:        newUUID(id.String()),
		Number:    number,
		AmountTZS: int(subtotal),
		Status:    gen.InvoiceStatus(status),
		CreatedAt: createdAt,
	}
	if tax > 0 {
		t := int(tax)
		out.TaxAmountTZS = &t
	}
	out.IssuedAt = issuedAt
	return out
}

// ListInvoices returns the merchant's invoices (GET /finance/invoices),
// newest first, keyset-paginated on (created_at, id) with the next page in
// X-Next-Cursor. The contract carries no pagination parameters, so limit
// (default 20, max 100) and cursor come from the query string; an empty
// array (never null) when the merchant has none.
func (s *Server) ListInvoices(w http.ResponseWriter, r *http.Request) {
	merchantID, ok := s.financeMerchantID(w, r)
	if !ok {
		return
	}
	limit := defaultInvoiceListLimit
	if raw := r.URL.Query().Get("limit"); raw != "" {
		if n, err := strconv.Atoi(raw); err == nil && n > 0 {
			limit = n
			if limit > maxInvoiceListLimit {
				limit = maxInvoiceListLimit
			}
		}
	}
	cursor := r.URL.Query().Get("cursor")

	query := `SELECT id, number, subtotal_tzs, tax_tzs, status, issued_at, paid_at, created_at
	          FROM invoices WHERE merchant_id = $1`
	args := []any{merchantID}
	if cursor != "" {
		at, id, err := parseInvoiceCursor(cursor)
		if err != nil {
			writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "cursor is invalid")
			return
		}
		args = append(args, at, id)
		query += ` AND (created_at, id) < ($2, $3)`
	}
	args = append(args, limit+1)
	query += fmt.Sprintf(" ORDER BY created_at DESC, id DESC LIMIT $%d", len(args))

	rows, err := s.db.Pool().Query(r.Context(), query, args...)
	if err != nil {
		s.logger.Error("list invoices failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer rows.Close()
	out := make([]gen.Invoice, 0, limit)
	var (
		lastAt   time.Time
		lastID   uuid.UUID
		sentinel bool
	)
	for rows.Next() {
		var (
			id        uuid.UUID
			number    string
			subtotal  int64
			tax       int64
			status    string
			issuedAt  *time.Time
			paidAt    *time.Time
			createdAt time.Time
		)
		if err := rows.Scan(&id, &number, &subtotal, &tax, &status, &issuedAt, &paidAt, &createdAt); err != nil {
			s.logger.Error("scan invoice failed", "merchant", merchantID, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		if len(out) == limit {
			sentinel = true
			continue
		}
		out = append(out, invoiceToContract(id, number, subtotal, tax, status, issuedAt, paidAt, createdAt))
		lastAt, lastID = createdAt, id
	}
	if err := rows.Err(); err != nil {
		s.logger.Error("iterate invoices failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if sentinel {
		w.Header().Set("X-Next-Cursor", encodeInvoiceCursor(lastAt, lastID))
	}
	writeJSON(w, http.StatusOK, out)
}

// RequestInvoice creates a merchant invoice (POST /finance/invoices). The
// total is computed server-side: total = amountTZS (subtotal) + taxAmountTZS;
// the client cannot influence it. Invoice numbers are unique per platform; a
// duplicate surfaces 409 VALIDATION_FAILED.
func (s *Server) RequestInvoice(w http.ResponseWriter, r *http.Request) {
	merchantID, ok := s.financeMerchantID(w, r)
	if !ok {
		return
	}
	var body gen.RequestInvoiceJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	number := strings.TrimSpace(body.Number)
	if number == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "number is required")
		return
	}
	if body.AmountTZS < 0 {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "amountTZS must not be negative")
		return
	}
	tax := int64(0)
	if body.TaxAmountTZS != nil {
		if *body.TaxAmountTZS < 0 {
			writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "taxAmountTZS must not be negative")
			return
		}
		tax = int64(*body.TaxAmountTZS)
	}
	subtotal := int64(body.AmountTZS)
	total := subtotal + tax

	var (
		id        uuid.UUID
		createdAt time.Time
	)
	err := s.db.Pool().QueryRow(r.Context(),
		`INSERT INTO invoices (merchant_id, number, subtotal_tzs, tax_tzs, total_tzs)
		 VALUES ($1, $2, $3, $4, $5) RETURNING id, created_at`,
		merchantID, number, subtotal, tax, total).Scan(&id, &createdAt)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			writeError(w, http.StatusConflict, "VALIDATION_FAILED", "An invoice with this number already exists")
			return
		}
		s.logger.Error("create invoice failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusCreated, invoiceToContract(id, number, subtotal, tax, "draft", nil, nil, createdAt))
}

// IssueInvoice moves a draft invoice to issued (POST
// /finance/invoices/{invoiceId}/issue). Only drafts are issuable: any other
// status surfaces 409 INVOICE_NOT_ISSUABLE. Unknown or another merchant's
// invoice surfaces INVOICE_NOT_FOUND.
func (s *Server) IssueInvoice(w http.ResponseWriter, r *http.Request, invoiceId openapi_types.UUID) {
	merchantID, ok := s.financeMerchantID(w, r)
	if !ok {
		return
	}
	ctx := r.Context()
	var status string
	err := s.db.Pool().QueryRow(ctx,
		`SELECT status FROM invoices WHERE id = $1 AND merchant_id = $2`, invoiceId, merchantID).Scan(&status)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "INVOICE_NOT_FOUND", "Invoice not found")
		return
	}
	if err != nil {
		s.logger.Error("issue invoice load failed", "merchant", merchantID, "invoice", invoiceId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if status != "draft" {
		writeError(w, http.StatusConflict, "INVOICE_NOT_ISSUABLE", "Only draft invoices can be issued")
		return
	}
	invoice, found, err := s.loadInvoice(ctx, merchantID, invoiceId)
	if err != nil || !found {
		s.logger.Error("issue invoice reload failed", "merchant", merchantID, "invoice", invoiceId, "found", found, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	issuedAt := time.Now().UTC()
	if _, err := s.db.Pool().Exec(ctx,
		`UPDATE invoices SET status = 'issued', issued_at = $3, updated_at = now()
		 WHERE id = $1 AND merchant_id = $2`, invoiceId, merchantID, issuedAt); err != nil {
		s.logger.Error("issue invoice failed", "merchant", merchantID, "invoice", invoiceId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	invoice.Status = gen.InvoiceStatusIssued
	invoice.IssuedAt = &issuedAt
	writeJSON(w, http.StatusOK, invoice)
}

// invoiceRow carries the stored invoice fields shared by the download and
// reload paths.
type invoiceRow struct {
	ID        uuid.UUID
	Number    string
	Subtotal  int64
	Tax       int64
	Total     int64
	Status    string
	IssuedAt  *time.Time
	PaidAt    *time.Time
	CreatedAt time.Time
}

// loadInvoice reads one invoice row owned by the merchant; a missing row
// returns ok=false.
func (s *Server) loadInvoice(ctx context.Context, merchantID uuid.UUID, invoiceID uuid.UUID) (gen.Invoice, bool, error) {
	var row invoiceRow
	err := s.db.Pool().QueryRow(ctx,
		`SELECT id, number, subtotal_tzs, tax_tzs, total_tzs, status, issued_at, paid_at, created_at
		 FROM invoices WHERE id = $1 AND merchant_id = $2`, invoiceID, merchantID).
		Scan(&row.ID, &row.Number, &row.Subtotal, &row.Tax, &row.Total, &row.Status,
			&row.IssuedAt, &row.PaidAt, &row.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return gen.Invoice{}, false, nil
	}
	if err != nil {
		return gen.Invoice{}, false, fmt.Errorf("finance: load invoice %s: %w", invoiceID, err)
	}
	return invoiceToContract(row.ID, row.Number, row.Subtotal, row.Tax, row.Status,
		row.IssuedAt, row.PaidAt, row.CreatedAt), true, nil
}

// DownloadInvoice returns the issued/paid invoice as plain text (GET
// /finance/invoices/{invoiceId}/download). The body is an honest simple
// invoice built from the stored row; draft invoices are not downloadable
// (409 INVOICE_NOT_ISSUABLE) and unknown or foreign invoices surface
// INVOICE_NOT_FOUND. The contract's downloadUrl envelope is deliberately not
// used: no document store exists, so the invoice text itself is served.
func (s *Server) DownloadInvoice(w http.ResponseWriter, r *http.Request, invoiceId openapi_types.UUID) {
	merchantID, ok := s.financeMerchantID(w, r)
	if !ok {
		return
	}
	invoice, found, err := s.loadInvoice(r.Context(), merchantID, invoiceId)
	if err != nil {
		s.logger.Error("download invoice load failed", "merchant", merchantID, "invoice", invoiceId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if !found {
		writeError(w, http.StatusNotFound, "INVOICE_NOT_FOUND", "Invoice not found")
		return
	}
	if invoice.Status != gen.InvoiceStatusIssued && invoice.Status != gen.InvoiceStatusPaid {
		writeError(w, http.StatusConflict, "INVOICE_NOT_ISSUABLE", "Only issued or paid invoices can be downloaded")
		return
	}
	var issuedLine string
	if invoice.IssuedAt != nil {
		issuedLine = "Issued at:      " + invoice.IssuedAt.UTC().Format(time.RFC3339) + "\n"
	}
	body := "HUDUMIKA INVOICE\n" +
		"================\n" +
		"Invoice number: " + invoice.Number + "\n" +
		"Status:         " + string(invoice.Status) + "\n" +
		issuedLine +
		"Subtotal:       " + strconv.FormatInt(invoiceRowTotal(invoice), 10) + "\n" +
		"================\n" +
		"TOTAL:          " + strconv.FormatInt(invoiceRowTotal(invoice), 10) + " TZS\n"
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="invoice-`+invoice.Number+`.txt"`)
	w.WriteHeader(http.StatusOK)
	if _, err := io.WriteString(w, body); err != nil {
		s.logger.Error("download invoice write failed", "merchant", merchantID, "invoice", invoiceId, "error", err)
	}
}

// invoiceRowTotal recomputes the invoice total from the row's subtotal and
// tax (the stored total is the same sum; recomputing keeps the text honest
// against the server-side rule total = subtotal + tax).
func invoiceRowTotal(invoice gen.Invoice) int64 {
	total := int64(invoice.AmountTZS)
	if invoice.TaxAmountTZS != nil {
		total += int64(*invoice.TaxAmountTZS)
	}
	return total
}

// encodeInvoiceCursor packs an invoice's (created_at, id) keyset into a
// URL-safe base64 cursor; parseInvoiceCursor is its inverse.
func encodeInvoiceCursor(createdAt time.Time, id uuid.UUID) string {
	raw := createdAt.UTC().Format(time.RFC3339Nano) + "|" + id.String()
	return base64.RawURLEncoding.EncodeToString([]byte(raw))
}

func parseInvoiceCursor(cursor string) (time.Time, uuid.UUID, error) {
	raw, err := base64.RawURLEncoding.DecodeString(cursor)
	if err != nil {
		return time.Time{}, uuid.Nil, fmt.Errorf("finance: decode invoice cursor: %w", err)
	}
	sep := strings.LastIndexByte(string(raw), '|')
	if sep < 0 {
		return time.Time{}, uuid.Nil, fmt.Errorf("finance: invoice cursor separator missing")
	}
	createdAt, err := time.Parse(time.RFC3339Nano, string(raw[:sep]))
	if err != nil {
		return time.Time{}, uuid.Nil, fmt.Errorf("finance: parse invoice cursor timestamp: %w", err)
	}
	id, err := uuid.Parse(string(raw[sep+1:]))
	if err != nil {
		return time.Time{}, uuid.Nil, fmt.Errorf("finance: parse invoice cursor id: %w", err)
	}
	return createdAt, id, nil
}

// --- daily settlements ----------------------------------------------------

// financeSettlementRow is one daily_settlements row.
type financeSettlementRow struct {
	ID         uuid.UUID
	MerchantID uuid.UUID
	CycleDate  time.Time
	TotalTZS   int64
	Count      int
	Status     string
	BatchID    *uuid.UUID
	PaidAt     *time.Time
}

const financeSettlementColumns = `id, merchant_id, cycle_date, total_tzs, count, status, batch_id, paid_at`

// scanSettlement scans one financeSettlementRow from a row; the column order
// must match financeSettlementColumns.
func scanSettlement(row pgx.Row) (financeSettlementRow, error) {
	var s financeSettlementRow
	err := row.Scan(&s.ID, &s.MerchantID, &s.CycleDate, &s.TotalTZS, &s.Count, &s.Status, &s.BatchID, &s.PaidAt)
	if err != nil {
		return financeSettlementRow{}, err
	}
	return s, nil
}

// settlementStatusToContract maps the stored status onto the contract enum
// (open/paid/settled): draft, processing and exception all project as open —
// the contract has no finer granularity; paid maps to paid.
func settlementStatusToContract(status string) gen.DailySettlementStatus {
	switch status {
	case "paid":
		return gen.DailySettlementStatusPaid
	default:
		return gen.DailySettlementStatusOpen
	}
}

// settlementToContract maps a daily_settlements row onto the contract
// DailySettlement. Revenue and payout are both the cycle total (the captured
// escrow released to the merchant); the batch id projects as batchNo.
func settlementToContract(s financeSettlementRow) gen.DailySettlement {
	out := gen.DailySettlement{
		Date:       openapi_types.Date{Time: s.CycleDate},
		RevenueTZS: int(s.TotalTZS),
		Status:     settlementStatusToContract(s.Status),
	}
	id := newUUID(s.ID.String())
	out.Id = &id
	count := s.Count
	out.OrderCount = &count
	payout := int(s.TotalTZS)
	out.PayoutTZS = &payout
	out.PaidAt = s.PaidAt
	if s.BatchID != nil {
		b := s.BatchID.String()
		out.BatchNo = &b
	}
	return out
}

// ListDailySettlements returns settlement records for the cycle window (GET
// /finance/settlements/daily). Finance staff see every merchant; a merchant
// session sees only its own rows; other roles are rejected with 403
// FORBIDDEN. from/to filter on the cycle date; both default to today.
func (s *Server) ListDailySettlements(w http.ResponseWriter, r *http.Request, params gen.ListDailySettlementsParams) {
	user, claims, ok := s.financeUser(w, r)
	if !ok {
		return
	}
	staff := staffRoles[claims.Role]
	if !staff && claims.Role != RoleMerchant {
		writeError(w, http.StatusForbidden, "FORBIDDEN", "Only finance staff or the merchant may view settlements")
		return
	}
	from := params.From
	to := params.To
	if from == nil && to == nil {
		today := openapi_types.Date{Time: time.Now().UTC()}
		from, to = &today, &today
	}
	if from != nil && to != nil && from.Time.After(to.Time) {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "from must not be after to")
		return
	}

	query := `SELECT ` + financeSettlementColumns + ` FROM daily_settlements WHERE 1 = 1`
	args := []any{}
	if !staff {
		args = append(args, user.ID)
		query += fmt.Sprintf(" AND merchant_id = $%d", len(args))
	}
	if from != nil {
		args = append(args, from.String())
		query += fmt.Sprintf(" AND cycle_date >= $%d", len(args))
	}
	if to != nil {
		args = append(args, to.String())
		query += fmt.Sprintf(" AND cycle_date <= $%d", len(args))
	}
	query += " ORDER BY cycle_date DESC, id"

	rows, err := s.db.Pool().Query(r.Context(), query, args...)
	if err != nil {
		s.logger.Error("list daily settlements failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer rows.Close()
	out := make([]gen.DailySettlement, 0, 8)
	for rows.Next() {
		settlement, err := scanSettlement(rows)
		if err != nil {
			s.logger.Error("scan daily settlement failed", "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		out = append(out, settlementToContract(settlement))
	}
	if err := rows.Err(); err != nil {
		s.logger.Error("iterate daily settlements failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// RunSettlement closes a daily settlement cycle for paid orders (POST
// /finance/settlements/run, body {date, reason}). A merchant caller settles
// its own paid orders; a finance-staff caller settles every merchant with
// paid orders on the cycle date (one row per merchant). The totals come from
// a single SUM over paid orders; the draft row is inserted with 201. An
// existing row for the (merchant, cycle) pair, or an empty cycle, surfaces
// 409 VALIDATION_FAILED. The reason is validated (max 500 chars) but not
// persisted: the schema has no reason column.
func (s *Server) RunSettlement(w http.ResponseWriter, r *http.Request) {
	user, claims, ok := s.financeUser(w, r)
	if !ok {
		return
	}
	staff := staffRoles[claims.Role]
	if !staff && claims.Role != RoleMerchant {
		writeError(w, http.StatusForbidden, "FORBIDDEN", "Only finance staff or the merchant may run settlements")
		return
	}
	var body gen.RunSettlementJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	if len(body.Reason) > settlementReasonMaxLen {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "reason must be at most 500 characters")
		return
	}
	cycle := body.Date.String()
	ctx := r.Context()

	var settlement financeSettlementRow
	var err error
	if staff {
		// One draft settlement row per merchant with paid orders on the
		// cycle; the data-modifying CTE returns the first row for the
		// response.
		settlement, err = scanSettlement(s.db.Pool().QueryRow(ctx,
			`WITH created AS (
				INSERT INTO daily_settlements (merchant_id, cycle_date, total_tzs, count)
				SELECT merchant_id, $1, SUM(total_tzs), count(*) FROM orders
				WHERE status = 'paid' AND created_at::date = $1
				GROUP BY merchant_id
				RETURNING `+financeSettlementColumns+`
			)
			SELECT * FROM created ORDER BY merchant_id LIMIT 1`, cycle))
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(w, http.StatusConflict, "VALIDATION_FAILED", "No paid orders to settle for this cycle")
			return
		}
		if err != nil {
			var pgErr *pgconn.PgError
			if errors.As(err, &pgErr) && pgErr.Code == "23505" {
				writeError(w, http.StatusConflict, "VALIDATION_FAILED", "A settlement already exists for this cycle")
				return
			}
			s.logger.Error("run settlement (staff) failed", "cycle", cycle, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		writeJSON(w, http.StatusCreated, settlementToContract(settlement))
		return
	}

	// Merchant path: settle the caller's own paid orders only.
	var exists bool
	if err := s.db.Pool().QueryRow(ctx,
		`SELECT EXISTS (SELECT 1 FROM daily_settlements WHERE merchant_id = $1 AND cycle_date = $2)`,
		user.ID, cycle).Scan(&exists); err != nil {
		s.logger.Error("run settlement existence check failed", "merchant", user.ID, "cycle", cycle, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if exists {
		writeError(w, http.StatusConflict, "VALIDATION_FAILED", "A settlement already exists for this cycle")
		return
	}
	var (
		total int64
		count int
	)
	if err := s.db.Pool().QueryRow(ctx,
		`SELECT COALESCE(SUM(total_tzs), 0), count(*) FROM orders
		 WHERE merchant_id = $1 AND status = 'paid' AND created_at::date = $2`,
		user.ID, cycle).Scan(&total, &count); err != nil {
		s.logger.Error("run settlement sum failed", "merchant", user.ID, "cycle", cycle, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if count == 0 {
		writeError(w, http.StatusConflict, "VALIDATION_FAILED", "No paid orders to settle for this cycle")
		return
	}
	settlement, err = scanSettlement(s.db.Pool().QueryRow(ctx,
		`INSERT INTO daily_settlements (merchant_id, cycle_date, total_tzs, count)
		 VALUES ($1, $2, $3, $4) RETURNING `+financeSettlementColumns,
		user.ID, cycle, total, count))
	if err != nil {
		s.logger.Error("run settlement insert failed", "merchant", user.ID, "cycle", cycle, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusCreated, settlementToContract(settlement))
}

// PayoutSettlement pays out a settlement (POST
// /finance/settlements/{settlementId}/payout): the captured escrow for the
// cycle is released to the merchant. A draft or processing settlement flips
// to paid with a payout batch entry in the same operation; a paid settlement
// surfaces 409 SETTLEMENT_ALREADY_PAID, an exception settlement 409
// VALIDATION_FAILED, and an unknown or foreign row SETTLEMENT_NOT_FOUND.
// Finance staff may pay out any settlement; a merchant may pay out its own.
func (s *Server) PayoutSettlement(w http.ResponseWriter, r *http.Request, settlementId openapi_types.UUID) {
	user, claims, ok := s.financeUser(w, r)
	if !ok {
		return
	}
	staff := staffRoles[claims.Role]
	if !staff && claims.Role != RoleMerchant {
		writeError(w, http.StatusForbidden, "FORBIDDEN", "Only finance staff or the merchant may pay out settlements")
		return
	}
	ctx := r.Context()

	var settlement financeSettlementRow
	var err error
	if staff {
		settlement, err = scanSettlement(s.db.Pool().QueryRow(ctx,
			`SELECT `+financeSettlementColumns+` FROM daily_settlements WHERE id = $1`, settlementId))
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(w, http.StatusNotFound, "SETTLEMENT_NOT_FOUND", "Settlement not found")
			return
		}
		if err != nil {
			s.logger.Error("payout settlement load failed", "settlement", settlementId, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
	} else {
		settlement, err = scanSettlement(s.db.Pool().QueryRow(ctx,
			`SELECT `+financeSettlementColumns+` FROM daily_settlements WHERE id = $1 AND merchant_id = $2`,
			settlementId, user.ID))
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(w, http.StatusNotFound, "SETTLEMENT_NOT_FOUND", "Settlement not found")
			return
		}
		if err != nil {
			s.logger.Error("payout settlement load failed", "settlement", settlementId, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
	}
	switch settlement.Status {
	case "paid":
		writeError(w, http.StatusConflict, "SETTLEMENT_ALREADY_PAID", "Settlement has already been paid out")
		return
	case "exception":
		writeError(w, http.StatusConflict, "VALIDATION_FAILED", "Settlement is in exception state and cannot be paid out")
		return
	case "draft", "processing":
	default:
		writeError(w, http.StatusConflict, "VALIDATION_FAILED", "Settlement is not payable in its current state")
		return
	}

	// Flip the settlement to paid first; the payout batch entry follows.
	paidAt := time.Now().UTC()
	var marked uuid.UUID
	err = s.db.Pool().QueryRow(ctx,
		`UPDATE daily_settlements SET status = 'paid', paid_at = $2
		 WHERE id = $1 AND status IN ('draft', 'processing') RETURNING id`,
		settlementId, paidAt).Scan(&marked)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusConflict, "SETTLEMENT_ALREADY_PAID", "Settlement has already been paid out")
		return
	}
	if err != nil {
		s.logger.Error("payout settlement status flip failed", "settlement", settlementId, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	// Join today's payout batch (created on demand; payout_batches.cycle is
	// UNIQUE per day — a batch created earlier by wallet withdrawals is
	// reused, mirroring wallet.go's ensure-batch pattern).
	cycle := settlement.CycleDate.Format(financePayoutCycleFormat)
	st := payouts.NewStore(s.db.Pool())
	batchID, err := st.CreateBatch(ctx, cycle)
	if err != nil {
		var pgErr *pgconn.PgError
		if !(errors.As(err, &pgErr) && pgErr.Code == "23505") {
			s.logger.Error("payout settlement batch create failed", "settlement", settlementId, "cycle", cycle, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		if err := s.db.Pool().QueryRow(ctx,
			`SELECT id FROM payout_batches WHERE cycle = $1`, cycle).Scan(&batchID); err != nil {
			s.logger.Error("payout settlement batch resolve failed", "settlement", settlementId, "cycle", cycle, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
	}
	if err := st.AddToBatch(ctx, batchID, settlement.MerchantID, settlement.TotalTZS, financePayoutMethod); err != nil {
		s.logger.Error("payout settlement batch add failed", "settlement", settlementId, "batch", batchID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	settlement.Status = "paid"
	settlement.PaidAt = &paidAt
	settlement.BatchID = &batchID
	writeJSON(w, http.StatusOK, settlementToContract(settlement))
}

// --- reconciliation -------------------------------------------------------

// GetReconciliation returns the order-to-account reconciliation summary for
// the window (GET /finance/reconciliation, staff only): matched = paid
// settlement records, exceptions = settlement records in exception state,
// orderTotalTZS = paid orders volume, paymentTotalTZS = captured payments.
// from/to default to today; from after to is rejected with 422.
func (s *Server) GetReconciliation(w http.ResponseWriter, r *http.Request, params gen.GetReconciliationParams) {
	_, claims, ok := s.financeUser(w, r)
	if !ok {
		return
	}
	if !staffRoles[claims.Role] {
		writeError(w, http.StatusForbidden, "FORBIDDEN", "Only finance staff may view reconciliation")
		return
	}
	from := params.From
	to := params.To
	if from == nil && to == nil {
		today := openapi_types.Date{Time: time.Now().UTC()}
		from, to = &today, &today
	}
	if from != nil && to != nil && from.Time.After(to.Time) {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "from must not be after to")
		return
	}
	fromStr := from.String()
	toStr := to.String()
	ctx := r.Context()

	var matched, exceptions int
	if err := s.db.Pool().QueryRow(ctx,
		`SELECT count(*) FILTER (WHERE status = 'paid'), count(*) FILTER (WHERE status = 'exception')
		 FROM daily_settlements WHERE cycle_date >= $1 AND cycle_date <= $2`,
		fromStr, toStr).Scan(&matched, &exceptions); err != nil {
		s.logger.Error("reconciliation settlement query failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	var orderTotal int64
	if err := s.db.Pool().QueryRow(ctx,
		`SELECT COALESCE(SUM(total_tzs), 0) FROM orders
		 WHERE status = 'paid' AND created_at::date >= $1 AND created_at::date <= $2`,
		fromStr, toStr).Scan(&orderTotal); err != nil {
		s.logger.Error("reconciliation order query failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	var paymentTotal int64
	if err := s.db.Pool().QueryRow(ctx,
		`SELECT COALESCE(SUM(amount_tzs), 0) FROM payment_intents
		 WHERE status = 'paid' AND paid_at::date >= $1 AND paid_at::date <= $2`,
		fromStr, toStr).Scan(&paymentTotal); err != nil {
		s.logger.Error("reconciliation payment query failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, gen.ReconciliationSummary{
		Exceptions:      exceptions,
		From:            *from,
		Matched:         matched,
		OrderTotalTZS:   int(orderTotal),
		PaymentTotalTZS: int(paymentTotal),
		To:              *to,
	})
}
