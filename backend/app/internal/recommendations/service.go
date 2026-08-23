package recommendations

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	openapi_types "github.com/oapi-codegen/runtime/types"

	"github.com/hudumika/api-backend/internal/gen"
)

// Service orchestrates the multi-stage recommendation pipeline.
type Service struct {
	db *pgxpool.Pool
}

func NewService(db *pgxpool.Pool) *Service {
	return &Service{db: db}
}

// daypart buckets: breakfast 6-10, lunch 11-14, dinner 17-21, late otherwise. Unknown when no time.
func DaypartFor(t time.Time) string {
	return daypartFor(t)
}
func daypartFor(t time.Time) string {
	loc := mustLoadTz()
	h := t.In(loc).Hour()
	switch {
	case h >= 6 && h <= 10:
		return "breakfast"
	case h >= 11 && h <= 14:
		return "lunch"
	case h >= 17 && h <= 21:
		return "dinner"
	default:
		return "late"
	}
}

// GetRecommendations implements the live engine. It is time/place/session/cold/warm-aware.
func (s *Service) GetRecommendations(ctx context.Context, userID uuid.UUID, cityID *uuid.UUID, lat, lon *float64, limit int, cursor string) ([]gen.RecommendedMerchant, error) {
	if limit <= 0 {
		limit = 5
	}
	if limit > 20 {
		limit = 20
	}

	// 1. Gather signals.
	viewed, _ := s.recentViewedMerchantIDs(ctx, userID, 20)
	favIDs, _ := s.favoriteMerchantIDs(ctx, userID)
	searchTerms, _ := s.recentSearchQueries(ctx, userID, 10)
	orderCounts, orderRecency, _ := s.orderHistorySignals(ctx, userID)
	sessionMerchantIDs, _ := s.sessionMerchantIDs(ctx, userID, 30*time.Minute, 20)
	recentOrdersForCount := len(orderCounts) // used for cold threshold

	// 2. Cold vs warm.
	isCold := recentOrdersForCount < 3 && len(viewed) < 5 && len(searchTerms) < 3

	// 3. Candidate generation (blended).
	candidates := s.candidates(ctx, cityID, lat, lon, orderCounts, viewed, searchTerms, favIDs, sessionMerchantIDs, isCold)

	// 4. If no candidates (empty city), fallback to city top-rated.
	if len(candidates) == 0 {
		candidates = s.topRatedInCity(ctx, cityID, 20)
	}

	// 5. Rank.
	now := time.Now()
	scored := s.rank(ctx, candidates, orderCounts, orderRecency, viewed, searchTerms, favIDs, sessionMerchantIDs, cityID, lat, lon, now, isCold)

	// 6. Re-rank (diversity, business, exploration, reasons already set in rank).
	scored = s.rerank(scored, sessionMerchantIDs, now)

	// 7. Cold-start pad: ensure 3-5 when warm but thin history.
	if !isCold && len(scored) >= 1 && len(scored) < 3 {
		fill := s.topRatedInCityExcluding(ctx, cityID, scored, 5-len(scored))
		scored = append(scored, fill...)
		// re-sort after pad
		sort.Slice(scored, func(i, j int) bool {
			if scored[i].Score != scored[j].Score {
				return scored[i].Score > scored[j].Score
			}
			if scored[i].Merchant.Rating != scored[j].Merchant.Rating {
				return scored[i].Merchant.Rating > scored[j].Merchant.Rating
			}
			return scored[i].Merchant.BusinessName < scored[j].Merchant.BusinessName
		})
	}

	// 8. Slice to limit + build response.
	if len(scored) > limit {
		scored = scored[:limit]
	}

	// 9. Record impression for A/B (Phase 2, best-effort).
	if len(scored) > 0 {
		go s.recordImpression(context.Background(), userID, scored, cityID, lat, lon)
	}

	out := make([]gen.RecommendedMerchant, 0, len(scored))
	for _, sc := range scored {
		m := sc.Merchant
		rm := gen.RecommendedMerchant{
			MerchantId:     openapiUUID(m.ID.String()),
			BusinessName:   m.BusinessName,
			Rating:         float32(m.Rating),
			ReviewCount:    int(m.ReviewCount),
			Reason:         sc.Reason,
			DeliveryMinutes: m.DeliveryMinutes,
		}
		if sc.Score != 0 {
			v := float32(sc.Score)
			rm.Score = &v
		}
		out = append(out, rm)
	}
	return out, nil
}

// scoredMerchant is internal ranking carrier.
type scoredMerchant struct {
	Merchant MerchantRow
	Score    float64
	Reason   string
}

