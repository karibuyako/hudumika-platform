import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Btn, Card, Chip, Empty, Icon, Pill, Row, Screen } from '@/components/ui';
import { Colors, FontSize, Spacing } from '@/constants/theme';
import { t, onLocaleChange, type I18nKey } from '@/i18n';
import type { WarehouseStatus } from '@/api/types';
import { useSupplyChainStore } from '@/store/supply-chain';

const STATUS_PILL: Record<WarehouseStatus, { label: I18nKey; tone: 'success' | 'warning' | 'danger' }> = {
  active: { label: 'sc.whStatusActive', tone: 'success' },
  full: { label: 'sc.whStatusFull', tone: 'warning' },
  maintenance: { label: 'sc.whStatusMaintenance', tone: 'danger' },
};

export default function WarehouseDetailScreen() {
  useSyncExternalStore(onLocaleChange, () => 0);
  const params = useLocalSearchParams<{ id?: string }>();
  const warehouseDetail = useSupplyChainStore((s) => s.warehouseDetail);
  const fetchWarehouse = useSupplyChainStore((s) => s.fetchWarehouse);
  const inventory = useSupplyChainStore((s) => s.inventory);
  const hydrateInventory = useSupplyChainStore((s) => s.hydrateInventory);

  const [error, setError] = useState('');
  const [tab, setTab] = useState<'stock' | 'info'>('stock');

  const id = params.id ?? '';

  const load = useCallback(async () => {
    const w = await fetchWarehouse(id);
    if (!w) setError(t('sc.errWhDetail'));
    else setError('');
    hydrateInventory().catch(() => undefined);
  }, [id, fetchWarehouse, hydrateInventory]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async fetch; setError runs in the await continuation
    if (id) load();
  }, [id, load]);

  const thresholds = useMemo(() => {
    const map = new Map<string, number>();
    for (const item of inventory.rows) map.set(item.catalogueItemId, item.lowStockThreshold);
    return map;
  }, [inventory.rows]);

  const w = warehouseDetail?.id === id ? warehouseDetail : null;
  const lowCount = w ? w.stock.filter((s) => s.quantity <= (thresholds.get(s.catalogueItemId) ?? 10)).length : 0;

  const openStock = (catalogueItemId?: string) => {
    router.push({ pathname: '/store/warehouses', params: catalogueItemId ? { prefill: catalogueItemId } : {} });
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: Colors.bg }} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.topBar}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Icon name="chevron-back" size={26} color={Colors.text} />
        </Pressable>
        <Text style={styles.topTitle} numberOfLines={1}>{w?.name ?? t('sc.whTitle')}</Text>
        <View style={{ width: 26 }} />
      </View>

      <Screen scroll>
        {error ? (
          <View style={{ alignItems: 'center', gap: Spacing.sm, paddingVertical: Spacing.lg }}>
            <Empty icon="business-outline" title={t('sc.whDetailMissing')} sub={error} />
            <Btn label={t('common.retry')} size="sm" variant="outline" onPress={() => load()} />
          </View>
        ) : null}

        {w ? (
          <>
            <Card style={{ gap: Spacing.sm, marginTop: Spacing.md }}>
              <Row style={{ justifyContent: 'space-between' }}>
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={styles.name}>{w.name}</Text>
                  <Text style={styles.meta}>{w.cityId}{w.address ? ` · ${w.address}` : ''}</Text>
                  <Text style={styles.meta}>
                    {t('sc.whServingCount', { n: w.servingCities.length })} · {t('sc.whUnits', { n: w.totalUnits ?? 0 })}
                  </Text>
                </View>
                <Pill label={t(STATUS_PILL[w.status].label)} tone={STATUS_PILL[w.status].tone} />
              </Row>
              {w.status === 'full' ? (
                <Text style={{ fontSize: FontSize.xs, color: Colors.warning, lineHeight: 16 }}>
                  {t('sc.whFullWarning')}
                </Text>
              ) : null}
              <Row gap={8} style={{ flexWrap: 'wrap' }}>
                {(['active', 'full', 'maintenance'] as WarehouseStatus[]).map((st) => (
                  <Chip key={st} label={t(STATUS_PILL[st].label)} selected={w.status === st} onPress={() => undefined} />
                ))}
              </Row>
              <Row gap={Spacing.sm}>
                <Btn label={t('sc.whSendStock')} size="sm" onPress={() => openStock()} />
              </Row>
            </Card>

            <Row gap={6} style={{ marginTop: Spacing.md, marginBottom: Spacing.sm }}>
              {(
                [
                  { key: 'stock', label: t('sc.whStock'), count: w.stock.length },
                  { key: 'info', label: t('sc.whInfo'), count: lowCount },
                ] as { key: 'stock' | 'info'; label: string; count: number }[]
              ).map((seg) => (
                <Pressable
                  key={seg.key}
                  onPress={() => setTab(seg.key)}
                  accessibilityRole="button"
                  accessibilityLabel={seg.label}
                  accessibilityState={{ selected: tab === seg.key }}
                  style={[styles.seg, tab === seg.key && styles.segActive]}>
                  <Text style={[styles.segText, tab === seg.key && { color: Colors.primaryDeep, fontWeight: '800' }]}>
                    {seg.label} {seg.count}
                  </Text>
                </Pressable>
              ))}
            </Row>

            {tab === 'stock' ? (
              <View style={{ gap: 2, paddingBottom: 24 }}>
                {w.stock.length === 0 ? <Empty icon="cube-outline" title={t('sc.whNoStock')} sub={t('sc.whNoStockSub')} /> : null}
                {[...w.stock].sort((a, b) => a.catalogueItemId.localeCompare(b.catalogueItemId)).map((s) => {
                  const item = inventory.rows.find((i) => i.catalogueItemId === s.catalogueItemId);
                  const threshold = thresholds.get(s.catalogueItemId) ?? 10;
                  const low = s.quantity <= threshold;
                  return (
                    <Row key={s.catalogueItemId} style={styles.stockRow}>
                      <View style={{ flex: 1, gap: 1 }}>
                        <Text style={styles.lineName} numberOfLines={1}>{item?.name ?? s.catalogueItemId}</Text>
                        <Text style={styles.meta}>{t('sc.whQty', { n: s.quantity })} · {t('sc.whThreshold', { n: threshold })}</Text>
                      </View>
                      {low ? <Pill label={t('sc.lowStock').toUpperCase()} tone="warning" /> : null}
                    </Row>
                  );
                })}
              </View>
            ) : (
              <View style={{ gap: Spacing.sm, paddingBottom: 24 }}>
                <Text style={styles.meta}>{t('sc.whStockLowInfo')}</Text>
                <Btn
                  label={t('sc.whSendStock')}
                  variant="outline"
                  size="sm"
                  onPress={() => openStock()}
                />
              </View>
            )}
          </>
        ) : null}
      </Screen>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.sm,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    backgroundColor: Colors.card,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.border,
  },
  topTitle: { fontSize: FontSize.lg, fontWeight: '800', color: Colors.text, flex: 1 },
  name: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text },
  meta: { fontSize: FontSize.xs, color: Colors.textTertiary, lineHeight: 16 },
  lineName: { fontSize: FontSize.sm, color: Colors.text, flexShrink: 1 },
  stockRow: {
    justifyContent: 'space-between',
    gap: Spacing.sm,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.border,
  },
  seg: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: Colors.borderStrong,
    backgroundColor: Colors.card,
  },
  segActive: { backgroundColor: Colors.primarySoft, borderColor: Colors.primaryDark },
  segText: { fontSize: FontSize.xs, color: Colors.textSecondary, fontWeight: '600' },
});
