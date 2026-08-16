import { router } from 'expo-router';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { t, onLocaleChange, type I18nKey } from '@/i18n';
import { api } from '@/api/client';
import type { CampaignPerformance, PromotionsAnalytics } from '@/api/types';
import { Btn, Card, Empty, Icon, IconName, ListRow, Pill, Row, Screen, Segmented, SheetModal } from '@/components/ui';
import { Colors, FontSize, Spacing } from '@/constants/theme';
import { dayLabel, tzs } from '@/lib/format';
import { useCampaignStore } from '@/store/campaigns';
import type { CampaignStatus, CampaignType } from '@/types';

const TYPE_META: Record<CampaignType, { icon: IconName; label: I18nKey; tint: string }> = {
  discount: { icon: 'pricetag-outline', label: 'mkt.typeDiscount', tint: Colors.warning },
  coupon: { icon: 'ticket-outline', label: 'mkt.typeCoupon', tint: Colors.info },
  flash: { icon: 'flash-outline', label: 'mkt.typeFlash', tint: 'Colors.violet' },
  full_reduction: { icon: 'layers-outline', label: 'mkt.typeFullReduction', tint: Colors.danger },
  new_customer: { icon: 'person-add-outline', label: 'mkt.typeNewCustomer', tint: Colors.warning },
  free_delivery: { icon: 'bicycle-outline', label: 'mkt.typeFreeDelivery', tint: Colors.success },
  group_buy: { icon: 'people-outline', label: 'mkt.typeGroupBuy', tint: Colors.warning },
  haggle: { icon: 'chatbubble-ellipses-outline', label: 'mkt.typeHaggle', tint: Colors.danger },
  featured: { icon: 'star-outline', label: 'mkt.typeFeatured', tint: Colors.gold },
  ppc: { icon: 'search-outline', label: 'mkt.typePpc', tint: Colors.info },
  brand: { icon: 'diamond-outline', label: 'mkt.typeBrand', tint: 'Colors.violet' },
  instant_discount: { icon: 'pricetag-outline', label: 'mkt.typeInstant', tint: Colors.danger },
};

const STATUS_META: Record<CampaignStatus, { label: I18nKey; tone: 'success' | 'info' | 'neutral' }> = {
  active: { label: 'mkt.active', tone: 'success' },
  scheduled: { label: 'mkt.scheduled', tone: 'info' },
  expired: { label: 'mkt.ended', tone: 'neutral' },
};

type Tab = CampaignStatus | 'all';

