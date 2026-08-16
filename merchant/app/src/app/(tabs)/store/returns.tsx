import { Stack, router } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Btn, Card, Chip, Empty, Field, Icon, Pill, Row, Screen, SheetModal } from '@/components/ui';
import { Colors, FontSize, Radius, Spacing } from '@/constants/theme';
import { t, onLocaleChange, type I18nKey } from '@/i18n';
import { fullTime } from '@/lib/format';
import type { Supplier, SupplierReturnDetail, SupplierReturnStatus } from '@/api/types';
import { useSupplyChainStore } from '@/store/supply-chain';
import { useMessageStore } from '@/store/messages';

const STATUS_PILL: Record<SupplierReturnStatus, { label: I18nKey; tone: 'neutral' | 'success' | 'warning' | 'danger' | 'info' }> = {
  pending: { label: 'rt.statusPending', tone: 'warning' },
  processed: { label: 'rt.statusProcessed', tone: 'success' },
  rejected: { label: 'rt.statusRejected', tone: 'danger' },
};

const REASON_CODES = [
  { key: 'damaged', label: 'rt.reasonDamaged' },
  { key: 'expired', label: 'rt.reasonExpired' },
  { key: 'wrong_item', label: 'rt.reasonWrongItem' },
  { key: 'over_delivery', label: 'rt.reasonOverDelivery' },
] as const;

