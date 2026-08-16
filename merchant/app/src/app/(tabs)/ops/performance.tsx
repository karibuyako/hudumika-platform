import { Stack, router } from 'expo-router';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Btn, Card, Chip, Empty, Icon, Pill, Row, Screen } from '@/components/ui';
import { Colors, FontSize, Radius, Spacing } from '@/constants/theme';
import { t, onLocaleChange, type I18nKey } from '@/i18n';
import { tzs } from '@/lib/format';
import { useStaffOpsStore } from '@/store/staff-ops';

const DAY = 86400000;

const RANGE_CHIPS: { key: '7d' | '30d'; label: I18nKey; from: (now: number) => number }[] = [
  { key: '7d', label: 'so.range7d', from: (now) => now - 6 * DAY },
  { key: '30d', label: 'so.range30d', from: (now) => now - 29 * DAY },
];

const iso = (ts: number) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export default function PerformanceScreen() {
  useSyncExternalStore(onLocaleChange, () => 0);
  const performance = useStaffOpsStore((s) => s.performance);
  const hydratePerformance = useStaffOpsStore((s) => s.hydratePerformance);

  const [rangeKey, setRangeKey] = useState<'7d' | '30d'>('7d');

  const range = useMemo(() => {
    const now = Date.now();
    const from = RANGE_CHIPS.find((r) => r.key === rangeKey)!.from(now);
    return { from: iso(from), to: iso(now) };
  }, [rangeKey]);

  useEffect(() => {
    hydratePerformance(range.from, range.to);
  }, [hydratePerformance, range]);

  const rows = [...performance.rows].sort((a, b) => b.ordersProcessed - a.ordersProcessed);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: Colors.bg }} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.topBar}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Icon name="chevron-back" size={26} color={Colors.text} />
        </Pressable>
        <Text style={styles.topTitle}>{t('so.perfTitle')}</Text>
        <View style={{ width: 26 }} />
      </View>

      <Screen scroll>
        <Row gap={8} style={{ flexWrap: 'wrap', marginTop: Spacing.md }}>
          {RANGE_CHIPS.map((r) => (
            <Chip key={r.key} label={t(r.label)} selected={rangeKey === r.key} onPress={() => setRangeKey(r.key)} />
          ))}
        </Row>

        {performance.error ? (
          <View style={{ alignItems: 'center', gap: Spacing.sm, paddingVertical: Spacing.lg }}>
            <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '600' }}>{t('so.perfEmpty')}</Text>
            <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>{t('so.perfEmptySub')}</Text>
            <Btn label={t('common.retry')} size="sm" variant="outline" onPress={() => hydratePerformance(range.from, range.to)} />
          </View>
        ) : null}

        <View style={{ gap: Spacing.md, marginTop: Spacing.md }}>
          {!performance.loading && rows.length === 0 ? <Empty icon="speedometer-outline" title={t('so.perfEmpty')} sub={t('so.perfEmptySub')} /> : null}
          {rows.map((p) => (
            <Card key={p.staffId} style={{ gap: Spacing.md }}>
              <Row style={{ justifyContent: 'space-between' }}>
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={styles.name} numberOfLines={1}>{p.name}</Text>
                  <Text style={styles.meta}>
                    {t('so.perfRating')}: {p.ratingAverage !== null ? p.ratingAverage.toFixed(1) : t('so.perfNoRating')} · {t('so.perfAttendance')}: {t('so.perfPct', { n: p.attendanceRate })}
                  </Text>
                </View>
                <Pill label={tzs(p.commissionTZS)} tone="success" />
              </Row>
              <View style={styles.statsRow}>
                <Stat label={t('so.perfOrders')} value={`${p.ordersProcessed}`} />
                <Stat label={t('so.perfHandle')} value={t('so.perfMin', { n: p.avgHandleTimeMinutes })} />
                <Stat label={t('so.perfCancellations')} value={`${p.cancellations}`} tone={p.cancellations > 3 ? Colors.danger : undefined} />
              </View>
            </Card>
          ))}
        </View>
      </Screen>
    </SafeAreaView>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <View style={styles.statBox}>
      <Text style={[styles.statValue, tone ? { color: tone } : null]}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    backgroundColor: Colors.card,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.border,
  },
  topTitle: { fontSize: FontSize.lg, fontWeight: '800', color: Colors.text },
  name: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text, flexShrink: 1 },
  meta: { fontSize: FontSize.xs, color: Colors.textTertiary },
  statsRow: { flexDirection: 'row', gap: Spacing.sm },
  statBox: {
    flex: 1,
    backgroundColor: Colors.surface,
    borderRadius: Radius.md,
    paddingVertical: Spacing.sm,
    alignItems: 'center',
    gap: 2,
  },
  statValue: { fontSize: FontSize.md, fontWeight: '800', color: Colors.text },
  statLabel: { fontSize: FontSize.xs, color: Colors.textTertiary },
});
