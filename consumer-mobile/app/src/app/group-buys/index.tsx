/* Group-buy deals feed — GET /group-buys (DESIGN-SYSTEM "Group buy card":
 * discount badge, strikethrough original price, Buy CTA). */
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { FlatList, StyleSheet, Text, View } from 'react-native';

import { Btn, Card, EmptyState, ErrorState, MoneyText, Row, Screen, SkeletonCard } from '@/components/ui';
import { DealCountdownPill, useDealClock } from '@/components/DealCountdown';
import { Colors, Fonts, FontSize, Radius, Spacing } from '@/constants/theme';
import { t } from '@/i18n';
import { getGroupBuyRepository } from '@/repos';
import { formatTZS } from '@/lib/format';
import { formatDealCountdown } from '@/lib/dates';
import type { GroupBuyDeal } from '@hudumika/contract';

export default function GroupBuysScreen() {
  const router = useRouter();
  const now = useDealClock();
  const [deals, setDeals] = useState<GroupBuyDeal[] | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      setDeals(await getGroupBuyRepository().list());
    } catch {
      setError(t('common.error'));
    }
  }, []);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Screen>
      <View style={{ paddingHorizontal: Spacing.lg, paddingTop: Spacing.lg }}>
        <Row style={{ justifyContent: 'space-between', marginBottom: Spacing.md }}>
          <Btn label={t('common.back')} onPress={() => router.back()} variant="subtle" size="sm" icon="arrow-back" />
          <Text style={styles.title}>{t('groupBuy.title')}</Text>
        </Row>
      </View>
      {error ? (
        <ErrorState message={error} onRetry={load} />
      ) : !deals ? (
        <View style={{ gap: Spacing.md, padding: Spacing.lg }}>
          <SkeletonCard rows={2} />
          <SkeletonCard rows={2} />
        </View>
      ) : deals.length === 0 ? (
        <EmptyState icon="pricetags-outline" title={t('groupBuy.empty')} />
      ) : (
        <FlatList
          data={deals}
          keyExtractor={(d) => d.id ?? d.title}
          onRefresh={load}
          refreshing={false}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ padding: Spacing.lg, paddingBottom: 60 }}
          renderItem={({ item }) => {
            const pct = item.originalPriceTZS > 0 ? Math.round((1 - item.priceTZS / item.originalPriceTZS) * 100) : 0;
            const ended = formatDealCountdown(item.salesEndAt, now) === null;
            return (
              <Card style={styles.card} onPress={() => router.push(`/group-buys/${item.id}`)}>
                <Row style={{ justifyContent: 'space-between', marginBottom: Spacing.sm }}>
                  <Text style={styles.name} numberOfLines={2}>{item.title}</Text>
                  {pct > 0 ? (
                    <View style={styles.discountBadge}>
                      <Text style={styles.discountText}>−{pct}%</Text>
                    </View>
                  ) : null}
                </Row>
                {item.description ? <Text style={styles.meta}>{item.description}</Text> : null}
                <DealCountdownPill endsAt={item.salesEndAt} now={now} />
                <Row style={{ justifyContent: 'space-between', marginTop: Spacing.md }}>
                  <View>
                    <Text style={styles.oldPrice}>{formatTZS(item.originalPriceTZS)}</Text>
                    <MoneyText amountTZS={item.priceTZS} size={FontSize.lg} bold />
                  </View>
                  <View style={[styles.buyPill, ended && { opacity: 0.5 }]}>
                    <Text style={styles.buyText}>{t('groupBuy.buy')}</Text>
                  </View>
                </Row>
              </Card>
            );
          }}
        />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: FontSize.lg, fontFamily: Fonts.sansBold, color: Colors.text, flex: 1, textAlign: 'center' },
  card: { marginBottom: Spacing.md },
  name: { fontSize: FontSize.md, fontFamily: Fonts.sansSemibold, color: Colors.text, flex: 1, paddingRight: Spacing.md },
  discountBadge: { backgroundColor: Colors.danger, borderRadius: Radius.sm, paddingHorizontal: 8, paddingVertical: 4 },
  discountText: { color: Colors.white, fontSize: FontSize.xs, fontFamily: Fonts.sansExtraBold },
  meta: { fontSize: FontSize.xs, color: Colors.textTertiary, fontFamily: Fonts.sans, marginTop: 2 },
  oldPrice: { fontSize: FontSize.xs, color: Colors.textFaint, fontFamily: Fonts.sansMedium, textDecorationLine: 'line-through' },
  buyPill: { backgroundColor: Colors.primary, borderRadius: Radius.pill, paddingHorizontal: 16, paddingVertical: 8, minWidth: 48, alignItems: 'center', justifyContent: 'center' },
  buyText: { color: Colors.white, fontSize: FontSize.sm, fontFamily: Fonts.sansBold },
});