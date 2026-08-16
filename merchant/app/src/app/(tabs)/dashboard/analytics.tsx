import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { t, onLocaleChange, type I18nKey } from '@/i18n';
import { api, ApiError } from '@/api/client';
import type { BenchmarkSummary, ChainStorePerformance, ForecastPoint, Funnel, MarketAnalysis, OrderAnalytics, ProductPerformance, ReportExport, RevenueAnalysis, StoreListItem } from '@/api/types';
import { BarChart, Donut, LineChart } from '@/components/charts';
import { Btn, Card, Chip, Divider, Icon, Kpi, Pill, Row, Screen, SectionTitle } from '@/components/ui';
import { Colors, FontSize, Radius } from '@/constants/theme';
import { weekdayRevenueProfile } from '@/data/seed';
import { computeStats, topDishes, weeklyTrend } from '@/lib/analytics';
import { tzs } from '@/lib/format';
import { useAnalyticsStore } from '@/store/analytics';
import { useCatalogStore } from '@/store/catalog';
import { useOrderStore } from '@/store/orders';
import { useTaskStore } from '@/store/tasks';

const DAY_MS = 86400000;
const DONUT_COLORS = [Colors.primary, Colors.info, Colors.success, Colors.textTertiary];

const isoDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const WEEK_FROM = isoDate(new Date(Date.now() - 6 * DAY_MS));
const WEEK_TO = isoDate(new Date());
const MONTH_FROM = isoDate(new Date(Date.now() - 29 * DAY_MS));

/* Live strip polling interval (ANALYTICS.md:16 "env-configured interval"). */
const POLL_MS = Number(process.env.EXPO_PUBLIC_ANALYTICS_POLL_MS ?? 60000) || 60000;

const TRAFFIC_LABELS: Record<string, I18nKey> = {
  search: 'an.chSearch',
  category: 'an.chCategory',
  promotion: 'an.chPromotion',
  group_buy: 'an.chGroupBuy',
  dine_in_qr: 'an.chDineInQr',
  direct: 'an.chDirect',
  referral: 'an.chReferral',
};

const REVENUE_LABELS: Record<string, I18nKey> = {
  delivery: 'an.chDelivery',
  dine_in: 'an.chDineIn',
  group_buy: 'an.chGroupBuy',
  pickup: 'an.chPickup',
};

const FUNNEL_LABELS: Record<string, I18nKey> = {
  impressions: 'an.fImp',
  store_visits: 'an.fVisits',
  menu_views: 'an.fMenu',
  carts: 'an.fCarts',
  orders: 'an.orders',
  completed: 'an.completed',
};

const TREND_META: Record<MarketAnalysis['trend'], { label: I18nKey; tone: 'success' | 'neutral' | 'danger' }> = {
  growing: { label: 'an.trendGrowing', tone: 'success' },
  stable: { label: 'an.trendStable', tone: 'neutral' },
  declining: { label: 'an.trendDeclining', tone: 'danger' },
};

