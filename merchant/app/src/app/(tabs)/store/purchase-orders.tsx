import { Stack, router } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Btn, Card, Chip, Empty, Field, Icon, Pill, Row, Screen, SheetModal } from '@/components/ui';
import { Colors, FontSize, Radius, Spacing } from '@/constants/theme';
import { t, onLocaleChange, type I18nKey } from '@/i18n';
import type { PurchaseOrder, PurchaseOrderStatus } from '@/api/types';
import { useSupplyChainStore } from '@/store/supply-chain';
import { useCatalogStore } from '@/store/catalog';
import { useMessageStore } from '@/store/messages';
import { fullTime, tzs } from '@/lib/format';

const STATUS_PILL: Record<PurchaseOrderStatus, { label: I18nKey; tone: 'neutral' | 'info' | 'warning' | 'success' | 'danger' }> = {
  draft: { label: 'sc.statusDraft', tone: 'neutral' },
  sent: { label: 'sc.statusSent', tone: 'info' },
  partially_received: { label: 'sc.statusPartiallyReceived', tone: 'warning' },
  received: { label: 'sc.statusReceived', tone: 'success' },
  closed: { label: 'sc.statusClosed', tone: 'neutral' },
  cancelled: { label: 'sc.statusCancelled', tone: 'danger' },
};

const STATUS_ORDER: PurchaseOrderStatus[] = ['draft', 'sent', 'partially_received', 'received', 'cancelled'];

