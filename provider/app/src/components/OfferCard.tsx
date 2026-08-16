import { StyleSheet, Text, View } from 'react-native';

import { CountdownPill } from '@/components/CountdownPill';
import { Card, Icon, Pill, Row } from '@/components/ui';
import { Colors, FontSize, NumberStyle, Spacing } from '@/constants/theme';
import { formatTZS, t } from '@/i18n';
import { dateISO } from '@/lib/format';
import type { ProviderJobOffer, ProviderJobOfferUrgency } from '@hudumika/contract';

const URGENCY_TONE: Record<ProviderJobOfferUrgency, 'warning' | 'danger' | 'neutral'> = {
  standard: 'neutral',
  urgent: 'warning',
  emergency: 'danger',
};

/** Marketplace job card: estimate range, matchScore + reasons[], urgency, countdown. */
export function OfferCard({ offer, onPress, onExpire }: {
  offer: ProviderJobOffer;
  onPress?: () => void;
  onExpire?: () => void;
}) {
  const hasEstimate = offer.estimateLowTZS != null && offer.estimateHighTZS != null;
  const hasMatch = offer.matchScore != null;

  return (
    <Card onPress={onPress} style={{ gap: Spacing.sm }}>
      <Row style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <View style={{ flex: 1, paddingRight: Spacing.sm }}>
          <Text style={styles.trade}>{offer.trade ? offer.trade.replace(/_/g, ' ') : t('booking.trade')}</Text>
          {offer.summary ? <Text numberOfLines={2} style={styles.summary}>{offer.summary}</Text> : null}
        </View>
        {offer.expiresAt ? <CountdownPill expiresAt={offer.expiresAt} onExpire={onExpire} /> : null}
      </Row>

      <Row gap={Spacing.sm} style={{ flexWrap: 'wrap' }}>
        {hasEstimate ? (
          <Pill label={`${t('jobs.estimate')} ${formatTZS(offer.estimateLowTZS ?? 0)}–${formatTZS(offer.estimateHighTZS ?? 0)}`} tone="neutral" />
        ) : null}
        {offer.urgency ? <Pill label={t(`jobs.urgency.${offer.urgency}`)} tone={URGENCY_TONE[offer.urgency]} /> : null}
        {offer.photoCount ? <Pill label={`${offer.photoCount} ${t('jobs.photos')}`} tone="info" /> : null}
      </Row>

      <Row style={{ justifyContent: 'space-between' }}>
        <View style={{ gap: 4, flex: 1 }}>
          <Row gap={6}>
            <Icon name="location" size={13} color={Colors.textTertiary} />
            <Text style={styles.meta}>{offer.customerArea ?? t('booking.address')}</Text>
          </Row>
          <Row gap={6}>
            <Icon name="navigate" size={13} color={Colors.textTertiary} />
            <Text style={styles.meta}>{offer.distanceKm.toFixed(1)} {t('jobs.distance')}</Text>
          </Row>
          {offer.scheduledFor ? (
            <Row gap={6}>
              <Icon name="calendar-outline" size={13} color={Colors.textTertiary} />
              <Text style={styles.meta}>{t('booking.scheduledFor')} · {dateISO(offer.scheduledFor)}</Text>
            </Row>
          ) : null}
        </View>
        {hasMatch ? (
          <View style={styles.matchBox}>
            <Text style={styles.matchLabel}>{t('jobs.match')}</Text>
            <Text style={[styles.matchValue, { fontVariant: NumberStyle.fontVariant }]}>{Math.round((offer.matchScore ?? 0) * 100)}%</Text>
          </View>
        ) : null}
      </Row>

      {offer.reasons && offer.reasons.length > 0 ? (
        <View style={{ gap: 4 }}>
          <Text style={styles.whyLabel}>{t('jobs.why')}</Text>
          {offer.reasons.map((r) => (
            <Row key={r} gap={6}>
              <Icon name="checkmark-circle" size={12} color={Colors.success} />
              <Text style={styles.whyText}>{r}</Text>
            </Row>
          ))}
        </View>
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  trade: { fontSize: FontSize.lg, fontFamily: 'PlusJakartaSans_800ExtraBold', color: Colors.text },
  summary: { fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 2, lineHeight: 18 },
  meta: { fontSize: FontSize.xs, color: Colors.textTertiary, fontFamily: 'PlusJakartaSans_600SemiBold' },
  whyLabel: { fontSize: FontSize.xs, color: Colors.textTertiary, fontFamily: 'PlusJakartaSans_700Bold' },
  whyText: { flex: 1, fontSize: FontSize.xs, color: Colors.textSecondary },
  matchBox: { alignItems: 'center', backgroundColor: Colors.primarySoft, borderRadius: 12, paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm },
  matchLabel: { fontSize: FontSize.xs, color: Colors.primaryDeep, fontFamily: 'PlusJakartaSans_700Bold' },
  matchValue: { fontSize: FontSize.lg, color: Colors.primaryDeep, fontFamily: 'PlusJakartaSans_800ExtraBold' },
});
