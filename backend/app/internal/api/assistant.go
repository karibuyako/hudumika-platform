package api

// PRODUCT ASSISTANT surface (backend/API-CONTRACT.yaml /products/assistant/*):
// a rule-based, deterministic product assistant. There is no model in this
// milestone (AI-LAYER.md honesty rule): describe composes text from the
// request keywords, suggestions are derived from order history with one
// query, and apply writes the suggested field onto the merchant's item.
//
// NOTE ON THE CONTRACT vs THE BUILD BRIEF: the contract body of
// /products/assistant/describe is {keywords, maxLength?} — there is no
// itemId — and the response is {description}. The describe handler is
// therefore stateless (no catalogue lookup) and needs no database.
//
// Error codes follow ERROR-CODES.md "Catalogue": ITEM_NOT_FOUND,
// CATALOGUE_MERCHANT_MISMATCH; validation failures are VALIDATION_FAILED.

import (
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"unicode"

	"github.com/google/uuid"

	"github.com/hudumika/api-backend/internal/gen"
	openapi_types "github.com/oapi-codegen/runtime/types"
)

const (
	// assistantDefaultMaxLength is the contract default for the describe
	// maxLength input.
	assistantDefaultMaxLength = 2000
	// assistantMinMaxLength bounds a caller-supplied maxLength so a
	// degenerate bound cannot force a near-empty description.
	assistantMinMaxLength = 20
	// assistantDescriptionMax is the apply-side bound for the description
	// field (contract CatalogueItem.description has no maxLength; the
	// symmetric create/update surfaces cap at 2000).
	assistantDescriptionMax = 2000
	// assistantPhotoMax bounds the photo URL accepted by apply.
	assistantPhotoMax = 2048
	// assistantTopItems is how many top sellers suggestions covers.
	assistantTopItems = 3
)

// describeFromKeywords builds the deterministic rule-based description:
// the keywords are normalized (trimmed, deduped preserving order), joined
// with ", ", first letter capitalised, and capped at maxLength on a word
// boundary. Identical input always yields identical output; no external AI
// is consulted (documented: a model-backed description would be a Phase 3
// upgrade, AI-LAYER.md).
func describeFromKeywords(keywords []string, maxLength int) string {
	seen := make(map[string]bool, len(keywords))
	clean := make([]string, 0, len(keywords))
	for _, kw := range keywords {
		kw = strings.TrimSpace(kw)
		if kw == "" || seen[kw] {
			continue
		}
		seen[kw] = true
		clean = append(clean, kw)
	}
	if len(clean) == 0 {
		return ""
	}
	text := strings.Join(clean, ", ")
	r := []rune(text)
	if len(r) > 0 && unicode.IsLetter(r[0]) {
		r[0] = unicode.ToUpper(r[0])
		text = string(r)
	}
	text += ". Order on Hudumika for fast delivery."
	if len(text) <= maxLength {
		return text
	}
	// Truncate at the last word boundary inside the bound; the ellipsis is
	// part of the deterministic output.
	cut := text[:maxLength]
	if i := strings.LastIndexByte(cut, ' '); i > 0 {
		cut = cut[:i]
	}
	return cut + " …"
}

// DescribeProductWithAssistant returns a deterministic, rule-based product
// description for the given keywords (POST /products/assistant/describe,
// contract {keywords, maxLength?} → {description}, 200). No database is
// touched: the contract binds no itemId and the rule has no model backing,
// so the handler is a pure function of the body.
func (s *Server) DescribeProductWithAssistant(w http.ResponseWriter, r *http.Request) {
	if _, ok := ClaimsFromContext(r.Context()); !ok {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Missing or invalid bearer token")
		return
	}
	var body gen.DescribeProductWithAssistantJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}
	maxLength := assistantDefaultMaxLength
	if body.MaxLength != nil {
		if *body.MaxLength < assistantMinMaxLength {
			writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED",
				fmt.Sprintf("maxLength must be at least %d", assistantMinMaxLength))
			return
		}
		maxLength = *body.MaxLength
	}
	description := describeFromKeywords(body.Keywords, maxLength)
	if description == "" {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED",
			"at least one non-empty keyword is required")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"description": description})
}