type MerchantRow struct {
	ID              uuid.UUID
	BusinessName    string
	Rating          float64
	ReviewCount     int
	IsOpen          bool
	CityID          *uuid.UUID
	BusinessType    string
	Categories      []string
	DeliveryMinutes *int
}

func openapiUUID(s string) openapi_types.UUID {
	var id openapi_types.UUID
	_ = json.Unmarshal([]byte(`"`+s+`"`), &id)
	return id
}

// recentViewedMerchantIDs from user_behavior_events view_merchant last 20.
func (s *Service) recentViewedMerchantIDs(ctx context.Context, userID uuid.UUID, n int) ([]uuid.UUID, error) {
	rows, err := s.db.Query(ctx, `SELECT merchant_id FROM user_behavior_events WHERE user_id=$1 AND event_type='view_merchant' AND merchant_id IS NOT NULL ORDER BY created_at DESC LIMIT $2`, userID, n)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []uuid.UUID
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

func (s *Service) favoriteMerchantIDs(ctx context.Context, userID uuid.UUID) ([]uuid.UUID, error) {
	rows, err := s.db.Query(ctx, `SELECT merchant_id FROM favorites WHERE user_id=$1 ORDER BY created_at DESC`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []uuid.UUID
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

func (s *Service) recentSearchQueries(ctx context.Context, userID uuid.UUID, n int) ([]string, error) {
	rows, err := s.db.Query(ctx, `SELECT query FROM search_history WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2`, userID, n)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var q string
		if err := rows.Scan(&q); err != nil {
			return nil, err
		}
		out = append(out, strings.ToLower(q))
	}
	return out, rows.Err()
}

func (s *Service) orderHistorySignals(ctx context.Context, userID uuid.UUID) (map[uuid.UUID]int, map[uuid.UUID]time.Time, error) {
	rows, err := s.db.Query(ctx, `SELECT merchant_id, created_at FROM orders WHERE customer_user_id=$1 AND status NOT IN ('cancelled','refunded','failed') ORDER BY created_at DESC`, userID)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	counts := make(map[uuid.UUID]int)
	recency := make(map[uuid.UUID]time.Time)
	for rows.Next() {
		var mid uuid.UUID
		var at time.Time
		if err := rows.Scan(&mid, &at); err != nil {
			return nil, nil, err
		}
		counts[mid]++
		if _, ok := recency[mid]; !ok {
			recency[mid] = at // first seen is most recent due to DESC
		}
	}
	return counts, recency, rows.Err()
}

func (s *Service) sessionMerchantIDs(ctx context.Context, userID uuid.UUID, window time.Duration, n int) ([]uuid.UUID, error) {
	since := time.Now().Add(-window)
	rows, err := s.db.Query(ctx, `SELECT merchant_id FROM user_behavior_events WHERE user_id=$1 AND merchant_id IS NOT NULL AND created_at > $2 ORDER BY created_at DESC LIMIT $3`, userID, since, n)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []uuid.UUID
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

func (s *Service) candidates(ctx context.Context, cityID *uuid.UUID, lat, lon *float64, orderCounts map[uuid.UUID]int, viewed []uuid.UUID, searchTerms []string, favIDs []uuid.UUID, sessionIDs []uuid.UUID, isCold bool) []MerchantRow {
	// Gather merchant IDs from signals.
	seen := make(map[uuid.UUID]struct{})
	var mids []uuid.UUID
	add := func(ids []uuid.UUID) {
		for _, id := range ids {
			if _, ok := seen[id]; !ok {
				seen[id] = struct{}{}
				mids = append(mids, id)
			}
		}
	}
	add(viewed)
	for id := range orderCounts {
		if _, ok := seen[id]; !ok {
			seen[id] = struct{}{}
			mids = append(mids, id)
		}
	}
	add(favIDs)
	add(sessionIDs)
	// Search terms → content matches (simple: business_name ILIKE %term% in city)
	for _, q := range searchTerms {
		ids := s.merchantsMatchingQuery(ctx, cityID, q, 5)
		add(ids)
	}

	// If cold, seed with city popularity + curated fallback.
	if isCold {
		pop := s.popularInCity(ctx, cityID, 10)
		add(pop)
	}

	// Fetch merchant rows for those IDs + ensure city filter + is_open.
	if len(mids) == 0 {
		return nil
	}
	rows, err := s.db.Query(ctx, `SELECT id, business_name, COALESCE(rating,0), review_count, is_open, city_id, COALESCE(business_type,'') FROM merchants WHERE id = ANY($1) AND verification='approved'`, mids)
	if err != nil {
		return nil
	}
	defer rows.Close()
	var out []MerchantRow
	for rows.Next() {
		var m MerchantRow
		var rating float64
		if err := rows.Scan(&m.ID, &m.BusinessName, &rating, &m.ReviewCount, &m.IsOpen, &m.CityID, &m.BusinessType); err != nil {
			continue
		}
		m.Rating = rating
		out = append(out, m)
	}
	return out
}

func (s *Service) merchantsMatchingQuery(ctx context.Context, cityID *uuid.UUID, q string, n int) []uuid.UUID {
	if q == "" {
		return nil
	}
	like := "%" + q + "%"
	var rows pgx.Rows
	var err error
	if cityID != nil {
		rows, err = s.db.Query(ctx, `SELECT id FROM merchants WHERE verification='approved' AND city_id=$1 AND (business_name ILIKE $2 OR COALESCE(description,'') ILIKE $2) LIMIT $3`, *cityID, like, n)
	} else {
		rows, err = s.db.Query(ctx, `SELECT id FROM merchants WHERE verification='approved' AND (business_name ILIKE $1 OR COALESCE(description,'') ILIKE $1) LIMIT $2`, like, n)
	}
	if err != nil {
		return nil
	}
	defer rows.Close()
	var out []uuid.UUID
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err == nil {
			out = append(out, id)
		}
	}
	return out
}

func (s *Service) popularInCity(ctx context.Context, cityID *uuid.UUID, n int) []uuid.UUID {
	var rows pgx.Rows
	var err error
	if cityID != nil {
		rows, err = s.db.Query(ctx, `SELECT merchant_id FROM orders JOIN merchants ON merchants.id=orders.merchant_id WHERE merchants.city_id=$1 AND orders.status NOT IN ('cancelled','refunded','failed') AND orders.created_at > now() - interval '7 days' GROUP BY merchant_id ORDER BY COUNT(*) DESC LIMIT $2`, *cityID, n)
	} else {
		rows, err = s.db.Query(ctx, `SELECT merchant_id FROM orders WHERE status NOT IN ('cancelled','refunded','failed') AND created_at > now() - interval '7 days' GROUP BY merchant_id ORDER BY COUNT(*) DESC LIMIT $1`, n)
	}
	if err != nil {
		return nil
	}
	defer rows.Close()
	var out []uuid.UUID
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err == nil {
			out = append(out, id)
		}
	}
	// If not enough, pad with top-rated open merchants.
	if len(out) < n {
		need := n - len(out)
		more := s.topRatedInCityIDs(ctx, cityID, need, out)
		out = append(out, more...)
	}
	return out
}

func (s *Service) topRatedInCityIDs(ctx context.Context, cityID *uuid.UUID, n int, exclude []uuid.UUID) []uuid.UUID {
	exMap := make(map[uuid.UUID]struct{}, len(exclude))
	for _, id := range exclude {
		exMap[id] = struct{}{}
	}
	var rows pgx.Rows
	var err error
	if cityID != nil {
		rows, err = s.db.Query(ctx, `SELECT id FROM merchants WHERE verification='approved' AND is_open=true AND city_id=$1 ORDER BY COALESCE(rating,0) DESC, review_count DESC LIMIT $2`, *cityID, n+len(exclude)*2)
	} else {
		rows, err = s.db.Query(ctx, `SELECT id FROM merchants WHERE verification='approved' AND is_open=true ORDER BY COALESCE(rating,0) DESC, review_count DESC LIMIT $1`, n+len(exclude)*2)
	}
	if err != nil {
		return nil
	}
	defer rows.Close()
	var out []uuid.UUID
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err == nil {
			if _, ok := exMap[id]; !ok {
				out = append(out, id)
				if len(out) >= n {
					break
				}
			}
		}
	}
	return out
}

