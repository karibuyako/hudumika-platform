/* Compact flash-deal card — the 神抢手-lite horizontal rail card used on the
 * home feed and the promo center. Backed by live group-buy deals selected via
 * src/lib/flash.ts (the contract's FlashSale resource has no repo surface
 * yet — see that file for the seam). */
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Card, MoneyText } from '@/components/ui';
import { DealCountdownPill } from '@/components/DealCountdown';
import { Colors, Fonts, FontSize, Radius, Spacing } from '@/constants/theme';
import { t } from '@/i18n';
import { formatTZS } from '@/lib/format';
import type { GroupBuyDeal } from '@hudumika/contract';

export function FlashDealCard({ deal, now, onPress }: {
  deal: GroupBuyDeal;
  /** Shared ticking clock from useDealClock() — one interval per screen. */
  now: number;
  onPress: () => void;
}) {
  const pct = deal.originalPriceTZS > 0 ? Math.round((1 - deal.priceTZS / deal.originalPriceTZS) * 100) : 0;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={t('home.flashDealA11y', { title: deal.title })}
      style={({ pressed }) => [pressed && { opacity: 0.85 }]}>
      <Card style={styles.card}>
        <View style={styles.topRow}>
          <Text style={styles.title} numberOfLines={2}>{deal.title}</Text>
          {pct > 0 ? (
            <View style={styles.badge}>
              <Text style={styles.badgeText}>−{pct}%</Text>
            </View>
          ) : null}
        </View>
        <DealCountdownPill endsAt={deal.salesEndAt} now={now} />
        <View style={styles.priceRow}>
          <Text style={styles.oldPrice}>{formatTZS(deal.originalPriceTZS)}</Text>
          <MoneyText amountTZS={deal.priceTZS} size={FontSize.md} bold />
        </View>
      </Card>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: { width: 220, gap: Spacing.sm },
  topRow: { flexDirection: 'row', alignItems: 'flex-start', gap: Spacing.sm },
  title: { flex: 1, fontSize: FontSize.sm, fontFamily: Fonts.sansSemibold, color: Colors.text },
  badge: { backgroundColor: Colors.danger, borderRadius: Radius.sm, paddingHorizontal: 8, paddingVertical: 4 },
  badgeText: { color: Colors.white, fontSize: FontSize.xs, fontFamily: Fonts.sansExtraBold },
  priceRow: { flexDirection: 'row', alignItems: 'baseline', gap: Spacing.sm, marginTop: 'auto' },
  oldPrice: { fontSize: FontSize.xs, color: Colors.textFaint, fontFamily: Fonts.sansMedium, textDecorationLine: 'line-through' },
});
