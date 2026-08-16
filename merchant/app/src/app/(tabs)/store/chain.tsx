import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';

import type { ChainReportBody, ChainStorePerformance } from '@/api/types';
import { BarChart } from '@/components/charts';
import { Btn, Card, Empty, Field, Kpi, Pill, Row, Screen, Segmented, SheetModal } from '@/components/ui';
import { Colors, FontSize, Radius, Spacing } from '@/constants/theme';
import { t, onLocaleChange, type I18nKey } from '@/i18n';
import { tzs } from '@/lib/format';
import { useChainStore } from '@/store/chain';

const STORES = [
  { id: 's_demo', name: 'Skewer House BBQ · Kariakoo' },
  { id: 's_demo_2', name: 'Skewer House BBQ · Guomao' },
];

const REPORT_TYPES = ['financial', 'operational', 'orders', 'inventory'] as const;

/* Sortable store-table columns (EF L16) — server values, client only re-orders. */
type SortKey = 'revenueTZS' | 'orderCount' | 'conversionRate' | 'rating' | 'lowStockCount';
const SORT_COLUMNS: { key: SortKey; label: I18nKey }[] = [
  { key: 'revenueTZS', label: 'ch.revenue' },
  { key: 'orderCount', label: 'ch.orders' },
  { key: 'lowStockCount', label: 'ch.lowStock' },
  { key: 'rating', label: 'ch.rating' },
];

const RANGE_DAYS = [7, 30, 90] as const;

function iso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/* Module-level (computed once): the report defaults — last 30 days. */
const FROM_DEFAULT = iso(new Date(Date.now() - 30 * 86400000));
const TO_DEFAULT = iso(new Date());

function rangeFromDays(days: number): { from: string; to: string } {
  return { from: iso(new Date(Date.now() - (days - 1) * 86400000)), to: iso(new Date()) };
}