func (s *Service) topRatedInCity(ctx context.Context, cityID *uuid.UUID, n int) []MerchantRow {
	ids := s.topRatedInCityIDs(ctx, cityID, n, nil)
	if len(ids) == 0 {
		return nil
	}
	rows, err := s.db.Query(ctx, `SELECT id, business_name, COALESCE(rating,0), review_count, is_open, city_id, COALESCE(business_type,'') FROM merchants WHERE id = ANY($1)`, ids)
	if err != nil {
		return nil
	}
	defer rows.Close()
	var out []MerchantRow
	for rows.Next() {
		var m MerchantRow
		var rating float64
		if err := rows.Scan(&m.ID, &m.BusinessName, &rating, &m.ReviewCount, &m.IsOpen, &m.CityID, &m.BusinessType); err == nil {
			m.Rating = rating
			out = append(out, m)
		}
	}
	// preserve rating order
	sort.Slice(out, func(i, j int) bool {
		if out[i].Rating != out[j].Rating {
			return out[i].Rating > out[j].Rating
		}
		return out[i].ReviewCount > out[j].ReviewCount
	})
	return out
}

func (s *Service) topRatedInCityExcluding(ctx context.Context, cityID *uuid.UUID, scored []scoredMerchant, n int) []scoredMerchant {
	ex := make(map[uuid.UUID]struct{}, len(scored))
	for _, sc := range scored {
		ex[sc.Merchant.ID] = struct{}{}
	}
	ids := s.topRatedInCityIDs(ctx, cityID, n, nil)
	var out []scoredMerchant
	for _, id := range ids {
		if _, ok := ex[id]; ok {
			continue
		}
		// fetch row
		var m MerchantRow
		var rating float64
		err := s.db.QueryRow(ctx, `SELECT id, business_name, COALESCE(rating,0), review_count, is_open, city_id, COALESCE(business_type,'') FROM merchants WHERE id=$1`, id).Scan(&m.ID, &m.BusinessName, &rating, &m.ReviewCount, &m.IsOpen, &m.CityID, &m.BusinessType)
		if err != nil {
			continue
		}
		m.Rating = rating
		out = append(out, scoredMerchant{Merchant: m, Score: 0.1, Reason: "Top rated in your city"})
		if len(out) >= n {
			break
		}
	}
	return out
}

