/* Dine-in — my bills (GET /dine-in/orders/me) + open a bill from a table QR
 * payload (hudumika:dinein:table:{tableId} — DINE-IN.md). The QR names the
 * table only; the server resolves it (GET /dine-in/tables/{id}/qr) and the
 * menu is the merchant catalogue. Pay runs the payment intent flow
 * (createIntent + confirm, mirroring checkout.tsx); the app never mutates
 * DineInOrder.status — it renders it and refetches. */
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';

import { Btn, Card, Chip, EmptyState, ErrorState, Field, Icon, MoneyText, PriceBreakdown, Row, Screen, Segmented, SheetModal, SkeletonCard, StatusPill } from '@/components/ui';
import { QrScanner } from '@/components/QrScanner';
import { Colors, Fonts, FontSize, Spacing } from '@/constants/theme';
import { t } from '@/i18n';
import { toast } from '@/store/ui';
import { useSessionStore } from '@/store/session';
import { getDineInRepository, getMerchantsRepository, getPaymentsRepository } from '@/repos';
import { idempotencyKey } from '@/lib/idempotency';
import { dateISO } from '@/lib/dates';
import { formatTZS } from '@/lib/format';
import { parseTableQr, DINE_IN_QR_EXAMPLE } from '@/lib/dineIn';
import { ApiError } from '@/api/client';
import type { Catalogue, DineInOrder, MerchantPublic } from '@hudumika/contract';

interface BasketLine {
  catalogueItemId: string;
  name: string;
  unitPriceTZS: number;
  quantity: number;
}

interface MenuCtx {
  merchantId: string;
  merchantName: string;
  tableId: string;
  catalogue: Catalogue;
}

