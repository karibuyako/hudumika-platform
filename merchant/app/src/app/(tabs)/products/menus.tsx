import * as Haptics from 'expo-haptics';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, TextInput, View } from 'react-native';

import { api, ApiError } from '@/api/client';
import type { Menu, MenuSection, StoreListItem } from '@/api/types';
import { Btn, Card, Empty, Field, Icon, Pill, Row, Screen, SheetModal, ToggleRow } from '@/components/ui';
import { Colors, FontSize, Radius, Spacing } from '@/constants/theme';
import { t, onLocaleChange } from '@/i18n';
import { useCatalogueExtStore, type MenuInput } from '@/store/catalogue-ext';
import { useCatalogStore } from '@/store/catalog';

type Sheet = null | 'create' | 'edit' | 'delete';

export default function MenusScreen() {
  useSyncExternalStore(onLocaleChange, () => 0);
  const menus = useCatalogueExtStore((s) => s.menus);
  const hydrate = useCatalogueExtStore((s) => s.hydrate);
  const createMenu = useCatalogueExtStore((s) => s.createMenu);
  const replaceMenu = useCatalogueExtStore((s) => s.replaceMenu);
  const deleteMenu = useCatalogueExtStore((s) => s.deleteMenu);
  const products = useCatalogStore((s) => s.products);
  const catalogLoaded = useCatalogStore((s) => s.loaded);
  const catalogHydrate = useCatalogStore((s) => s.hydrate);

  const [sheet, setSheet] = useState<Sheet>(null);
  const [target, setTarget] = useState<Menu | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [stores, setStores] = useState<StoreListItem[]>([]);
  const [storesErr, setStoresErr] = useState('');
  const [name, setName] = useState('');
  const [storeIds, setStoreIds] = useState<string[]>([]);
  const [active, setActive] = useState(true);
  const [sections, setSections] = useState<MenuSection[]>([]);
  const [err, setErr] = useState('');

  useEffect(() => {
    hydrate();
    if (!catalogLoaded) void catalogHydrate();
    api
      .get<{ stores: StoreListItem[] }>('/merchants/me/stores', { retries: 1 })
      .then((r) => setStores(r.stores))
      .catch((e) => setStoresErr(e instanceof ApiError ? e.message : t('prdt.errStores')));
  }, [hydrate, catalogLoaded, catalogHydrate]);

  const onRefresh = async () => {
    setRefreshing(true);
    await hydrate();
    setRefreshing(false);
  };

  const openCreate = () => {
    setTarget(null);
    setName('');
    setStoreIds(stores[0] ? [stores[0].id] : []);
    setActive(true);
    setSections([]);
    setErr('');
    setSheet('create');
  };

  const openEdit = (menu: Menu) => {
    setTarget(menu);
    setName(menu.name);
    setStoreIds(menu.storeIds);
    setActive(menu.active);
    setSections(menu.sections.map((s) => ({ name: s.name, itemIds: [...s.itemIds] })));
    setErr('');
    setSheet('edit');
  };

  const toggleStore = (id: string) => {
    setStoreIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const addSection = () => {
    setSections((prev) => [...prev, { name: '', itemIds: [] }]);
  };

  const patchSection = (idx: number, patch: Partial<MenuSection>) => {
    setSections((prev) => prev.map((s, i) => (i === idx ? { ...s, ...patch } : s)));
  };

  const removeSection = (idx: number) => {
    setSections((prev) => prev.filter((_, i) => i !== idx));
  };

  const moveSection = (idx: number, delta: -1 | 1) => {
    setSections((prev) => {
      const next = [...prev];
      const j = idx + delta;
      if (j < 0 || j >= next.length) return prev;
      [next[idx], next[j]] = [next[j], next[idx]];
      return next;
    });
  };

  const toggleItem = (sectionIdx: number, productId: string) => {
    setSections((prev) =>
      prev.map((s, i) =>
        i === sectionIdx
          ? { ...s, itemIds: s.itemIds.includes(productId) ? s.itemIds.filter((id) => id !== productId) : [...s.itemIds, productId] }
          : s,
      ),
    );
  };

  const save = async () => {
    if (!name.trim()) {
      setErr(t('ce.errName'));
      return;
    }
    if (storeIds.length === 0) {
      setErr(t('ce.errStores'));
      return;
    }
    const cleanSections = sections
      .map((s) => ({ name: s.name.trim(), itemIds: s.itemIds }))
      .filter((s) => s.name);
    const input: MenuInput = { name: name.trim(), storeIds, active, sections: cleanSections };
    if (target) {
      const updated = await replaceMenu(target.id, input);
      if (updated) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        setSheet(null);
      } else setErr(t('ce.errSave'));
    } else {
      const created = await createMenu(input);
      if (created) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        setSheet(null);
      } else setErr(t('ce.errSave'));
    }
  };

  const confirmDelete = async () => {
    if (!target) return;
    const ok = await deleteMenu(target.id);
    if (ok) Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setSheet(null);
  };

  const storeName = (id: string) => stores.find((s) => s.id === id)?.name ?? id;

  return (
    <Screen>
      <FlatList
        data={menus}
        keyExtractor={(m) => m.id}
        contentContainerStyle={{ padding: Spacing.md, gap: 10, paddingBottom: 24 }}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Colors.primary} />}
        ListEmptyComponent={<Empty icon="book-outline" title={t('ce.menusEmpty')} sub={t('ce.menusEmptySub')} />}
        renderItem={({ item }) => (
          <Card>
            <Row style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <Text style={{ flex: 1, fontSize: FontSize.md, fontWeight: '700', color: Colors.text }}>{item.name}</Text>
              {item.active ? <Pill label={t('ce.active')} tone="success" /> : <Pill label={t('ce.inactive')} tone="neutral" />}
            </Row>
            <Text style={{ fontSize: FontSize.sm, color: Colors.textTertiary, marginTop: 4 }}>
              {t('ce.menuStores', { n: item.storeIds.length })} · {t('ce.menuSections', { n: item.sections.length })} · {item.storeIds.map(storeName).join(' · ')}
            </Text>
            <Row gap={Spacing.sm} style={{ marginTop: 8 }}>
              <Btn label={t('ce.rename')} size="sm" variant="subtle" style={{ flex: 1 }} onPress={() => openEdit(item)} />
              <Btn label={t('common.delete')} size="sm" variant="danger" style={{ flex: 1 }} onPress={() => { setTarget(item); setErr(''); setSheet('delete'); }} />
            </Row>
          </Card>
        )}
      />

      <View style={styles.footer}>
        <Btn label={t('ce.addMenu')} size="lg" icon="add" onPress={openCreate} />
      </View>

      <SheetModal visible={sheet === 'create' || sheet === 'edit'} onClose={() => setSheet(null)} title={target ? t('ce.editMenu') : t('ce.addMenu')}>
        <View style={{ gap: Spacing.md }}>
          <Field label={t('ce.name')} value={name} onChangeText={setName} placeholder={t('ce.menuNamePh')} maxLength={160} />
          <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '600' }}>{t('ce.menuStoresLabel')}</Text>
          {storesErr ? (
            <Text style={{ fontSize: FontSize.xs, color: Colors.danger }}>{storesErr}</Text>
          ) : stores.length === 0 ? (
            <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>{t('prds.empty')}</Text>
          ) : (
            stores.map((s) => {
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
                  {selected ? <IconCheck /> : null}
                </Pressable>
              );
            })
          )}

          <View style={{ gap: Spacing.xs }}>
            <Row style={{ justifyContent: 'space-between', alignItems: 'center' }}>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '600' }}>{t('ce.sections')}</Text>
                <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary, marginTop: 2 }}>{t('ce.sectionsSub')}</Text>
              </View>
              <Btn label={t('ce.addSection')} size="sm" variant="ghost" icon="add" onPress={addSection} />
            </Row>
            {sections.length === 0 ? (
              <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>{t('ce.noSections')}</Text>
            ) : (
              sections.map((sec, idx) => (
                <Card key={`${idx}-${sec.name}`} style={{ gap: Spacing.sm, backgroundColor: Colors.surface }}>
                  <Row gap={6} style={{ alignItems: 'flex-end' }}>
                    <View style={{ flex: 1, gap: Spacing.xs }}>
                      <Text style={styles.sectionLabel}>{t('ce.sectionNamePh')}</Text>
                      <TextInput
                        value={sec.name}
                        onChangeText={(v) => patchSection(idx, { name: v })}
                        placeholder={t('ce.sectionNamePh')}
                        placeholderTextColor={Colors.textTertiary}
                        maxLength={80}
                        style={styles.sectionInput}
                      />
                    </View>
                    <Pressable onPress={() => moveSection(idx, -1)} hitSlop={8} accessibilityRole="button" accessibilityLabel={t('ce.moveUp')} disabled={idx === 0} style={{ paddingBottom: 12, opacity: idx === 0 ? 0.3 : 1 }}>
                      <Icon name="chevron-up" size={18} color={Colors.textSecondary} />
                    </Pressable>
                    <Pressable onPress={() => moveSection(idx, 1)} hitSlop={8} accessibilityRole="button" accessibilityLabel={t('ce.moveDown')} disabled={idx === sections.length - 1} style={{ paddingBottom: 12, opacity: idx === sections.length - 1 ? 0.3 : 1 }}>
                      <Icon name="chevron-down" size={18} color={Colors.textSecondary} />
                    </Pressable>
                    <Pressable onPress={() => removeSection(idx)} hitSlop={8} accessibilityRole="button" accessibilityLabel={t('ce.removeSection')} style={{ paddingBottom: 12 }}>
                      <Icon name="trash-outline" size={18} color={Colors.danger} />
                    </Pressable>
                  </Row>
                  <Text style={{ fontSize: FontSize.xs, color: Colors.textSecondary, fontWeight: '600' }}>
                    {t('ce.sectionItems', { name: sec.name || t('ce.sectionNamePh'), n: sec.itemIds.length })}
                  </Text>
                  <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>{t('ce.pickItems')}</Text>
                  {products.length === 0 ? (
                    <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>{t('prd.empty')}</Text>
                  ) : (
                    <Row gap={6} style={{ flexWrap: 'wrap' }}>
                      {products.map((p) => {
                        const inSection = sec.itemIds.includes(p.id);
                        return (
                          <Pressable
                            key={p.id}
                            onPress={() => toggleItem(idx, p.id)}
                            accessibilityRole="button"
                            accessibilityLabel={`${p.emoji} ${p.name}`}
                            accessibilityState={{ selected: inSection }}
                            style={[styles.itemChip, inSection && styles.itemChipActive]}>
                            <Text numberOfLines={1} style={[styles.itemChipText, { maxWidth: 180 }, inSection && { color: Colors.text, fontWeight: '700' }]}>
                              {p.emoji} {p.name}
                            </Text>
                          </Pressable>
                        );
                      })}
                    </Row>
                  )}
                </Card>
              ))
            )}
          </View>

          <ToggleRow label={t('ce.menuActive')} value={active} onChange={setActive} />
          {target ? (
            <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>{t('ce.menuReplaceHint')}</Text>
          ) : null}
          {err ? <Text style={{ fontSize: FontSize.sm, color: Colors.danger }}>{err}</Text> : null}
          <Row gap={Spacing.md}>
            <Btn label={t('common.cancel')} size="lg" variant="subtle" style={{ flex: 1 }} onPress={() => setSheet(null)} />
            <Btn label={t('common.save')} size="lg" style={{ flex: 1 }} onPress={save} />
          </Row>
        </View>
      </SheetModal>

      <SheetModal visible={sheet === 'delete'} onClose={() => setSheet(null)} title={t('ce.deleteMenuTitle')}>
        <Text style={{ fontSize: FontSize.md, color: Colors.textSecondary, textAlign: 'center', lineHeight: 22 }}>
          {t('ce.deleteMenuSub')}
        </Text>
        <Row gap={Spacing.md}>
          <Btn label={t('common.cancel')} size="lg" variant="subtle" style={{ flex: 1 }} onPress={() => setSheet(null)} />
          <Btn label={t('common.delete')} size="lg" variant="danger" style={{ flex: 1 }} onPress={confirmDelete} />
        </Row>
      </SheetModal>
    </Screen>
  );
}

function IconCheck() {
  return (
    <View style={styles.check}>
      <Text style={styles.checkText}>✓</Text>
    </View>
  );
}

const styles = StyleSheet.create({
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
  check: {
    width: 22,
    height: 22,
    borderRadius: Radius.pill,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkText: { color: Colors.white, fontSize: FontSize.xs, fontWeight: '800' },
  sectionLabel: { fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '600' },
  sectionInput: {
    borderWidth: 1,
    borderColor: Colors.borderStrong,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.md,
    paddingVertical: 9,
    fontSize: FontSize.sm,
    color: Colors.text,
    backgroundColor: Colors.card,
  },
  itemChip: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: Radius.pill,
    borderWidth: 1,
    borderColor: Colors.borderStrong,
    backgroundColor: Colors.card,
  },
  itemChipActive: { backgroundColor: Colors.primary, borderColor: Colors.primaryDark },
  itemChipText: { fontSize: FontSize.xs, color: Colors.textSecondary, fontWeight: '600' },
  footer: {
    padding: Spacing.lg,
    paddingBottom: 28,
    backgroundColor: Colors.card,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Colors.border,
  },
});