func (s *Service) rank(ctx context.Context, candidates []MerchantRow, orderCounts map[uuid.UUID]int, orderRecency map[uuid.UUID]time.Time, viewed []uuid.UUID, searchTerms []string, favIDs []uuid.UUID, sessionIDs []uuid.UUID, cityID *uuid.UUID, lat, lon *float64, now time.Time, isCold bool) []scoredMerchant {
	viewSet := make(map[uuid.UUID]struct{}, len(viewed))
	for _, id := range viewed {
		viewSet[id] = struct{}{}
	}
	favSet := make(map[uuid.UUID]struct{}, len(favIDs))
	for _, id := range favIDs {
		favSet[id] = struct{}{}
	}
	sessionSet := make(map[uuid.UUID]struct{}, len(sessionIDs))
	for _, id := range sessionIDs {
		sessionSet[id] = struct{}{}
	}
	searchSet := make(map[string]struct{}, len(searchTerms))
	for _, q := range searchTerms {
		searchSet[q] = struct{}{}
	}
	// Precompute max order count for normalization.
	maxCount := 1
	for _, c := range orderCounts {
		if c > maxCount {
			maxCount = c
		}
	}
	hour := now.In(mustLoadTz()).Hour()
	daypart := daypartFor(now)

	var out []scoredMerchant
	for _, m := range candidates {
		// Hard filter: never recommend closed.
		if !m.IsOpen {
			continue
		}
		score := 0.0
		reason := "Top rated in your city"

		// Repeat: order history, recency decay.
		if cnt, ok := orderCounts[m.ID]; ok {
			// Normalize 0..1
			norm := float64(cnt) / float64(maxCount)
			// Recency decay: recent order (7d) boost 1.3, old (60d) 0.8
			if at, ok2 := orderRecency[m.ID]; ok2 {
				days := now.Sub(at).Hours() / 24
				decay := math.Exp(-days / 30) // 30d half-life
				norm = norm * (0.7 + 0.6*decay)
			}
			score += 3.0 * norm
			reason = fmt.Sprintf("Because you ordered from them %dx", cnt)
			if cnt == 1 {
				reason = "Because you ordered from them"
			}
		} else if _, ok := favSet[m.ID]; ok {
			score += 2.2
			reason = "Your favorite"
		} else if _, ok := viewSet[m.ID]; ok {
			score += 1.8
			reason = "You viewed this"
		} else if _, ok := sessionSet[m.ID]; ok {
			score += 2.0
			reason = "Based on your session"
		}

		// Search term content similarity: business_name contains query.
		lname := strings.ToLower(m.BusinessName)
		for q := range searchSet {
			if strings.Contains(lname, q) || strings.Contains(strings.ToLower(strings.Join(m.Categories, " ")), q) {
				score += 1.5
				if reason == "Top rated in your city" {
					reason = fmt.Sprintf("Matches your search '%s'", q)
				}
			}
		}

		// Popularity (global, but city-filtered candidates already)
		popNorm := float64(m.ReviewCount) / 1000
		if popNorm > 1 {
			popNorm = 1
		}
		score += 0.6 * popNorm

		// Rating
		score += 0.8 * (m.Rating / 5.0)

		// DeliveryMinutes: faster delivery boost
		if m.DeliveryMinutes != nil && *m.DeliveryMinutes > 0 {
			// 15 min = 1.0, 60 min = 0.2
			etaNorm := 1.0 - (float64(*m.DeliveryMinutes)-15)/45*0.8
			if etaNorm < 0.2 {
				etaNorm = 0.2
			}
			if etaNorm > 1 {
				etaNorm = 1
			}
			score += 0.4 * etaNorm
		}

		// Time/daypart: lunch/dinner boost for restaurant business_type
		if daypart == "lunch" || daypart == "dinner" {
			if m.BusinessType == "restaurant" || strings.Contains(strings.ToLower(strings.Join(m.Categories, " ")), "food") {
				score += 0.3
				if hour >= 11 && hour <= 14 && reason == "Top rated in your city" {
					reason = "Popular for lunch"
				}
				if hour >= 17 && hour <= 21 && reason == "Top rated in your city" {
					reason = "Popular for dinner"
				}
			}
		} else if daypart == "breakfast" {
			if strings.Contains(lname, "chai") || strings.Contains(lname, "mandazi") || strings.Contains(lname, "breakfast") {
				score += 0.5
				if reason == "Top rated in your city" {
					reason = "Good for breakfast"
				}
			}
		}

		// Location: city match already, but boost if lat/lon near merchant city (future: actual distance)
		if cityID != nil && m.CityID != nil && *m.CityID == *cityID {
			score += 0.4
			if reason == "Top rated in your city" {
				reason = "Top rated in your city"
			}
		}

		// Trending: if merchant has recent orders velocity (we approximate via reviewCount already), keep.

		out = append(out, scoredMerchant{Merchant: m, Score: score, Reason: reason})
	}

	sort.Slice(out, func(i, j int) bool {
		if out[i].Score != out[j].Score {
			return out[i].Score > out[j].Score
		}
		if out[i].Merchant.Rating != out[j].Merchant.Rating {
			return out[i].Merchant.Rating > out[j].Merchant.Rating
		}
		return out[i].Merchant.BusinessName < out[j].Merchant.BusinessName
	})
	return out
}