export default function SupplierReturnsScreen() {
  useSyncExternalStore(onLocaleChange, () => 0);
  const returns = useSupplyChainStore((s) => s.supplierReturns);
  const returnsError = useSupplyChainStore((s) => s.supplierReturnsError);
  const returnsLoading = useSupplyChainStore((s) => s.supplierReturnsLoading);
  const hydrateReturns = useSupplyChainStore((s) => s.hydrateSupplierReturns);
  const suppliers = useSupplyChainStore((s) => s.suppliers);
  const hydrateSuppliers = useSupplyChainStore((s) => s.hydrateSuppliers);
  const inventory = useSupplyChainStore((s) => s.inventory);
  const hydrateInventory = useSupplyChainStore((s) => s.hydrateInventory);
  const createReturn = useSupplyChainStore((s) => s.createSupplierReturn);
  const processReturn = useSupplyChainStore((s) => s.processSupplierReturn);
  const rejectReturn = useSupplyChainStore((s) => s.rejectSupplierReturn);
  const pushMessage = useMessageStore((s) => s.push);

  const [sheet, setSheet] = useState<null | 'create' | 'reject'>(null);
  const [target, setTarget] = useState<SupplierReturnDetail | null>(null);
  const [supplierId, setSupplierId] = useState('');
  const [lines, setLines] = useState<Record<string, string>>({});
  const [reason, setReason] = useState('');
  const [rejectReason, setRejectReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    await Promise.all([hydrateReturns(), hydrateSuppliers(), hydrateInventory()]);
  }, [hydrateReturns, hydrateSuppliers, hydrateInventory]);

  useEffect(() => {
    load().catch(() => undefined);
  }, [load]);

  const openCreate = () => {
    setSupplierId(suppliers.rows[0]?.id ?? '');
    setLines({});
    setReason('');
    setError('');
    setSheet('create');
  };

  const setLine = (catalogueItemId: string, v: string) => {
    setLines((prev) => ({ ...prev, [catalogueItemId]: v }));
  };

  const submit = async () => {
    const items = Object.entries(lines)
      .map(([catalogueItemId, qty]) => ({ catalogueItemId, quantity: Number(qty) }))
      .filter((l) => Number.isInteger(l.quantity) && l.quantity > 0);
    if (!supplierId || items.length === 0 || !reason.trim()) {
      setError(t('rt.errFill'));
      return;
    }
    setBusy(true);
    setError('');
    const res = await createReturn({ supplierId, items, reason: reason.trim() });
    setBusy(false);
    if (res.ok) {
      setSheet(null);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      pushMessage({ type: 'system', title: t('rt.created'), body: `${items.length} line(s) · ${reason.trim()}` });
      hydrateReturns();
    } else {
      setError(res.message ?? t('rt.errCreate'));
    }
  };

  const process = async (r: SupplierReturnDetail) => {
    setBusy(true);
    const res = await processReturn(r.id);
    setBusy(false);
    if (res.ok) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      pushMessage({ type: 'system', title: t('rt.processed'), body: r.id });
    } else {
      setError(res.message ?? t('rt.errProcess'));
    }
  };

  const openReject = (r: SupplierReturnDetail) => {
    setTarget(r);
    setRejectReason('');
    setError('');
    setSheet('reject');
  };

  const reject = async () => {
    if (!target || !rejectReason.trim()) return;
    setBusy(true);
    setError('');
    const res = await rejectReturn(target.id, rejectReason.trim());
    setBusy(false);
    if (res.ok) {
      setSheet(null);
      setTarget(null);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      pushMessage({ type: 'system', title: t('rt.rejected'), body: rejectReason.trim() });
    } else {
      setError(res.message ?? t('rt.errReject'));
    }
  };

  const supplierName = (id: string) => suppliers.rows.find((s: Supplier) => s.id === id)?.name ?? id;
  const itemName = (id: string) => inventory.rows.find((i) => i.catalogueItemId === id)?.name ?? id;
  const anyLine = Object.values(lines).some((v) => Number(v) > 0);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: Colors.bg }} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.topBar}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Icon name="chevron-back" size={26} color={Colors.text} />
        </Pressable>
        <Text style={styles.topTitle}>{t('rt.title')}</Text>
        <Btn label={t('common.add')} icon="add" size="sm" onPress={openCreate} />
      </View>

      <Screen scroll>
        <Row style={{ marginTop: Spacing.md }}>
          <Text style={{ fontSize: FontSize.xs, color: Colors.textTertiary, flex: 1 }}>{t('rt.sub')}</Text>
        </Row>

        {returnsError ? (
          <View style={{ alignItems: 'center', gap: Spacing.sm, paddingVertical: Spacing.lg }}>
            <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '600' }}>{returnsError}</Text>
            <Btn label={t('common.retry')} size="sm" variant="outline" onPress={() => load()} />
          </View>
        ) : null}

        <View style={{ gap: Spacing.md, marginTop: Spacing.md }}>
          {!returnsLoading && returns.length === 0 && !returnsError ? (
            <Empty icon="return-up-back-outline" title={t('rt.empty')} sub={t('rt.emptySub')} />
          ) : null}
          {returns.map((r) => (
            <Card key={r.id} style={{ gap: Spacing.sm }}>
              <Row style={{ justifyContent: 'space-between' }}>
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={styles.name} numberOfLines={1}>{supplierName(r.supplierId)}</Text>
                  <Text style={styles.meta}>{fullTime(r.createdAt)} · {r.items.reduce((s, it) => s + it.quantity, 0)} unit(s)</Text>
                </View>
                <Pill label={t(STATUS_PILL[r.status].label)} tone={STATUS_PILL[r.status].tone} />
              </Row>
              <View style={{ gap: 2 }}>
                {r.items.map((it) => (
                  <Text key={it.catalogueItemId} style={styles.meta} numberOfLines={1}>
                    · {itemName(it.catalogueItemId)} × {it.quantity}
                  </Text>
                ))}
              </View>
              <Text style={styles.meta}>{t('rt.reason')}: {r.reason}</Text>
              {r.status === 'rejected' && r.rejectionReason ? (
                <Text style={styles.meta}>{t('rt.rejectionReason')}: {r.rejectionReason}</Text>
              ) : null}
              {r.status === 'pending' ? (
                <Row gap={Spacing.sm}>
                  <Btn label={t('rt.process')} variant="success" size="sm" style={{ flex: 1 }} loading={busy} onPress={() => process(r)} />
                  <Btn label={t('rt.reject')} variant="danger" size="sm" style={{ flex: 1 }} onPress={() => openReject(r)} />
                </Row>
              ) : null}
            </Card>
          ))}
        </View>
      </Screen>

      <SheetModal visible={sheet === 'create'} onClose={() => setSheet(null)} title={t('rt.createTitle')}>
        <View style={{ gap: Spacing.md }}>
          <Text style={styles.fieldLabel}>{t('rt.supplier')}</Text>
          <Row gap={8} style={{ flexWrap: 'wrap' }}>
            {suppliers.rows.filter((s: Supplier) => s.status === 'active').map((s: Supplier) => (
              <Chip key={s.id} label={s.name} selected={supplierId === s.id} onPress={() => setSupplierId(s.id)} />
            ))}
          </Row>
          <Text style={styles.fieldLabel}>{t('rt.items')}</Text>
          {inventory.rows.map((item) => {
            const value = lines[item.catalogueItemId] ?? '0';
            return (
              <Row key={item.catalogueItemId} style={{ justifyContent: 'space-between' }}>
                <View style={{ flex: 1, gap: 1 }}>
                  <Text style={styles.lineName} numberOfLines={1}>{item.name}</Text>
                  <Text style={styles.meta}>{t('sc.stockOnHand')} {item.stockOnHand}</Text>
                </View>
                <View style={styles.qtyBox}>
                  <Pressable onPress={() => setLine(item.catalogueItemId, String(Math.max(0, Number(value) - 1)))} style={styles.stepBtn} hitSlop={6}>
                    <Text style={styles.stepText}>−</Text>
                  </Pressable>
                  <Text style={styles.stepValue}>{value}</Text>
                  <Pressable onPress={() => setLine(item.catalogueItemId, String(Math.min(item.stockOnHand, Number(value) + 1)))} style={styles.stepBtn} hitSlop={6}>
                    <Text style={styles.stepText}>+</Text>
                  </Pressable>
                </View>
              </Row>
            );
          })}
          <Text style={styles.fieldLabel}>{t('rt.reason')}</Text>
          <Row gap={8} style={{ flexWrap: 'wrap' }}>
            {REASON_CODES.map((c) => (
              <Chip key={c.key} label={t(c.label)} selected={reason === t(c.label)} onPress={() => setReason(t(c.label))} />
            ))}
          </Row>
          <Field label={t('rt.reasonDetail')} value={reason} onChangeText={setReason} placeholder={t('rt.reasonPh')} maxLength={500} multiline />
          {error ? <Text style={{ color: Colors.danger, fontSize: FontSize.xs }}>{error}</Text> : null}
          <Btn label={t('rt.create')} size="lg" loading={busy} disabled={!supplierId || !anyLine || !reason.trim()} onPress={submit} />
        </View>
      </SheetModal>

      <SheetModal visible={sheet === 'reject'} onClose={() => setSheet(null)} title={t('rt.rejectTitle')}>
        <View style={{ gap: Spacing.md }}>
          <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary, lineHeight: 19 }}>
            {target ? t('rt.rejectBody', { id: target.id }) : ''}
          </Text>
          <Field label={t('rt.rejectionReason')} value={rejectReason} onChangeText={setRejectReason} placeholder={t('rt.reasonPh')} maxLength={500} multiline />
          {error ? <Text style={{ color: Colors.danger, fontSize: FontSize.xs }}>{error}</Text> : null}
          <Row gap={Spacing.sm}>
            <Btn label={t('common.cancel')} variant="outline" size="sm" style={{ flex: 1 }} onPress={() => setSheet(null)} />
            <Btn label={t('rt.reject')} variant="danger" size="sm" style={{ flex: 1 }} loading={busy} disabled={!rejectReason.trim()} onPress={reject} />
          </Row>
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
  lineName: { fontSize: FontSize.sm, color: Colors.text, flex: 1 },
  fieldLabel: { fontSize: FontSize.sm, color: Colors.textSecondary, fontWeight: '600' },
  qtyBox: { flexDirection: 'row', alignItems: 'center', gap: 8 },
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
