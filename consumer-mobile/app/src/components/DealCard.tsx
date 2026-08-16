/* Deal card for the LIVE DEALS ZONE (神抢手-lite): one flash deal inside a
 * live-deals session. Shared by the sessions list (src/app/live-deals.tsx)
 * and the live broadcast detail (src/app/live/[sessionId].tsx) so both
 * surfaces render the exact same card. Every value comes from the contract
 * payload: money is integer TZS via formatTZS(), the discount % is derived,
 * and the merchant link / countdown copy follow the session's server-derived
 * status (live | scheduled | ended). */
import { useRouter } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import { Btn, Card, Icon, MoneyText, Row } from '@/components/ui';
import { Colors, Fonts, FontSize, Radius, Spacing } from '@/constants/theme';
import { t } from '@/i18n';
import { clockISO } from '@/lib/dates';
import { formatTZS } from '@/lib/format';
import type { LiveDealSession } from '@hudumika/contract';
import { LiveDealSessionStatus } from '@hudumika/contract';

export function DealCard({ deal, session }: {
  deal: NonNullable<LiveDealSession['deals']>[number];
  session: LiveDealSession;
}) {
  const router = useRouter();
  const pct = deal.originalPriceTZS > 0 ? Math.round((1 - deal.priceTZS / deal.originalPriceTZS) * 100) : 0;
  const live = session.status === LiveDealSessionStatus.live;
  const ended = session.status === LiveDealSessionStatus.ended;
  return (
    <Card style={[styles.dealCard, ended && styles.cardEnded]}>
      <Row style={{ justifyContent: 'space-between', marginBottom: Spacing.sm }}>
        <Text style={styles.dealTitle} numberOfLines={2}>{deal.title}</Text>
        {pct > 0 ? (
          <View style={styles.discountBadge}>
            <Text style={styles.discountText}>−{pct}%</Text>
          </View>
        ) : null}
      </Row>
      <Row gap={Spacing.sm} style={{ marginBottom: Spacing.sm }}>
        <Icon name="storefront" size={14} color={ended ? Colors.textFaint : Colors.textSecondary} />
        <Text style={[styles.merchantName, ended && styles.textEnded]} numberOfLines={1}>{deal.merchantName}</Text>
      </Row>
      <Row style={{ justifyContent: 'space-between', marginTop: Spacing.sm }}>
        <View>
          <Text style={styles.oldPrice}>{formatTZS(deal.originalPriceTZS)}</Text>
          <MoneyText amountTZS={deal.priceTZS} size={FontSize.lg} bold />
        </View>
        {deal.quantityLimit ? (
          <Text style={styles.meta}>{t('liveDeals.quantityLimit', { n: deal.quantityLimit })}</Text>
        ) : null}
      </Row>
      {live && deal.merchantId ? (
        <Btn
          label={t('liveDeals.viewMerchant')}
          size="sm"
          variant="outline"
          icon="storefront"
          onPress={() => router.push(`/merchant/${deal.merchantId}`)}
          style={{ alignSelf: 'flex-start', marginTop: Spacing.md }}
        />
      ) : null}
      {ended ? <Text style={styles.endedLabel}>{t('liveDeals.ended')}</Text> : null}
      {!live && !ended && deal.merchantId ? (
        <Text style={styles.comingAt}>{t('liveDeals.comingAt', { t: clockISO(session.startsAt) })}</Text>
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  dealCard: { marginBottom: Spacing.sm },
  cardEnded: { opacity: 0.55 },
  dealTitle: { flex: 1, fontSize: FontSize.md, fontFamily: Fonts.sansSemibold, color: Colors.text, paddingRight: Spacing.sm },
  merchantName: { fontSize: FontSize.xs, color: Colors.textSecondary, fontFamily: Fonts.sansMedium, flex: 1 },
  discountBadge: { backgroundColor: Colors.danger, borderRadius: Radius.sm, paddingHorizontal: 8, paddingVertical: 4 },
  discountText: { color: Colors.white, fontSize: FontSize.xs, fontFamily: Fonts.sansExtraBold },
  oldPrice: { fontSize: FontSize.xs, color: Colors.textFaint, fontFamily: Fonts.sansMedium, textDecorationLine: 'line-through' },
  meta: { fontSize: FontSize.xs, color: Colors.textTertiary, fontFamily: Fonts.sans, marginTop: 2 },
  endedLabel: { fontSize: FontSize.xs, color: Colors.textFaint, fontFamily: Fonts.sansBold, marginTop: Spacing.sm },
  comingAt: { fontSize: FontSize.xs, color: Colors.textTertiary, fontFamily: Fonts.sansMedium, marginTop: Spacing.sm },
  textEnded: { color: Colors.textFaint },
});