export default function AnalyticsScreen() {
  useSyncExternalStore(onLocaleChange, () => 0);
  const orders = useOrderStore((s) => s.orders);
  const tasks = useTaskStore((s) => s.tasks);
  const completeTask = useTaskStore((s) => s.complete);
  const server = useAnalyticsStore((s) => s);
  const selectedStoreId = server.selectedStoreId;
  const catalog = useCatalogStore((s) => s.products);
  const catalogById = useMemo(() => new Map(catalog.map((p) => [p.id, p])), [catalog]);
  const stats = server.overview ?? computeStats(orders);
  const week = server.trend.length ? server.trend.map((d) => ({ label: d.label, revenue: d.revenue })) : weeklyTrend(orders);
  const weekday = weekdayRevenueProfile(orders);
  const dishes = server.dishes.length ? server.dishes : topDishes(orders).map((d) => ({ id: '', ...d }));
  const traffic = server.traffic;
  const totalDishSold = dishes.reduce((s, d) => s + d.sold, 0);
  const completedCount = orders.filter((o) => o.status === 'completed').length;
  const gmvDelta = Math.round(((stats.todayRevenue - stats.prevRevenue) / Math.max(stats.prevRevenue, 1)) * 100);
  const ordersDelta = Math.round(((stats.todayOrders - stats.prevOrders) / Math.max(stats.prevOrders, 1)) * 100);
  const weekdayColors = weekday.map((d) => (d.label === 'Sat' || d.label === 'Sun' ? Colors.primary : Colors.info));
  const pendingTasks = tasks.filter((t) => !t.done);
  const [insights, setInsights] = useState<InsightsState>({});
  const [forecast, setForecast] = useState<{ storeId: string | null; points: ForecastPoint[] | null }>({ storeId: null, points: null });
  const [storeList, setStoreList] = useState<StoreListItem[]>([]);
  const [attempt, setAttempt] = useState(0);
  const [exported, setExported] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportBusy, setExportBusy] = useState(false);

  useEffect(() => {
    let active = true;
    api
      .get<{ stores: StoreListItem[] }>('/merchants/me/stores', { retries: 1 })
      .then((r) => {
        if (active) setStoreList(r.stores);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    const storeQ = selectedStoreId ? `&storeId=${encodeURIComponent(selectedStoreId)}` : '';
    const load = async () => {
      let benchmark: BenchmarkSummary | undefined;
      try {
        benchmark = await api.get<BenchmarkSummary>('/analytics/benchmarks', { retries: 1 });
      } catch {
        /* market card stays hidden */
      }
      if (!active) return;
      const settled = await Promise.allSettled([
        api.get<Funnel>(`/analytics/funnel?from=${WEEK_FROM}&to=${WEEK_TO}${storeQ}`, { retries: 1 }),
        Promise.resolve(benchmark),
        benchmark?.category
          ? api.get<MarketAnalysis>(`/analytics/market?category=${encodeURIComponent(benchmark.category)}`, { retries: 1 })
          : Promise.resolve(undefined),
        api.get<RevenueAnalysis>(`/analytics/revenue?from=${WEEK_FROM}&to=${WEEK_TO}${storeQ}`, { retries: 1 }),
        api.get<ChainStorePerformance[]>(`/chain/analytics?from=${WEEK_FROM}&to=${WEEK_TO}`, { retries: 1 }),
        api.get<ProductPerformance[]>(`/analytics/products?from=${WEEK_FROM}&to=${WEEK_TO}&limit=20${storeQ}`, { retries: 1 }),
        api.get<OrderAnalytics>(`/analytics/order-analytics?from=${WEEK_FROM}&to=${WEEK_TO}${storeQ}`, { retries: 1 }),
        api.get<ForecastPoint[]>(`/analytics/forecast?horizonDays=7${storeQ}`, { retries: 1 }),
      ]);
      if (!active) return;
      setInsights({
        funnel: settled[0].status === 'fulfilled' ? settled[0].value : undefined,
        benchmark: settled[1].status === 'fulfilled' ? settled[1].value : undefined,
        market: settled[2].status === 'fulfilled' ? settled[2].value : undefined,
        revenue: settled[3].status === 'fulfilled' ? settled[3].value : undefined,
        chain: settled[4].status === 'fulfilled' ? settled[4].value : undefined,
        products: settled[5].status === 'fulfilled' ? settled[5].value : undefined,
        orderAnalytics: settled[6].status === 'fulfilled' ? settled[6].value : undefined,
      });
      setForecast({ storeId: selectedStoreId, points: settled[7].status === 'fulfilled' ? settled[7].value : null });
    };
    load();
    return () => {
      active = false;
    };
  }, [selectedStoreId, attempt]);

  /* Re-hydrate the legacy overview/trend/dishes/traffic payloads when the
   * selected store changes (home dashboard consumes the same store). */
  useEffect(() => {
    server.hydrate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedStoreId]);

  /* Contract dashboard live strip — polls while the screen is focused. */
  useFocusEffect(
    useCallback(() => {
      server.hydrateDashboard();
      const timer = setInterval(() => server.hydrateDashboard(), POLL_MS);
      return () => clearInterval(timer);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectedStoreId]),
  );

  const funnelSteps = insights.funnel?.steps ?? [];
  const benchmark = insights.benchmark;
  const forecastPoints = forecast.storeId === selectedStoreId ? forecast.points : null;
  const market = insights.market;
  const revenue = insights.revenue;
  const chain = [...(insights.chain ?? [])].sort((a, b) => b.revenueTZS - a.revenueTZS);
  const orderAnalytics = insights.orderAnalytics;
  const trafficChannels = traffic?.byChannel ?? [];
  const trafficConversion = traffic?.totals.conversionRate ?? 0;
  const donutSources = trafficChannels
    .filter((c) => c.visits > 0)
    .slice(0, 4)
    .map((c, i) => ({ name: t(TRAFFIC_LABELS[c.channel] ?? 'an.chDirect'), value: c.visits, color: DONUT_COLORS[i % DONUT_COLORS.length] }));
  const peakHours = (orderAnalytics?.byHour ?? []).filter((h) => h.count > 0).sort((a, b) => b.count - a.count).slice(0, 5);
  const needsAttention = (() => {
    const list = insights.products ?? [];
    const notSellable = list.filter((p) => p.availabilityRate === 0 && p.unitsSold > 0);
    const slowest = list.filter((p) => p.unitsSold > 0).sort((a, b) => a.unitsSold - b.unitsSold).slice(0, 3);
    const seen = new Set<string>();
    return [...notSellable, ...slowest].filter((p) => (seen.has(p.catalogueItemId) ? false : (seen.add(p.catalogueItemId), true)));
  })();
  const reviewTrend = (server.reviewAnalytics?.trendByDay ?? []).filter((d) => d.count > 0).slice(-14);
  const dashboard = server.dashboard;
  const reviewMaxCount = Math.max(1, ...reviewTrend.map((d) => d.count));

  const openTask = (action: string | undefined) => {
    if (action === 'open-product') router.push('/products');
    else if (action === 'open-campaign') router.push('/marketing');
    else if (action === 'open-review') router.push('/dashboard/reviews');
    else if (action === 'open-settings') router.push('/store');
    else if (action === 'open-orders') router.push('/orders');
  };

  const downloadReport = async () => {
    setExportBusy(true);
    setExportError(null);
    try {
      const report = await api.post<ReportExport>('/analytics/reports/export', {
        reportType: 'revenue',
        from: MONTH_FROM,
        to: WEEK_TO,
      });
      if (Platform.OS === 'web') {
        const a = document.createElement('a');
        a.href = report.downloadUrl;
        a.download = `analytics-export-${MONTH_FROM}-${WEEK_TO}.json`;
        a.click();
      }
      setExported(true);
      setTimeout(() => setExported(false), 2200);
    } catch (e) {
      const err = e as ApiError;
      setExportError(
        err.code === 'ANALYTICS_REPORT_EXCEEDS_LIMIT' || err.code === 'ANALYTICS_EXPORT_NOT_READY' || err.code === 'ANALYTICS_RANGE_INVALID'
          ? err.message
          : t('an.exportFailed'),
      );
      setTimeout(() => setExportError(null), 4200);
    } finally {
      setExportBusy(false);
    }
  };

  return (
    <Screen scroll>
      {storeList.length > 1 ? (
        <>
          <SectionTitle title={t('an.storeSwitcher')} icon="storefront-outline" />
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            <Chip label={t('an.allStores')} selected={selectedStoreId === null} onPress={() => server.setStoreId(null)} />
            {storeList.map((s) => (
              <Chip key={s.id} label={s.name} selected={selectedStoreId === s.id} onPress={() => server.setStoreId(s.id)} />
            ))}
          </View>
        </>
      ) : null}

      <Row style={{ gap: SpacingOpts.md }}>
        <Kpi label={t('an.gmv')} value={tzs(stats.gmv)} delta={gmvDelta} icon="trending-up" />
        <Kpi label={t('an.completed')} value={`${completedCount}`} delta={ordersDelta} icon="receipt" />
        <Kpi label={t('an.aov')} value={tzs(stats.aov)} icon="cart" />
      </Row>

      <SectionTitle title={t('axe.layoutTitle')} icon="people" action={t('dashboard.fullAnalytics')} onAction={() => router.push('/dashboard/analytics-ext')} />

      {pendingTasks.length > 0 ? (
        <>
          <SectionTitle title={t('an.tasks')} icon="checkmark-done-circle" />
          <View style={{ gap: SpacingOpts.md }}>
            {pendingTasks.map((task) => (
              <Pressable key={task.id} onPress={() => (task.action ? openTask(task.action) : undefined)} style={({ pressed }) => [{ opacity: pressed ? 0.85 : 1 }]}>
                <Card style={styles.taskCard}>
                  <View style={[styles.taskBadge, task.priority === 'high' ? styles.taskHigh : task.priority === 'medium' ? styles.taskMed : styles.taskLow]}>
                    <Text style={styles.taskBadgeText}>{task.priority.toUpperCase()}</Text>
                  </View>
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text style={styles.taskTitle}>{task.title}</Text>
                    <Text style={styles.taskSub}>{task.sub}</Text>
                  </View>
                  <Pressable
                    hitSlop={10}
                    onPress={() => completeTask(task.id)}
                    style={[styles.taskCheck, task.done && styles.taskCheckDone]}>
                    {task.done ? <Icon name="checkmark" size={14} color={Colors.white} /> : null}
                  </Pressable>
                </Card>
              </Pressable>
            ))}
          </View>
        </>
      ) : (
        <Card style={styles.allDone}>
          <Icon name="checkmark-circle" size={18} color={Colors.success} />
          <Text style={{ fontSize: FontSize.sm, color: Colors.success, fontWeight: '700' }}>{t('an.tasksClear')}</Text>
        </Card>
      )}

      {dashboard ? (
        <>
          <SectionTitle title={t('an.todayLive')} icon="pulse" />
          <Card style={{ gap: SpacingOpts.md }}>
            <Row style={{ justifyContent: 'space-between', alignItems: 'flex-end' }}>
              <View style={{ gap: 2 }}>
                <Text style={styles.kpiLabel}>{t('an.todayRevenue')}</Text>
                <Text style={{ fontSize: 28, fontWeight: '900', color: Colors.text, fontVariant: ['tabular-nums'] }}>{tzs(dashboard.today.revenueTZS)}</Text>
                {gmvDelta !== 0 ? (
                  <Text style={{ fontSize: FontSize.xs, color: gmvDelta >= 0 ? Colors.success : Colors.danger, fontWeight: '700' }}>
                    {gmvDelta >= 0 ? '▲' : '▼'} {Math.abs(gmvDelta)}% {t('an.vsYesterday')}
                  </Text>
                ) : null}
              </View>
              <View style={{ alignItems: 'flex-end', gap: 2 }}>
                <Text style={styles.kpiLabel}>{t('an.todayOrders')}</Text>
                <Text style={styles.kpiValue}>{dashboard.today.orderCount}</Text>
                {ordersDelta !== 0 ? (
                  <Text style={{ fontSize: FontSize.xs, color: ordersDelta >= 0 ? Colors.success : Colors.danger, fontWeight: '700' }}>
                    {ordersDelta >= 0 ? '▲' : '▼'} {Math.abs(ordersDelta)}% {t('an.vsYesterday')}
                  </Text>
                ) : null}
              </View>
            </Row>
            <Row style={{ justifyContent: 'space-between' }}>
              <Stat label={t('an.dineInToday')} value={`${dashboard.today.dineInCount}`} />
              <Stat label={t('an.groupBuyToday')} value={`${dashboard.today.groupBuyCount}`} />
              <Stat label={t('an.newCustomersToday')} value={`${dashboard.today.newCustomers}`} />
              <Stat label={t('an.aovToday')} value={tzs(dashboard.today.averageOrderValueTZS)} />
            </Row>
            <View style={styles.divider} />
            <Row style={{ justifyContent: 'space-between', alignItems: 'center' }}>
              <Text style={styles.miniHead}>{t('an.live')}</Text>
              <Pill label={t('an.live')} tone="success" />
            </Row>
            <Row style={{ justifyContent: 'space-between' }}>
              <Stat label={t('an.activeOrders')} value={`${dashboard.live.activeOrders}`} />
              <Stat label={t('an.activeTables')} value={`${dashboard.live.activeDineInTables}`} />
              <Stat label={t('an.openAlerts')} value={`${dashboard.live.openAlerts}`} />
            </Row>
          </Card>
        </>
      ) : null}

      <SectionTitle title={t('an.revenue7')} icon="analytics" />
      <Card>
        <LineChart
          data={week.map((d) => ({ label: d.label, value: d.revenue }))}
          height={150}
          color={Colors.info}
          valueSuffix=" TZS"
        />
      </Card>

      <SectionTitle title={t('an.weekday')} icon="calendar" />
      <Card>
        <BarChart data={weekday.map((d) => ({ label: d.label, value: d.revenue }))} height={110} colors={weekdayColors} valueSuffix=" TZS" />
      </Card>

      <SectionTitle title={t('an.traffic')} icon="share-social" />
      <Card style={{ gap: SpacingOpts.md }}>
        <Row style={{ justifyContent: 'space-between' }}>
          <View style={{ gap: 2 }}>
            <Text style={styles.kpiLabel}>{t('an.trafficVisits')}</Text>
            <Text style={styles.kpiValue}>{formatNum(traffic?.totals.visits ?? 0)}</Text>
          </View>
          <View style={{ gap: 2, alignItems: 'flex-end' }}>
            <Text style={styles.kpiLabel}>{t('an.trafficOrders')}</Text>
            <Text style={styles.kpiValue}>{formatNum(traffic?.totals.orders ?? 0)}</Text>
          </View>
          <View style={{ gap: 2, alignItems: 'flex-end' }}>
            <Text style={styles.kpiLabel}>{t('an.conversionRate')}</Text>
            <Text style={styles.kpiValue}>{(trafficConversion * 100).toFixed(1)}%</Text>
          </View>
        </Row>
        {donutSources.length > 0 ? (
          <Donut data={donutSources} centerValue={`${Math.round(trafficConversion * 100)}%`} centerLabel="conversion" />
        ) : null}
        <View style={{ gap: 6 }}>
          <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary, fontWeight: '700' }}>{t('an.channels')}</Text>
          {trafficChannels.filter((c) => c.visits > 0).map((c) => (
            <Row key={c.channel} style={{ justifyContent: 'space-between' }}>
              <Text style={{ fontSize: FontSize.sm, color: Colors.text }}>{t(TRAFFIC_LABELS[c.channel] ?? 'an.chDirect')}</Text>
              <Row gap={8}>
                <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>{formatNum(c.visits)} · {c.orders} {t('an.ordersShort')}</Text>
                <Text style={{ fontSize: FontSize.sm, fontWeight: '700', color: Colors.text, fontVariant: ['tabular-nums'] }}>
                  {(c.conversionRate * 100).toFixed(1)}%
                </Text>
              </Row>
            </Row>
          ))}
        </View>
      </Card>

      {forecastPoints && forecastPoints.length > 0 ? (
        <>
          <SectionTitle title={t('an.forecast')} icon="trending-up" />
          <Card style={{ gap: SpacingOpts.md }}>
            <Text style={{ fontSize: FontSize.xs, color: Colors.textSecondary, lineHeight: 16 }}>{t('an.forecastDesc')}</Text>
            {forecastPoints.map((p) => (
              <View key={p.date} style={{ gap: 5 }}>
                <Row style={{ justifyContent: 'space-between' }}>
                  <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary }}>{p.date}</Text>
                  <Text style={{ fontSize: FontSize.sm, fontWeight: '700', color: Colors.text, fontVariant: ['tabular-nums'] }}>
                    {tzs(p.predictedRevenueTZS)}
                  </Text>
                </Row>
                <Row gap={8} style={{ alignItems: 'center' }}>
                  <View style={[styles.progressTrack, { flex: 1 }]}>
                    <View style={[styles.progressFill, { width: `${Math.min(100, Math.max(0, Math.round(p.confidence * 100)))}%`, backgroundColor: Colors.info }]} />
                  </View>
                  <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary, width: 52, textAlign: 'right' }}>
                    {Math.round(p.confidence * 100)}% {t('an.confidence')}
                  </Text>
                </Row>
              </View>
            ))}
            <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary, lineHeight: 15 }}>{t('an.forecastNote')}</Text>
          </Card>
        </>
      ) : null}

      {benchmark ? (
        <>
          <SectionTitle title={t('an.ranking', { cat: benchmark.category })} icon="trophy" />
          <Card style={{ gap: SpacingOpts.md }}>
            <Row style={{ justifyContent: 'space-between', alignItems: 'flex-end' }}>
              <View>
                <Text style={styles.kpiLabel}>{t('an.score')}</Text>
                <Row gap={8} style={{ alignItems: 'flex-end' }}>
                  <Text style={{ fontSize: 34, fontWeight: '900', color: Colors.text, fontVariant: ['tabular-nums'] }}>{benchmark.merchantScore}</Text>
                  <Text style={{ fontSize: FontSize.sm, color: Colors.success, fontWeight: '700', marginBottom: 6 }}>
                    {t('an.percentile', { n: benchmark.percentileRank })}
                  </Text>
                </Row>
              </View>
              <View style={{ alignItems: 'flex-end', gap: 2 }}>
                <Text style={styles.kpiLabel}>{t('an.industryAvgShort')}</Text>
                <Text style={styles.kpiValue}>{benchmark.industryAverage}</Text>
              </View>
            </Row>
            <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>{t('an.rankByData')}</Text>
            <View style={styles.divider} />
            {benchmark.metrics.map((row) => (
              <View key={row.metric} style={{ gap: 3 }}>
                <Row style={{ justifyContent: 'space-between' }}>
                  <Text style={{ fontSize: FontSize.sm, fontWeight: '700', color: Colors.text }}>{row.metric}</Text>
                  <Pill label={`${row.merchant >= row.average ? '+' : ''}${Math.round(row.merchant - row.average)}`} tone={row.merchant >= row.average ? 'success' : 'danger'} />
                </Row>
                <Row gap={SpacingOpts.lg}>
                  <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>
                    {t('an.store', { n: formatNum(row.merchant) })}
                  </Text>
                  <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>
                    {t('an.industryAvg', { n: formatNum(row.average) })}
                  </Text>
                </Row>
              </View>
            ))}
          </Card>
        </>
      ) : null}

      {market ? (
        <>
          <SectionTitle title={t('an.market')} icon="trending-up-outline" />
          <Card style={{ gap: SpacingOpts.md }}>
            <Row style={{ justifyContent: 'space-between', alignItems: 'center' }}>
              <Row gap={SpacingOpts.lg}>
                <View style={{ gap: 2 }}>
                  <Text style={styles.kpiLabel}>{t('an.demandIndex')}</Text>
                  <Text style={styles.kpiValue}>{market.demandIndex}</Text>
                </View>
                <View style={{ gap: 2 }}>
                  <Text style={styles.kpiLabel}>{t('an.competitors')}</Text>
                  <Text style={styles.kpiValue}>{market.competitorCount}</Text>
                </View>
              </Row>
              <Pill label={t(TREND_META[market.trend].label)} tone={TREND_META[market.trend].tone} />
            </Row>
            <Text style={styles.miniHead}>{t('an.topSearches')}</Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
              {market.topSearches.map((s) => (
                <PillMini key={s} label={s} />
              ))}
            </View>
            <View style={styles.divider} />
            <Row style={{ justifyContent: 'space-between' }}>
              <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary }}>{t('an.priceBand')}</Text>
              <Text style={{ fontSize: FontSize.md, fontWeight: '800', color: Colors.text }}>
                {market.suggestedPriceBandTZS ? `TZS ${formatNum(market.suggestedPriceBandTZS.low)}–${formatNum(market.suggestedPriceBandTZS.high)}` : '—'}
              </Text>
            </Row>
          </Card>
        </>
      ) : null}

      {revenue ? (
        <>
          <SectionTitle title={t('fin.composition')} icon="pie-chart-outline" />
          <Card style={{ gap: SpacingOpts.md }}>
            <Row style={{ justifyContent: 'space-between' }}>
              <Text style={styles.miniHead}>{t('an.channels')}</Text>
              <Text style={{ fontSize: FontSize.md, fontWeight: '800', color: Colors.text }}>{tzs(revenue.totalTZS)}</Text>
            </Row>
            {revenue.byChannel.map((c) => {
              const share = revenue.totalTZS ? Math.round((c.amountTZS / revenue.totalTZS) * 100) : 0;
              return (
                <View key={c.channel} style={{ gap: 5 }}>
                  <Row style={{ justifyContent: 'space-between' }}>
                    <Text style={{ fontSize: FontSize.sm, color: Colors.text }}>{t(REVENUE_LABELS[c.channel] ?? 'an.chDelivery')}</Text>
                    <Row gap={8}>
                      <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>{share}%</Text>
                      <Text style={{ fontSize: FontSize.sm, fontWeight: '700', color: Colors.text, fontVariant: ['tabular-nums'] }}>{tzs(c.amountTZS)}</Text>
                    </Row>
                  </Row>
                  <View style={styles.progressTrack}>
                    <View style={[styles.progressFill, { width: `${Math.min(100, Math.max(0, share))}%`, backgroundColor: Colors.info }]} />
                  </View>
                </View>
              );
            })}
          </Card>
        </>
      ) : null}

      {chain.length > 0 ? (
        <>
          <SectionTitle title={t('an.chainSummary')} icon="storefront-outline" />
          <Card style={{ gap: SpacingOpts.md }}>
            {chain.map((s, i) => (
              <View key={s.storeId} style={{ gap: 6 }}>
                <Row style={{ justifyContent: 'space-between' }}>
                  <Row gap={8} style={{ flex: 1, minWidth: 0 }}>
                    <Text style={[styles.rank, i < 3 && styles.rankTop]}>{i + 1}</Text>
                    <Text style={{ flex: 1, fontSize: FontSize.md, fontWeight: '700', color: Colors.text }} numberOfLines={1}>{s.businessName}</Text>
                  </Row>
                  <Pill label={t(s.isOpen ? 'an.open' : 'an.closed')} tone={s.isOpen ? 'success' : 'neutral'} />
                </Row>
                <Row gap={SpacingOpts.sm} style={{ flexWrap: 'wrap' }}>
                  <Stat label={t('an.revenue')} value={tzs(s.revenueTZS)} />
                  <Stat label={t('an.orders')} value={`${s.orderCount}`} />
                  <Stat label={t('an.rating')} value={s.rating !== null ? s.rating.toFixed(1) : '—'} />
                  <Stat label={t('an.lowStockShort')} value={`${s.lowStockCount}`} />
                </Row>
              </View>
            ))}
          </Card>
        </>
      ) : null}

      {reviewTrend.length > 0 ? (
        <>
          <SectionTitle title={t('an.reviewTrend')} icon="star" />
          <Card style={{ gap: SpacingOpts.md }}>
            <Row style={{ justifyContent: 'space-between' }}>
              <View style={{ gap: 2 }}>
                <Text style={styles.kpiLabel}>{t('an.ratingAverage')}</Text>
                <Text style={styles.kpiValue}>{server.reviewAnalytics?.ratingAverage.toFixed(1) ?? '—'}</Text>
              </View>
              <View style={{ gap: 2, alignItems: 'flex-end' }}>
                <Text style={styles.kpiLabel}>{t('an.reviewCount')}</Text>
                <Text style={styles.kpiValue}>{server.reviewAnalytics?.reviewCount ?? 0}</Text>
              </View>
              <View style={{ gap: 2, alignItems: 'flex-end' }}>
                <Text style={styles.kpiLabel}>{t('an.replyRate')}</Text>
                <Text style={styles.kpiValue}>{server.reviewAnalytics?.replyRate.toFixed(1) ?? '—'}%</Text>
              </View>
            </Row>
            {reviewTrend.map((d) => (
              <View key={d.date} style={{ gap: 4 }}>
                <Row style={{ justifyContent: 'space-between' }}>
                  <Text style={{ fontSize: FontSize.xs, color: Colors.textSecondary }}>{d.date}</Text>
                  <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>
                    {d.count} · ★ {d.avgRating.toFixed(1)}
                  </Text>
                </Row>
                <View style={styles.progressTrack}>
                  <View style={[styles.progressFill, { width: `${(d.count / reviewMaxCount) * 100}%`, backgroundColor: Colors.primary }]} />
                </View>
              </View>
            ))}
          </Card>
        </>
      ) : null}

      <SectionTitle title={t('an.diagnostics')} icon="sparkles" />
      <Card style={{ gap: SpacingOpts.sm }}>
        <Row gap={10} style={{ alignItems: 'flex-start' }}>
          <Icon name="hourglass-outline" size={18} color={Colors.textSecondary} />
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={{ fontSize: FontSize.sm, fontWeight: '700', color: Colors.text }}>{t('an.diagComingSoon')}</Text>
            <Text style={{ fontSize: FontSize.xs, color: Colors.textSecondary, lineHeight: 16 }}>{t('an.diagComingSoonSub')}</Text>
          </View>
        </Row>
      </Card>

      {funnelSteps.length > 0 ? (
        <>
          <SectionTitle title={t('an.funnel')} icon="funnel-outline" />
          <Card style={{ gap: SpacingOpts.md }}>
            {funnelSteps.map((step, i) => {
              const rate = i === 0 ? 100 : Math.round((step.count / Math.max(funnelSteps[i - 1].count, 1)) * 100);
              return (
                <View key={step.name} style={{ gap: 5 }}>
                  <Row style={{ justifyContent: 'space-between' }}>
                    <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary }}>
                      {t(FUNNEL_LABELS[step.name] ?? 'an.orders')} <Text style={{ color: Colors.textTertiary }}>· {rate}%</Text>
                    </Text>
                    <Text style={{ fontSize: FontSize.sm, fontWeight: '700', color: Colors.text, fontVariant: ['tabular-nums'] }}>
                      {step.count.toLocaleString()}
                    </Text>
                  </Row>
                  <View style={styles.progressTrack}>
                    <View style={[styles.progressFill, { width: `${Math.min(100, Math.max(0, rate))}%`, backgroundColor: Colors.info }]} />
                  </View>
                </View>
              );
            })}
          </Card>
        </>
      ) : null}

      <SectionTitle title={t('an.topDishes')} icon="ribbon" />
      <Card style={{ gap: 2, paddingVertical: SpacingOpts.sm }}>
        {dishes.map((d, i) => (
          <Row key={`${d.id}-${d.name}`} style={{ paddingVertical: SpacingOpts.md, gap: SpacingOpts.md }}>
            <Text style={[styles.rank, i < 3 && styles.rankTop]}>{i + 1}</Text>
            <Text style={{ fontSize: 20 }}>{d.emoji || (d.id ? catalogById.get(d.id)?.emoji ?? '' : '')}</Text>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: FontSize.md, fontWeight: '600', color: Colors.text }} numberOfLines={1}>{d.name}</Text>
              <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>
                {t('an.sold', { n: d.sold, pct: Math.round((d.sold / Math.max(totalDishSold, 1)) * 100) })}
              </Text>
            </View>
            <Text style={{ fontSize: FontSize.md, fontWeight: '700', color: Colors.text }}>{tzs(d.revenue)}</Text>
          </Row>
        ))}
      </Card>

      {needsAttention.length > 0 ? (
        <Card style={{ marginTop: SpacingOpts.md, gap: SpacingOpts.sm, paddingVertical: SpacingOpts.sm }}>
          <Row gap={6}>
            <Icon name="alert-circle-outline" size={15} color={Colors.warning} />
            <Text style={{ fontSize: FontSize.sm, fontWeight: '800', color: Colors.text }}>{t('an.needsAttention')}</Text>
          </Row>
          {needsAttention.map((p) => (
            <Row key={p.catalogueItemId} style={{ justifyContent: 'space-between', paddingVertical: 4 }}>
              <Text style={{ flex: 1, paddingRight: 8, fontSize: FontSize.sm, color: Colors.text }} numberOfLines={1}>{p.name}</Text>
              <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary, marginRight: 8 }}>{t('an.soldOnly', { n: p.unitsSold })}</Text>
              {p.availabilityRate === 0 ? <Pill label={t('an.notSellable')} tone="danger" /> : <Pill label={t('an.slow')} tone="warning" />}
            </Row>
          ))}
        </Card>
      ) : null}

      {server.overview ? (
        <Card style={{ marginTop: SpacingOpts.lg, paddingVertical: SpacingOpts.sm }}>
          <Row style={{ justifyContent: 'space-between', paddingVertical: 8 }}>
            <Text style={styles.kpiLabel}>{t('an.repeatRate')}</Text>
            <Text style={styles.kpiValue}>{server.overview.repeatRate}%</Text>
          </Row>
          <Divider />
          <Row style={{ justifyContent: 'space-between', paddingVertical: 8 }}>
            <Text style={styles.kpiLabel}>{t('an.praiseRate')}</Text>
            <Text style={styles.kpiValue}>{server.overview.praiseRate}%</Text>
          </Row>
        </Card>
      ) : null}

      {orderAnalytics ? (
        <>
          <SectionTitle title={t('an.orderAnalytics')} icon="list" />
          <Card style={{ gap: SpacingOpts.md }}>
            <Row style={{ justifyContent: 'space-between' }}>
              <View style={{ gap: 2 }}>
                <Text style={styles.kpiLabel}>{t('an.totalOrders')}</Text>
                <Text style={styles.kpiValue}>{orderAnalytics.totalOrders}</Text>
              </View>
              <View style={{ gap: 2, alignItems: 'flex-end' }}>
                <Text style={styles.kpiLabel}>{t('an.avgOrder')}</Text>
                <Text style={styles.kpiValue}>{tzs(orderAnalytics.avgOrderValueTZS)}</Text>
              </View>
            </Row>
            <Text style={styles.miniHead}>{t('an.peakHours')}</Text>
            {peakHours.map((h) => (
              <Row key={h.hour} style={{ justifyContent: 'space-between', paddingVertical: 2 }}>
                <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary }}>{`${String(h.hour).padStart(2, '0')}:00`}</Text>
                <Text style={{ fontSize: FontSize.sm, fontWeight: '700', color: Colors.text, fontVariant: ['tabular-nums'] }}>{h.count}</Text>
              </Row>
            ))}
            <View style={styles.divider} />
            <Text style={styles.miniHead}>{t('an.priceBands')}</Text>
            {orderAnalytics.byPriceBand.map((b) => (
              <Row key={b.band} style={{ justifyContent: 'space-between', paddingVertical: 2 }}>
                <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary }}>{t('an.tzsBand', { band: b.band })}</Text>
                <Text style={{ fontSize: FontSize.sm, fontWeight: '700', color: Colors.text, fontVariant: ['tabular-nums'] }}>{b.count}</Text>
              </Row>
            ))}
          </Card>
        </>
      ) : null}

      <SectionTitle title={t('an.reports')} icon="download-outline" />
      <Card style={{ gap: SpacingOpts.md }}>
        <Btn label={t('an.download30')} icon="download-outline" loading={exportBusy} onPress={downloadReport} style={{ width: '100%' }} />
        {exported ? (
          <Text style={{ fontSize: FontSize.sm, color: Colors.success, fontWeight: '700' }}>{t('an.reportExported')}</Text>
        ) : exportError ? (
          <Text style={{ fontSize: FontSize.sm, color: Colors.danger, fontWeight: '700' }}>{exportError}</Text>
        ) : (
          <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>{t('an.reportDesc')}</Text>
        )}
      </Card>
      {insights.orderAnalytics === undefined && insights.funnel === undefined ? (
        <Pressable onPress={() => setAttempt((n) => n + 1)} hitSlop={8} accessibilityRole="button" accessibilityLabel={t('common.retry')}>
          <Text style={{ textAlign: 'center', fontSize: FontSize.xs, color: Colors.info, fontWeight: '700', paddingVertical: SpacingOpts.md }}>
            {t('common.retry')}
          </Text>
        </Pressable>
      ) : null}
    </Screen>
  );
}

