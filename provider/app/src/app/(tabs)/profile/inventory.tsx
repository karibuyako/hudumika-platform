import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, RefreshControl, StyleSheet, Text, View } from 'react-native';

import { ApiError } from '@/api/client';
import { Btn, Empty, ErrorCard, Field, ListRow, Pill, Row, Screen, Segmented, SheetModal } from '@/components/ui';
import { Colors, FontSize, Spacing } from '@/constants/theme';
import { formatTZS, t } from '@/i18n';
import { getInventoryRepository } from '@/repos';
import type { ProviderInventoryItem, ProviderInventoryItemCategory } from '@hudumika/contract';

const CATEGORIES = ['part', 'consumable', 'equipment', 'tool'] as const;
type Category = (typeof CATEGORIES)[number];

const CATEGORY_TONE: Record<ProviderInventoryItemCategory, 'info' | 'warning' | 'neutral' | 'success'> = {
  part: 'info',
  consumable: 'warning',
  equipment: 'neutral',
  tool: 'success',
};

const toNum = (s: string): number | undefined => {
  const v = s.trim();
  if (v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : undefined;
};

export default function InventoryScreen() {
  const [items, setItems] = useState<ProviderInventoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  const [adjusting, setAdjusting] = useState<ProviderInventoryItem | null>(null);
  const [delta, setDelta] = useState('');
  const [reason, setReason] = useState('');
  const [adjustError, setAdjustError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [category, setCategory] = useState<Category>('part');
  const [stock, setStock] = useState('');
  const [threshold, setThreshold] = useState('');
  const [unitCost, setUnitCost] = useState('');
  const [formError, setFormError] = useState('');
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    try {
      setItems(await getInventoryRepository().list());
      setError('');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('misc.error'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const openAdjust = (item: ProviderInventoryItem) => {
    setAdjusting(item);
    setDelta('');
    setReason('');
    setAdjustError('');
  };

  const onAdjust = async () => {
    const d = toNum(delta);
    if (d === undefined || d === 0) {
      setAdjustError(t('misc.error'));
      return;
    }
    if (!adjusting?.id) return;
    setSubmitting(true);
    setAdjustError('');
    try {
      const updated = await getInventoryRepository().adjust(adjusting.id, d, reason.trim());
      setItems((prev) => prev.map((i) => (i.id === updated.id ? updated : i)));
      setAdjusting(null);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'INVENTORY_ADJUSTMENT_REASON_REQUIRED') {
        setAdjustError(t('inventory.reasonRequired'));
      } else if (e instanceof ApiError && e.code === 'INVENTORY_NEGATIVE_STOCK') {
        setAdjustError(t('inventory.reasonRequired'));
      } else {
        setAdjustError(e instanceof ApiError ? e.message : t('misc.error'));
      }
    } finally {
      setSubmitting(false);
    }
  };

  const openAdd = () => {
    setName('');
    setCategory('part');
    setStock('');
    setThreshold('');
    setUnitCost('');
    setFormError('');
    setAdding(true);
  };

  const onCreate = async () => {
    const stockNum = toNum(stock);
    if (!name.trim() || stockNum === undefined || stockNum < 0) {
      setFormError(t('misc.error'));
      return;
    }
    setCreating(true);
    setFormError('');
    try {
      await getInventoryRepository().create({
        name: name.trim(),
        category,
        stockOnHand: stockNum,
        lowStockThreshold: toNum(threshold),
        unitCostTZS: toNum(unitCost) ?? null,
      });
      setAdding(false);
      await load();
    } catch (e) {
      setFormError(e instanceof ApiError ? e.message : t('misc.error'));
    } finally {
      setCreating(false);
    }
  };

  return (
    <Screen>
      <FlatList
        data={items}
        keyExtractor={(i) => i.id ?? i.name}
        contentContainerStyle={styles.list}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Colors.primary} />}
        ListHeaderComponent={
          <View style={styles.header}>
            <Btn label={t('inventory.add')} icon="add" onPress={openAdd} />
          </View>
        }
        ListEmptyComponent={
          loading && !refreshing ? (
            <View style={styles.center}>
              <ActivityIndicator color={Colors.primary} />
            </View>
          ) : error && items.length === 0 ? (
            <ErrorCard message={error} onRetry={load} />
          ) : (
            <Empty icon="cube-outline" title={t('inventory.empty')} />
          )
        }
        renderItem={({ item }) => {
          const low = item.stockOnHand === 0 || (item.lowStockThreshold != null && item.stockOnHand <= item.lowStockThreshold);
          return (
            <View style={styles.rowWrap}>
              <ListRow
                title={item.name}
                sub={formatTZS(item.unitCostTZS ?? 0)}
                onPress={() => openAdjust(item)}
                trailing={
                  <Row gap={6}>
                    {item.stockOnHand === 0 ? (
                      <Pill label={t('inventory.out')} tone="danger" />
                    ) : low ? (
                      <Pill label={t('inventory.low')} tone="warning" />
                    ) : null}
                    {item.category ? <Pill label={t(`inventory.category.${item.category}`)} tone={CATEGORY_TONE[item.category]} /> : null}
                  </Row>
                }
                value={`${item.stockOnHand}`}
              />
            </View>
          );
        }}
      />

      <SheetModal visible={!!adjusting} onClose={() => setAdjusting(null)} title={`${t('inventory.adjust')} · ${adjusting?.name ?? ''}`}>
        <Field
          label={t('inventory.delta')}
          value={delta}
          onChangeText={setDelta}
          keyboardType="numbers-and-punctuation"
          placeholder="-5"
        />
        <Field label={t('inventory.reason')} value={reason} onChangeText={setReason} placeholder={t('inventory.reason')} />
        {adjustError ? <Text style={styles.error}>{adjustError}</Text> : null}
        <Btn label={t('inventory.adjust')} onPress={onAdjust} loading={submitting} icon="swap-vertical" />
      </SheetModal>

      <SheetModal visible={adding} onClose={() => setAdding(false)} title={t('inventory.add')}>
        <Field label={t('inventory.name')} value={name} onChangeText={setName} placeholder="Tap washers 15mm" />
        <Segmented
          options={CATEGORIES.map((c) => ({ key: c, label: t(`inventory.category.${c}`) }))}
          value={category}
          onChange={setCategory}
        />
        <Field label={t('inventory.stock')} value={stock} onChangeText={setStock} keyboardType="number-pad" placeholder="24" />
        <Field label={t('inventory.threshold')} value={threshold} onChangeText={setThreshold} keyboardType="number-pad" hint={t('misc.optional')} />
        <Field label={t('inventory.unitCost')} value={unitCost} onChangeText={setUnitCost} keyboardType="number-pad" hint={t('misc.optional')} />
        {formError ? <Text style={styles.error}>{formError}</Text> : null}
        <Btn label={t('misc.save')} onPress={onCreate} loading={creating} icon="checkmark" />
      </SheetModal>
    </Screen>
  );
}

const styles = StyleSheet.create({
  list: { padding: Spacing.lg, paddingBottom: 120 },
  header: { marginBottom: Spacing.md },
  rowWrap: { marginBottom: Spacing.sm },
  center: { alignItems: 'center', paddingVertical: 80 },
  error: { color: Colors.danger, fontSize: FontSize.sm },
});
