import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';

import {
  Btn,
  Card,
  Chip,
  EmptyState,
  ErrorState,
  Icon,
  MoneyText,
  Pill,
  Rating,
  Row,
  Screen,
  SheetModal,
  SkeletonCard,
} from '@/components/ui';
import { Colors, Fonts, FontSize, Radius, Spacing } from '@/constants/theme';
import { t } from '@/i18n';
import {
  activeFilterCount,
  filterResults,
  resolveResultRoute,
  sortResults,
  type SearchFilters,
  type SearchSort,
} from '@/lib/search';
import { formatTZS } from '@/lib/format';
import { getSearchRepository } from '@/repos';
import { useUiStore } from '@/store/ui';
import type { SearchResults, SearchResultsResultsItem } from '@hudumika/contract';
import { SearchResultsResultsItemEntityType } from '@hudumika/contract';

const SORT_OPTIONS: { key: SearchSort; label: string }[] = [
  { key: 'relevance', label: t('search.sort.relevance') },
  { key: 'rating', label: t('search.sort.rating') },
  { key: 'price_asc', label: t('search.sort.priceAsc') },
  { key: 'price_desc', label: t('search.sort.priceDesc') },
  { key: 'distance', label: t('search.sort.distance') },
];

const RATING_CHIPS = [4.5, 4, 3];
const PRICE_CHIPS = [5000, 10000, 20000, 50000];
const TYPE_CHIPS: { key: string; label: string }[] = [
  { key: SearchResultsResultsItemEntityType.restaurant, label: t('search.type.restaurant') },
  { key: SearchResultsResultsItemEntityType.dish, label: t('search.type.dish') },
  { key: SearchResultsResultsItemEntityType.provider, label: t('search.type.provider') },
];

