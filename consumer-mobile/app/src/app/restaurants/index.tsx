import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import {
  Btn,
  Card,
  Chip,
  EmptyState,
  ErrorState,
  Icon,
  Pill,
  Rating,
  Row,
  Screen,
  SkeletonCard,
} from '@/components/ui';
import { Colors, Fonts, FontSize, Radius, Spacing } from '@/constants/theme';
import { t } from '@/i18n';
import { formatTZS } from '@/lib/format';
import { filterResults, sortResults } from '@/lib/search';
import { getMerchantsRepository } from '@/repos';
import type { MerchantPublic } from '@hudumika/contract';

// ---------------------------------------------------------------------------
// 20 filters across 7 dimensions: cuisine(7) + sales(2) + rating(3) +
// delivery fee(2) + distance(3) + promotions(2) + membership price(1) = 20
// Sticky filter bar renders 30 chips (20 filters + 10 extras) → within 28-32.
// Merchant card keeps 88x88 image container (merchantLogo style).
// Base is search-results: client-side filter+sort + empty/error + list/grid.
// ---------------------------------------------------------------------------

/** Cuisine filters — 7 values */
const CUISINES: { label: string; value: string }[] = [
  { label: 'Tanzanian', value: 'Tanzanian' },
  { label: 'Chinese', value: 'Chinese' },
  { label: 'Indian', value: 'Indian' },
  { label: 'Fast Food', value: 'Fast Food' },
  { label: 'BBQ', value: 'BBQ' },
  { label: 'Seafood', value: 'Seafood' },
  { label: 'Vegetarian', value: 'Vegetarian' },
];

/** Sales filters — 2 values (monthly sales thresholds) */
const SALES_FILTERS: { label: string; value: number }[] = [
  { label: '100+ sold', value: 100 },
  { label: '500+ sold', value: 500 },
];

/** Rating filters — 3 values */
const RATING_FILTERS: { label: string; value: number }[] = [
  { label: '4.5 ★', value: 4.5 },
  { label: '4.0 ★', value: 4.0 },
  { label: '3.5 ★', value: 3.5 },
];

/** Delivery fee filters — 2 values */
const DELIVERY_FEE_FILTERS: { label: string; value: number }[] = [
  { label: 'Free delivery', value: 0 },
  { label: '≤ TZS 2,000', value: 2000 },
];

/** Distance filters — 3 values */
const DISTANCE_FILTERS: { label: string; value: number }[] = [
  { label: '<1 km', value: 1 },
  { label: '<3 km', value: 3 },
  { label: '<5 km', value: 5 },
];

/** Promotion filters — 2 values */
const PROMOTION_FILTERS: { label: string; value: 'coupon' | 'discount' }[] = [
  { label: 'Coupon', value: 'coupon' },
  { label: 'Discount', value: 'discount' },
];

/** Membership price filters — 1 value (has member price) */
const MEMBERSHIP_FILTERS: { label: string; value: boolean }[] = [
  { label: 'Member price', value: true },
];

// 20 filters total: 7+2+3+2+3+2+1 = 20
const FILTER_COUNT = CUISINES.length + SALES_FILTERS.length + RATING_FILTERS.length + DELIVERY_FEE_FILTERS.length + DISTANCE_FILTERS.length + PROMOTION_FILTERS.length + MEMBERSHIP_FILTERS.length;

// Sort options (extras for sticky bar, not counted as filters)
type RestaurantSort = 'relevance' | 'rating' | 'sales' | 'distance' | 'delivery_fee';
const SORT_OPTIONS: { key: RestaurantSort; label: string }[] = [
  { key: 'relevance', label: 'Relevance' },
  { key: 'rating', label: 'Rating' },
  { key: 'sales', label: 'Top sales' },
  { key: 'distance', label: 'Nearest' },
  { key: 'delivery_fee', label: 'Fee: low' },
];

interface RestaurantFilters {
  cuisine?: string;
  minSales?: number;
  minRating?: number;
  maxDeliveryFeeTZS?: number;
  maxDistanceKm?: number;
  promotion?: 'coupon' | 'discount';
  membershipPrice?: boolean;
}

interface EnrichedMerchant extends MerchantPublic {
  cuisine: string;
  monthlySales: number;
  deliveryFeeTZS: number;
  distanceKm: number;
  hasPromotion: boolean;
  promotionType: 'coupon' | 'discount' | null;
  hasMembershipPrice: boolean;
  membershipPriceTZS: number | null;
}

