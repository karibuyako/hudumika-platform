import { useEffect, useSyncExternalStore } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Card, Pill, Row, Screen, SectionTitle } from '@/components/ui';
import { Colors, FontSize } from '@/constants/theme';
import { t, onLocaleChange } from '@/i18n';
import { tzs } from '@/lib/format';
import { useAnalyticsExtStore } from '@/store/analytics-ext';

export default function AnalyticsExtScreen() {
  useSyncExternalStore(onLocaleChange, () => 0);
  const store = useAnalyticsExtStore();

  useEffect(() => {
    store.hydrate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const score = store.storeScore;
  const customers = store.customers;
  const distribution = store.distribution;
  const marketing = store.marketing;
  const maxArea = Math.max(1, ...distribution.map((d) => d.customerCount));
  const freqLabel = customers?.avgOrderFrequency != null ? `${customers.avgOrderFrequency.toFixed(1)}×` : '—';
  const churnLabel = customers?.churnRate != null ? `${customers.churnRate.toFixed(1)}%` : '—';
  const ltvLabel = customers?.avgLifetimeValueTZS != null ? tzs(customers.avgLifetimeValueTZS) : '—';

  return (
    <Screen scroll>
      <SectionTitle title={t('axe.storeScore')} icon="ribbon-outline" />
      <Card style={{ gap: SpacingOpts.md }}>
        {score ? (
          <>
            <Row style={{ justifyContent: 'space-between', alignItems: 'flex-end' }}>
              <View>
                <Text style={styles.kpiLabel}>{t('axe.storeScore')}</Text>
                <Text style={styles.bigScore}>{score.score}</Text>
                <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>0–100</Text>
              </View>
              <View style={{ alignItems: 'flex-end', gap: 4 }}>
                <Pill label={`★ ${score.ratingAverage.toFixed(1)}`} tone="success" />
                <Text style={styles.kpiLabel}>{t('axe.ratingAverage')}</Text>
              </View>
            </Row>
            <View style={styles.divider} />
            <Text style={styles.miniHead}>{t('axe.breakdown')}</Text>
            {score.breakdown.map((b) => (
              <View key={b.factor} style={{ gap: 5 }}>
                <Row style={{ justifyContent: 'space-between' }}>
                  <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary }}>{factorLabel(b.factor)}</Text>
                  <Text style={{ fontSize: FontSize.sm, fontWeight: '800', color: Colors.text }}>{b.score}</Text>
                </Row>
                <View style={styles.progressTrack}>
                  <View style={[styles.progressFill, { width: `${b.score}%`, backgroundColor: b.score >= 80 ? Colors.success : b.score >= 50 ? Colors.info : Colors.warning }]} />
                </View>
              </View>
            ))}
          </>
        ) : (
          <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary }}>{t('axe.errLoad')}</Text>
        )}
      </Card>

      <SectionTitle title={t('axe.customers')} icon="people-outline" />
      <Card style={{ gap: SpacingOpts.md }}>
        {customers ? (
          <>
            <Row style={{ justifyContent: 'space-between' }}>
              <KpiTile label={t('axe.newCustomers')} value={`${customers.newCustomers}`} color={Colors.info} />
              <KpiTile label={t('axe.returningCustomers')} value={`${customers.returningCustomers}`} color={Colors.primaryDark} />
              <KpiTile label={t('axe.retentionRate')} value={`${customers.retentionRate.toFixed(1)}%`} color={Colors.success} />
            </Row>
            <View style={styles.divider} />
            <Row style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
              <Text style={styles.miniHead}>
                {t('axe.avgFrequency')}: <Text style={{ color: Colors.text, fontWeight: '700' }}>{freqLabel}</Text>
              </Text>
              <Text style={styles.miniHead}>
                {t('axe.avgLifetimeValue')}: <Text style={{ color: Colors.text, fontWeight: '700' }}>{ltvLabel}</Text>
              </Text>
              <Text style={styles.miniHead}>
                {t('axe.churnRate')}: <Text style={{ color: Colors.text, fontWeight: '700' }}>{churnLabel}</Text>
              </Text>
            </Row>
          </>
        ) : (
          <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary }}>{t('axe.errLoad')}</Text>
        )}
      </Card>

      <SectionTitle title={t('axe.distribution')} icon="location-outline" />
      <Card style={{ gap: SpacingOpts.md }}>
        {distribution.length === 0 ? (
          <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary }}>{t('axe.errLoad')}</Text>
        ) : (
          distribution.map((d) => (
            <View key={d.area} style={{ gap: 5 }}>
              <Row style={{ justifyContent: 'space-between' }}>
                <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary }}>{d.area}</Text>
                <Text style={{ fontSize: FontSize.sm, fontWeight: '800', color: Colors.text, fontVariant: ['tabular-nums'] }}>{d.customerCount}</Text>
              </Row>
              <View style={styles.progressTrack}>
                <View style={[styles.progressFill, { width: `${(d.customerCount / maxArea) * 100}%`, backgroundColor: Colors.primary }]} />
              </View>
            </View>
          ))
        )}
      </Card>

      <SectionTitle title={t('axe.marketing')} icon="megaphone-outline" />
      <Card style={{ gap: SpacingOpts.md }}>
        {marketing ? (
          <>
            <Row style={{ justifyContent: 'space-between' }}>
              <KpiTile label={t('axe.totalSpend')} value={tzs(marketing.totalSpendTZS)} color={Colors.warning} />
              <KpiTile label={t('axe.attributedRevenue')} value={tzs(marketing.attributedRevenueTZS)} color={Colors.success} />
              <KpiTile label={t('axe.activeCampaigns')} value={`${marketing.activeCampaigns}`} color={Colors.info} />
            </Row>
            <View style={styles.divider} />
            <Row style={{ justifyContent: 'space-between', alignItems: 'center' }}>
              <Text style={styles.miniHead}>{t('axe.roi')}</Text>
              <Pill label={`${marketing.roiPercent.toFixed(1)}%`} tone={marketing.roiPercent >= 100 ? 'success' : 'warning'} />
            </Row>
          </>
        ) : (
          <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary }}>{t('axe.errLoad')}</Text>
        )}
      </Card>
    </Screen>
  );
}

function factorLabel(factor: string): string {
  const map: Record<string, string> = {
    delivery_speed: 'Delivery speed',
    food_quality: 'Food quality',
    service: 'Service',
    repeat_rate: 'Repeat rate',
    average_order_value: 'Average order value',
  };
  return map[factor] ?? factor;
}

function KpiTile({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <View style={{ gap: 2, minWidth: 0, flex: 1 }}>
      <Text style={[styles.kpiValue, { color }]} numberOfLines={1}>{value}</Text>
      <Text style={styles.kpiLabel} numberOfLines={1}>{label}</Text>
    </View>
  );
}


const SpacingOpts = {
  sm: 8,
  md: 12,
  lg: 16,
};

const styles = StyleSheet.create({
  kpiLabel: { fontSize: FontSize.xs, color: Colors.textTertiary },
  kpiValue: { fontSize: FontSize.lg, fontWeight: '800', color: Colors.text },
  bigScore: { fontSize: 40, fontWeight: '900', color: Colors.text, fontVariant: ['tabular-nums'] },
  miniHead: { fontSize: 10, color: Colors.textTertiary, fontWeight: '700', letterSpacing: 0.6 },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: Colors.border },
  progressTrack: { height: 6, borderRadius: 3, backgroundColor: Colors.surface, overflow: 'hidden' },
  progressFill: { height: 6, borderRadius: 3 },
});