export default function SearchResultsScreen() {
  const router = useRouter();
  const { q, category, voice, image } = useLocalSearchParams<{ q: string; category?: string; voice?: string; image?: string }>();
  const viewMode = useUiStore((s) => s.searchViewMode);
  const setViewMode = useUiStore((s) => s.setSearchViewMode);
  const [results, setResults] = useState<SearchResultsResultsItem[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [sort, setSort] = useState<SearchSort>('relevance');
  const [filters, setFilters] = useState<SearchFilters>({});
  const [sortSheet, setSortSheet] = useState(false);
  const [filterSheet, setFilterSheet] = useState(false);

  const runSearch = useCallback(
    async (cursor?: string): Promise<{ items: SearchResultsResultsItem[]; next: string | null }> => {
      // Voice/image searches ride their contract endpoints (POST /search/voice
      // with the transcript, POST /search/image with the imageUrl — the local
      // URI is the upload-less demo key; a live app uploads first). Their
      // bodies carry no filter/sort params, so filters + sort apply through
      // the defensive client-side pass below (same semantics as the server
      // side for text search).
      let res: SearchResults;
      if (image) {
        res = await getSearchRepository().imageSearch({ imageUrl: image });
      } else if (voice === '1') {
        res = await getSearchRepository().voiceSearch(q ?? '');
      } else {
        // Filters + sort ride the repo call server-side (the mock implements
        // them; docs/CONTRACT-ADDITIONS.md #3 — mock-only until the contract
        // ships the params). The defensive client-side pass below only covers
        // results whose fields the server could not filter on.
        res = await getSearchRepository().search(q ?? '', {
          category: category ?? undefined,
          cursor,
          ...(filters.minRating !== undefined ? { minRating: filters.minRating } : {}),
          ...(filters.maxPriceTZS !== undefined ? { priceMaxTZS: filters.maxPriceTZS } : {}),
          ...(filters.entityType !== undefined ? { entityType: filters.entityType } : {}),
          ...(sort !== 'relevance' ? { sort } : {}),
        });
      }
      return { items: res.results, next: res.nextCursor ?? null };
    },
    [q, category, filters, sort, voice, image],
  );

  const load = useCallback(async () => {
    setError('');
    try {
      const { items, next } = await runSearch();
      setResults(items);
      setNextCursor(next);
    } catch {
      setError(t('common.error'));
    }
  }, [runSearch]);

  useEffect(() => {
    load();
  }, [load]);

  const loadMore = useCallback(async () => {
    if (loadingMore || !nextCursor) return;
    setLoadingMore(true);
    try {
      const { items, next } = await runSearch(nextCursor);
      setResults((prev) => [...(prev ?? []), ...items]);
      setNextCursor(next);
    } catch {
      /* non-fatal — keep the list, stop paginating on this cursor */
    } finally {
      setLoadingMore(false);
    }
  }, [runSearch, nextCursor, loadingMore]);

  // Filters + sort are applied SERVER-side by the repo call (mock implements
  // them; CONTRACT-ADDITIONS.md #3). This pass stays as the defensive
  // client-side re-application for results the server could not filter on
  // (e.g. a live backend that has not yet adopted the params, or a result
  // missing a field — dropped, never crashes).
  const visible = useMemo(
    () => sortResults(filterResults(results ?? [], filters), sort),
    [results, filters, sort],
  );
  const filterCount = activeFilterCount(filters);

  const open = (item: SearchResultsResultsItem) => {
    const route = resolveResultRoute(item);
    if (!route) return;
    if (route.kind === 'merchant') {
      router.push(`/merchant/${route.id}`);
    } else if (route.kind === 'provider') {
      router.push(`/provider/${route.id}`);
    } else {
      router.push({ pathname: '/search-results', params: { q: route.q } });
    }
  };

  const clearFilters = () => {
    setFilters({});
    setFilterSheet(false);
  };

  const renderItem = ({ item }: { item: SearchResultsResultsItem }) => (
    <Card style={styles.card} onPress={() => open(item)} accessibilityLabel={t('search.resultA11y', { title: item.title ?? item.subtitle ?? item.id ?? '' })}>
      <Row gap={Spacing.md}>
        <View style={styles.icon}>
          <Icon
            name={item.entityType === 'provider' ? 'person' : item.entityType === 'dish' ? 'fast-food' : 'storefront'}
            size={20}
            color={Colors.textSecondary}
          />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.itemTitle} numberOfLines={1}>{item.title}</Text>
          {item.subtitle ? <Text style={styles.sub} numberOfLines={1}>{item.subtitle}</Text> : null}
          <Row gap={Spacing.sm} style={{ marginTop: 4 }}>
            {item.rating ? <Rating rating={item.rating} /> : null}
            {item.priceTZS ? <MoneyText amountTZS={item.priceTZS} size={FontSize.xs} /> : null}
            {item.distanceKm ? <Text style={styles.sub}>{item.distanceKm.toFixed(1)} {t('common.km')}</Text> : null}
          </Row>
        </View>
      </Row>
    </Card>
  );

  const renderGridItem = ({ item }: { item: SearchResultsResultsItem }) => (
    <Card style={styles.gridCard} onPress={() => open(item)} accessibilityLabel={t('search.resultA11y', { title: item.title ?? item.subtitle ?? item.id ?? '' })}>
      <View style={styles.gridImage}>
        <Icon
          name={item.entityType === 'provider' ? 'person' : item.entityType === 'dish' ? 'fast-food' : 'storefront'}
          size={22}
          color={Colors.textSecondary}
        />
      </View>
      <Text style={styles.itemTitle} numberOfLines={2}>{item.title}</Text>
      {item.subtitle ? <Text style={styles.sub} numberOfLines={1}>{item.subtitle}</Text> : null}
      <Row gap={Spacing.sm} style={{ marginTop: 4 }}>
        {item.rating ? <Rating rating={item.rating} /> : null}
        {item.priceTZS ? <MoneyText amountTZS={item.priceTZS} size={FontSize.xs} /> : null}
      </Row>
    </Card>
  );

  const listFooter = loadingMore ? (
    <Row style={{ justifyContent: 'center', paddingVertical: Spacing.md }} gap={Spacing.sm}>
      <ActivityIndicator size="small" color={Colors.primary} />
      <Text style={{ color: Colors.textFaint, fontSize: FontSize.xs, fontFamily: Fonts.sans }}>
        {t('search.loadMore')}
      </Text>
    </Row>
  ) : null;

  if (error) {
    return (
      <Screen>
        <ErrorState message={error} onRetry={load} />
      </Screen>
    );
  }

  return (
    <Screen>
      <View style={{ paddingHorizontal: Spacing.lg, paddingTop: Spacing.lg }}>
        <Row style={{ gap: Spacing.md }}>
          <Btn label={t('common.back')} onPress={() => router.back()} variant="subtle" size="sm" icon="arrow-back" />
          <Text style={styles.title} numberOfLines={1}>“{q}”</Text>
          {category ? <Pill label={category} tone="info" /> : null}
        </Row>
        {results !== null ? (
          <Row gap={Spacing.sm} style={{ marginTop: Spacing.md }}>
            <Pressable
              onPress={() => setFilterSheet(true)}
              accessibilityRole="button"
              accessibilityLabel={t('search.filters')}
              accessibilityState={{ selected: filterCount > 0 }}
              style={styles.headerBtn}>
              <Icon name="options-outline" size={15} color={Colors.textSecondary} />
              <Text style={styles.headerBtnText}>{t('search.filters')}</Text>
              {filterCount > 0 ? (
                <View style={styles.countBadge}>
                  <Text style={styles.countBadgeText}>{filterCount}</Text>
                </View>
              ) : null}
            </Pressable>
            <Pressable
              onPress={() => setSortSheet(true)}
              accessibilityRole="button"
              accessibilityLabel={t('search.sort')}
              style={styles.headerBtn}>
              <Icon name="swap-vertical-outline" size={15} color={Colors.textSecondary} />
              <Text style={styles.headerBtnText}>{t('search.sort')}</Text>
              {sort !== 'relevance' ? <Icon name="checkmark" size={13} color={Colors.primaryDeep} /> : null}
            </Pressable>
            <Pressable
              onPress={() => setViewMode('grid')}
              accessibilityRole="button"
              accessibilityLabel={t('search.viewGrid')}
              accessibilityState={{ selected: viewMode === 'grid' }}
              style={styles.headerIconBtn}>
              <Icon name="grid-outline" size={16} color={viewMode === 'grid' ? Colors.primaryDeep : Colors.textSecondary} />
            </Pressable>
            <Pressable
              onPress={() => setViewMode('list')}
              accessibilityRole="button"
              accessibilityLabel={t('search.viewList')}
              accessibilityState={{ selected: viewMode === 'list' }}
              style={styles.headerIconBtn}>
              <Icon name="list-outline" size={16} color={viewMode === 'list' ? Colors.primaryDeep : Colors.textSecondary} />
            </Pressable>
          </Row>
        ) : null}
      </View>
      {!results ? (
        <View style={{ gap: Spacing.md, padding: Spacing.lg }}>
          <SkeletonCard rows={2} />
          <SkeletonCard rows={2} />
        </View>
      ) : results.length === 0 && filterCount > 0 ? (
        <EmptyState
          icon="options-outline"
          title={t('search.filters.empty')}
          actionLabel={t('search.filters.clearAll')}
          onAction={clearFilters}
        />
      ) : results.length === 0 ? (
        <EmptyState
          icon="search-outline"
          title={t('search.empty', { q: q ?? '' })}
          sub={t('search.suggestions')}
          actionLabel={t('common.search')}
          onAction={() => router.push('/search')}
        />
      ) : visible.length === 0 ? (
        <EmptyState
          icon="options-outline"
          title={t('search.filters.empty')}
          actionLabel={t('search.filters.clearAll')}
          onAction={clearFilters}
        />
      ) : (
        viewMode === 'grid' ? (
          <FlatList
            key="grid"
            data={visible}
            numColumns={2}
            keyExtractor={(item, i) => `${item.entityType}-${item.id ?? i}`}
            renderItem={renderGridItem}
            columnWrapperStyle={{ gap: Spacing.md }}
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{ padding: Spacing.lg, paddingBottom: 60, gap: Spacing.md }}
            onEndReached={loadMore}
            onEndReachedThreshold={0.4}
            ListFooterComponent={listFooter}
          />
        ) : (
          <FlatList
            key="list"
            data={visible}
            keyExtractor={(item, i) => `${item.entityType}-${item.id ?? i}`}
            renderItem={renderItem}
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{ padding: Spacing.lg, paddingBottom: 60 }}
            onEndReached={loadMore}
            onEndReachedThreshold={0.4}
            ListFooterComponent={listFooter}
          />
        )
      )}

      <SheetModal visible={sortSheet} onClose={() => setSortSheet(false)} title={t('search.sort')}>
        {SORT_OPTIONS.map((opt) => (
          <Pressable
            key={opt.key}
            onPress={() => {
              setSort(opt.key);
              setSortSheet(false);
            }}
            accessibilityRole="button"
            accessibilityState={{ selected: sort === opt.key }}
            style={[styles.sheetRow, sort === opt.key && styles.sheetRowSelected]}>
            <Text style={[styles.sheetRowText, { flex: 1 }]}>{opt.label}</Text>
            <Icon
              name={sort === opt.key ? 'radio-button-on' : 'radio-button-off'}
              size={18}
              color={sort === opt.key ? Colors.primary : Colors.borderStrong}
            />
          </Pressable>
        ))}
      </SheetModal>

      <SheetModal visible={filterSheet} onClose={() => setFilterSheet(false)} title={t('search.filters')}>
        {filterCount > 0 ? (
          <Btn label={t('search.filters.clearAll')} onPress={clearFilters} variant="ghost" size="sm" />
        ) : null}

        <Text style={styles.sheetSection}>{t('search.filters.rating')}</Text>
        <View style={styles.chipWrap}>
          {RATING_CHIPS.map((r) => (
            <Chip
              key={r}
              label={r.toFixed(1)}
              selected={filters.minRating === r}
              onPress={() => setFilters((prev) => ({ ...prev, minRating: filters.minRating === r ? undefined : r }))}
            />
          ))}
        </View>

        <Text style={styles.sheetSection}>{t('search.filters.maxPrice')}</Text>
        <View style={styles.chipWrap}>
          {PRICE_CHIPS.map((p) => (
            <Chip
              key={p}
              label={formatTZS(p)}
              selected={filters.maxPriceTZS === p}
              onPress={() => setFilters((prev) => ({ ...prev, maxPriceTZS: filters.maxPriceTZS === p ? undefined : p }))}
            />
          ))}
        </View>

        <Text style={styles.sheetSection}>{t('search.filters.type')}</Text>
        <View style={styles.chipWrap}>
          {TYPE_CHIPS.map((c) => (
            <Chip
              key={c.key}
              label={c.label}
              selected={filters.entityType === c.key}
              onPress={() => setFilters((prev) => ({ ...prev, entityType: filters.entityType === c.key ? undefined : c.key }))}
            />
          ))}
        </View>
      </SheetModal>
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: FontSize.lg, fontFamily: Fonts.sansBold, color: Colors.text, flex: 1 },
  card: { marginBottom: Spacing.md },
  gridCard: { flex: 1 },
  gridImage: {
    width: '100%',
    height: 64,
    borderRadius: Radius.md,
    backgroundColor: Colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: Spacing.sm,
  },
  icon: {
    width: 42,
    height: 42,
    borderRadius: Radius.md,
    backgroundColor: Colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  itemTitle: { fontSize: FontSize.md, fontFamily: Fonts.sansSemibold, color: Colors.text },
  sub: { fontSize: FontSize.xs, color: Colors.textTertiary, fontFamily: Fonts.sans },
  headerBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: Spacing.md,
    paddingVertical: 8,
    borderRadius: Radius.pill,
    borderWidth: 1,
    borderColor: Colors.borderStrong,
    backgroundColor: Colors.card,
  },
  headerBtnText: { fontSize: FontSize.sm, color: Colors.textSecondary, fontFamily: Fonts.sansMedium },
  headerIconBtn: {
    alignItems: 'center',
    justifyContent: 'center',
    width: 34,
    height: 34,
    borderRadius: Radius.pill,
    borderWidth: 1,
    borderColor: Colors.borderStrong,
    backgroundColor: Colors.card,
  },
  countBadge: {
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 4,
  },
  countBadgeText: { color: Colors.ink, fontSize: 10, fontFamily: Fonts.sansExtraBold },
  sheetRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    paddingVertical: Spacing.md,
    paddingHorizontal: Spacing.md,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.card,
  },
  sheetRowSelected: { borderColor: Colors.primary, backgroundColor: Colors.primarySoft },
  sheetRowText: { fontSize: FontSize.sm, color: Colors.text, fontFamily: Fonts.sansMedium },
  sheetSection: {
    fontSize: FontSize.sm,
    color: Colors.textTertiary,
    fontFamily: Fonts.sansSemibold,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm },
});
