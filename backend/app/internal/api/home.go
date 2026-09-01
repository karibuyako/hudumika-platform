package api

// HOME consumer BFF feed (backend/API-CONTRACT.yaml /home, operation
// getConsumerHome): the one-request dashboard for the customer app —
// service categories, approved merchants and providers, live promotions and
// group-buy deals, the caller's recent orders, unread notification count and
// platform membership. The contract response schema has no generated Go type
// (the openapi spec only declares an inline object), so the response shape
// lives here as homeFeedResponse.
//
// Auth: the router gates the route behind RequireAuth, so every request that
// reaches the handler carries a session; the caller is resolved to their
// users row via notificationUser (same resolution the notifications handlers
// use).
//
// Geo: the optional cityId narrows the merchant feed to merchants whose
// city_id matches (a NULL city_id never matches, so merchants without a city
// drop out of a city-scoped feed). Without cityId there is no geo filter and
// the feed is global. lat/lon are accepted for future proximity ranking but
// are not used by this milestone (documented deviation: no distance
// computation or radius filter yet).
//
// Every section is honest-empty: a table with no matching rows renders [],
// never null, and membership is nil unless the caller has a
// customer_memberships row.

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/hudumika/api-backend/internal/gen"
	"github.com/hudumika/api-backend/internal/groupbuy"
	"github.com/hudumika/api-backend/internal/loyalty"
	"github.com/hudumika/api-backend/internal/merchants"
	"github.com/hudumika/api-backend/internal/orders"
	"github.com/hudumika/api-backend/internal/promotions"
	openapi_types "github.com/oapi-codegen/runtime/types"
)

// GetSettings().DefaultHomeFeedLimit caps each unbounded feed section; the contract arrays carry
// no pagination, so a generous fixed cap keeps the payloads sane.
// Deprecated: use GetSettings().DefaultHomeFeedLimit instead.

// homeFeedResponse mirrors the contract /home response
// (required: generatedAt; the rest optional).
type homeFeedResponse struct {
	GeneratedAt  time.Time                   `json:"generatedAt"`
	Location     *homeFeedLocation           `json:"location,omitempty"`
	Categories   []gen.ServiceCategoryConfig `json:"categories"`
	Merchants    []gen.MerchantPublic        `json:"merchants"`
	Providers    []gen.ProviderPublic        `json:"providers"`
	Promotions   []gen.Promotion             `json:"promotions"`
	GroupBuys    []gen.GroupBuyDeal          `json:"groupBuys"`
	RecentOrders []gen.Order                 `json:"recentOrders"`
	UnreadCount  int                         `json:"unreadCount"`
	Membership   *gen.CustomerMembership     `json:"membership,omitempty"`
}

// homeFeedLocation is the contract's inline location object. Only the city
// is resolved this milestone; serviceArea stays empty until lat/lon drive
// area lookups.
type homeFeedLocation struct {
	City        string `json:"city,omitempty"`
	ServiceArea string `json:"serviceArea,omitempty"`
}