function PillMini({ label }: { label: string }) {
  return (
    <View style={styles.pill}>
      <Text style={styles.pillText}>{label}</Text>
    </View>
  );
}

interface InsightsState {
  funnel?: Funnel;
  benchmark?: BenchmarkSummary;
  market?: MarketAnalysis;
  revenue?: RevenueAnalysis;
  chain?: ChainStorePerformance[];
  products?: ProductPerformance[];
  orderAnalytics?: OrderAnalytics;
}

function formatNum(n: number): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: 1 });
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ minWidth: 62 }}>
      <Text style={{ fontSize: 10, color: Colors.textTertiary }}>{label}</Text>
      <Text style={{ fontSize: FontSize.sm, fontWeight: '800', color: Colors.text, fontVariant: ['tabular-nums'] }}>{value}</Text>
    </View>
  );
}

const SpacingOpts = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
};

const styles = StyleSheet.create({
  kpiLabel: { fontSize: FontSize.xs, color: Colors.textTertiary },
  kpiValue: { fontSize: FontSize.lg, fontWeight: '800', color: Colors.text },
  rank: {
    width: 22,
    height: 22,
    borderRadius: 6,
    backgroundColor: Colors.surface,
    textAlign: 'center',
    lineHeight: 22,
    fontSize: FontSize.xs,
    fontWeight: '700',
    color: Colors.textTertiary,
  },
  rankTop: { backgroundColor: Colors.primary, color: Colors.text },
  taskCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 14,
  },
  taskBadge: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: Radius.pill,
  },
  taskHigh: { backgroundColor: Colors.dangerSoft },
  taskMed: { backgroundColor: Colors.warningSoft },
  taskLow: { backgroundColor: Colors.surface },
  taskBadgeText: { fontSize: 10, fontWeight: '800', color: Colors.textSecondary, letterSpacing: 0.5 },
  taskTitle: { fontSize: FontSize.sm, fontWeight: '700', color: Colors.text },
  taskSub: { fontSize: FontSize.xs, color: Colors.textTertiary, lineHeight: 15 },
  taskCheck: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 1.5,
    borderColor: Colors.borderStrong,
    alignItems: 'center',
    justifyContent: 'center',
  },
  taskCheckDone: { backgroundColor: Colors.success, borderColor: Colors.success },
  allDone: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 14 },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: Colors.border },
  progressTrack: { height: 6, borderRadius: 3, backgroundColor: Colors.surface, overflow: 'hidden' },
  progressFill: { height: 6, borderRadius: 3 },
  pill: {
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: Radius.pill,
    backgroundColor: Colors.surface,
  },
  pillText: { fontSize: 10, fontWeight: '700', color: Colors.textSecondary },
  miniHead: { fontSize: 10, color: Colors.textTertiary, fontWeight: '700', letterSpacing: 0.6 },
});
