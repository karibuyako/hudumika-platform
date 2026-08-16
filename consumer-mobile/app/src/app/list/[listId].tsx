/* Curated merchant list detail (必吃榜-lite) — ranked merchant cards for a
 * demo curated list, loaded from the ListsRepository (GET /lists/{id} —
 * mock-only-until-adopted paths, docs/CONTRACT-ADDITIONS.md #14; the mock IS
 * the server: it serves the seed the home rail renders from
 * src/lib/lists.ts). The pure helpers in src/lib/lists.ts resolve the list's
 * merchant ids against whatever the merchants repo returned (resolveList
 * filters to present merchants, preserving rank order) — fixture drift
 * degrades a list to fewer entries, never a crash. */
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { FlatList, StyleSheet, Text, View } from 'react-native';

import { Btn, Card, EmptyState, ErrorState, Pill, Rating, Row, Screen, SkeletonCard } from '@/components/ui';
import { Colors, Fonts, FontSize, Radius, Spacing } from '@/constants/theme';
import { t } from '@/i18n';
import { ApiError } from '@/api/client';
import { getListsRepository, getMerchantsRepository } from '@/repos';
import { resolveList } from '@/lib/lists';
import type { CuratedList } from '@/lib/lists';
import type { MerchantPublic } from '@hudumika/contract';

export default function CuratedListScreen() {
  const router = useRouter();
  const { listId } = useLocalSearchParams<{ listId: string }>();
  const [list, setList] = useState<CuratedList | null | undefined>(undefined);
  const [merchants, setMerchants] = useState<MerchantPublic[] | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      const [l, ms] = await Promise.all([
        getListsRepository().getCurated(listId),
        getMerchantsRepository().list(),
      ]);
      setList(l);
      setMerchants(ms);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        setList(null);
      } else {
        setError(t('common.error'));
      }
    }
  }, [listId]);

  useEffect(() => {
    load();
  }, [load]);

  if (list === null) {
    return (
      <Screen>
        <View style={{ padding: Spacing.lg }}>
          <Row style={{ justifyContent: 'space-between', marginBottom: Spacing.md }}>
            <Btn label={t('common.back')} onPress={() => router.back()} variant="subtle" size="sm" icon="arrow-back" />
            <Text style={styles.title}>{t('lists.title')}</Text>
          </Row>
          <EmptyState icon="list-outline" title={t('lists.notFound')} />
        </View>
      </Screen>
    );
  }

  if (error) {
    return (
      <Screen>
        <View style={{ padding: Spacing.lg }}>
          <ErrorState message={error} onRetry={load} />
        </View>
      </Screen>
    );
  }

  const resolved = list && merchants ? resolveList(list.id, merchants) : null;

  return (
    <Screen>
      <FlatList
        data={resolved?.merchants ?? []}
        keyExtractor={(m) => m.id}
        onRefresh={load}
        refreshing={false}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: 40 }}
        ListHeaderComponent={
          <View style={{ paddingHorizontal: Spacing.lg, paddingTop: Spacing.lg }}>
            <Row style={{ justifyContent: 'space-between', marginBottom: Spacing.md }}>
              <Btn label={t('common.back')} onPress={() => router.back()} variant="subtle" size="sm" icon="arrow-back" />
              <Text style={styles.title}>{list ? t(list.titleKey) : t('lists.title')}</Text>
            </Row>
            {list ? <Text style={styles.tagline}>{t(list.taglineKey)}</Text> : null}
            {!list || !merchants ? (
              <View style={{ gap: Spacing.md, marginTop: Spacing.md }}>
                <SkeletonCard rows={2} />
                <SkeletonCard rows={2} />
                <SkeletonCard rows={2} />
              </View>
            ) : null}
          </View>
        }
        renderItem={({ item, index }) => (
          <Card style={styles.card} onPress={() => router.push(`/merchant/${item.id}`)} accessibilityLabel={t('home.merchantLabel', { name: item.businessName })}>
            <Row gap={Spacing.md}>
              <View style={styles.rankBadge}>
                <Text style={styles.rankText}>{t('lists.rank', { n: index + 1 })}</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.name} numberOfLines={1}>{item.businessName}</Text>
                <Row gap={Spacing.sm} style={{ marginTop: 4 }}>
                  <Rating rating={item.rating} reviewCount={item.reviewCount} />
                  {item.deliveryMinutes ? (
                    <Text style={styles.meta}>{t('order.estimated', { m: item.deliveryMinutes })}</Text>
                  ) : null}
                </Row>
              </View>
              <Pill label={item.isOpen ? t('merchant.open') : t('merchant.closed')} tone={item.isOpen ? 'success' : 'danger'} />
            </Row>
          </Card>
        )}
        ListEmptyComponent={
          merchants ? (
            <View style={{ paddingHorizontal: Spacing.lg }}>
              <EmptyState icon="storefront-outline" title={t('lists.empty')} />
            </View>
          ) : null
        }
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: FontSize.lg, fontFamily: Fonts.sansBold, color: Colors.text, flex: 1, textAlign: 'center' },
  tagline: { fontSize: FontSize.sm, color: Colors.textTertiary, fontFamily: Fonts.sans, textAlign: 'center', marginBottom: Spacing.sm },
  card: { marginHorizontal: Spacing.lg, marginBottom: Spacing.md },
  rankBadge: {
    width: 40,
    height: 40,
    borderRadius: Radius.md,
    backgroundColor: Colors.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rankText: { fontSize: FontSize.sm, fontFamily: Fonts.sansExtraBold, color: Colors.primaryDeep },
  name: { fontSize: FontSize.md, fontFamily: Fonts.sansSemibold, color: Colors.text },
  meta: { fontSize: FontSize.xs, color: Colors.textTertiary, fontFamily: Fonts.sans },
});
