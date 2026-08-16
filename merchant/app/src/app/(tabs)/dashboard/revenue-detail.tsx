import { router } from 'expo-router';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { LineChart } from '@/components/charts';
import { Btn, Card, Divider, Row, Screen, Segmented } from '@/components/ui';
import { Colors, FontSize, Spacing } from '@/constants/theme';
import { revenueTrend } from '@/lib/analytics';
import { t, onLocaleChange, type I18nKey } from '@/i18n';
import { tzs } from '@/lib/format';
import { useFinanceStore } from '@/store/finance';
import { useOrderStore } from '@/store/orders';

type Range = 'day' | 'week' | 'month';

const RANGE_HINT: Record<Range, I18nKey> = {
  day: 'revd.hintToday',
  week: 'revd.hintWeek',
  month: 'revd.hintMonth',
};

export default function RevenueDetailScreen() {
  useSyncExternalStore(onLocaleChange, () => 0);
  const orders = useOrderStore((s) => s.orders);
  const wallet = useFinanceStore((s) => s.wallet);
  const [range, setRange] = useState<Range>('week');
  /* Earnings pass (gap-09): commission renders from the API value
   * (wallet.commissionRateBps) — never recomputed client-side. */
  useEffect(() => {
    void useFinanceStore.getState().hydrateWithdrawals();
  }, []);
  const data = revenueTrend(orders, range);
  const total = data.reduce((s, d) => s + d.value, 0);
  const peak = [...data].sort((a, b) => b.value - a.value)[0];
  const deliveryTotal = orders
    .filter((o) => o.status === 'completed')
    .reduce((s, o) => s + o.deliveryFee, 0);
  const commissionBps = wallet?.commissionRateBps ?? null;

  return (
    <Screen scroll>
      <Card>
        <Text style={styles.label}>{t('revd.title')}</Text>
        <Text style={styles.total}>{tzs(total)}</Text>
        <Text style={styles.sub}>{t(RANGE_HINT[range])}</Text>
        <LineChart data={data} height={150} color={Colors.primaryDark} valueSuffix="TZS " />
      </Card>

      <View style={{ marginTop: Spacing.lg }}>
        <Segmented
          value={range}
          onChange={setRange}
          options={[
            { key: 'day', label: t('revd.today') },
            { key: 'week', label: t('revd.week') },
            { key: 'month', label: t('revd.month') },
          ]}
        />
      </View>

      <Card style={{ marginTop: Spacing.lg, paddingVertical: Spacing.sm }}>
        <Row style={{ justifyContent: 'space-between', paddingVertical: Spacing.md }}>
          <Text style={styles.rowLabel}>{t('revd.peak')}</Text>
          <Text style={styles.rowValue}>{peak ? t('revd.peakVal', { label: peak.label, amount: tzs(peak.value) }) : '—'}</Text>
        </Row>
        <Divider />
        <Row style={{ justifyContent: 'space-between', paddingVertical: Spacing.md }}>
          <Text style={styles.rowLabel}>{t('revd.deliveryIncluded')}</Text>
          <Text style={styles.rowValue}>{tzs(deliveryTotal)}</Text>
        </Row>
        <Divider />
        <Row style={{ justifyContent: 'space-between', paddingVertical: Spacing.md }}>
          <Text style={styles.rowLabel}>{t('revd.commission')}</Text>
          <Text style={styles.rowValue}>{commissionBps !== null ? `${(commissionBps / 100).toFixed(2)}%` : '—'}</Text>
        </Row>
      </Card>

      <Btn label={t('revd.viewLedger')} icon="wallet-outline" onPress={() => router.push('/dashboard/finance')} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  label: { fontSize: FontSize.sm, color: Colors.textSecondary },
  total: { fontSize: 32, fontWeight: '800', color: Colors.text, marginTop: 4, letterSpacing: 0.5 },
  sub: { fontSize: FontSize.xs, color: Colors.textTertiary, marginBottom: Spacing.lg },
  rowLabel: { fontSize: FontSize.md, color: Colors.textSecondary },
  rowValue: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text },
});