export default function ChainScreen() {
  useSyncExternalStore(onLocaleChange, () => 0);
  const dashboard = useChainStore((s) => s.dashboard);
  const loading = useChainStore((s) => s.loading);
  const error = useChainStore((s) => s.error);
  const hydrate = useChainStore((s) => s.hydrate);
  const exportReport = useChainStore((s) => s.exportReport);
  const analytics = useChainStore((s) => s.analytics);
  const analyticsLoading = useChainStore((s) => s.analyticsLoading);
  const analyticsError = useChainStore((s) => s.analyticsError);
  const fetchAnalytics = useChainStore((s) => s.fetchAnalytics);

  const [refreshing, setRefreshing] = useState(false);
  const [tab, setTab] = useState<'dashboard' | 'analytics'>('dashboard');
  const [sheet, setSheet] = useState(false);
  const [reportType, setReportType] = useState<ChainReportBody['reportType']>('financial');
  const [from, setFrom] = useState(FROM_DEFAULT);
  const [to, setTo] = useState(TO_DEFAULT);
  const [storeIds, setStoreIds] = useState<string[]>([]);
  const [err, setErr] = useState('');
  const [result, setResult] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey | null>(null);
  const [sortAsc, setSortAsc] = useState(false);
  const [rangeDays, setRangeDays] = useState<number>(7);

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  const onRefresh = async () => {
    setRefreshing(true);
    await hydrate();
    setRefreshing(false);
  };

  const toggleStore = (id: string) => {
    setStoreIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const run = async () => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      setErr(t('ch.errDate'));
      return;
    }
    setErr('');
    setResult(null);
    const body: ChainReportBody = {
      reportType,
      from,
      to,
      storeIds: storeIds.length ? storeIds : undefined,
    };
    const res = await exportReport(body);
    if (!res) {
      setErr(t('ch.errExport'));
      return;
    }
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setResult(t('ch.reportReady', { sec: res.expiresInSeconds }));
  };

  const applyRange = (days: number) => {
    setRangeDays(days);
    const r = rangeFromDays(days);
    setFrom(r.from);
    setTo(r.to);
    fetchAnalytics(r.from, r.to);
  };

  const loadAnalytics = () => {
    fetchAnalytics(from, to);
  };

  useEffect(() => {
    if (tab === 'analytics') {
      fetchAnalytics(from, to);
    }
  }, [tab, from, to, fetchAnalytics]);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortAsc((v) => !v);
    } else {
      setSortKey(key);
      setSortAsc(false);
    }
  };

  const sortedStores = (list: ChainStorePerformance[]): ChainStorePerformance[] => {
    if (!sortKey) return list;
    const dir = sortAsc ? 1 : -1;
    return [...list].sort((a, b) => {
      const av = a[sortKey] ?? 0;
      const bv = b[sortKey] ?? 0;
      if (av === bv) return a.businessName.localeCompare(b.businessName);
      return (av < bv ? -1 : 1) * dir;
    });
  };

  const totals = dashboard?.totals;
  const stores = dashboard?.stores ?? [];
  const ranked = [...analytics].sort((a, b) => b.revenueTZS - a.revenueTZS);

  return (
    <Screen>
      <ScrollView
        contentContainerStyle={{ padding: Spacing.lg, gap: Spacing.md, paddingBottom: 40 }}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Colors.primary} />}>
        <Row style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>
            {dashboard ? t('ch.asOf', { date: dashboard.date }) : t('common.loading')}
          </Text>
        </Row>

        <Segmented
          options={[
            { key: 'dashboard', label: t('ch.dashboard') },
            { key: 'analytics', label: t('ch.analytics') },
          ]}
          value={tab}
          onChange={setTab}
          equal
        />

        {error ? (
          <View style={{ alignItems: 'center', gap: Spacing.sm, paddingVertical: Spacing.lg }}>
            <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '600' }}>{error}</Text>
            <Btn label={t('common.retry')} size="sm" variant="outline" onPress={() => hydrate()} />
          </View>
        ) : null}

        {tab === 'dashboard' ? (
          <>
            {!loading && !error && dashboard && stores.length === 0 ? (
              <Empty icon="storefront-outline" title={t('ch.emptyChain')} sub={t('ch.emptyChainSub')} />
            ) : null}

            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
              <View style={{ flex: 1, minWidth: 140 }}>
                <Kpi label={t('ch.orders')} value={String(totals?.orders ?? 0)} icon="receipt-outline" />
              </View>
              <View style={{ flex: 1, minWidth: 140 }}>
                <Kpi label={t('ch.revenue')} value={tzs(totals?.revenueTZS ?? 0)} icon="cash-outline" />
              </View>
              <View style={{ flex: 1, minWidth: 140 }}>
                <Kpi label={t('ch.active')} value={String(totals?.activeOrders ?? 0)} icon="flame-outline" />
              </View>
              <View style={{ flex: 1, minWidth: 140 }}>
                {/* EF L16 — lowStockAlerts deep-links to /store/inventory alerts tab. */}
                <Kpi
                  label={t('ch.lowStock')}
                  value={String(totals?.lowStockAlerts ?? 0)}
                  icon="alert-circle-outline"
                  onPress={() => router.push('/store/inventory?tab=alerts' as never)}
                />
              </View>
            </View>

            <Row style={{ justifyContent: 'space-between', alignItems: 'center' }}>
              <Text style={{ fontSize: FontSize.md, fontWeight: '700', color: Colors.text }}>{t('ch.stores')}</Text>
              <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>{t('ch.tapToSort')}</Text>
            </Row>

            {stores.length > 0 ? (
              <Card style={{ gap: 0, padding: 0, overflow: 'hidden' }}>
                <Row style={styles.tableHead}>
                  <Text style={[styles.th, { flex: 2 }]}>{t('ch.store')}</Text>
                  {SORT_COLUMNS.map((c) => (
                    <Pressable key={c.key} onPress={() => toggleSort(c.key)} accessibilityRole="button" accessibilityLabel={t(c.label)} style={[styles.th, { flex: 1, justifyContent: 'flex-end' }]}>
                      <Text style={[styles.thText, sortKey === c.key && { color: Colors.primaryDeep, fontWeight: '800' }]}>
                        {t(c.label)}{sortKey === c.key ? (sortAsc ? ' ↑' : ' ↓') : ''}
                      </Text>
                    </Pressable>
                  ))}
                </Row>
                {sortedStores(stores).map((s) => (
                  <View key={s.storeId} style={styles.tableRow}>
                    <View style={{ flex: 2, gap: 2 }}>
                      <Row gap={6}>
                        <Text style={styles.cellName} numberOfLines={1}>{s.businessName}</Text>
                        {s.isOpen ? <Pill label={t('ch.open')} tone="success" /> : <Pill label={t('ch.closed')} tone="neutral" />}
                      </Row>
                      <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>
                        {t('ch.rating', { r: s.rating ?? '—' })} · {t('ch.conversion', { p: (s.conversionRate * 100).toFixed(1) })}
                      </Text>
                    </View>
                    <Text style={[styles.cell, { flex: 1 }]}>{tzs(s.revenueTZS)}</Text>
                    <Text style={[styles.cell, { flex: 1 }]}>{s.orderCount}</Text>
                    <Text style={[styles.cell, { flex: 1, color: s.lowStockCount > 0 ? Colors.warning : Colors.text }]}>{s.lowStockCount}</Text>
                    <Text style={[styles.cell, { flex: 1 }]}>{s.rating ?? '—'}</Text>
                  </View>
                ))}
              </Card>
            ) : null}

            <Btn label={t('ch.reports')} size="lg" icon="download-outline" onPress={() => { setSheet(true); setErr(''); setResult(null); }} />
          </>
        ) : (
          <>
            <Row style={{ justifyContent: 'space-between', alignItems: 'center' }}>
              <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '600' }}>{t('ch.analyticsRange')}</Text>
              <Row gap={8}>
                {RANGE_DAYS.map((d) => (
                  <Pressable
                    key={d}
                    onPress={() => applyRange(d)}
                    accessibilityRole="button"
                    accessibilityLabel={`${d}d`}
                    accessibilityState={{ selected: rangeDays === d }}
                    style={[styles.typeChip, rangeDays === d && { borderColor: Colors.primary, backgroundColor: Colors.primarySoft }]}>
                    <Text style={{ fontSize: FontSize.xs, color: rangeDays === d ? Colors.primaryDeep : Colors.textSecondary, fontWeight: '700' }}>
                      {t('ch.rangeDays', { n: d })}
                    </Text>
                  </Pressable>
                ))}
              </Row>
            </Row>
            <Row gap={Spacing.sm}>
              <View style={{ flex: 1 }}>
                <Field label={t('ch.from')} value={from} onChangeText={setFrom} placeholder="2026-01-01" />
              </View>
              <View style={{ flex: 1 }}>
                <Field label={t('ch.to')} value={to} onChangeText={setTo} placeholder="2026-01-31" />
              </View>
            </Row>
            {analyticsError ? (
              <View style={{ alignItems: 'center', gap: Spacing.sm, paddingVertical: Spacing.sm }}>
                <Text style={{ fontSize: FontSize.sm, color: Colors.danger, fontWeight: '600' }}>{analyticsError}</Text>
                <Btn label={t('common.retry')} size="sm" variant="outline" onPress={loadAnalytics} />
              </View>
            ) : null}

            {!analyticsLoading && !analyticsError && analytics.length === 0 ? (
              <Empty icon="stats-chart-outline" title={t('ch.emptyRange')} sub={t('ch.emptyRangeSub')} />
            ) : null}

            {analytics.length > 0 ? (
              <>
                <Card style={{ gap: Spacing.sm }}>
                  <Text style={{ fontSize: FontSize.md, fontWeight: '700', color: Colors.text }}>{t('ch.barComparison')}</Text>
                  <BarChart
                    data={ranked.map((s) => ({ label: s.businessName.replace('Skewer House BBQ · ', ''), value: s.revenueTZS }))}
                    height={150}
                    valueSuffix=""
                  />
                </Card>
                <Text style={{ fontSize: FontSize.md, fontWeight: '700', color: Colors.text }}>{t('ch.ranked')}</Text>
                {ranked.map((s, i) => (
                  <Card key={s.storeId} style={{ gap: 4 }}>
                    <Row style={{ justifyContent: 'space-between' }}>
                      <Text style={styles.cellName} numberOfLines={1}>{i + 1}. {s.businessName}</Text>
                      {s.isOpen ? <Pill label={t('ch.open')} tone="success" /> : <Pill label={t('ch.closed')} tone="neutral" />}
                    </Row>
                    <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>
                      {tzs(s.revenueTZS)} · {s.orderCount} {t('ch.orders').toLowerCase()} · {t('ch.rating', { r: s.rating ?? '—' })} · {t('ch.lowStock')} {s.lowStockCount}
                    </Text>
                  </Card>
                ))}
              </>
            ) : null}
          </>
        )}
      </ScrollView>

      <SheetModal visible={sheet} onClose={() => setSheet(false)} title={t('ch.reports')}>
        <View style={{ gap: Spacing.md }}>
          <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '600' }}>{t('ch.reportType')}</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            {REPORT_TYPES.map((rt) => (
              <Pressable
                key={rt}
                onPress={() => setReportType(rt)}
                accessibilityRole="button"
                accessibilityLabel={t(`ch.type.${rt}`)}
                style={[styles.typeChip, reportType === rt && { borderColor: Colors.primary, backgroundColor: Colors.primarySoft }]}>
                <Text style={{ fontSize: FontSize.xs, color: reportType === rt ? Colors.primaryDeep : Colors.textSecondary, fontWeight: '700' }}>
                  {t(`ch.type.${rt}`)}
                </Text>
              </Pressable>
            ))}
          </View>
          <Row gap={Spacing.sm}>
            <View style={{ flex: 1 }}>
              <Field label={t('ch.from')} value={from} onChangeText={setFrom} placeholder="2026-01-01" />
            </View>
            <View style={{ flex: 1 }}>
              <Field label={t('ch.to')} value={to} onChangeText={setTo} placeholder="2026-01-31" />
            </View>
          </Row>
          <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '600' }}>{t('bulk.storesLabel')}</Text>
          {STORES.map((s) => {
            const selected = storeIds.includes(s.id);
            return (
              <Pressable
                key={s.id}
                onPress={() => toggleStore(s.id)}
                accessibilityRole="button"
                accessibilityLabel={s.name}
                accessibilityState={{ selected }}
                style={({ pressed }) => [styles.storeRow, selected && { borderColor: Colors.primary }, pressed && { opacity: 0.8 }]}>
                <Text style={{ flex: 1, fontSize: FontSize.sm, color: Colors.text, fontWeight: selected ? '700' : '500' }} numberOfLines={1}>
                  {s.name}
                </Text>
                {selected ? <Text style={{ color: Colors.primaryDeep, fontWeight: '800' }}>✓</Text> : null}
              </Pressable>
            );
          })}
          {err ? <Text style={{ fontSize: FontSize.sm, color: Colors.danger }}>{err}</Text> : null}
          {result ? <Text style={{ fontSize: FontSize.sm, color: Colors.success }}>{result}</Text> : null}
          <Row gap={Spacing.md}>
            <Btn label={t('common.cancel')} size="lg" variant="subtle" style={{ flex: 1 }} onPress={() => setSheet(false)} />
            <Btn label={t('ch.export')} size="lg" style={{ flex: 1 }} onPress={run} />
          </Row>
        </View>
      </SheetModal>
    </Screen>
  );
}

const styles = StyleSheet.create({
  typeChip: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: Radius.pill,
    borderWidth: 1,
    borderColor: Colors.borderStrong,
    backgroundColor: Colors.card,
  },
  storeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 10,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.card,
    gap: Spacing.sm,
  },
  tableHead: {
    paddingHorizontal: Spacing.md,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.border,
    gap: Spacing.sm,
  },
  th: { alignItems: 'flex-start' },
  thText: { fontSize: FontSize.xs, color: Colors.textSecondary, fontWeight: '700' },
  tableRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    paddingHorizontal: Spacing.md,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.border,
  },
  cell: { fontSize: FontSize.xs, color: Colors.text, fontWeight: '700', textAlign: 'right' },
  cellName: { fontSize: FontSize.sm, fontWeight: '700', color: Colors.text, flexShrink: 1 },
});