// productAssistantSuggestion is one entry of GET
// /products/assistant/suggestions (contract inline schema {type, suggestion,
// itemId?}; no generated type exists, the enum constants below keep the type
// vocabulary honest).
type productAssistantSuggestion struct {
	Type       string              `json:"type"`
	Suggestion string              `json:"suggestion"`
	ItemId     *openapi_types.UUID `json:"itemId,omitempty"`
}

// assistantSuggestionTypes maps the contract type enum to a reusable string;
// only the entries we can back with data are ever emitted (see
// GetProductAssistantSuggestions).
var assistantSuggestionTypes = map[gen.GetProductAssistantSuggestions200JSONResponseBodyType]string{
	gen.GetProductAssistantSuggestions200JSONResponseBodyTypeDescription: "description",
	gen.GetProductAssistantSuggestions200JSONResponseBodyTypePrice:       "price",
}

// topSeller is one row of the suggestions query: a merchant's item with its
// order-line count.
type topSeller struct {
	ItemID   uuid.UUID
	Name     string
	PriceTZS int64
	Units    int64
}

// GetProductAssistantSuggestions returns rule-based suggestions for the
// merchant's top-selling items (GET /products/assistant/suggestions, 200).
// One query aggregates order_items against orders that already cleared
// payment (the post-payment status chain) grouped by catalogue_item_id; the
// top items each get a deterministic "description" and "price" suggestion.
// category/photo/stock/title are deliberately never emitted: category and
// photo are merchant-chosen fields a rule has no basis to change, and stock
// is owned by the inventory bounded context. An empty catalogue (or no
// orders yet) serializes as [].
func (s *Server) GetProductAssistantSuggestions(w http.ResponseWriter, r *http.Request) {
	merchantID, ok := s.catalogueMerchantID(w, r)
	if !ok {
		return
	}
	rows, err := s.db.Pool().Query(r.Context(), `
		SELECT oi.catalogue_item_id, ci.name, ci.price_tzs, count(*) AS units
		FROM order_items oi
		JOIN orders o ON o.id = oi.order_id
		JOIN catalogue_items ci ON ci.id = oi.catalogue_item_id AND ci.deleted_at IS NULL
		WHERE ci.merchant_id = $1
		  AND oi.catalogue_item_id IS NOT NULL
		  AND o.status IN ('paid', 'merchant_accepted', 'preparing', 'rider_assigned',
		                   'picked_up', 'delivering', 'delivered', 'completed')
		GROUP BY oi.catalogue_item_id, ci.name, ci.price_tzs
		ORDER BY units DESC, oi.catalogue_item_id
		LIMIT $2`, merchantID, assistantTopItems)
	if err != nil {
		s.logger.Error("product assistant suggestions query failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	defer rows.Close()

	out := make([]productAssistantSuggestion, 0, assistantTopItems*2)
	for rows.Next() {
		var t topSeller
		if err := rows.Scan(&t.ItemID, &t.Name, &t.PriceTZS, &t.Units); err != nil {
			s.logger.Error("product assistant suggestions scan failed", "merchant", merchantID, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		id := newUUID(t.ItemID.String())
		out = append(out,
			productAssistantSuggestion{
				Type:       assistantSuggestionTypes[gen.GetProductAssistantSuggestions200JSONResponseBodyTypeDescription],
				Suggestion: fmt.Sprintf("%s — TZS %d. Ordered %d time(s) on Hudumika; a proven seller worth featuring in the menu and marketing.", t.Name, t.PriceTZS, t.Units),
				ItemId:     &id,
			},
			productAssistantSuggestion{
				Type:       assistantSuggestionTypes[gen.GetProductAssistantSuggestions200JSONResponseBodyTypePrice],
				Suggestion: fmt.Sprintf("Top seller with %d order(s) — keep the price at TZS %d or test a promotion.", t.Units, t.PriceTZS),
				ItemId:     &id,
			})
	}
	if err := rows.Err(); err != nil {
		s.logger.Error("product assistant suggestions iterate failed", "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// ApplyProductAssistantSuggestion writes one suggested field onto the
// merchant's item (POST /products/assistant/apply, body {itemId, type,
// value}, response CatalogueItem, 200). The merchant gate (catalogueMerchantID)
// scopes the guarded UPDATE: a miss — unknown id, another merchant's item,
// or a soft-deleted row — surfaces ITEM_NOT_FOUND without revealing
// ownership. type maps per the contract enum: title → name, description →
// description, price → price_tzs, category → category_id (must be a category
// of this merchant, else CATEGORY_NOT_FOUND), photo → image_url. stock is
// owned by the inventory bounded context and is rejected.
func (s *Server) ApplyProductAssistantSuggestion(w http.ResponseWriter, r *http.Request) {
	merchantID, ok := s.catalogueMerchantID(w, r)
	if !ok {
		return
	}
	var body gen.ApplyProductAssistantSuggestionJSONRequestBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "Invalid request body")
		return
	}

	ctx := r.Context()
	sets := []string{"updated_at = now()"}
	args := make([]any, 0, 3)
	value := strings.TrimSpace(body.Value)
	switch body.Type {
	case gen.ApplyProductAssistantSuggestionJSONBodyTypeTitle:
		if !validateCatalogueItemName(value) {
			writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "title value must be 1-160 characters")
			return
		}
		args = append(args, value)
		sets = append(sets, "name = "+argPlaceholder(len(args)))
	case gen.ApplyProductAssistantSuggestionJSONBodyTypeDescription:
		if value == "" || len(value) > assistantDescriptionMax {
			writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED",
				fmt.Sprintf("description value must be 1-%d characters", assistantDescriptionMax))
			return
		}
		args = append(args, value)
		sets = append(sets, "description = "+argPlaceholder(len(args)))
	case gen.ApplyProductAssistantSuggestionJSONBodyTypePrice:
		price, err := strconv.ParseInt(value, 10, 64)
		if err != nil || price < 0 {
			writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "price value must be a non-negative integer")
			return
		}
		args = append(args, price)
		sets = append(sets, "price_tzs = "+argPlaceholder(len(args)))
	case gen.ApplyProductAssistantSuggestionJSONBodyTypeCategory:
		if value == "" {
			writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "category value is required")
			return
		}
		categoryID, err := resolveCategoryID(ctx, s.db.Pool(), merchantID, value, false)
		if err != nil {
			if errors.Is(err, errCategoryNotFound) {
				writeError(w, http.StatusNotFound, "CATEGORY_NOT_FOUND", "Category does not belong to this merchant")
				return
			}
			s.logger.Error("assistant apply category lookup failed", "merchant", merchantID, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		if categoryID == nil {
			writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "category value is required")
			return
		}
		args = append(args, *categoryID)
		sets = append(sets, "category_id = "+argPlaceholder(len(args)))
	case gen.ApplyProductAssistantSuggestionJSONBodyTypePhoto:
		if value == "" || len(value) > assistantPhotoMax {
			writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED",
				fmt.Sprintf("photo value must be 1-%d characters", assistantPhotoMax))
			return
		}
		args = append(args, value)
		sets = append(sets, "image_url = "+argPlaceholder(len(args)))
	case gen.ApplyProductAssistantSuggestionJSONBodyTypeStock:
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED",
			"stock suggestions are owned by the inventory context and cannot be applied here")
		return
	default:
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED",
			"type must be one of title, description, price, category, photo, stock")
		return
	}

	itemID := uuid.UUID(body.ItemId)
	args = append(args, itemID, merchantID)
	query := fmt.Sprintf(`UPDATE catalogue_items SET %s
		WHERE id = $%d AND merchant_id = $%d AND deleted_at IS NULL`,
		strings.Join(sets, ", "), len(args)-1, len(args))
	tag, err := s.db.Pool().Exec(ctx, query, args...)
	if err != nil {
		s.logger.Error("assistant apply update failed", "item", itemID, "merchant", merchantID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if tag.RowsAffected() == 0 {
		// No ownership leak: unknown, soft-deleted and foreign items are
		// indistinguishable (ITEM_NOT_FOUND per ERROR-CODES.md "Catalogue").
		writeError(w, http.StatusNotFound, "ITEM_NOT_FOUND", "Catalogue item not found")
		return
	}
	item, err := s.loadCatalogueItem(ctx, s.db.Pool(), itemID)
	if err != nil {
		s.logger.Error("assistant apply reload failed", "item", itemID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	writeJSON(w, http.StatusOK, item)
}

// argPlaceholder renders the $n positional placeholder for the next query
// argument; the numbered placeholders stay dense because they are emitted in
// append order (same convention as UpdateCatalogueItem).
func argPlaceholder(n int) string {
	return fmt.Sprintf("$%d", n)
}
