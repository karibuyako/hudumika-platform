import { Stack, router } from 'expo-router';
import * as Haptics from 'expo-haptics';
import * as Clipboard from 'expo-clipboard';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Btn, Chip, Empty, Icon, Pill, Row, Screen, SheetModal } from '@/components/ui';
import { Colors, FontSize, Radius, Spacing } from '@/constants/theme';
import { t, onLocaleChange } from '@/i18n';
import { api, ApiError } from '@/api/client';
import type { ProductRow, StoreListItem, TableRow } from '@/api/types';
import { useDineInStore } from '@/store/dine-in';
import { tzs } from '@/lib/format';

interface Form {
  name: string;
  zone: string;
  capacity: number;
  active: boolean;
  qrPayload: string;
  menuUrl: string;
}

export default function TablesScreen() {
  useSyncExternalStore(onLocaleChange, () => 0);
  const [stores, setStores] = useState<StoreListItem[]>([]);
  const [storeId, setStoreId] = useState('s_demo');
  const [tables, setTables] = useState<TableRow[]>([]);
  const [sheet, setSheet] = useState<null | 'add' | 'edit' | 'delete' | 'openBill'>(null);
  const [target, setTarget] = useState<TableRow | null>(null);
  const [form, setForm] = useState<Form>({ name: '', zone: '', capacity: 2, active: true, qrPayload: '', menuUrl: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sheetError, setSheetError] = useState('');
  const [qrCopied, setQrCopied] = useState(false);
  const [qrPrinted, setQrPrinted] = useState(false);
  const [billProducts, setBillProducts] = useState<ProductRow[]>([]);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [billTarget, setBillTarget] = useState<TableRow | null>(null);
  const openBillStore = useDineInStore();

  useEffect(() => {
    api
      .get<{ stores: StoreListItem[] }>('/stores', { retries: 1 })
      .then((r) => setStores(r.stores))
      .catch(() => undefined);
  }, []);

  const load = useCallback(async (sid: string) => {
    setTables([]);
    setError('');
    try {
      const r = await api.get<{ tables: TableRow[] }>(`/dine-in/tables?storeId=${sid}`, { retries: 1 });
      setTables(r.tables);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('tbl.errLoad'));
    }
  }, []);

  useEffect(() => {
    api
      .get<{ tables: TableRow[] }>(`/dine-in/tables?storeId=${storeId}`, { retries: 1 })
      .then((r) => setTables(r.tables))
      .catch((e) => setError(e instanceof ApiError ? e.message : t('tbl.errLoad')));
  }, [storeId]);

  const onStoreChange = (sid: string) => {
    setSheet(null);
    setTarget(null);
    setStoreId(sid);
  };

  const openAdd = () => {
    setTarget(null);
    setForm({ name: '', zone: '', capacity: 2, active: true, qrPayload: '', menuUrl: '' });
    setSheetError('');
    setSheet('add');
  };

  const openEdit = async (tb: TableRow) => {
    setTarget(tb);
    setForm({ name: tb.label ?? tb.name, zone: tb.zone, capacity: tb.capacity, active: tb.active ?? !tb.disabled, qrPayload: '', menuUrl: '' });
    setSheetError('');
    setQrCopied(false);
    setQrPrinted(false);
    setSheet('edit');
    /* Contract QR (DINE-IN.md): payload + menu URL come from the API, never
     * hardcoded; re-fetched on every open (label changes re-render the card). */
    try {
      const r = await api.get<{ qrPayload: string; menuUrl: string }>(`/dine-in/tables/${tb.id}/qr`, { retries: 1 });
      setForm((f) => ({ ...f, qrPayload: r.qrPayload, menuUrl: r.menuUrl }));
    } catch (e) {
      setSheetError(e instanceof ApiError ? e.message : t('qr.errAdd'));
    }
  };

  const add = async () => {
    if (!form.name.trim()) return;
    setBusy(true);
    setSheetError('');
    try {
      await api.post('/dine-in/tables', { storeId, label: form.name.trim(), zone: form.zone.trim(), capacity: form.capacity, active: form.active });
      setSheet(null);
      await load(storeId);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e) {
      setSheetError(e instanceof ApiError ? e.message : t('tbl.errAdd'));
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!target || !form.name.trim()) return;
    setBusy(true);
    setSheetError('');
    try {
      await api.patch(`/dine-in/tables/${target.id}`, {
        label: form.name.trim(),
        zone: form.zone.trim(),
        capacity: form.capacity,
        active: form.active,
      });
      setSheet(null);
      await load(storeId);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e) {
      setSheetError(e instanceof ApiError ? e.message : t('tbl.errUpdate'));
    } finally {
      setBusy(false);
    }
  };

  const openBillSheet = async (tb: TableRow) => {
    setSheetError('');
    setBillTarget(tb);
    setSelected({});
    setSheet('openBill');
    try {
      const r = await api.get<{ products: ProductRow[] }>(`/products?storeId=${tb.storeId}`, { retries: 1 });
      setBillProducts(r.products.filter((p) => p.visible && !p.deleted && p.stock > 0));
    } catch {
      setBillProducts([]);
    }
  };

  const submitBill = async () => {
    if (!billTarget) return;
    const ids = Object.keys(selected).filter((k) => selected[k]);
    if (ids.length === 0) return;
    setBusy(true);
    setSheetError('');
    try {
      const bill = await openBillStore.openBill({ tableId: billTarget.id, items: ids.map((id) => ({ catalogueItemId: id, quantity: 1 })) });
      setSheet(null);
      await load(storeId);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      router.push(`/store/bill/${bill.id}` as never);
    } catch (e) {
      setSheetError(e instanceof ApiError ? e.message : t('din.errOpen'));
    } finally {
      setBusy(false);
    }
  };

  const regenQr = async () => {
    if (!target) return;
    setBusy(true);
    setSheetError('');
    try {
      const r = await api.post<{ table: TableRow }>(`/tables/${target.id}/qr`);
      setTables((list) => list.map((t) => (t.id === r.table.id ? r.table : t)));
      const qr = await api.get<{ qrPayload: string; menuUrl: string }>(`/dine-in/tables/${target.id}/qr`, { retries: 1 });
      setForm((f) => ({ ...f, qrPayload: qr.qrPayload, menuUrl: qr.menuUrl }));
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e) {
      setSheetError(e instanceof ApiError ? e.message : t('qr.errAdd'));
    } finally {
      setBusy(false);
    }
  };

  const copyQr = async () => {
    if (!form.qrPayload) return;
    await Clipboard.setStringAsync(form.qrPayload);
    setQrCopied(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  };

  const printQr = async () => {
    if (!target) return;
    setBusy(true);
    setSheetError('');
    setQrPrinted(false);
    try {
      await api.post('/print-jobs', {
        jobType: 'label',
        tableId: target.id,
        label: `QR ${form.name.trim()}`,
      });
      setQrPrinted(true);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e) {
      setSheetError(e instanceof ApiError ? e.message : t('qr.errAdd'));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!target) return;
    setBusy(true);
    setSheetError('');
    try {
      await api.delete(`/dine-in/tables/${target.id}`);
      setSheet(null);
      setTarget(null);
      await load(storeId);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e) {
      setSheetError(e instanceof ApiError ? e.message : t('tbl.errDelete'));
    } finally {
      setBusy(false);
    }
  };

  const idle = tables.filter((t) => t.status === 'idle').length;
  const occupied = tables.filter((t) => t.status === 'occupied').length;
  const reserved = tables.filter((t) => t.status === 'reserved').length;
  const rows: TableRow[][] = [];
  for (let i = 0; i < tables.length; i += 2) rows.push(tables.slice(i, i + 2));

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: Colors.bg }} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.topBar}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Icon name="chevron-back" size={26} color={Colors.text} />
        </Pressable>
        <Text style={styles.topTitle}>{t('tbl.title')}</Text>
        <View style={{ width: 26 }} />
      </View>

      <Screen scroll>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
          {stores.map((s) => (
            <Chip key={s.id} label={s.name} selected={storeId === s.id} onPress={() => onStoreChange(s.id)} />
          ))}
        </View>

        {error ? <Text style={styles.error}>{error}</Text> : null}

        <Row gap={8} style={{ marginTop: Spacing.md }}>
          {[
            { label: 'tbl.total' as const, value: tables.length, color: Colors.text },
            { label: 'tbl.idle' as const, value: idle, color: Colors.success },
            { label: 'tbl.occupied' as const, value: occupied, color: Colors.danger },
            { label: 'tbl.reserved' as const, value: reserved, color: Colors.warning },
          ].map((s) => (
            <View key={s.label} style={styles.statCard}>
              <Text style={[styles.statValue, { color: s.color }]}>{s.value}</Text>
              <Text style={styles.statLabel}>{t(s.label)}</Text>
            </View>
          ))}
        </Row>

        <Row style={{ justifyContent: 'space-between', marginTop: Spacing.md }}>
          <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary, flex: 1 }}>
            {t('tbl.sub')}
          </Text>
          <Btn label={t('tbl.add')} icon="add" size="sm" onPress={openAdd} />
        </Row>

        <View style={{ gap: Spacing.md, marginTop: Spacing.md }}>
          {tables.length === 0 ? <Empty icon="restaurant-outline" title={t('tbl.empty')} sub={t('tbl.emptySub')} /> : null}
          {rows.map((chunk, i) => (
            <Row key={i} gap={10} style={{ alignItems: 'stretch' }}>
              {chunk.map((tb) => (
                <Pressable key={tb.id} onPress={() => openEdit(tb)} style={({ pressed }) => [styles.tableCard, pressed && { opacity: 0.8 }]}>
                  <View style={{ gap: 6, opacity: tb.disabled ? 0.5 : 1 }}>
                    <Row style={{ justifyContent: 'space-between' }}>
                      <Text style={styles.tableName} numberOfLines={1}>{tb.name}</Text>
                      <Pill
                        label={tb.disabled ? t('tbl.disabled') : tb.status === 'idle' ? t('tbl.idle') : tb.status === 'occupied' ? t('tbl.occupied') : t('tbl.reserved')}
                        tone={tb.disabled ? 'neutral' : tb.status === 'idle' ? 'success' : tb.status === 'occupied' ? 'danger' : 'warning'}
                      />
                    </Row>
                    <Text style={styles.tableMeta} numberOfLines={1}>{tb.zone || t('tbl.unzoned')}</Text>
                    <Row gap={4}>
                      <Icon name="people" size={13} color={Colors.textTertiary} />
                      <Text style={styles.tableMeta}>{t('tbl.seats', { n: tb.capacity })}</Text>
                    </Row>
                    {tb.currentOrderId ? (
                      <Pressable
                        onPress={() => router.push(`/store/bill/${tb.currentOrderId}` as never)}
                        accessibilityRole="button"
                        accessibilityLabel={t('tbl.openBill')}
                        style={({ pressed }) => [styles.billLink, pressed && { opacity: 0.7 }]}>
                        <Icon name="receipt-outline" size={13} color={Colors.primaryDark} />
                        <Text style={styles.billLinkText} numberOfLines={1}>{t('tbl.openBill')}</Text>
                        <Icon name="chevron-forward" size={13} color={Colors.textTertiary} />
                      </Pressable>
                    ) : tb.status === 'idle' && !tb.disabled ? (
                      <Pressable
                        onPress={() => openBillSheet(tb)}
                        accessibilityRole="button"
                        accessibilityLabel={t('tbl.openBill')}
                        style={({ pressed }) => [styles.billLink, pressed && { opacity: 0.7 }]}>
                        <Icon name="add-circle-outline" size={13} color={Colors.success} />
                        <Text style={[styles.billLinkText, { color: Colors.success }]} numberOfLines={1}>{t('tbl.openBill')}</Text>
                      </Pressable>
                    ) : null}
                  </View>
                </Pressable>
              ))}
              {chunk.length === 1 ? <View style={{ flex: 1 }} /> : null}
            </Row>
          ))}
        </View>
      </Screen>

      <SheetModal visible={sheet === 'add'} onClose={() => setSheet(null)} title={t('tbl.add')}>
        <View style={{ gap: Spacing.md }}>
          <View style={{ gap: Spacing.sm }}>
            <Text style={styles.fieldLabel}>{t('tbl.tableName')}</Text>
            <TextInput value={form.name} onChangeText={(v) => setForm((f) => ({ ...f, name: v }))} placeholder={t('tbl.namePh')} placeholderTextColor={Colors.textTertiary} style={styles.input} maxLength={40} />
          </View>
          <View style={{ gap: Spacing.sm }}>
            <Text style={styles.fieldLabel}>{t('tbl.zone')}</Text>
            <TextInput value={form.zone} onChangeText={(v) => setForm((f) => ({ ...f, zone: v }))} placeholder={t('tbl.zonePh')} placeholderTextColor={Colors.textTertiary} style={styles.input} maxLength={30} />
          </View>
          <View style={{ gap: Spacing.sm }}>
            <Text style={styles.fieldLabel}>{t('tbl.capacity')}</Text>
            <Row gap={8}>
              <Pressable onPress={() => setForm((f) => ({ ...f, capacity: Math.max(1, f.capacity - 1) }))} style={styles.stepBtn}>
                <Text style={styles.stepText}>−</Text>
              </Pressable>
              <Text style={styles.stepValue}>{form.capacity}</Text>
              <Pressable onPress={() => setForm((f) => ({ ...f, capacity: Math.min(20, f.capacity + 1) }))} style={styles.stepBtn}>
                <Text style={styles.stepText}>+</Text>
              </Pressable>
            </Row>
          </View>
          <View style={{ gap: Spacing.sm }}>
            <Row style={{ justifyContent: 'space-between' }}>
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={styles.fieldLabel}>{t('tbl.active')}</Text>
                <Text style={styles.fieldSub}>{t('tbl.activeSub')}</Text>
              </View>
              <Switch
                value={form.active}
                onValueChange={(v) => setForm((f) => ({ ...f, active: v }))}
                trackColor={{ false: Colors.borderStrong, true: Colors.success }}
                thumbColor={Colors.white}
                ios_backgroundColor={Colors.borderStrong}
              />
            </Row>
          </View>
          {sheetError ? <Text style={{ color: Colors.danger, fontSize: FontSize.xs }}>{sheetError}</Text> : null}
          <Btn label={t('tbl.add')} size="lg" loading={busy} disabled={!form.name.trim()} onPress={add} />
        </View>
      </SheetModal>

      <SheetModal visible={sheet === 'edit'} onClose={() => setSheet(null)} title={target ? t('tbl.editTitle', { name: target.label ?? target.name }) : ''}>
        <View style={{ gap: Spacing.md }}>
          <View style={{ gap: Spacing.sm }}>
            <Text style={styles.fieldLabel}>{t('tbl.tableName')}</Text>
            <TextInput value={form.name} onChangeText={(v) => setForm((f) => ({ ...f, name: v }))} placeholder={t('tbl.namePh')} placeholderTextColor={Colors.textTertiary} style={styles.input} maxLength={40} />
          </View>
          <View style={{ gap: Spacing.sm }}>
            <Text style={styles.fieldLabel}>{t('tbl.zone')}</Text>
            <TextInput value={form.zone} onChangeText={(v) => setForm((f) => ({ ...f, zone: v }))} placeholder={t('tbl.zonePh')} placeholderTextColor={Colors.textTertiary} style={styles.input} maxLength={30} />
          </View>
          <View style={{ gap: Spacing.sm }}>
            <Text style={styles.fieldLabel}>{t('tbl.capacity')}</Text>
            <Row gap={8}>
              <Pressable onPress={() => setForm((f) => ({ ...f, capacity: Math.max(1, f.capacity - 1) }))} style={styles.stepBtn}>
                <Text style={styles.stepText}>−</Text>
              </Pressable>
              <Text style={styles.stepValue}>{form.capacity}</Text>
              <Pressable onPress={() => setForm((f) => ({ ...f, capacity: Math.min(20, f.capacity + 1) }))} style={styles.stepBtn}>
                <Text style={styles.stepText}>+</Text>
              </Pressable>
            </Row>
          </View>
          <Row style={{ justifyContent: 'space-between' }}>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={styles.fieldLabel}>{t('tbl.active')}</Text>
              <Text style={styles.fieldSub}>{t('tbl.activeSub')}</Text>
            </View>
            <Switch
              value={form.active}
              onValueChange={(v) => setForm((f) => ({ ...f, active: v }))}
              trackColor={{ false: Colors.borderStrong, true: Colors.success }}
              thumbColor={Colors.white}
              ios_backgroundColor={Colors.borderStrong}
            />
          </Row>
          <Row style={{ justifyContent: 'space-between' }}>
            <Text style={styles.fieldLabel}>{t('tbl.status')}</Text>
            <Pill
              label={target && (target.disabled || !form.active) ? t('tbl.disabled') : target?.status === 'idle' ? t('tbl.idle') : target?.status === 'occupied' ? t('tbl.occupied') : t('tbl.reserved')}
              tone={target && (target.disabled || !form.active) ? 'neutral' : target?.status === 'idle' ? 'success' : target?.status === 'occupied' ? 'danger' : 'warning'}
            />
          </Row>
          <View style={styles.qrRow}>
            <Icon name="qr-code-outline" size={14} color={Colors.textTertiary} />
            {form.qrPayload ? (
              <Text style={styles.qrUrl} numberOfLines={2}>{form.qrPayload}</Text>
            ) : (
              <Text style={styles.qrUrl} numberOfLines={1}>{t('tbl.qrLoading')}</Text>
            )}
          </View>
          <Row gap={Spacing.sm}>
            <Btn label={qrCopied ? t('qr.copied') : t('qr.copy')} variant="outline" size="sm" style={{ flex: 1 }} disabled={!form.qrPayload} onPress={copyQr} />
            <Btn label={qrPrinted ? t('tbl.qrPrinted') : t('tbl.printQr')} variant="outline" size="sm" style={{ flex: 1 }} loading={busy} disabled={!form.qrPayload} onPress={printQr} />
          </Row>
          <Btn label={t('tbl.newQr')} variant="subtle" size="sm" loading={busy} onPress={regenQr} />
          {sheetError ? <Text style={{ color: Colors.danger, fontSize: FontSize.xs }}>{sheetError}</Text> : null}
          <Btn label={t('tbl.save')} size="lg" loading={busy} disabled={!form.name.trim()} onPress={save} />
          <Btn
            label={t('tbl.deleteTitle')}
            variant="danger"
            size="sm"
            onPress={() => {
              setTarget(target);
              setSheetError('');
              setSheet('delete');
            }}
          />
        </View>
      </SheetModal>

      <SheetModal visible={sheet === 'openBill'} onClose={() => setSheet(null)} title={billTarget ? t('tbl.openBill') : ''}>
        <View style={{ gap: Spacing.md }}>
          <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary, lineHeight: 19 }}>
            {t('tbl.pickItems')} · {billTarget?.name ?? ''}
          </Text>
          {billProducts.length === 0 ? (
            <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary }}>{t('tbl.noneAvailable')}</Text>
          ) : (
            <ScrollView style={{ maxHeight: 300 }} showsVerticalScrollIndicator={false} nestedScrollEnabled>
              <View style={{ gap: Spacing.xs }}>
                {billProducts.map((p) => {
                  const on = !!selected[p.id];
                  return (
                    <Pressable
                      key={p.id}
                      onPress={() => setSelected((s) => ({ ...s, [p.id]: !on }))}
                      accessibilityRole="button"
                      accessibilityLabel={p.name}
                      accessibilityState={{ selected: on }}
                      style={[styles.featRow, on && styles.featActive]}>
                      <Text style={{ fontSize: 18 }}>{p.emoji}</Text>
                      <Text style={{ flex: 1, fontSize: FontSize.sm, color: Colors.text, fontWeight: on ? '700' : '400' }} numberOfLines={1}>{p.name}</Text>
                      <Text style={styles.featPrice}>{tzs(p.price)}</Text>
                      {on ? <Icon name="checkmark-circle" size={17} color={Colors.success} /> : <Icon name="add-circle-outline" size={17} color={Colors.textTertiary} />}
                    </Pressable>
                  );
                })}
              </View>
            </ScrollView>
          )}
          {sheetError ? <Text style={{ color: Colors.danger, fontSize: FontSize.xs }}>{sheetError}</Text> : null}
          <Btn
            label={t('tbl.openBill')}
            size="lg"
            loading={busy}
            disabled={Object.keys(selected).filter((k) => selected[k]).length === 0}
            onPress={submitBill}
          />
        </View>
      </SheetModal>

      <SheetModal visible={sheet === 'delete'} onClose={() => setSheet(null)} title={t('tbl.deleteTitle')}>
        <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary, textAlign: 'center', lineHeight: 19 }}>
          {t('tbl.deleteBody', { name: target?.name ?? '' })}
        </Text>
        {sheetError ? <Text style={{ color: Colors.danger, fontSize: FontSize.xs, textAlign: 'center' }}>{sheetError}</Text> : null}
        <Row gap={Spacing.sm}>
          <Btn label={t('tbl.cancel')} variant="outline" size="sm" style={{ flex: 1 }} onPress={() => setSheet(null)} />
          <Btn label={t('tbl.delete')} variant="danger" size="sm" style={{ flex: 1 }} loading={busy} onPress={remove} />
        </Row>
      </SheetModal>
    </SafeAreaView>
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
  error: { color: Colors.danger, fontSize: FontSize.xs, marginTop: Spacing.sm },
  statCard: {
    flex: 1,
    backgroundColor: Colors.card,
    borderRadius: Radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
    paddingVertical: 10,
    alignItems: 'center',
    gap: 2,
  },
  statValue: { fontSize: FontSize.xl, fontWeight: '900' },
  statLabel: { fontSize: FontSize.xs, color: Colors.textTertiary, fontWeight: '600' },
  tableCard: {
    flex: 1,
    backgroundColor: Colors.card,
    borderRadius: Radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
    padding: Spacing.md,
    shadowColor: Colors.black,
    shadowOpacity: 0.04,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 1,
  },
  tableName: { fontSize: FontSize.md, fontWeight: '800', color: Colors.text, flexShrink: 1 },
  tableMeta: { fontSize: FontSize.xs, color: Colors.textTertiary },
  billLink: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    marginTop: 2,
    paddingVertical: 4,
  },
  billLinkText: { fontSize: FontSize.xs, color: Colors.primaryDark, fontWeight: '700', flexShrink: 1 },
  featRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 11,
    paddingHorizontal: Spacing.md,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.borderStrong,
  },
  featActive: { borderColor: Colors.primaryDark, backgroundColor: Colors.primarySoft },
  featPrice: { fontSize: FontSize.sm, color: Colors.text, fontWeight: '700', fontVariant: ['tabular-nums'] },
  fieldLabel: { fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '600' },
  fieldSub: { fontSize: FontSize.xs, color: Colors.textTertiary, marginTop: 2 },
  input: {
    borderWidth: 1,
    borderColor: Colors.borderStrong,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.md,
    paddingVertical: 11,
    fontSize: FontSize.sm,
    color: Colors.text,
    backgroundColor: Colors.card,
  },
  stepBtn: {
    width: 36,
    height: 36,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.borderStrong,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.card,
  },
  stepText: { fontSize: 20, color: Colors.text },
  stepValue: { fontSize: FontSize.xl, fontWeight: '800', color: Colors.text, minWidth: 40, textAlign: 'center' },
  qrRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: Colors.surface,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.md,
    paddingVertical: 10,
  },
  qrUrl: { flex: 1, fontSize: FontSize.xs, color: Colors.textSecondary },
});