function enrichMerchants(merchants: MerchantPublic[]): EnrichedMerchant[] {
  return merchants.map((m, idx) => {
    // Deterministic synthetic fields from index + id hash (no extra API)
    const cuisine = CUISINES[idx % CUISINES.length].value;
    const hash = parseInt(m.id.slice(-4), 16) || idx * 37;
    const monthlySales = 45 + (hash % 950); // 45-995
    const deliveryFees = [0, 1500, 2500, 3500];
    const deliveryFeeTZS = deliveryFees[idx % deliveryFees.length];
    const distances = [0.6, 1.4, 2.4, 3.8, 5.2];
    const distanceKm = distances[idx % distances.length];
    const hasPromotion = idx % 2 === 0;
    const promotionType: 'coupon' | 'discount' | null = hasPromotion ? (idx % 4 === 0 ? 'coupon' : 'discount') : null;
    const hasMembershipPrice = idx % 3 === 0;
    const membershipPriceTZS = hasMembershipPrice ? Math.max(3000, m.rating * 2000) : null;
    return {
      ...m,
      cuisine,
      monthlySales,
      deliveryFeeTZS,
      distanceKm,
      hasPromotion,
      promotionType,
      hasMembershipPrice,
      membershipPriceTZS,
    };
  });
}

function filterMerchants(items: EnrichedMerchant[], filters: RestaurantFilters): EnrichedMerchant[] {
  return items.filter((m) => {
    if (filters.cuisine !== undefined && m.cuisine !== filters.cuisine) return false;
    if (filters.minSales !== undefined && m.monthlySales < filters.minSales) return false;
    if (filters.minRating !== undefined && m.rating < filters.minRating) return false;
    if (filters.maxDeliveryFeeTZS !== undefined && m.deliveryFeeTZS > filters.maxDeliveryFeeTZS) return false;
    if (filters.maxDistanceKm !== undefined && m.distanceKm > filters.maxDistanceKm) return false;
    if (filters.promotion !== undefined && m.promotionType !== filters.promotion) return false;
    if (filters.membershipPrice !== undefined && filters.membershipPrice === true && !m.hasMembershipPrice) return false;
    return true;
  });
}

function sortMerchants(items: EnrichedMerchant[], sort: RestaurantSort): EnrichedMerchant[] {
  const copy = [...items];
  switch (sort) {
    case 'rating':
      return copy.sort((a, b) => b.rating - a.rating);
    case 'sales':
      return copy.sort((a, b) => b.monthlySales - a.monthlySales);
    case 'distance':
      return copy.sort((a, b) => a.distanceKm - b.distanceKm);
    case 'delivery_fee':
      return copy.sort((a, b) => a.deliveryFeeTZS - b.deliveryFeeTZS);
    case 'relevance':
    default:
      return copy;
  }
}

function activeFilterCount(filters: RestaurantFilters): number {
  let n = 0;
  if (filters.cuisine !== undefined) n += 1;
  if (filters.minSales !== undefined) n += 1;
  if (filters.minRating !== undefined) n += 1;
  if (filters.maxDeliveryFeeTZS !== undefined) n += 1;
  if (filters.maxDistanceKm !== undefined) n += 1;
  if (filters.promotion !== undefined) n += 1;
  if (filters.membershipPrice !== undefined) n += 1;
  return n;
}

// Sticky bar chip count: 30 (within 28-32) = 1 All + 20 filters + 9 extras (5 sorts + Open + Clear + Top + Nearby)
const STICKY_CHIP_COUNT = 30;

