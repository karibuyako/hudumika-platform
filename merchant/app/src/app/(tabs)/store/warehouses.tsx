import { Stack, router, useLocalSearchParams } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Btn, Card, Chip, Empty, Field, Icon, Pill, Row, Screen, SheetModal } from '@/components/ui';
import { Colors, FontSize, Radius, Spacing } from '@/constants/theme';
import { t, onLocaleChange, type I18nKey } from '@/i18n';
import type { Warehouse, WarehouseStatus } from '@/api/types';
import { useSupplyChainStore } from '@/store/supply-chain';
import { useCatalogStore } from '@/store/catalog';
import { useMessageStore } from '@/store/messages';

const STATUS_PILL: Record<WarehouseStatus, { label: I18nKey; tone: 'success' | 'warning' | 'danger' }> = {
  active: { label: 'sc.whStatusActive', tone: 'success' },
  full: { label: 'sc.whStatusFull', tone: 'warning' },
  maintenance: { label: 'sc.whStatusMaintenance', tone: 'danger' },
};

const STATUS_ORDER: WarehouseStatus[] = ['active', 'full', 'maintenance'];

export default function WarehousesScreen() {
  useSyncExternalStore(onLocaleChange, () => 0);
  const params = useLocalSearchParams<{ prefill?: string }>();
  const warehouses = useSupplyChainStore((s) => s.warehouses);
  const products = useCatalogStore((s) => s.products);
  const hydrate = useSupplyChainStore((s) => s.hydrateWarehouses);
  const addWarehouse = useSupplyChainStore((s) => s.addWarehouse);
  const updateWarehouse = useSupplyChainStore((s) => s.updateWarehouse);
  const setWarehouseStock = useSupplyChainStore((s) => s.setWarehouseStock);
  const fulfillFromWarehouse = useSupplyChainStore((s) => s.fulfillFromWarehouse);
  const pushMessage = useMessageStore((s) => s.push);

  const [sheet, setSheet] = useState<null | 'add' | 'edit' | 'stock' | 'fulfill'>(null);
  const [target, setTarget] = useState<Warehouse | null>(null);
  const [name, setName] = useState('');
  const [city, setCity] = useState('');
  const [address, setAddress] = useState('');
  const [serving, setServing] = useState('');
  const [status, setStatus] = useState<WarehouseStatus>('active');
  const [deltas, setDeltas] = useState<Record<string, string>>({});
  const [deltaReason, setDeltaReason] = useState('');
  const [orderId, setOrderId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    hydrate().catch(() => undefined);
  }, [hydrate]);

  /* A10: navigating from a warehouse.stock_low alert pre-fills the item in
   * the Send-inventory sheet (deferred like store/index.tsx param loads so
   * the effect never setState synchronously). */
  useEffect(() => {
    if (!params.prefill || !warehouses.loaded) return;
    const w = warehouses.rows[0];
    if (!w) return;
    setTimeout(() => {
      const next: Record<string, string> = {};
      for (const s of w.stock) next[s.catalogueItemId] = '0';
      next[params.prefill!] = '1';
      setTarget(w);
      setDeltas(next);
      setDeltaReason('');
      setError('');
      setSheet('stock');
    }, 0);
  }, [params.prefill, warehouses.loaded, warehouses.rows]);

  const resetForm = () => {
    setName('');
    setCity('');
    setAddress('');
    setServing('');
    setStatus('active');
    setError('');
  };

  const openAdd = () => {
    resetForm();
    setSheet('add');
  };

  const openEdit = (w: Warehouse) => {
    setTarget(w);
    setName(w.name);
    setCity(w.cityId);
    setAddress(w.address ?? '');
    setServing(w.servingCities.join(', '));
    setStatus(w.status);
    setError('');
    setSheet('edit');
  };

  const openStock = (w: Warehouse, prefillId?: string) => {
    setTarget(w);
    const next: Record<string, string> = {};
    for (const s of w.stock) next[s.catalogueItemId] = '0';
    if (prefillId) next[prefillId] = '1';
    setDeltas(next);
    setDeltaReason('');
    setError('');
    setSheet('stock');
  };

  const save = async () => {
    if (!name.trim() || !city.trim()) return;
    setBusy(true);
    setError('');
    const input = {
      name: name.trim(),
      cityId: city.trim(),
      address: address.trim() || undefined,
      servingCities: serving.split(',').map((c) => c.trim()).filter(Boolean),
      status,
    };
    const res = target ? await updateWarehouse(target.id, input) : await addWarehouse(input);
    setBusy(false);
    if (res.ok) {
      setSheet(null);
      setTarget(null);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      pushMessage({ type: 'system', title: target ? t('sc.supplierSaved') : t('sc.supplierAdded'), body: input.name });
    } else {
      setError(res.message ?? t('sc.errWh'));
    }
  };

  const setDelta = (catalogueItemId: string, v: string) => {
    setDeltas((prev) => ({ ...prev, [catalogueItemId]: v }));
  };

  const applyStock = async () => {
    if (!target) return;
    const items = Object.entries(deltas)
      .map(([catalogueItemId, v]) => ({ catalogueItemId, delta: Number(v) }))
      .filter((l) => Number.isInteger(l.delta) && l.delta !== 0);
    if (items.length === 0) return;
    /* ISC L154-156 — negative deltas (write-off/return) require a reason. */
    if (items.some((l) => l.delta < 0) && !deltaReason.trim()) {
      setError(t('sc.whReasonRequired'));
      return;
    }
    setBusy(true);
    setError('');
    const body = items.some((l) => l.delta < 0) ? { items, reason: deltaReason.trim() } : { items };
    const res = await setWarehouseStock(target.id, body);
    setBusy(false);
    if (res.ok) {
      setSheet(null);
      setTarget(null);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      pushMessage({ type: 'system', title: t('sc.whStockUpdated'), body: target.name });
    } else {
      setError(res.message ?? t('sc.errWh'));
    }
  };

  const fulfill = async () => {
    if (!target || !orderId.trim()) return;
    setBusy(true);
    setError('');
    const res = await fulfillFromWarehouse(target.id, orderId.trim());
    setBusy(false);
    if (res.ok) {
      setSheet(null);
      setTarget(null);
      setOrderId('');
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      pushMessage({ type: 'system', title: t('sc.whFulfilled'), body: orderId.trim() });
    } else {
      setError(res.message ?? t('sc.errWh'));
    }
  };

  const productName = (id: string) => products.find((p) => p.id === id)?.name ?? id;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: Colors.bg }} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.topBar}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Icon name="chevron-back" size={26} color={Colors.text} />
        </Pressable>
        <Text style={styles.topTitle}>{t('sc.whTitle')}</Text>
        <Btn label={t('common.add')} icon="add" size="sm" onPress={openAdd} />
      </View>

      <Screen scroll>
        <Row style={{ marginTop: Spacing.md }}>
          <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary, flex: 1 }}>{t('sc.whSub')}</Text>
        </Row>

        {warehouses.error ? (
          <View style={{ alignItems: 'center', gap: Spacing.sm, paddingVertical: Spacing.lg }}>
            <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '600' }}>{warehouses.error}</Text>
            <Btn label={t('common.retry')} size="sm" variant="outline" onPress={() => hydrate()} />
          </View>
        ) : null}

        <View style={{ gap: Spacing.md, marginTop: Spacing.md }}>
          {warehouses.rows.length === 0 && !warehouses.error ? <Empty icon="business-outline" title={t('sc.whEmpty')} sub={t('sc.whEmptySub')} /> : null}
          {warehouses.rows.map((w) => (
            <Card key={w.id} style={{ gap: Spacing.sm }}>
              <Pressable
                onPress={() => router.push(`/store/warehouse-detail?id=${encodeURIComponent(w.id)}` as never)}
                accessibilityRole="button"
                accessibilityLabel={w.name}>
                <Row style={{ justifyContent: 'space-between' }}>
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text style={styles.name} numberOfLines={1}>{w.name}</Text>
                    <Text style={styles.meta}>{w.cityId}{w.address ? ` · ${w.address}` : ''}</Text>
                    <Text style={styles.meta}>
                      {t('sc.whServingCount', { n: w.servingCities.length })} · {t('sc.whUnits', { n: w.totalUnits ?? 0 })}
                    </Text>
                  </View>
                  <Pill label={t(STATUS_PILL[w.status].label)} tone={STATUS_PILL[w.status].tone} />
                </Row>
              </Pressable>
              {w.status === 'full' ? (
                <Text style={{ fontSize: FontSize.xs, color: Colors.warning, lineHeight: 16 }}>{t('sc.whFullWarning')}</Text>
              ) : null}
              <Row gap={Spacing.sm} style={{ flexWrap: 'wrap' }}>
                <Btn label={t('common.edit')} variant="outline" size="sm" onPress={() => openEdit(w)} />
                <Btn label={t('sc.whSendStock')} variant="outline" size="sm" onPress={() => openStock(w)} />
                <Btn
                  label={t('sc.whFulfill')}
                  variant="outline"
                  size="sm"
                  onPress={() => {
                    setTarget(w);
                    setOrderId('');
                    setError('');
                    setSheet('fulfill');
                  }}
                />
              </Row>
              {w.stock.length ? (
                <View style={{ gap: 2 }}>
                  {w.stock.slice(0, 4).map((s) => (
                    <Text key={s.catalogueItemId} style={styles.meta} numberOfLines={1}>
                      · {productName(s.catalogueItemId)} × {s.quantity}
                    </Text>
                  ))}
                </View>
              ) : null}
            </Card>
          ))}
        </View>
      </Screen>

      <SheetModal
        visible={sheet === 'add' || sheet === 'edit'}
        onClose={() => setSheet(null)}
        title={sheet === 'edit' ? t('sc.editWarehouse') : t('sc.addWarehouse')}>
        <View style={{ gap: Spacing.md }}>
          <Field label={t('sc.whName')} value={name} onChangeText={setName} placeholder={t('sc.whNamePh')} maxLength={120} />
          <Field label={t('sc.whCity')} value={city} onChangeText={setCity} placeholder="city_dar" />
          <Field label={t('sc.whAddress')} value={address} onChangeText={setAddress} maxLength={300} />
          <Field label={t('sc.whServing')} value={serving} onChangeText={setServing} placeholder="city_dar, city_dodoma" />
          <Text style={styles.fieldLabel}>{t('sc.whStatusActive')}</Text>
          <Row gap={8} style={{ flexWrap: 'wrap' }}>
            {STATUS_ORDER.map((st) => (
              <Chip key={st} label={t(STATUS_PILL[st].label)} selected={status === st} onPress={() => setStatus(st)} />
            ))}
          </Row>
          {error ? <Text style={{ color: Colors.danger, fontSize: FontSize.xs }}>{error}</Text> : null}
          <Btn label={t('common.save')} size="lg" loading={busy} disabled={!name.trim() || !city.trim()} onPress={save} />
        </View>
      </SheetModal>

      <SheetModal visible={sheet === 'stock'} onClose={() => setSheet(null)} title={t('sc.whSendStockTitle')}>
        {target ? (
          <View style={{ gap: Spacing.md }}>
            <Text style={styles.meta}>{target.name} — {t('sc.whDelta')}</Text>
            {products.map((p) => {
              const current = target.stock.find((s) => s.catalogueItemId === p.id)?.quantity ?? 0;
              const value = deltas[p.id] ?? '0';
              return (
                <Row key={p.id} style={{ justifyContent: 'space-between' }}>
                  <View style={{ flex: 1, gap: 1 }}>
                    <Text style={styles.lineName} numberOfLines={1}>{p.name}</Text>
                    <Text style={styles.meta}>{t('sc.stockOnHand')} {current}</Text>
                  </View>
                  <View style={styles.deltaBox}>
                    <Pressable onPress={() => setDelta(p.id, String(Number(value) - 1))} style={styles.stepBtn} hitSlop={6}>
                      <Text style={styles.stepText}>−</Text>
                    </Pressable>
                    <Text style={styles.stepValue}>{value}</Text>
                    <Pressable onPress={() => setDelta(p.id, String(Number(value) + 1))} style={styles.stepBtn} hitSlop={6}>
                      <Text style={styles.stepText}>+</Text>
                    </Pressable>
                  </View>
                </Row>
              );
            })}
            {Object.values(deltas).some((v) => Number(v) < 0) ? (
              <Field label={t('sc.whReasonLabel')} value={deltaReason} onChangeText={setDeltaReason} placeholder={t('sc.whReasonPh')} maxLength={500} multiline />
            ) : null}
            {error ? <Text style={{ color: Colors.danger, fontSize: FontSize.xs }}>{error}</Text> : null}
            <Btn
              label={t('sc.whSendStock')}
              size="lg"
              loading={busy}
              disabled={!Object.values(deltas).some((v) => Number(v) !== 0) || (Object.values(deltas).some((v) => Number(v) < 0) && !deltaReason.trim())}
              onPress={applyStock}
            />
          </View>
        ) : null}
      </SheetModal>

      <SheetModal visible={sheet === 'fulfill'} onClose={() => setSheet(null)} title={t('sc.whFulfill')}>
        {target ? (
          <View style={{ gap: Spacing.md }}>
            <Text style={styles.meta}>{target.name}</Text>
            <Field label={t('sc.whFulfillOrderId')} value={orderId} onChangeText={setOrderId} placeholder="o_seed_0" />
            {error ? <Text style={{ color: Colors.danger, fontSize: FontSize.xs }}>{error}</Text> : null}
            <Btn label={t('sc.whFulfill')} size="lg" loading={busy} disabled={!orderId.trim()} onPress={fulfill} />
          </View>
        ) : null}
      </SheetModal>
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
  name: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text, flexShrink: 1 },
  meta: { fontSize: FontSize.xs, color: Colors.textTertiary },
  fieldLabel: { fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '600' },
  lineName: { fontSize: FontSize.sm, color: Colors.text, flex: 1 },
  deltaBox: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  stepBtn: {
    width: 30,
    height: 30,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.borderStrong,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.card,
  },
  stepText: { fontSize: 16, color: Colors.text },
  stepValue: { fontSize: FontSize.md, fontWeight: '800', color: Colors.text, minWidth: 28, textAlign: 'center' },
});
