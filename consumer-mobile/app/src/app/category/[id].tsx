import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, StyleSheet, Text, View } from 'react-native';

import { Btn, Card, EmptyState, ErrorState, Icon, Pill, Rating, Row, Screen, SkeletonCard } from '@/components/ui';
import { Colors, Fonts, FontSize, Radius, Spacing } from '@/constants/theme';
import { t } from '@/i18n';
import { track } from '@/lib/analytics';
import { getMerchantsRepository } from '@/repos';
import type { MerchantPublic } from '@hudumika/contract';

export default function CategoryScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ id?: string; category?: string }>();
  const raw = (params.id ?? params.category ?? '') as string | string[] | undefined;
  const rawStr = Array.isArray(raw) ? (raw[0] ?? '') : (raw ?? '');
  const category = (() => {
    try {
      return decodeURIComponent(rawStr);
    } catch {
      return rawStr;
    }
  })();

  const [merchants, setMerchants] = useState<MerchantPublic[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async (cursor?: string) => {
    if (!category) {
      setError(t('common.error'));
      return;
    }
    if (!cursor) setError('');
    try {
      // Direct filtered fetch — bypasses the search input. Uses GET /merchants?category=Food
      // (the repo appends ?category= into the query string; the mock filters server-side).
      // Keep params: category rides the route param [id] and stays in the URL.
      const page = await getMerchantsRepository().list({ category, cursor, limit: 20 });
      const offset = cursor ? Number(cursor) : 0;
      const next = page.length === 20 ? String(offset + page.length) : null;
      if (!cursor) {
        setMerchants(page);
        setNextCursor(next);
      } else {
        setMerchants((prev) => [...(prev ?? []), ...page]);
        setNextCursor(next);
      }
    } catch {
      if (!cursor) setError(t('common.error'));
    }
  }, [category]);

  useEffect(() => {
    if (category) {
      track({ name: 'category_opened', category });
    }
  }, [category]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadMore = useCallback(async () => {
    if (loadingMore || !nextCursor) return;
    setLoadingMore(true);
    try {
      await load(nextCursor);
    } finally {
      setLoadingMore(false);
    }
  }, [load, loadingMore, nextCursor]);

  const renderItem = useCallback(({ item }: { item: MerchantPublic }) => (
    <Card style={styles.gridCard} onPress={() => router.push(`/merchant/${item.id}`)} accessibilityLabel={t('home.merchantLabel', { name: item.businessName })}>
      <View style={styles.gridImage}>
        <Icon name="storefront" size={24} color={Colors.textSecondary} />
      </View>
      <Text style={styles.itemTitle} numberOfLines={2}>{item.businessName}</Text>
      {(item.categories ?? []).length > 0 ? (
        <Text style={styles.sub} numberOfLines={1}>{(item.categories ?? []).join(' · ')}</Text>
      ) : null}
      <Row gap={Spacing.sm} style={{ marginTop: 4 }}>
        <Rating rating={item.rating} reviewCount={item.reviewCount} />
      </Row>
      <Row gap={Spacing.sm} style={{ marginTop: 4 }}>
        <Pill label={item.isOpen ? t('merchant.open') : t('merchant.closed')} tone={item.isOpen ? 'success' : 'danger'} />
        {item.deliveryMinutes ? (
          <Text style={styles.sub}>{t('order.estimated', { m: item.deliveryMinutes })}</Text>
        ) : null}
      </Row>
    </Card>
  ), [router]);

  if (!category) {
    return (
      <Screen>
        <View style={{ padding: Spacing.lg }}>
          <Row style={{ gap: Spacing.md }}>
            <Btn label={t('common.back')} onPress={() => router.back()} variant="subtle" size="sm" icon="arrow-back" />
            <Text style={styles.title}>{t('home.categories')}</Text>
          </Row>
          <ErrorState message={t('common.error')} onRetry={() => load()} />
        </View>
      </Screen>
    );
  }

  if (error) {
    return (
      <Screen>
        <View style={{ padding: Spacing.lg }}>
          <Row style={{ gap: Spacing.md }}>
            <Btn label={t('common.back')} onPress={() => router.back()} variant="subtle" size="sm" icon="arrow-back" />
            <Text style={styles.title} numberOfLines={1}>{category}</Text>
          </Row>
          <ErrorState message={error} onRetry={() => load()} />
        </View>
      </Screen>
    );
  }

  return (
    <Screen>
      <View style={{ paddingHorizontal: Spacing.lg, paddingTop: Spacing.lg }}>
        <Row style={{ gap: Spacing.md }}>
          <Btn label={t('common.back')} onPress={() => router.back()} variant="subtle" size="sm" icon="arrow-back" />
          <Text style={styles.title} numberOfLines={1}>{category}</Text>
          <Pill label={category} tone="info" />
        </Row>
        {merchants !== null ? (
          <Text style={styles.count} accessibilityLabel={`${merchants.length} merchants`}>
            {t('lists.merchants', { n: merchants.length })}
          </Text>
        ) : null}
      </View>

      {!merchants ? (
        <View style={{ gap: Spacing.md, padding: Spacing.lg }}>
          <SkeletonCard rows={2} />
          <SkeletonCard rows={2} />
        </View>
      ) : merchants.length === 0 ? (
        <EmptyState icon="storefront-outline" title={t('home.emptyNearby')} />
      ) : (
        <FlatList
          data={merchants}
          numColumns={2}
          keyExtractor={(m) => m.id}
          renderItem={renderItem}
          columnWrapperStyle={{ gap: Spacing.md }}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ padding: Spacing.lg, paddingBottom: 60, gap: Spacing.md }}
          onEndReached={loadMore}
          onEndReachedThreshold={0.4}
          ListFooterComponent={
            loadingMore ? (
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
  title: { fontSize: FontSize.lg, fontFamily: Fonts.sansBold, color: Colors.text, flex: 1 },
  count: { fontSize: FontSize.sm, color: Colors.textTertiary, fontFamily: Fonts.sans, marginTop: Spacing.sm },
  gridCard: { flex: 1 },
  gridImage: {
    width: '100%',
    height: 80,
    borderRadius: Radius.md,
    backgroundColor: Colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: Spacing.sm,
  },
  itemTitle: { fontSize: FontSize.md, fontFamily: Fonts.sansSemibold, color: Colors.text },
  sub: { fontSize: FontSize.xs, color: Colors.textTertiary, fontFamily: Fonts.sans },
});
