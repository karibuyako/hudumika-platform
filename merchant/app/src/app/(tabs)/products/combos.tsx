import * as Haptics from 'expo-haptics';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';

import type { Combo, ComboLine } from '@/api/types';
import { Btn, Card, Empty, Icon, Pill, Row, Screen, SheetModal, Field } from '@/components/ui';
import { Colors, FontSize, Radius, Spacing } from '@/constants/theme';
import { t, onLocaleChange } from '@/i18n';
import { tzs } from '@/lib/format';
import { useCatalogueExtStore, type ComboInput } from '@/store/catalogue-ext';
import { useCatalogStore } from '@/store/catalog';

type Sheet = null | 'create' | 'edit' | 'delete';

export default function CombosScreen() {
  useSyncExternalStore(onLocaleChange, () => 0);
  const combos = useCatalogueExtStore((s) => s.combos);
  const hydrate = useCatalogueExtStore((s) => s.hydrate);
  const createCombo = useCatalogueExtStore((s) => s.createCombo);
  const updateCombo = useCatalogueExtStore((s) => s.updateCombo);
  const deleteCombo = useCatalogueExtStore((s) => s.deleteCombo);
  const products = useCatalogStore((s) => s.products);
  const hydrateProducts = useCatalogStore((s) => s.hydrate);

  const [sheet, setSheet] = useState<Sheet>(null);
  const [target, setTarget] = useState<Combo | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  const [picked, setPicked] = useState<Record<string, number>>({});
  const [err, setErr] = useState('');

  useEffect(() => {
    hydrate();
    hydrateProducts();
  }, [hydrate, hydrateProducts]);

  const onRefresh = async () => {
    setRefreshing(true);
    await hydrate();
    setRefreshing(false);
  };

  const openCreate = () => {
    setTarget(null);
    setName('');
    setPrice('');
    setPicked({});
    setErr('');
    setSheet('create');
  };

  const openEdit = (combo: Combo) => {
    setTarget(combo);
    setName(combo.name);
    setPrice(combo.priceTZS !== undefined ? String(combo.priceTZS) : '');
    const p: Record<string, number> = {};
    for (const it of combo.items) p[it.catalogueItemId] = it.quantity;
    setPicked(p);
    setErr('');
    setSheet('edit');
  };

  const toggleItem = (itemId: string) => {
    setPicked((prev) => {
      const next = { ...prev };
      if (next[itemId]) delete next[itemId];
      else next[itemId] = 1;
      return next;
    });
  };

  const bumpQty = (itemId: string, delta: number) => {
    setPicked((prev) => {
      const cur = prev[itemId] ?? 0;
      const next = cur + delta;
      if (next <= 0) {
        const copy = { ...prev };
        delete copy[itemId];
        return copy;
      }
      return { ...prev, [itemId]: next };
    });
  };

  const save = async () => {
    const items: ComboLine[] = Object.entries(picked).map(([catalogueItemId, quantity]) => ({ catalogueItemId, quantity }));
    if (!name.trim()) {
      setErr(t('ce.errName'));
      return;
    }
    if (items.length === 0) {
      setErr(t('ce.errItems'));
      return;
    }
    const priceTZS = price.trim() === '' ? undefined : Number(price);
    if (price.trim() !== '' && (!Number.isInteger(priceTZS) || (priceTZS ?? 0) < 0)) {
      setErr(t('ce.errPrice'));
      return;
    }
    const input: ComboInput = { name: name.trim(), items, priceTZS, available: target?.available ?? true };
    if (target) {
      const updated = await updateCombo(target.id, { ...input, description: target.description, imageUrl: target.imageUrl ?? null });
      if (updated) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        setSheet(null);
      } else setErr(t('ce.errSave'));
    } else {
      const created = await createCombo(input);
      if (created) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        setSheet(null);
      } else setErr(t('ce.errSave'));
    }
  };

  const confirmDelete = async () => {
    if (!target) return;
    const ok = await deleteCombo(target.id);
    if (ok) Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setSheet(null);
  };

  const productName = (id: string) => products.find((p) => p.id === id)?.name ?? id;

  const itemSummary = (combo: Combo) =>
    combo.items.map((it) => `${it.quantity}× ${productName(it.catalogueItemId)}`).join(' · ');

  const pickable = useMemo(
    () => products.filter((p) => !p.deleted && p.visible).sort((a, b) => a.sort - b.sort),
    [products],
  );

  return (
    <Screen>
      <FlatList
        data={combos}
        keyExtractor={(c) => c.id}
        contentContainerStyle={{ padding: Spacing.md, gap: 10, paddingBottom: 24 }}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Colors.primary} />}
        ListEmptyComponent={<Empty icon="restaurant-outline" title={t('ce.combosEmpty')} sub={t('ce.combosEmptySub')} />}
        renderItem={({ item }) => (
          <Card>
            <Row style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <Text style={{ flex: 1, fontSize: FontSize.md, fontWeight: '700', color: Colors.text }}>{item.name}</Text>
              {item.available ? <Pill label={t('ce.available')} tone="success" /> : <Pill label={t('ce.unavailable')} tone="neutral" />}
            </Row>
            {item.description ? (
              <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary, marginTop: 4 }}>{item.description}</Text>
            ) : null}
            <Text style={{ fontSize: FontSize.sm, color: Colors.textTertiary, marginTop: 4 }} numberOfLines={2}>
              {itemSummary(item)}
            </Text>
            <Row style={{ justifyContent: 'space-between', alignItems: 'center', marginTop: 8 }}>
              <Text style={{ fontSize: FontSize.md, fontWeight: '800', color: Colors.primaryDeep }}>{tzs(item.priceTZS ?? 0)}</Text>
              <Row gap={Spacing.sm}>
                <Btn label={t('common.edit')} size="sm" variant="subtle" onPress={() => openEdit(item)} />
                <Btn label={t('common.delete')} size="sm" variant="danger" onPress={() => { setTarget(item); setErr(''); setSheet('delete'); }} />
              </Row>
            </Row>
          </Card>
        )}
      />

      <View style={styles.footer}>
        <Btn label={t('ce.addCombo')} size="lg" icon="add" onPress={openCreate} />
      </View>

      <SheetModal visible={sheet === 'create' || sheet === 'edit'} onClose={() => setSheet(null)} title={target ? t('ce.editCombo') : t('ce.addCombo')}>
        <View style={{ gap: Spacing.md }}>
          <Field label={t('ce.name')} value={name} onChangeText={setName} placeholder={t('ce.namePh')} maxLength={160} />
          <Field label={t('ce.price')} value={price} onChangeText={setPrice} placeholder={t('ce.pricePh')} keyboardType="number-pad" />
          <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '600' }}>{t('ce.items')}</Text>
          <View style={{ maxHeight: 320 }}>
            <FlatList
              data={pickable}
              keyExtractor={(p) => p.id}
              contentContainerStyle={{ gap: 6 }}
              showsVerticalScrollIndicator={false}
              renderItem={({ item }) => {
                const qty = picked[item.id];
                return (
                  <Pressable
                    onPress={() => toggleItem(item.id)}
                    accessibilityRole="button"
                    accessibilityLabel={item.name}
                    style={({ pressed }) => [
                      styles.itemRow,
                      qty !== undefined && { borderColor: Colors.primary },
                      pressed && { opacity: 0.8 },
                    ]}>
                    <View style={styles.itemEmoji}>
                      <Text style={{ fontSize: 18 }}>{item.emoji}</Text>
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={{ fontSize: FontSize.sm, color: Colors.text, fontWeight: '600' }} numberOfLines={1}>{item.name}</Text>
                      <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>{tzs(item.price)}</Text>
                    </View>
                    {qty !== undefined ? (
                      <Row gap={8} style={{ alignItems: 'center' }}>
                        <Pressable onPress={() => bumpQty(item.id, -1)} accessibilityRole="button" accessibilityLabel={t('ce.qtyMinus')} style={styles.qtyBtn}>
                          <Text style={styles.qtyBtnText}>−</Text>
                        </Pressable>
                        <Text style={{ fontSize: FontSize.sm, fontWeight: '700', color: Colors.text }}>{qty}</Text>
                        <Pressable onPress={() => bumpQty(item.id, 1)} accessibilityRole="button" accessibilityLabel={t('ce.qtyPlus')} style={styles.qtyBtn}>
                          <Text style={styles.qtyBtnText}>+</Text>
                        </Pressable>
                      </Row>
                    ) : (
                      <Icon name="add-circle-outline" size={20} color={Colors.textTertiary} />
                    )}
                  </Pressable>
                );
              }}
            />
          </View>
          {err ? <Text style={{ fontSize: FontSize.sm, color: Colors.danger }}>{err}</Text> : null}
          <Row gap={Spacing.md}>
            <Btn label={t('common.cancel')} size="lg" variant="subtle" style={{ flex: 1 }} onPress={() => setSheet(null)} />
            <Btn label={t('common.save')} size="lg" style={{ flex: 1 }} onPress={save} />
          </Row>
        </View>
      </SheetModal>

      <SheetModal visible={sheet === 'delete'} onClose={() => setSheet(null)} title={t('ce.deleteComboTitle')}>
        <Text style={{ fontSize: FontSize.md, color: Colors.textSecondary, textAlign: 'center', lineHeight: 22 }}>
          {t('ce.deleteComboSub')}
        </Text>
        <Row gap={Spacing.md}>
          <Btn label={t('common.cancel')} size="lg" variant="subtle" style={{ flex: 1 }} onPress={() => setSheet(null)} />
          <Btn label={t('common.delete')} size="lg" variant="danger" style={{ flex: 1 }} onPress={confirmDelete} />
        </Row>
      </SheetModal>
    </Screen>
  );
}

const styles = StyleSheet.create({
  itemRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    padding: 8,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.card,
  },
  itemEmoji: {
    width: 34,
    height: 34,
    borderRadius: Radius.sm,
    backgroundColor: Colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  qtyBtn: {
    width: 26,
    height: 26,
    borderRadius: Radius.sm,
    backgroundColor: Colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  qtyBtnText: { fontSize: FontSize.md, color: Colors.primaryDeep, fontWeight: '700' },
  footer: {
    padding: Spacing.lg,
    paddingBottom: 28,
    backgroundColor: Colors.card,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Colors.border,
  },
});