export default function MarketingScreen() {
  useSyncExternalStore(onLocaleChange, () => 0);
  const campaigns = useCampaignStore((s) => s.campaigns);
  const stopCampaign = useCampaignStore((s) => s.stopCampaign);
  const hydrate = useCampaignStore((s) => s.hydrate);
  const [tab, setTab] = useState<Tab>('all');
  const [roi, setRoi] = useState<PromotionsAnalytics | null>(null);
  const [roiFailed, setRoiFailed] = useState(false);
  const [roiAttempt, setRoiAttempt] = useState(0);
  const [perfId, setPerfId] = useState<string | null>(null);
  const [perf, setPerf] = useState<CampaignPerformance | null>(null);
  const [perfFailed, setPerfFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .get<PromotionsAnalytics>('/analytics/promotions', { retries: 1 })
      .then((r) => {
        if (!cancelled) {
          setRoi(r);
          setRoiFailed(false);
        }
      })
      .catch(() => {
        if (!cancelled) setRoiFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [roiAttempt]);

  useEffect(() => {
    if (!perfId) return;
    let cancelled = false;
    api
      .get<{ performance: CampaignPerformance }>(`/campaigns/${perfId}/performance`, { retries: 1 })
      .then((r) => {
        if (!cancelled) setPerf(r.performance);
      })
      .catch(() => {
        if (!cancelled) setPerfFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [perfId]);

  const counts = useMemo(() => {
    const c = { active: 0, scheduled: 0, expired: 0 };
    campaigns.forEach((cp) => {
      c[cp.status] += 1;
    });
    return c;
  }, [campaigns]);

  const list = campaigns.filter((c) => (tab === 'all' ? true : c.status === tab));
  const monthSpend = campaigns.reduce((s, c) => s + c.spent, 0);

  const handleStop = async (id: string) => {
    await stopCampaign(id);
    setPerfId(null);
    setPerf(null);
    hydrate();
  };

  return (
    <Screen scroll>
      <Card style={styles.spendCard}>
        <Text style={styles.spendLabel}>{t('mkt.monthSpend')}</Text>
        <Text style={styles.spend}>{tzs(monthSpend)}</Text>
        <Text style={styles.spendSub}>
          {roi ? t('mkt.promotedSub', { roas: roi.roas.toFixed(1) }) : t('mkt.loading')}
        </Text>
      </Card>

      {roiFailed ? (
        <Card style={{ marginTop: Spacing.lg, alignItems: 'center', gap: Spacing.sm }}>
          <Icon name="cloud-offline-outline" size={22} color={Colors.textTertiary} />
          <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '600' }}>{t('mkt.roiErr')}</Text>
          <Btn label={t('common.retry')} size="sm" variant="outline" onPress={() => setRoiAttempt((n) => n + 1)} />
        </Card>
      ) : (
        <Card style={{ marginTop: Spacing.lg, gap: Spacing.md }}>
          <Row style={{ justifyContent: 'space-between', alignItems: 'flex-end' }}>
            <View style={{ gap: 2 }}>
              <Text style={styles.roiLabel}>{t('mkt.roi')}</Text>
              <Text style={styles.roiValue}>{roi ? `${roi.roas.toFixed(1)}x` : '—'}</Text>
            </View>
            <View style={{ alignItems: 'flex-end', gap: 2 }}>
              <Text style={styles.roiSub}>{roi ? t('mkt.spend', { amount: tzs(roi.totalSpend) }) : t('mkt.loading')}</Text>
              <Text style={styles.roiSub}>{roi ? t('mkt.revenue', { amount: tzs(roi.attributedRevenue) }) : ''}</Text>
            </View>
          </Row>
          {roi && roi.perCampaign.length > 0 ? (
            <View>
              {roi.perCampaign.map((p, i) => (
                <View key={p.id}>
                  {i > 0 ? <View style={styles.divider} /> : null}
                  <Row style={{ justifyContent: 'space-between', paddingVertical: 8 }}>
                    <Text style={styles.roiRowTitle} numberOfLines={1}>{p.title}</Text>
                    <Text style={styles.roiRowVal}>{tzs(p.spent)} → {tzs(p.revenue)}</Text>
                  </Row>
                </View>
              ))}
            </View>
          ) : null}
        </Card>
      )}

      <Card style={{ paddingVertical: 0, overflow: 'hidden', marginTop: Spacing.lg }}>
        <ListRow
          icon="people-outline"
          title={t('gb.listTitle')}
          sub={t('gb.listSub')}
          onPress={() => router.push('/marketing/deals')}
        />
      </Card>

      <View style={{ marginTop: Spacing.lg }}>
        <Text style={styles.toolsTitle}>{t('mkg.section')}</Text>
        <Card style={{ paddingVertical: 0, overflow: 'hidden' }}>
          <ListRow
            icon="megaphone-outline"
            title={t('mkg.promotions')}
            sub={t('mkg.promotionsSub')}
            onPress={() => router.push('/marketing/promotions')}
          />
          <ListRow
            icon="ticket-outline"
            title={t('cc.layoutTitle')}
            sub={t('mkg.couponsSub')}
            onPress={() => router.push('/marketing/coupons')}
          />
          <ListRow
            icon="flash-outline"
            title={t('mkg.flashSales')}
            sub={t('mkg.flashSalesSub')}
            onPress={() => router.push('/marketing/flash-sales')}
          />
          <ListRow
            icon="search-outline"
            title={t('mkg.dianjin')}
            sub={t('mkg.dianjinSub')}
            onPress={() => router.push('/marketing/dianjin')}
          />
          <ListRow
            icon="people-outline"
            title={t('mkg.precision')}
            sub={t('mkg.precisionSub')}
            onPress={() => router.push('/marketing/precision')}
          />
          <ListRow
            icon="sparkles-outline"
            title={t('mkg.selfService')}
            sub={t('mkg.selfServiceSub')}
            onPress={() => router.push('/marketing/self-service')}
          />
          <ListRow
            icon="diamond-outline"
            title={t('mkg.brand')}
            sub={t('mkg.brandSub')}
            onPress={() => router.push('/marketing/brand')}
          />
        </Card>
      </View>

      <View style={{ marginTop: Spacing.lg }}>
        <Segmented
          value={tab}
          onChange={setTab}
          options={[
            { key: 'all', label: t('mkt.all') },
            { key: 'active', label: t('mkt.active'), count: counts.active },
            { key: 'scheduled', label: t('mkt.scheduled'), count: counts.scheduled },
            { key: 'expired', label: t('mkt.ended'), count: counts.expired },
          ]}
        />
      </View>

      <View style={{ marginTop: Spacing.lg, gap: Spacing.md }}>
        {list.length === 0 ? <Empty icon="megaphone-outline" title={t('mkt.empty')} sub={t('mkt.emptySub')} /> : null}
        {list.map((c) => {
          const meta = TYPE_META[c.type];
          const status = STATUS_META[c.status];
          const progress = Math.min(1, c.spent / Math.max(c.budget, 1));
          /* Server-computed ROAS only — the client never recomputes attribution
           * (PROMOTIONS.md:182). */
          const serverPerf = roi?.perCampaign.find((p) => p.id === c.id);
          const roas = serverPerf?.roas ?? 0;
          return (
            <Card
              key={c.id}
              onPress={() => {
                setPerf(null);
                setPerfFailed(false);
                setPerfId(c.id);
              }}
              style={{ gap: Spacing.sm }}>
              <Row style={{ justifyContent: 'space-between' }}>
                <Row gap={10} style={{ flex: 1 }}>
                  <View style={[styles.typeIcon, { backgroundColor: `${meta.tint}1A` }]}>
                    <Icon name={meta.icon} size={19} color={meta.tint} />
                  </View>
                  <Text style={styles.cpTitle} numberOfLines={2}>{c.title}</Text>
                </Row>
                <Pill label={t(status.label)} tone={status.tone} />
              </Row>
              <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary, lineHeight: 16 }}>
                {t('mkt.typeLine', { label: t(meta.label), start: dayLabel(c.start), end: dayLabel(c.end), target: c.target })}
              </Text>
              {c.status !== 'expired' ? (
                <View>
                  <View style={styles.progressTrack}>
                    <View style={[styles.progressFill, { width: `${Math.round(progress * 100)}%` }]} />
                  </View>
                  <Row style={{ justifyContent: 'space-between', marginTop: 6 }}>
                    <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>
                      {t('mkt.spentBudget', { a: tzs(c.spent), b: tzs(c.budget) })}
                    </Text>
                    <Row gap={6}>
                      <Pill label={t('mkt.orders', { n: c.attributedOrders ?? 0 })} tone="success" />
                      {roas > 0 ? <Pill label={`ROAS ${roas.toFixed(1)}x`} tone="info" /> : null}
                    </Row>
                  </Row>
                </View>
              ) : (
                <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>
                  {t('mkt.actualSpend', { a: tzs(c.spent) })}
                </Text>
              )}
            </Card>
          );
        })}
      </View>

      <Btn
        label={t('mkt.create')}
        icon="add"
        size="lg"
        onPress={() => router.push('/marketing/builder')}
        style={{ marginTop: Spacing.md }}
      />

      <SheetModal visible={perfId !== null} onClose={() => setPerfId(null)} title={perf ? perf.title : t('mkt.perfTitle')}>
        {perfFailed ? (
          <Text style={{ fontSize: FontSize.sm, color: Colors.textTertiary, textAlign: 'center', paddingVertical: Spacing.md }}>
            {t('mkt.perfErr')}
          </Text>
        ) : !perf ? (
          <Text style={{ fontSize: FontSize.sm, color: Colors.textTertiary, textAlign: 'center', paddingVertical: Spacing.md }}>
            {t('mkt.loading')}
          </Text>
        ) : (
          <View>
            <PerfRow label={t('mkt.perfImpressions')} value={perf.impressions.toLocaleString()} />
            <View style={styles.divider} />
            <PerfRow label={t('mkt.perfClicks')} value={perf.clicks.toLocaleString()} />
            <View style={styles.divider} />
            <PerfRow label={t('mkt.perfCtr')} value={`${(perf.ctr * 100).toFixed(2)}%`} />
            <View style={styles.divider} />
            <PerfRow label={t('mkt.perfOrders')} value={perf.orders.toLocaleString()} />
            <View style={styles.divider} />
            <PerfRow label={t('mkt.perfRevenue')} value={tzs(perf.revenue)} />
            <View style={styles.divider} />
            <PerfRow label={t('mkt.perfSpend')} value={tzs(perf.spent)} />
            <View style={styles.divider} />
            <PerfRow label={t('mkt.perfRoas')} value={`${perf.roas.toFixed(2)}x`} />
          </View>
        )}
        {perf && perf.status !== 'expired' ? (
          <Btn label={t('mkt.stop')} variant="danger" onPress={() => handleStop(perf.id)} />
        ) : null}
      </SheetModal>
    </Screen>
  );
}

function PerfRow({ label, value }: { label: string; value: string }) {
  return (
    <Row style={{ justifyContent: 'space-between', paddingVertical: 10 }}>
      <Text style={{ fontSize: FontSize.sm, color: Colors.textTertiary }}>{label}</Text>
      <Text style={{ fontSize: FontSize.sm, fontWeight: '700', color: Colors.text }}>{value}</Text>
    </Row>
  );
}

const styles = StyleSheet.create({
  toolsTitle: { fontSize: FontSize.xs, color: Colors.textTertiary, fontWeight: '600', marginBottom: Spacing.sm, textTransform: 'uppercase', letterSpacing: 0.6 },
  spendCard: { backgroundColor: Colors.black },
  spendLabel: { color: 'rgba(255,255,255,0.6)', fontSize: FontSize.xs },
  spend: { color: Colors.white, fontSize: 32, fontWeight: '800', marginTop: 6, letterSpacing: 0.5 },
  spendSub: { color: 'rgba(255,255,255,0.45)', fontSize: FontSize.xs, marginTop: 4 },
  roiLabel: { fontSize: FontSize.xs, color: Colors.textTertiary, fontWeight: '600' },
  roiValue: { fontSize: 28, fontWeight: '800', color: Colors.text, letterSpacing: 0.5, marginTop: 2 },
  roiSub: { fontSize: FontSize.xs, color: Colors.textTertiary },
  roiRowTitle: { fontSize: FontSize.xs, color: Colors.textSecondary, flex: 1, paddingRight: Spacing.md },
  roiRowVal: { fontSize: FontSize.xs, fontWeight: '600', color: Colors.text },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: Colors.border },
  typeIcon: {
    width: 38,
    height: 38,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cpTitle: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text, flex: 1 },
  progressTrack: {
    height: 6,
    borderRadius: 3,
    backgroundColor: Colors.surface,
    overflow: 'hidden',
  },
  progressFill: { height: 6, borderRadius: 3, backgroundColor: Colors.primary },
});