export default function PurchaseOrdersScreen() {
  useSyncExternalStore(onLocaleChange, () => 0);
  const purchaseOrders = useSupplyChainStore((s) => s.purchaseOrders);
  const suppliers = useSupplyChainStore((s) => s.suppliers);
  const products = useCatalogStore((s) => s.products);
  const hydrate = useSupplyChainStore((s) => s.hydratePurchaseOrders);
  const hydrateSuppliers = useSupplyChainStore((s) => s.hydrateSuppliers);
  const createPO = useSupplyChainStore((s) => s.createPurchaseOrder);
  const sendPO = useSupplyChainStore((s) => s.sendPurchaseOrder);
  const receivePO = useSupplyChainStore((s) => s.receivePurchaseOrder);
  const cancelPO = useSupplyChainStore((s) => s.cancelPurchaseOrder);
  const pushMessage = useMessageStore((s) => s.push);

  const [filter, setFilter] = useState<PurchaseOrderStatus | 'all'>('all');
  const [sheet, setSheet] = useState<null | 'create' | 'detail' | 'receive' | 'cancel'>(null);
  const [target, setTarget] = useState<PurchaseOrder | null>(null);
  const [supplierId, setSupplierId] = useState('');
  const [note, setNote] = useState('');
  const [lines, setLines] = useState<{ catalogueItemId: string; name: string; quantity: number; unitCostTZS: number }[]>([]);
  const [receiveQty, setReceiveQty] = useState<Record<string, number>>({});
  const [cancelReason, setCancelReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    hydrate().catch(() => undefined);
    hydrateSuppliers().catch(() => undefined);
  }, [hydrate, hydrateSuppliers]);

  const supplierName = (id: string) => suppliers.rows.find((s) => s.id === id)?.name ?? id;
  const filtered = useMemo(
    () => (filter === 'all' ? purchaseOrders.rows : purchaseOrders.rows.filter((p) => p.status === filter)),
    [purchaseOrders.rows, filter],
  );

  const resetCreate = () => {
    setSupplierId(suppliers.rows[0]?.id ?? '');
    setNote('');
    setLines([]);
    setError('');
  };

  const openCreate = () => {
    resetCreate();
    setSheet('create');
  };

  const addLine = (productId: string, name: string, price: number) => {
    setLines((prev) => {
      const exists = prev.find((l) => l.catalogueItemId === productId);
      if (exists) return prev.map((l) => (l.catalogueItemId === productId ? { ...l, quantity: l.quantity + 1 } : l));
      return [...prev, { catalogueItemId: productId, name, quantity: 1, unitCostTZS: price * 800 }];
    });
  };

  const setLineQty = (catalogueItemId: string, qty: number) => {
    setLines((prev) => prev.map((l) => (l.catalogueItemId === catalogueItemId ? { ...l, quantity: Math.max(1, qty) } : l)));
  };

  const create = async () => {
    if (!supplierId || lines.length === 0) return;
    setBusy(true);
    setError('');
    const res = await createPO({
      supplierId,
      items: lines.map((l) => ({ catalogueItemId: l.catalogueItemId, quantity: l.quantity })),
      note: note.trim() || undefined,
    });
    setBusy(false);
    if (res.ok) {
      setSheet(null);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      pushMessage({ type: 'system', title: t('sc.poCreated'), body: '' });
    } else {
      setError(res.message ?? t('sc.errPo'));
    }
  };

  const openDetail = (po: PurchaseOrder) => {
    setTarget(po);
    setError('');
    setSheet('detail');
  };

  const openReceive = (po: PurchaseOrder) => {
    setTarget(po);
    const next: Record<string, number> = {};
    for (const it of po.items) next[it.catalogueItemId] = Math.max(0, it.quantity - it.receivedQuantity);
    setReceiveQty(next);
    setError('');
    setSheet('receive');
  };

  const openCancel = (po: PurchaseOrder) => {
    setTarget(po);
    setCancelReason('');
    setError('');
    setSheet('cancel');
  };

  const send = async () => {
    if (!target) return;
    setBusy(true);
    setError('');
    const res = await sendPO(target.id);
    setBusy(false);
    if (res.ok) {
      setSheet(null);
      setTarget(null);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      pushMessage({ type: 'system', title: t('sc.poSent'), body: '' });
    } else {
      setError(res.message ?? t('sc.errPoSend'));
    }
  };

  const receive = async () => {
    if (!target) return;
    const items = Object.entries(receiveQty)
      .filter(([, q]) => q > 0)
      .map(([catalogueItemId, quantity]) => ({ catalogueItemId, quantity }));
    if (items.length === 0) return;
    setBusy(true);
    setError('');
    const res = await receivePO(target.id, items);
    setBusy(false);
    if (res.ok) {
      setSheet(null);
      setTarget(null);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      pushMessage({ type: 'system', title: t('sc.poReceived'), body: '' });
    } else {
      setError(res.message ?? t('sc.errPoReceive'));
    }
  };

  const cancel = async () => {
    if (!target || !cancelReason.trim()) return;
    setBusy(true);
    setError('');
    const res = await cancelPO(target.id, { reason: cancelReason.trim() });
    setBusy(false);
    if (res.ok) {
      setSheet(null);
      setTarget(null);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      pushMessage({ type: 'system', title: t('sc.poCancelled'), body: '' });
    } else {
      setError(res.message ?? t('sc.errPoCancel'));
    }
  };

  const poActions = (po: PurchaseOrder) => (
    <Row gap={Spacing.sm}>
      <Btn label={t('common.cancel')} variant="outline" size="sm" style={{ flex: 1 }} onPress={() => openDetail(po)} />
      {po.status === 'draft' ? <Btn label={t('sc.poSend')} size="sm" style={{ flex: 1 }} onPress={() => { setTarget(po); setError(''); setSheet('detail'); }} /> : null}
      {po.status === 'sent' || po.status === 'partially_received' ? <Btn label={t('sc.poReceive')} size="sm" style={{ flex: 1 }} onPress={() => openReceive(po)} /> : null}
    </Row>
  );

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: Colors.bg }} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.topBar}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Icon name="chevron-back" size={26} color={Colors.text} />
        </Pressable>
        <Text style={styles.topTitle}>{t('sc.posTitle')}</Text>
        <Btn label={t('common.add')} icon="add" size="sm" onPress={openCreate} />
      </View>

      <Screen scroll>
        <Row style={{ marginTop: Spacing.md, flexWrap: 'wrap', gap: Spacing.sm }}>
          <Chip label={t('common.all')} selected={filter === 'all'} onPress={() => setFilter('all')} />
          {STATUS_ORDER.map((st) => (
            <Chip key={st} label={t(STATUS_PILL[st].label)} selected={filter === st} onPress={() => setFilter(st)} />
          ))}
        </Row>

        {purchaseOrders.error ? (
          <View style={{ alignItems: 'center', gap: Spacing.sm, paddingVertical: Spacing.lg }}>
            <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '600' }}>{purchaseOrders.error}</Text>
            <Btn label={t('common.retry')} size="sm" variant="outline" onPress={() => hydrate(filter === 'all' ? undefined : filter)} />
          </View>
        ) : null}

        <View style={{ gap: Spacing.md, marginTop: Spacing.md }}>
          {filtered.length === 0 && !purchaseOrders.error ? <Empty icon="document-text-outline" title={t('sc.poEmpty')} sub={t('sc.poEmptySub')} /> : null}
          {filtered.map((po) => (
            <Card key={po.id} style={{ gap: Spacing.sm }}>
              <Row style={{ justifyContent: 'space-between' }}>
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={styles.name} numberOfLines={1}>{supplierName(po.supplierId)}</Text>
                  <Text style={styles.meta}>
                    {po.items.length} {t('sc.poItems')} · {tzs(po.totalCostTZS)} · {fullTime(po.createdAt)}
                  </Text>
                </View>
                <Pill label={t(STATUS_PILL[po.status].label)} tone={STATUS_PILL[po.status].tone} />
              </Row>
              {po.items.slice(0, 3).map((it) => (
                <Text key={it.catalogueItemId} style={styles.meta} numberOfLines={1}>
                  · {it.name} × {it.quantity}{it.receivedQuantity > 0 ? ` (${t('sc.poReceivedQty', { qty: it.receivedQuantity })})` : ''}
                </Text>
              ))}
              {poActions(po)}
            </Card>
          ))}
        </View>
      </Screen>

      <SheetModal visible={sheet === 'create'} onClose={() => setSheet(null)} title={t('sc.poCreateSheetTitle')}>
        <View style={{ gap: Spacing.md }}>
          <Text style={styles.fieldLabel}>{t('sc.poSupplier')}</Text>
          <Row gap={8} style={{ flexWrap: 'wrap' }}>
            {suppliers.rows.filter((s) => s.status === 'active').map((s) => (
              <Chip key={s.id} label={s.name} selected={supplierId === s.id} onPress={() => setSupplierId(s.id)} />
            ))}
          </Row>
          <Text style={styles.fieldLabel}>{t('sc.poItems')}</Text>
          <View style={styles.lineBox}>
            {lines.length === 0 ? <Text style={styles.meta}>{t('sc.poNoItems')}</Text> : null}
            {lines.map((l) => (
              <Row key={l.catalogueItemId} style={{ justifyContent: 'space-between', paddingVertical: Spacing.xs }}>
                <Text style={styles.lineName} numberOfLines={1}>{l.name}</Text>
                <Row gap={8}>
                  <Pressable onPress={() => setLineQty(l.catalogueItemId, l.quantity - 1)} style={styles.stepBtn} hitSlop={6}>
                    <Text style={styles.stepText}>−</Text>
                  </Pressable>
                  <Text style={styles.stepValue}>{l.quantity}</Text>
                  <Pressable onPress={() => setLineQty(l.catalogueItemId, l.quantity + 1)} style={styles.stepBtn} hitSlop={6}>
                    <Text style={styles.stepText}>+</Text>
                  </Pressable>
                </Row>
              </Row>
            ))}
          </View>
          <Text style={styles.fieldLabel}>{t('sc.poItem')}</Text>
          <ScrollView style={{ maxHeight: 180 }} nestedScrollEnabled>
            <View style={{ gap: 4 }}>
              {products.map((p) => (
                <Pressable key={p.id} onPress={() => addLine(p.id, p.name, p.price)} style={styles.catalogRow}>
                  <Text style={styles.catalogName} numberOfLines={1}>{p.name}</Text>
                  <Icon name="add-circle-outline" size={18} color={Colors.primary} />
                </Pressable>
              ))}
            </View>
          </ScrollView>
          <Field label={t('sc.poNote')} value={note} onChangeText={setNote} placeholder={t('sc.poNotePh')} maxLength={500} />
          {error ? <Text style={{ color: Colors.danger, fontSize: FontSize.xs }}>{error}</Text> : null}
          <Btn label={t('common.save')} size="lg" loading={busy} disabled={!supplierId || lines.length === 0} onPress={create} />
        </View>
      </SheetModal>

      <SheetModal visible={sheet === 'detail'} onClose={() => setSheet(null)} title={t('sc.posTitle')}>
        {target ? (
          <View style={{ gap: Spacing.md }}>
            <Row style={{ justifyContent: 'space-between' }}>
              <Text style={styles.name} numberOfLines={1}>{supplierName(target.supplierId)}</Text>
              <Pill label={t(STATUS_PILL[target.status].label)} tone={STATUS_PILL[target.status].tone} />
            </Row>
            {target.items.map((it) => (
              <Row key={it.catalogueItemId} style={{ justifyContent: 'space-between' }}>
                <View style={{ flex: 1, gap: 1 }}>
                  <Text style={styles.meta} numberOfLines={1}>{it.name}</Text>
                  <Text style={styles.meta}>{t('sc.poReceivedQty', { qty: it.receivedQuantity })} / {it.quantity}</Text>
                </View>
                <Text style={styles.meta}>{tzs(it.unitCostTZS)}</Text>
              </Row>
            ))}
            <Row style={{ justifyContent: 'space-between' }}>
              <Text style={styles.fieldLabel}>{t('sc.poTotal')}</Text>
              <Text style={styles.name}>{tzs(target.totalCostTZS)}</Text>
            </Row>
            {target.note ? <Text style={styles.meta}>{target.note}</Text> : null}
            {target.expectedArrivalAt ? <Text style={styles.meta}>{t('sc.poExpectedArrival', { date: fullTime(target.expectedArrivalAt) })}</Text> : null}
            {target.receivedAt ? <Text style={styles.meta}>{t('sc.poReceived')} · {fullTime(target.receivedAt)}</Text> : null}
            {error ? <Text style={{ color: Colors.danger, fontSize: FontSize.xs }}>{error}</Text> : null}
            <Row gap={Spacing.sm}>
              {target.status === 'draft' ? (
                <>
                  <Btn label={t('sc.poSend')} size="sm" style={{ flex: 1 }} loading={busy} onPress={send} />
                  <Btn label={t('sc.poCancel')} variant="outline" size="sm" style={{ flex: 1 }} onPress={() => openCancel(target)} />
                </>
              ) : null}
              {target.status === 'sent' || target.status === 'partially_received' ? (
                <>
                  <Btn label={t('sc.poReceive')} size="sm" style={{ flex: 1 }} onPress={() => openReceive(target)} />
                  <Btn label={t('sc.poCancel')} variant="outline" size="sm" style={{ flex: 1 }} onPress={() => openCancel(target)} />
                </>
              ) : null}
            </Row>
          </View>
        ) : null}
      </SheetModal>

      <SheetModal visible={sheet === 'receive'} onClose={() => setSheet(null)} title={t('sc.poReceiveTitle')}>
        {target ? (
          <View style={{ gap: Spacing.md }}>
            {target.items.map((it) => {
              const max = it.quantity - it.receivedQuantity;
              const value = receiveQty[it.catalogueItemId] ?? 0;
              return (
                <Row key={it.catalogueItemId} style={{ justifyContent: 'space-between' }}>
                  <View style={{ flex: 1, gap: 1 }}>
                    <Text style={styles.lineName} numberOfLines={1}>{it.name}</Text>
                    <Text style={styles.meta}>{t('sc.poReceivedQty', { qty: it.receivedQuantity })} / {it.quantity}</Text>
                  </View>
                  <Row gap={8}>
                    <Pressable onPress={() => setReceiveQty((q) => ({ ...q, [it.catalogueItemId]: Math.max(0, value - 1) }))} style={styles.stepBtn} hitSlop={6}>
                      <Text style={styles.stepText}>−</Text>
                    </Pressable>
                    <Text style={styles.stepValue}>{value}</Text>
                    <Pressable onPress={() => setReceiveQty((q) => ({ ...q, [it.catalogueItemId]: Math.min(max, value + 1) }))} style={styles.stepBtn} hitSlop={6}>
                      <Text style={styles.stepText}>+</Text>
                    </Pressable>
                  </Row>
                </Row>
              );
            })}
            {error ? <Text style={{ color: Colors.danger, fontSize: FontSize.xs }}>{error}</Text> : null}
            <Btn label={t('sc.poReceive')} size="lg" loading={busy} disabled={!Object.values(receiveQty).some((q) => q > 0)} onPress={receive} />
          </View>
        ) : null}
      </SheetModal>

      <SheetModal visible={sheet === 'cancel'} onClose={() => setSheet(null)} title={t('sc.poCancelTitle')}>
        <View style={{ gap: Spacing.md }}>
          <Field label={t('sc.poCancelReason')} value={cancelReason} onChangeText={setCancelReason} placeholder={t('sc.poCancelReasonPh')} maxLength={500} />
          {error ? <Text style={{ color: Colors.danger, fontSize: FontSize.xs }}>{error}</Text> : null}
          <Btn label={t('sc.poCancel')} variant="danger" size="lg" loading={busy} disabled={!cancelReason.trim()} onPress={cancel} />
        </View>
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
  lineBox: { borderWidth: 1, borderColor: Colors.border, borderRadius: Radius.md, padding: Spacing.sm, gap: 2 },
  lineName: { fontSize: FontSize.sm, color: Colors.text, flex: 1 },
  catalogRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.border,
  },
  catalogName: { fontSize: FontSize.sm, color: Colors.text, flex: 1 },
  stepBtn: {
    width: 32,
    height: 32,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.borderStrong,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.card,
  },
  stepText: { fontSize: 18, color: Colors.text },
  stepValue: { fontSize: FontSize.lg, fontWeight: '800', color: Colors.text, minWidth: 32, textAlign: 'center' },
});