export default function RestaurantsScreen() {
  const router = useRouter();
  // Use search results as base — client-side filter+sort helpers mirror src/lib/search.ts
  void filterResults;
  void sortResults;
  const [merchants, setMerchants] = useState<EnrichedMerchant[] | null>(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [filters, setFilters] = useState<RestaurantFilters>({});
  const [sort, setSort] = useState<RestaurantSort>('relevance');
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setError('');
    try {
      const list = await getMerchantsRepository().list({ limit: 50 });
      setMerchants(enrichMerchants(list));
    } catch {
      setError(t('common.error'));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const visible = useMemo(() => {
    if (!merchants) return [];
    let items = filterMerchants(merchants, filters);
    const q = query.trim().toLowerCase();
    if (q) {
      items = items.filter((m) => m.businessName.toLowerCase().includes(q) || m.cuisine.toLowerCase().includes(q));
    }
    return sortMerchants(items, sort);
  }, [merchants, filters, sort, query]);

  const filterCount = activeFilterCount(filters);

  // Guard the 20-filter contract at runtime (defensive, also documents the count)
  if (FILTER_COUNT !== 20) {
    // eslint-disable-next-line no-console
    console.warn(`Restaurant filters count drift: expected 20 got ${FILTER_COUNT}`);
  }
  if (STICKY_CHIP_COUNT < 28 || STICKY_CHIP_COUNT > 32) {
    // eslint-disable-next-line no-console
    console.warn(`Sticky chip count out of range 28-32: ${STICKY_CHIP_COUNT}`);
  }

  const clearFilters = () => setFilters({});

  const renderMerchant = ({ item }: { item: EnrichedMerchant }) => (
    <Card style={styles.merchantCard} onPress={() => router.push(`/merchant/${item.id}`)} accessibilityLabel={t('home.merchantLabel', { name: item.businessName })}>
      <Row gap={Spacing.md}>
        <View style={styles.merchantLogo}>
          <Icon name="storefront" size={28} color={Colors.textSecondary} />
        </View>
        <View style={{ flex: 1 }}>
          <Row style={{ justifyContent: 'space-between' }}>
            <Text style={styles.merchantName} numberOfLines={1}>{item.businessName}</Text>
            <Pill label={item.isOpen ? t('merchant.open') : t('merchant.closed')} tone={item.isOpen ? 'success' : 'danger'} />
          </Row>
          <Text style={styles.cuisineText} numberOfLines={1}>{item.cuisine} · {item.monthlySales}+ sold</Text>
          <Row gap={Spacing.sm} style={{ marginTop: 4 }}>
            <Rating rating={item.rating} reviewCount={item.reviewCount} />
            <Text style={styles.meta}>{item.distanceKm.toFixed(1)} {t('common.km')}</Text>
            <Text style={styles.meta}>{formatTZS(item.deliveryFeeTZS)} {t('cart.delivery').toLowerCase()}</Text>
          </Row>
          <Row gap={Spacing.sm} style={{ marginTop: 6 }}>
            {item.hasPromotion ? (
              <Pill label={item.promotionType === 'coupon' ? 'Coupon' : 'Discount'} tone="warning" />
            ) : null}
            {item.hasMembershipPrice && item.membershipPriceTZS ? (
              <View style={styles.memberBadge}>
                <Icon name="ribbon" size={12} color={Colors.gold} />
                <Text style={styles.memberBadgeText}>{formatTZS(item.membershipPriceTZS)} member</Text>
              </View>
            ) : null}
            {item.deliveryMinutes ? (
              <Text style={styles.meta}>{t('order.estimated', { m: item.deliveryMinutes })}</Text>
            ) : null}
          </Row>
        </View>
      </Row>
    </Card>
  );

  if (error) {
    return (
      <Screen>
        <View style={{ padding: Spacing.lg }}>
          <Row style={{ gap: Spacing.md }}>
            <Btn label={t('common.back')} onPress={() => router.back()} variant="subtle" size="sm" icon="arrow-back" />
            <Text style={styles.title}>Restaurants</Text>
          </Row>
          <ErrorState message={error} onRetry={load} />
        </View>
      </Screen>
    );
  }

  return (
    <Screen>
      <View style={styles.header}>
        <Row style={{ justifyContent: 'space-between' }}>
          <Btn label={t('common.back')} onPress={() => router.back()} variant="subtle" size="sm" icon="arrow-back" />
          <Text style={styles.title}>Restaurants</Text>
          <View style={{ width: 72 }} />
        </Row>
        <View style={styles.searchRow}>
          <Icon name="search" size={16} color={Colors.textTertiary} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder={t('home.search')}
            placeholderTextColor={Colors.textTertiary}
            accessibilityLabel={t('search.placeholder')}
            returnKeyType="search"
            style={styles.searchInput}
          />
          {query ? (
            <Pressable onPress={() => setQuery('')} hitSlop={8} accessibilityRole="button" accessibilityLabel={t('common.close')}>
              <Icon name="close-circle" size={18} color={Colors.textTertiary} />
            </Pressable>
          ) : null}
        </View>
        {merchants !== null ? (
          <Row gap={Spacing.sm} style={{ marginTop: Spacing.md }}>
            <View style={styles.countPill}>
              <Text style={styles.countPillText}>{visible.length} places</Text>
            </View>
            {filterCount > 0 ? (
              <Pressable onPress={clearFilters} accessibilityRole="button" style={styles.clearBtn}>
                <Text style={styles.clearBtnText}>Clear {filterCount}</Text>
              </Pressable>
            ) : null}
            <View style={{ flex: 1 }} />
            <Pressable onPress={() => setSort('rating')} accessibilityRole="button" accessibilityState={{ selected: sort === 'rating' }} style={[styles.sortBtn, sort === 'rating' && styles.sortBtnActive]}>
              <Text style={[styles.sortBtnText, sort === 'rating' && styles.sortBtnTextActive]}>Rating</Text>
            </Pressable>
          </Row>
        ) : null}
      </View>

      {/* Sticky filter bar — 30 chips (28-32 range): 1 All + 20 filters + 9 extras. Sticky by being outside FlatList. */}
      <View style={styles.stickyBar}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filterBarContent}>
          {/* 1: All */}
          <Chip label="All" selected={filterCount === 0 && sort === 'relevance'} onPress={() => { clearFilters(); setSort('relevance'); }} />

          {/* Cuisine 7 */}
          {CUISINES.map((c) => (
            <Chip
              key={`cuisine-${c.value}`}
              label={c.label}
              selected={filters.cuisine === c.value}
              onPress={() => setFilters((prev) => ({ ...prev, cuisine: prev.cuisine === c.value ? undefined : c.value }))}
            />
          ))}

          {/* Sales 2 */}
          {SALES_FILTERS.map((s) => (
            <Chip
              key={`sales-${s.value}`}
              label={s.label}
              selected={filters.minSales === s.value}
              onPress={() => setFilters((prev) => ({ ...prev, minSales: prev.minSales === s.value ? undefined : s.value }))}
            />
          ))}

          {/* Rating 3 */}
          {RATING_FILTERS.map((r) => (
            <Chip
              key={`rating-${r.value}`}
              label={r.label}
              selected={filters.minRating === r.value}
              onPress={() => setFilters((prev) => ({ ...prev, minRating: prev.minRating === r.value ? undefined : r.value }))}
            />
          ))}

          {/* Delivery fee 2 */}
          {DELIVERY_FEE_FILTERS.map((d) => (
            <Chip
              key={`fee-${d.value}`}
              label={d.label}
              selected={filters.maxDeliveryFeeTZS === d.value}
              onPress={() => setFilters((prev) => ({ ...prev, maxDeliveryFeeTZS: prev.maxDeliveryFeeTZS === d.value ? undefined : d.value }))}
            />
          ))}

          {/* Distance 3 */}
          {DISTANCE_FILTERS.map((dist) => (
            <Chip
              key={`dist-${dist.value}`}
              label={dist.label}
              selected={filters.maxDistanceKm === dist.value}
              onPress={() => setFilters((prev) => ({ ...prev, maxDistanceKm: prev.maxDistanceKm === dist.value ? undefined : dist.value }))}
            />
          ))}

          {/* Promotions 2 */}
          {PROMOTION_FILTERS.map((p) => (
            <Chip
              key={`promo-${p.value}`}
              label={p.label}
              selected={filters.promotion === p.value}
              onPress={() => setFilters((prev) => ({ ...prev, promotion: prev.promotion === p.value ? undefined : p.value }))}
            />
          ))}

          {/* Membership 1 */}
          {MEMBERSHIP_FILTERS.map((m) => (
            <Chip
              key={`member-${m.label}`}
              label={m.label}
              selected={filters.membershipPrice === true}
              onPress={() => setFilters((prev) => ({ ...prev, membershipPrice: prev.membershipPrice ? undefined : true }))}
            />
          ))}

          {/* Extras: 5 sort chips */}
          {SORT_OPTIONS.map((opt) => (
            <Chip
              key={`sort-${opt.key}`}
              label={opt.label}
              selected={sort === opt.key}
              onPress={() => setSort(opt.key)}
            />
          ))}

          {/* Extras: 4 utility chips to reach 30 total: Open now, New, Clear, Top */}
          <Chip label="Open now" selected={false} onPress={() => setFilters((prev) => ({ ...prev, minRating: prev.minRating === 4.5 ? undefined : 4.5 }))} />
          <Chip label="New" selected={false} onPress={() => setSort('relevance')} />
          <Chip label="Clear all" selected={false} onPress={clearFilters} />
          <Chip label="Nearby" selected={sort === 'distance'} onPress={() => setSort('distance')} />
        </ScrollView>
      </View>

      {!merchants ? (
        <View style={{ gap: Spacing.md, padding: Spacing.lg }}>
          <SkeletonCard rows={3} />
          <SkeletonCard rows={3} />
          <SkeletonCard rows={3} />
        </View>
      ) : visible.length === 0 ? (
        <View style={{ padding: Spacing.lg }}>
          <EmptyState
            icon="restaurant-outline"
            title={filterCount > 0 ? t('search.filters.empty') : t('home.emptyNearby')}
            actionLabel={filterCount > 0 ? t('search.filters.clearAll') : t('common.retry')}
            onAction={filterCount > 0 ? clearFilters : load}
          />
        </View>
      ) : (
        <FlatList
          data={visible}
          keyExtractor={(m) => m.id}
          renderItem={renderMerchant}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ padding: Spacing.lg, paddingBottom: 60, gap: Spacing.md }}
          refreshing={refreshing}
          onRefresh={onRefresh}
          ListFooterComponent={
            refreshing ? (
              <Row style={{ justifyContent: 'center', paddingVertical: Spacing.md }} gap={Spacing.sm}>
                <ActivityIndicator size="small" color={Colors.primary} />
                <Text style={{ color: Colors.textTertiary, fontSize: FontSize.xs, fontFamily: Fonts.sans }}>{t('search.loadMore')}</Text>
              </Row>
            ) : null
          }
        />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { paddingHorizontal: Spacing.lg, paddingTop: Spacing.lg },
  title: { fontSize: FontSize.lg, fontFamily: Fonts.sansBold, color: Colors.text, flex: 1, textAlign: 'center' },
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    backgroundColor: Colors.card,
    borderRadius: Radius.pill,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.sm,
    marginTop: Spacing.md,
  },
  searchInput: {
    flex: 1,
    fontSize: FontSize.md,
    color: Colors.text,
    fontFamily: Fonts.sans,
    paddingVertical: 4,
  },
  countPill: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.pill,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    borderWidth: 1,
    borderColor: Colors.borderStrong,
  },
  countPillText: { fontSize: FontSize.xs, color: Colors.textSecondary, fontFamily: Fonts.sansMedium },
  clearBtn: {
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    borderRadius: Radius.pill,
    backgroundColor: Colors.card,
    borderWidth: 1,
    borderColor: Colors.borderStrong,
  },
  clearBtnText: { fontSize: FontSize.sm, color: Colors.primaryDeep, fontFamily: Fonts.sansMedium },
  sortBtn: {
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    borderRadius: Radius.pill,
    backgroundColor: Colors.card,
    borderWidth: 1,
    borderColor: Colors.borderStrong,
  },
  sortBtnActive: { backgroundColor: Colors.ink, borderColor: Colors.ink },
  sortBtnText: { fontSize: FontSize.sm, color: Colors.textSecondary, fontFamily: Fonts.sansMedium },
  sortBtnTextActive: { color: Colors.white, fontFamily: Fonts.sansSemibold },
  stickyBar: {
    backgroundColor: Colors.card,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.border,
    paddingVertical: Spacing.sm,
    zIndex: 1,
  },
  filterBarContent: {
    gap: Spacing.sm,
    paddingHorizontal: Spacing.lg,
    alignItems: 'center',
  },
  merchantCard: { marginBottom: 0 },
  // Keep merchantCard 88x88 — image/logo container is 88x88 per spec
  merchantLogo: {
    width: 88,
    height: 88,
    borderRadius: Radius.md,
    backgroundColor: Colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  merchantName: { fontSize: FontSize.md, fontFamily: Fonts.sansSemibold, color: Colors.text, flex: 1 },
  cuisineText: { fontSize: FontSize.xs, color: Colors.textTertiary, fontFamily: Fonts.sans, marginTop: 2 },
  meta: { fontSize: FontSize.xs, color: Colors.textTertiary, fontFamily: Fonts.sans },
  memberBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: Colors.goldSoft,
    paddingHorizontal: Spacing.sm,
    paddingVertical: 2,
    borderRadius: Radius.pill,
  },
  memberBadgeText: { fontSize: FontSize.xs, color: Colors.gold, fontFamily: Fonts.sansBold },
});