// GetConsumerHome assembles the home feed. All reads are plain sequential
// queries (no N+1); a failure anywhere surfaces the INTERNAL_ERROR envelope
// because a partial feed would be dishonest.
func (s *Server) GetConsumerHome(w http.ResponseWriter, r *http.Request, params gen.GetConsumerHomeParams) {
	user, err := s.notificationUser(r)
	if err != nil {
		s.writeNotificationUserError(w, err)
		return
	}

	out := homeFeedResponse{GeneratedAt: time.Now().UTC()}

	if params.CityId != nil {
		city, err := s.homeCityName(r, *params.CityId)
		if err != nil {
			s.logger.Error("home city lookup failed", "city", *params.CityId, "error", err)
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
			return
		}
		if city != "" {
			out.Location = &homeFeedLocation{City: city}
		}
	}

	out.Categories, err = s.homeCategories(r)
	if err != nil {
		s.logger.Error("home categories failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	var cityID *string
	if params.CityId != nil {
		v := params.CityId.String()
		cityID = &v
	}
	merchantRows, _, err := s.merchantStore().ListApprovedMerchants(r.Context(), cityID, GetSettings().DefaultHomeFeedLimit, "")
	if err != nil {
		s.logger.Error("home merchants failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	out.Merchants = make([]gen.MerchantPublic, 0, len(merchantRows))
	for i := range merchantRows {
		out.Merchants = append(out.Merchants, toMerchantPublic(&merchantRows[i]))
	}

	out.Providers, err = s.homeProviders(r)
	if err != nil {
		s.logger.Error("home providers failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	out.Promotions, err = s.homePromotions(r)
	if err != nil {
		s.logger.Error("home promotions failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	out.GroupBuys, err = s.homeGroupBuys(r)
	if err != nil {
		s.logger.Error("home group buys failed", "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	recent, err := s.homeRecentOrders(r, user.ID)
	if err != nil {
		s.logger.Error("home recent orders failed", "user", user.ID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	out.RecentOrders = recent

	out.UnreadCount, err = s.homeUnreadCount(r, user.ID)
	if err != nil {
		s.logger.Error("home unread count failed", "user", user.ID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}

	memberships, _, err := loyalty.NewStore(s.db.Pool()).GetMyMemberships(r.Context(), user.ID, 1, "")
	if err != nil {
		s.logger.Error("home membership lookup failed", "user", user.ID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Could not process request")
		return
	}
	if len(memberships) > 0 {
		m := toGenCustomerMembership(memberships[0])
		out.Membership = &m
	}

	writeJSON(w, http.StatusOK, out)
}

// homeCityName resolves a city row's name; "" when the id does not exist.
func (s *Server) homeCityName(r *http.Request, cityID openapi_types.UUID) (string, error) {
	var name string
	err := s.db.Pool().QueryRow(r.Context(),
		`SELECT name FROM cities WHERE id = $1`, cityID).Scan(&name)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("home: city %s: %w", cityID, err)
	}
	return name, nil
}

// homeCategories returns the active service category configuration. The
// table stores only id/name/sort/active, so the contract's optional
// configuration fields stay nil and pricingModel defaults to the neutral
// quote model (documented deviation — no per-category pricing is stored).
func (s *Server) homeCategories(r *http.Request) ([]gen.ServiceCategoryConfig, error) {
	rows, err := s.db.Pool().Query(r.Context(),
		`SELECT id, name FROM service_categories_config
		 WHERE active = true ORDER BY sort_order, name LIMIT $1`, GetSettings().DefaultHomeFeedLimit)
	if err != nil {
		return nil, fmt.Errorf("home: list categories: %w", err)
	}
	defer rows.Close()

	out := make([]gen.ServiceCategoryConfig, 0, 8)
	for rows.Next() {
		var (
			id   uuid.UUID
			name string
		)
		if err := rows.Scan(&id, &name); err != nil {
			return nil, fmt.Errorf("home: scan category: %w", err)
		}
		out = append(out, gen.ServiceCategoryConfig{
			Id:           newUUID(id.String()),
			Name:         name,
			PricingModel: gen.ServiceCategoryConfigPricingModelQuote,
		})
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("home: iterate categories: %w", err)
	}
	return out, nil
}

// homeProviders returns approved providers newest first. The merchants store
// has no approved-provider listing, so the query lives here (it is the only
// caller today).
func (s *Server) homeProviders(r *http.Request) ([]gen.ProviderPublic, error) {
	rows, err := s.db.Pool().Query(r.Context(),
		`SELECT id, owner_user_id, name, trade, bio, avatar_url, city_id,
		        base_rate_tzs, verification, verification_reason, reliability_score,
		        rating, review_count, payout_cycle_days, service_areas, created_at, updated_at
		 FROM providers
		 WHERE verification = 'approved'
		 ORDER BY created_at DESC, id DESC LIMIT $1`, GetSettings().DefaultHomeFeedLimit)
	if err != nil {
		return nil, fmt.Errorf("home: list providers: %w", err)
	}
	defer rows.Close()

	out := make([]gen.ProviderPublic, 0, 8)
	for rows.Next() {
		var (
			p           merchants.Provider
			serviceArea []byte
		)
		if err := rows.Scan(&p.ID, &p.OwnerUserID, &p.Name, &p.Trade, &p.Bio, &p.AvatarURL,
			&p.CityID, &p.BaseRateTZS, &p.Verification, &p.VerificationReason,
			&p.ReliabilityScore, &p.Rating, &p.ReviewCount, &p.PayoutCycleDays,
			&serviceArea, &p.CreatedAt, &p.UpdatedAt); err != nil {
			return nil, fmt.Errorf("home: scan provider: %w", err)
		}
		item := gen.ProviderPublic{
			Id:          newUUID(p.ID.String()),
			Name:        p.Name,
			Trade:       p.Trade,
			AvatarUrl:   p.AvatarURL,
			Rating:      merchantRating(p.Rating),
			ReviewCount: p.ReviewCount,
			Verified:    true,
		}
		if p.BaseRateTZS != nil {
			v := int(*p.BaseRateTZS)
			item.BaseRateTZS = &v
		}
		if len(serviceArea) > 0 {
			var areas []string
			if err := json.Unmarshal(serviceArea, &areas); err == nil {
				item.ServiceAreas = &areas
			}
		}
		out = append(out, item)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("home: iterate providers: %w", err)
	}
	return out, nil
}

// homePromotions returns live promotions within their window across every
// merchant, newest first. The promotions store only lists active campaigns
// per merchant, so the feed query lives here.
func (s *Server) homePromotions(r *http.Request) ([]gen.Promotion, error) {
	rows, err := s.db.Pool().Query(r.Context(),
		`SELECT id, merchant_id, type, title, description, rules, budget_tzs, status,
		        starts_at, ends_at, redeem_count, spend_tzs, reject_reason, performance,
		        created_at, updated_at
		 FROM promotions
		 WHERE status = 'live' AND starts_at <= now() AND ends_at > now()
		 ORDER BY created_at DESC, id DESC LIMIT $1`, GetSettings().DefaultHomeFeedLimit)
	if err != nil {
		return nil, fmt.Errorf("home: list promotions: %w", err)
	}
	defer rows.Close()

	out := make([]gen.Promotion, 0, 8)
	for rows.Next() {
		var (
			row         promotions.PromotionRow
			rules       []byte
			performance []byte
		)
		if err := rows.Scan(&row.ID, &row.MerchantID, &row.Type, &row.Title, &row.Description,
			&rules, &row.BudgetTZS, &row.Status, &row.StartsAt, &row.EndsAt,
			&row.RedeemCount, &row.SpendTZS, &row.RejectReason, &performance,
			&row.CreatedAt, &row.UpdatedAt); err != nil {
			return nil, fmt.Errorf("home: scan promotion: %w", err)
		}
		if len(rules) > 0 {
			_ = json.Unmarshal(rules, &row.Rules)
		}
		if len(performance) > 0 {
			_ = json.Unmarshal(performance, &row.Performance)
		}
		out = append(out, toGenPromotion(row))
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("home: iterate promotions: %w", err)
	}
	return out, nil
}

// homeGroupBuys returns active group-buy deals still in their sale window,
// newest first. The groupbuy store lists by status only, so the feed adds
// the end_at guard here.
func (s *Server) homeGroupBuys(r *http.Request) ([]gen.GroupBuyDeal, error) {
	rows, err := s.db.Pool().Query(r.Context(),
		`SELECT id, merchant_id, title, description, original_price_tzs, deal_price_tzs,
		        quantity_total, quantity_sold, start_at, end_at, status, created_at, updated_at
		 FROM group_buy_deals
		 WHERE status = 'active' AND end_at > now()
		 ORDER BY created_at DESC, id DESC LIMIT $1`, GetSettings().DefaultHomeFeedLimit)
	if err != nil {
		return nil, fmt.Errorf("home: list group buys: %w", err)
	}
	defer rows.Close()

	out := make([]gen.GroupBuyDeal, 0, 8)
	for rows.Next() {
		var row groupbuy.DealRow
		if err := rows.Scan(&row.ID, &row.MerchantID, &row.Title, &row.Description,
			&row.OriginalPriceTZS, &row.DealPriceTZS, &row.QuantityTotal, &row.QuantitySold,
			&row.StartAt, &row.EndAt, &row.Status, &row.CreatedAt, &row.UpdatedAt); err != nil {
			return nil, fmt.Errorf("home: scan group buy: %w", err)
		}
		out = append(out, toGenGroupBuyDeal(row))
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("home: iterate group buys: %w", err)
	}
	return out, nil
}

// homeRecentOrders returns the caller's 5 newest orders (newest first). The
// orders store pages oldest-first, so the feed query lives here; the column
// list mirrors the store's orderColumns so rows scan onto orders.OrderRow.
func (s *Server) homeRecentOrders(r *http.Request, userID uuid.UUID) ([]gen.Order, error) {
	const recentOrderColumns = `id, no, customer_user_id, merchant_id, rider_id, status, subtotal_tzs,
		delivery_fee_tzs, platform_fee_tzs, tax_tzs, discount_tzs, total_tzs,
		delivery_address, note, version, source, created_at, updated_at`
	rows, err := s.db.Pool().Query(r.Context(),
		`SELECT `+recentOrderColumns+` FROM orders
		 WHERE customer_user_id = $1
		 ORDER BY created_at DESC, id DESC LIMIT 5`, userID)
	if err != nil {
		return nil, fmt.Errorf("home: recent orders for %s: %w", userID, err)
	}
	defer rows.Close()

	out := make([]gen.Order, 0, 5)
	for rows.Next() {
		var (
			row     orders.OrderRow
			address []byte
		)
		if err := rows.Scan(&row.ID, &row.No, &row.CustomerUserID, &row.MerchantID, &row.RiderID,
			&row.Status, &row.SubtotalTZS, &row.DeliveryFeeTZS, &row.PlatformFeeTZS,
			&row.TaxTZS, &row.DiscountTZS, &row.TotalTZS, &address, &row.Note,
			&row.Version, &row.Source, &row.CreatedAt, &row.UpdatedAt); err != nil {
			return nil, fmt.Errorf("home: scan recent order: %w", err)
		}
		if len(address) > 0 {
			var a orders.AddressSnapshot
			if err := json.Unmarshal(address, &a); err != nil {
				return nil, fmt.Errorf("home: decode recent order address: %w", err)
			}
			row.DeliveryAddress = &a
		}
		out = append(out, toGenOrder(row))
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("home: iterate recent orders: %w", err)
	}
	return out, nil
}

// homeUnreadCount counts the caller's unread in-app notifications.
func (s *Server) homeUnreadCount(r *http.Request, userID uuid.UUID) (int, error) {
	var count int
	if err := s.db.Pool().QueryRow(r.Context(),
		`SELECT COUNT(*) FROM notifications WHERE user_id = $1 AND NOT read`, userID).Scan(&count); err != nil {
		return 0, fmt.Errorf("home: count unread notifications for %s: %w", userID, err)
	}
	return count, nil
}