export default function DineInScreen() {
  const router = useRouter();
  const user = useSessionStore((s) => s.user);
  const [bills, setBills] = useState<DineInOrder[] | null>(null);
  const [merchants, setMerchants] = useState<MerchantPublic[]>([]);
  const [error, setError] = useState('');
  const [qr, setQr] = useState('');
  const [qrError, setQrError] = useState('');
  const [scannerOpen, setScannerOpen] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [menu, setMenu] = useState<MenuCtx | null>(null);
  const [basket, setBasket] = useState<BasketLine[]>([]);
  const [opening, setOpening] = useState(false);
  const [detail, setDetail] = useState<DineInOrder | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [banner, setBanner] = useState('');
  const [paying, setPaying] = useState(false);
  const [splitChecking, setSplitChecking] = useState(false);
  const [splitSheet, setSplitSheet] = useState(false);
  const [splitMode, setSplitMode] = useState<'preset' | 'custom'>('preset');
  const [splitDiners, setSplitDiners] = useState<2 | 3 | 4>(2);
  const [splitRows, setSplitRows] = useState<{ label: string; amount: string }[]>([
    { label: t('split.you'), amount: '' },
    { label: t('split.person', { n: 1 }), amount: '' },
  ]);
  const [splitting, setSplitting] = useState(false);
  const [splitError, setSplitError] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      const [mine, all] = await Promise.all([getDineInRepository().listMyOrders(), getMerchantsRepository().list()]);
      setBills(mine);
      if (all.length) setMerchants(all);
    } catch {
      setError(t('common.error'));
    }
  }, []);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const merchantName = useCallback((id: string) => merchants.find((m) => m.id === id)?.businessName ?? id, [merchants]);

  const openDetail = useCallback(
    async (orderId: string) => {
      setDetailLoading(true);
      setError('');
      setBanner('');
      try {
        setDetail(await getDineInRepository().getOrder(orderId));
      } catch (e) {
        if (e instanceof ApiError && (e.code === 'DINE_IN_ORDER_NOT_FOUND' || e.status === 403 || e.status === 404)) {
          toast(t('dineIn.orderNotFound'), 'error');
          load();
        } else {
          toast(t('common.error'), 'error');
        }
      } finally {
        setDetailLoading(false);
      }
    },
    [load],
  );

  const resolveQr = async (raw?: string) => {
    const parsed = parseTableQr(raw ?? qr);
    if (!parsed) {
      setQrError(t('dineIn.qrInvalid'));
      return;
    }
    const tableId = parsed.tableId;
    setQrError('');
    setResolving(true);
    setBanner('');
    try {
      // The QR names the table only — the server resolves the table context
      // (merchant + menu). No merchant guessing from the table id.
      const resolved = await getDineInRepository().resolveTable(tableId);
      const merchant = await getMerchantsRepository().get(resolved.merchantId);
      const catalogue = await getMerchantsRepository().getCatalogue(resolved.merchantId);
      setBasket([]);
      setDetail(null);
      setMenu({ merchantId: resolved.merchantId, merchantName: merchant.businessName, tableId, catalogue });
    } catch (e) {
      setMenu(null);
      if (e instanceof ApiError && e.code === 'DINE_IN_TABLE_NOT_FOUND') {
        setQrError(t('dineIn.tableNotFound'));
      } else if (e instanceof ApiError && e.code === 'DINE_IN_TABLE_IN_USE') {
        // The table already has an open bill — surface the banner and jump
        // to it from the history (DINE-IN.md Gate step).
        setBanner(t('dineIn.tableInUse'));
        try {
          const mine = await getDineInRepository().listMyOrders();
          const open = mine.find((o) => o.tableId === tableId && (o.status === 'open' || o.status === 'billing'));
          if (open) void openDetail(open.id);
        } catch {
          /* history will show the open bill on the list below */
        }
      } else {
        toast(t('common.error'), 'error');
      }
    } finally {
      setResolving(false);
    }
  };

  const addItem = (item: { catalogueItemId: string; name: string; unitPriceTZS: number }) => {
    setBasket((prev) => {
      const existing = prev.find((l) => l.catalogueItemId === item.catalogueItemId);
      if (existing) return prev.map((l) => (l.catalogueItemId === item.catalogueItemId ? { ...l, quantity: l.quantity + 1 } : l));
      return [...prev, { ...item, quantity: 1 }];
    });
  };

  const adjustItem = (catalogueItemId: string, delta: number) => {
    setBasket((prev) =>
      prev
        .map((l) => (l.catalogueItemId === catalogueItemId ? { ...l, quantity: l.quantity + delta } : l))
        .filter((l) => l.quantity > 0),
    );
  };

  const basketTotal = useMemo(() => basket.reduce((acc, l) => acc + l.unitPriceTZS * l.quantity, 0), [basket]);

  const openBill = async () => {
    if (!menu) return;
    if (basket.length === 0) {
      toast(t('dineIn.addItemsFirst'), 'info');
      return;
    }
    setOpening(true);
    try {
      const order = await getDineInRepository().openOrder(
        menu.merchantId,
        menu.tableId,
        basket.map((l) => ({ catalogueItemId: l.catalogueItemId, quantity: l.quantity })),
        idempotencyKey(user?.id ?? 'cus_1', 'dine-in'),
      );
      toast(t('dineIn.opened', { table: menu.tableId }));
      setBasket([]);
      setMenu(null);
      setDetail(order);
      load();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'DINE_IN_TABLE_IN_USE') {
        setBanner(t('dineIn.tableInUse'));
        setMenu(null);
        load();
      } else {
        toast(e instanceof ApiError ? e.message : t('common.error'), 'error');
      }
    } finally {
      setOpening(false);
    }
  };

  const pay = async (order: DineInOrder) => {
    if (!order || (order.status !== 'open' && order.status !== 'billing')) return;
    setPaying(true);
    try {
      // Payment intent flow (mirrors checkout.tsx): intent → confirm; the
      // server (webhook) moves billing → paid, the app renders paid + paidAt.
      const intent = await getPaymentsRepository().createIntent(order.id, 'mpesa', idempotencyKey(user?.id ?? 'cus_1', 'dine-in.intent'));
      await getPaymentsRepository().confirm(intent.id, idempotencyKey(user?.id ?? 'cus_1', 'dine-in.confirm'));
      toast(t('dineIn.payDone'));
      await openDetail(order.id);
      load();
    } catch (e) {
      if (e instanceof ApiError && (e.code === 'DINE_IN_BILL_NOT_PAYABLE' || e.code === 'DINE_IN_ORDER_STATUS_CONFLICT')) {
        toast(e.code === 'DINE_IN_BILL_NOT_PAYABLE' ? t('dineIn.billNotPayable') : t('dineIn.statusConflict'), 'info');
        await openDetail(order.id);
      } else if (e instanceof ApiError && e.code === 'PAYMENT_ALREADY_PAID') {
        await openDetail(order.id);
      } else {
        toast(e instanceof ApiError ? e.message : t('common.error'), 'error');
      }
    } finally {
      setPaying(false);
    }
  };

  const detailTotalRows = (order: DineInOrder) => [
    { label: t('breakdown.subtotal'), amountTZS: order.totals.subtotalTZS },
    ...(order.totals.discountTZS !== 0 ? [{ label: t('breakdown.discount'), amountTZS: order.totals.discountTZS, signed: true as const }] : []),
  ];

  // Split-bill (mock-first, docs/CONTRACT-ADDITIONS.md #25): the action
  // checks for an existing split first — a bill carries one split, so a
  // second open jumps straight to its summary.
  const openSplit = async () => {
    if (!detail) return;
    setSplitChecking(true);
    try {
      await getDineInRepository().getSplit(detail.id);
      router.push({ pathname: '/dine-in-splits/[splitId]', params: { splitId: detail.id } });
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        setSplitRows([
          { label: t('split.you'), amount: '' },
          { label: t('split.person', { n: 1 }), amount: '' },
        ]);
        setSplitError('');
        setSplitSheet(true);
      } else {
        toast(t('common.error'), 'error');
      }
    } finally {
      setSplitChecking(false);
    }
  };

  // Even split: integer TZS only — base floor per diner, the remainder lands
  // on the initiator's share so the amounts always sum EXACTLY to the total.
  const presetShares = useMemo(() => {
    if (!detail) return [];
    const total = detail.totals.totalTZS;
    const base = Math.floor(total / splitDiners);
    const remainder = total - base * splitDiners;
    return [
      { label: t('split.you'), amountTZS: base + remainder },
      ...Array.from({ length: splitDiners - 1 }, (_, i) => ({ label: t('split.person', { n: i + 1 }), amountTZS: base })),
    ];
  }, [detail, splitDiners]);

  const updateSplitRow = (index: number, key: 'label' | 'amount', value: string) => {
    setSplitRows((prev) => prev.map((r, i) => (i === index ? { ...r, [key]: value } : r)));
  };

  const addSplitRow = () => {
    setSplitRows((prev) => [...prev, { label: t('split.person', { n: prev.length }), amount: '' }]);
  };

  const removeSplitRow = (index: number) => {
    setSplitRows((prev) => prev.filter((_, i) => i !== index));
  };

  // Live custom-share validation: 2+ named shares, integer amounts ≥ 1 that
  // sum EXACTLY to the bill total (mirrors the mock server rule).
  const customSplit = useMemo(() => {
    const total = detail?.totals.totalTZS ?? 0;
    const amounts = splitRows.map((r) => Number(r.amount));
    const labelsOk = splitRows.every((r) => r.label.trim().length > 0);
    const amountsOk = amounts.length >= 2 && amounts.every((a) => Number.isInteger(a) && a >= 1);
    const sum = amountsOk ? amounts.reduce((acc, a) => acc + a, 0) : 0;
    return { valid: labelsOk && amountsOk && sum === total, sum, total };
  }, [splitRows, detail]);

  const confirmSplit = async () => {
    if (!detail) return;
    const shares =
      splitMode === 'preset'
        ? presetShares
        : splitRows.map((r) => ({ label: r.label.trim(), amountTZS: Number(r.amount) }));
    setSplitting(true);
    setSplitError('');
    try {
      await getDineInRepository().splitBill(detail.id, { shares }, idempotencyKey(user?.id ?? 'cus_1', 'dine-in.split'));
      toast(t('dineIn.splitCreated'));
      setSplitSheet(false);
      router.push({ pathname: '/dine-in-splits/[splitId]', params: { splitId: detail.id } });
    } catch (e) {
      if (e instanceof ApiError && e.code === 'CONFLICT') {
        // A split was created between the check and the create — jump to it.
        setSplitSheet(false);
        router.push({ pathname: '/dine-in-splits/[splitId]', params: { splitId: detail.id } });
      } else if (e instanceof ApiError && e.code === 'VALIDATION_FAILED') {
        setSplitError(t('dineIn.splitTotalMustMatch', { amount: formatTZS(detail.totals.totalTZS) }));
      } else if (e instanceof ApiError && e.code === 'DINE_IN_ORDER_STATUS_CONFLICT') {
        toast(t('dineIn.statusConflict'), 'info');
        setSplitSheet(false);
        void openDetail(detail.id);
      } else {
        setSplitError(e instanceof ApiError ? e.message : t('common.error'));
      }
    } finally {
      setSplitting(false);
    }
  };

  // Refetch the bill when the split summary (or any child) pops back — the
  // split completing settles the bill (mock webhook), and the detail must
  // render that fresh state (paid) instead of the stale open one.
  const focusedOrderId = detail?.id ?? null;
  useFocusEffect(
    useCallback(() => {
      if (!focusedOrderId) return;
      void getDineInRepository()
        .getOrder(focusedOrderId)
        .then(setDetail)
        .catch(() => {
          /* best-effort focus refetch — the detail refetches on demand */
        });
    }, [focusedOrderId]),
  );

  if (detailLoading) {
    return (
      <Screen>
        <View style={{ gap: Spacing.md, padding: Spacing.lg }}>
          <SkeletonCard rows={3} />
        </View>
      </Screen>
    );
  }

  if (detail) {
    const payable = detail.status === 'open' || detail.status === 'billing';
    return (
      <Screen scroll>
        <Row style={{ justifyContent: 'space-between', marginBottom: Spacing.md }}>
          <Btn label={t('common.back')} onPress={() => setDetail(null)} variant="subtle" size="sm" icon="arrow-back" />
          <Text style={styles.title}>{t('dineIn.billTitle')}</Text>
          <View style={{ width: 40 }} />
        </Row>
        <Card style={{ gap: Spacing.md }}>
          <Row style={{ justifyContent: 'space-between' }}>
            <View style={{ flex: 1 }}>
              <Text style={styles.name}>{t('dineIn.table', { table: detail.tableId })}</Text>
              <Text style={styles.meta}>{merchantName(detail.merchantId)}</Text>
            </View>
            <StatusPill status={detail.status} />
          </Row>
          <Text style={styles.meta}>{t('dineIn.openedAt', { t: dateISO(detail.createdAt) })}</Text>
          {(detail.items ?? []).map((line) => (
            <Row key={line.catalogueItemId} style={{ justifyContent: 'space-between' }}>
              <Text style={styles.value} numberOfLines={1}>
                {line.name} · {t('dineIn.qty', { n: line.quantity })}
              </Text>
              <MoneyText amountTZS={line.unitPriceTZS * line.quantity} size={FontSize.sm} />
            </Row>
          ))}
          <PriceBreakdown rows={detailTotalRows(detail)} totalTZS={detail.totals.totalTZS} totalLabel={t('breakdown.total')} />
          {detail.status === 'paid' && detail.paidAt ? (
            <Text style={[styles.meta, { color: Colors.success, fontFamily: Fonts.sansSemibold }]}>{t('dineIn.paidAt', { t: dateISO(detail.paidAt) })}</Text>
          ) : null}
          {detail.status === 'closed' ? <Text style={[styles.meta, { color: Colors.textTertiary, fontFamily: Fonts.sansSemibold }]}>{t('dineIn.settled')}</Text> : null}
          {payable ? (
            <Btn
              label={t('dineIn.split')}
              onPress={openSplit}
              variant="ghost"
              icon="people-outline"
              loading={splitChecking}
              style={{ marginTop: Spacing.sm }}
            />
          ) : null}
        </Card>
        {payable ? (
          <Btn label={t('dineIn.requestBill')} size="lg" onPress={() => pay(detail)} loading={paying} style={{ marginTop: Spacing.lg }} />
        ) : null}
        <SheetModal visible={splitSheet} onClose={() => setSplitSheet(false)} title={t('dineIn.splitTitle')}>
          <Row gap={Spacing.sm} style={{ marginBottom: Spacing.md }}>
            <View style={{ flex: 1 }}>
              <Segmented
                options={[
                  { key: 'preset', label: t('dineIn.splitDiners') },
                  { key: 'custom', label: t('dineIn.splitCustom') },
                ]}
                value={splitMode}
                onChange={setSplitMode}
                equal
              />
            </View>
          </Row>
          {splitMode === 'preset' ? (
            <View style={{ gap: Spacing.md }}>
              <Row gap={Spacing.sm}>
                {([2, 3, 4] as const).map((n) => (
                  <Chip key={n} label={`${n}`} selected={splitDiners === n} onPress={() => setSplitDiners(n)} />
                ))}
              </Row>
              {presetShares.map((s) => (
                <Row key={s.label} style={{ justifyContent: 'space-between' }}>
                  <Text style={styles.value}>{s.label}</Text>
                  <MoneyText amountTZS={s.amountTZS} size={FontSize.sm} />
                </Row>
              ))}
            </View>
          ) : (
            <View style={{ gap: Spacing.md }}>
              {splitRows.map((row, i) => (
                <View key={i} style={{ gap: Spacing.xs }}>
                  <Row gap={Spacing.sm}>
                    <View style={{ flex: 1 }}>
                      <Field
                        label={t('dineIn.splitShareLabel')}
                        value={row.label}
                        onChangeText={(v) => updateSplitRow(i, 'label', v)}
                        placeholder={t('split.you')}
                      />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Field
                        label={t('dineIn.splitShareAmount')}
                        value={row.amount}
                        onChangeText={(v) => updateSplitRow(i, 'amount', v)}
                        keyboardType="numeric"
                        placeholder="0"
                      />
                    </View>
                  </Row>
                  {splitRows.length > 2 ? (
                    <Btn label={t('split.removeShare')} variant="subtle" size="sm" onPress={() => removeSplitRow(i)} icon="trash-outline" />
                  ) : null}
                </View>
              ))}
              <Btn label={t('split.addShare')} variant="ghost" size="sm" onPress={addSplitRow} icon="add" />
            </View>
          )}
          {splitMode === 'custom' && !customSplit.valid ? (
            <Text style={styles.errorText}>{t('dineIn.splitTotalMustMatch', { amount: formatTZS(customSplit.total) })}</Text>
          ) : null}
          {splitError ? <Text style={styles.errorText}>{splitError}</Text> : null}
          <Btn
            label={t('dineIn.split')}
            size="lg"
            onPress={confirmSplit}
            loading={splitting}
            disabled={splitMode === 'custom' && !customSplit.valid}
            style={{ marginTop: Spacing.md }}
          />
        </SheetModal>
      </Screen>
    );
  }

  if (menu) {
    return (
      <Screen>
        <View style={{ paddingHorizontal: Spacing.lg, paddingTop: Spacing.lg }}>
          <Row style={{ justifyContent: 'space-between', marginBottom: Spacing.md }}>
            <Btn label={t('common.back')} onPress={() => setMenu(null)} variant="subtle" size="sm" icon="arrow-back" />
            <Text style={styles.title}>{t('dineIn.menuFrom', { merchant: menu.merchantName })}</Text>
            <View style={{ width: 40 }} />
          </Row>
        </View>
        <FlatList
          data={menu.catalogue.items}
          keyExtractor={(i) => i.id ?? i.name}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ padding: Spacing.lg, paddingBottom: 60 }}
          ListEmptyComponent={<EmptyState icon="restaurant-outline" title={t('dineIn.menuEmpty')} />}
          ListFooterComponent={
            <Card style={styles.basketCard}>
              <Text style={styles.sectionLabel}>{t('dineIn.basket')}</Text>
              {basket.length === 0 ? (
                <Text style={styles.meta}>{t('dineIn.basketEmpty')}</Text>
              ) : (
                basket.map((l) => (
                  <Row key={l.catalogueItemId} style={{ justifyContent: 'space-between', marginVertical: Spacing.xs }}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.value} numberOfLines={1}>{l.name}</Text>
                      <Text style={styles.meta}>{t('dineIn.qty', { n: l.quantity })}</Text>
                    </View>
                    <Row gap={Spacing.sm}>
                      <Pressable onPress={() => adjustItem(l.catalogueItemId, -1)} accessibilityRole="button" style={styles.qtyBtn}>
                        <Icon name="remove" size={14} color={Colors.text} />
                      </Pressable>
                      <Pressable onPress={() => adjustItem(l.catalogueItemId, 1)} accessibilityRole="button" style={styles.qtyBtn}>
                        <Icon name="add" size={14} color={Colors.text} />
                      </Pressable>
                      <MoneyText amountTZS={l.unitPriceTZS * l.quantity} size={FontSize.sm} />
                    </Row>
                  </Row>
                ))
              )}
              {basket.length > 0 ? (
                <Btn
                  label={t('dineIn.openBill', { amount: formatTZS(basketTotal) })}
                  size="lg"
                  onPress={openBill}
                  loading={opening}
                  style={{ marginTop: Spacing.md }}
                />
              ) : null}
            </Card>
          }
          renderItem={({ item }) => {
            const unavailable = item.available === false;
            return (
              <Card style={[styles.menuItem, unavailable && { opacity: 0.55 }]} flat>
                <Row style={{ justifyContent: 'space-between' }}>
                  <View style={{ flex: 1, paddingRight: Spacing.md }}>
                    <Text style={[styles.name, unavailable && { color: Colors.textTertiary }]} numberOfLines={1}>{item.name}</Text>
                    {item.description ? <Text style={styles.meta} numberOfLines={2}>{item.description}</Text> : null}
                    <MoneyText amountTZS={item.priceTZS} size={FontSize.sm} bold />
                    {unavailable ? <Text style={[styles.meta, { color: Colors.textTertiary, fontFamily: Fonts.sansSemibold }]}>{t('dineIn.itemUnavailable')}</Text> : null}
                  </View>
                  {unavailable ? null : (
                    <Btn label={t('dineIn.add')} size="sm" onPress={() => addItem({ catalogueItemId: item.id!, name: item.name, unitPriceTZS: item.priceTZS })} icon="add" />
                  )}
                </Row>
              </Card>
            );
          }}
        />
      </Screen>
    );
  }

  return (
    <Screen>
      <View style={{ paddingHorizontal: Spacing.lg, paddingTop: Spacing.lg }}>
        <Row style={{ justifyContent: 'space-between', marginBottom: Spacing.md }}>
          <Btn label={t('common.back')} onPress={() => router.back()} variant="subtle" size="sm" icon="arrow-back" />
          <Text style={styles.title}>{t('dineIn.title')}</Text>
          <View style={{ width: 40 }} />
        </Row>
        <Card style={{ gap: Spacing.md, marginBottom: Spacing.lg }}>
          <Text style={styles.sectionLabel}>{t('dineIn.qrLabel')}</Text>
          <Row gap={Spacing.sm} style={{ alignItems: 'flex-start' }}>
            <View style={{ flex: 1 }}>
              <Field label={t('dineIn.qrField')} value={qr} onChangeText={(v) => { setQr(v); setQrError(''); }} placeholder={DINE_IN_QR_EXAMPLE} autoCapitalize="none" />
              {qrError ? <Text style={styles.errorText}>{qrError}</Text> : null}
            </View>
            <Btn
              label={t('dineIn.scan')}
              onPress={() => { setScannerOpen(true); }}
              icon="scan-outline"
              style={{ marginTop: 22 }}
            />
          </Row>
          <Btn label={t('dineIn.open')} onPress={() => resolveQr()} loading={resolving} icon="scan-outline" />
        </Card>
        <QrScanner
          visible={scannerOpen}
          onClose={() => setScannerOpen(false)}
          onScan={(payload) => {
            setScannerOpen(false);
            setQr(payload);
            setQrError('');
            void resolveQr(payload);
          }}
        />
        {banner ? (
          <Card style={[styles.bannerCard, { backgroundColor: Colors.warningSoft }]}>
            <Row gap={Spacing.md}>
              <Icon name="alert-circle-outline" size={18} color={Colors.warning} />
              <Text style={[styles.meta, { color: Colors.text, flex: 1 }]}>{banner}</Text>
            </Row>
          </Card>
        ) : null}
        <Text style={[styles.sectionLabel, { marginBottom: Spacing.sm }]}>{t('dineIn.history')}</Text>
      </View>
      {error ? (
        <ErrorState message={error} onRetry={load} />
      ) : !bills ? (
        <View style={{ gap: Spacing.md, padding: Spacing.lg }}>
          <SkeletonCard rows={2} />
        </View>
      ) : bills.length === 0 ? (
        <EmptyState icon="restaurant-outline" title={t('dineIn.empty')} sub={t('dineIn.emptyHint')} />
      ) : (
        <FlatList
          data={bills}
          keyExtractor={(b) => b.id}
          onRefresh={load}
          refreshing={false}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ paddingHorizontal: Spacing.lg, paddingBottom: 60 }}
          renderItem={({ item }) => (
            <Card style={styles.historyCard} onPress={() => openDetail(item.id)}>
              <Row style={{ justifyContent: 'space-between' }}>
                <View style={{ flex: 1, paddingRight: Spacing.md }}>
                  <Text style={styles.name}>{t('dineIn.table', { table: item.tableId })}</Text>
                  <Text style={styles.meta} numberOfLines={1}>{merchantName(item.merchantId)}</Text>
                </View>
                <StatusPill status={item.status} />
              </Row>
              <Row style={{ justifyContent: 'space-between', marginTop: Spacing.sm }}>
                <Text style={styles.meta}>{dateISO(item.createdAt)}</Text>
                <MoneyText amountTZS={item.totals.totalTZS} size={FontSize.md} bold />
              </Row>
            </Card>
          )}
        />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: FontSize.lg, fontFamily: Fonts.sansBold, color: Colors.text, flex: 1, textAlign: 'center' },
  sectionLabel: { fontSize: FontSize.sm, color: Colors.textTertiary, fontFamily: Fonts.sansSemibold },
  name: { fontSize: FontSize.md, fontFamily: Fonts.sansSemibold, color: Colors.text },
  value: { fontSize: FontSize.sm, color: Colors.text, fontFamily: Fonts.sansMedium },
  meta: { fontSize: FontSize.xs, color: Colors.textTertiary, fontFamily: Fonts.sans, marginTop: 2 },
  errorText: { color: Colors.danger, fontSize: FontSize.xs, fontFamily: Fonts.sansSemibold },
  bannerCard: { marginBottom: Spacing.lg },
  historyCard: { marginBottom: Spacing.md },
  menuItem: { marginBottom: Spacing.md, backgroundColor: Colors.card },
  basketCard: { marginTop: Spacing.md, gap: Spacing.sm },
  qtyBtn: { width: 28, height: 28, borderRadius: 14, borderWidth: 1, borderColor: Colors.borderStrong, alignItems: 'center', justifyContent: 'center' },
});