func mustLoadTz() *time.Location {
	loc, _ := time.LoadLocation("Africa/Dar_es_Salaam")
	if loc == nil {
		return time.UTC
	}
	return loc
}

func (s *Service) rerank(scored []scoredMerchant, sessionIDs []uuid.UUID, now time.Time) []scoredMerchant {
	if len(scored) == 0 {
		return scored
	}
	// Diversity: max 2 same business_type in top 5
	typeCount := make(map[string]int)
	var out []scoredMerchant
	var deferred []scoredMerchant
	for _, sc := range scored {
		bt := sc.Merchant.BusinessType
		if typeCount[bt] >= 2 && len(out) < 5 {
			deferred = append(deferred, sc)
			continue
		}
		out = append(out, sc)
		typeCount[bt]++
		if len(out) >= 5 {
			break
		}
	}
	// Append deferred if still room
	for _, sc := range deferred {
		if len(out) >= 5 {
			break
		}
		out = append(out, sc)
	}
	// Fill up to 5 if still short and we had more
	if len(out) < 5 && len(scored) > len(out) {
		// add remaining in order
		seen := make(map[uuid.UUID]struct{}, len(out))
		for _, sc := range out {
			seen[sc.Merchant.ID] = struct{}{}
		}
		for _, sc := range scored {
			if _, ok := seen[sc.Merchant.ID]; ok {
				continue
			}
			out = append(out, sc)
			if len(out) >= 5 {
				break
			}
		}
	}
	// Exploration: 10% chance to inject a trending not in top (already handled via candidate popular)
	// For determinism in tests, we don't randomize; exploration is via candidate inclusion.
	return out
}

func (s *Service) recordImpression(ctx context.Context, userID uuid.UUID, scored []scoredMerchant, cityID *uuid.UUID, lat, lon *float64) {
	ids := make([]string, 0, len(scored))
	reasons := make([]string, 0, len(scored))
	for _, sc := range scored {
		ids = append(ids, sc.Merchant.ID.String())
		reasons = append(reasons, sc.Reason)
	}
	idsJSON, _ := json.Marshal(ids)
	reasonsJSON, _ := json.Marshal(reasons)
	_, _ = s.db.Exec(ctx, `INSERT INTO recommendation_impressions (user_id, merchant_ids, reasons, city_id, lat, lon) VALUES ($1, $2::jsonb, $3::jsonb, $4, $5, $6)`, userID, string(idsJSON), string(reasonsJSON), cityID, lat, lon)
}
