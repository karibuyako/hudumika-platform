import { Stack, router, useLocalSearchParams } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Btn, Card, Icon, Row, SheetModal } from '@/components/ui';
import { Colors, FontSize, Radius, Spacing } from '@/constants/theme';
import { t, onLocaleChange } from '@/i18n';
import { api } from '@/api/client';
import type { OrderDto, Payment, Printer, ReceiptTemplate } from '@/api/types';
import { fullTime, tzs } from '@/lib/format';

interface Receipt {
  order: OrderDto;
  payment?: Payment;
  store?: { id?: string; name: string; phone: string; address: string };
}

export default function PrintScreen() {
  useSyncExternalStore(onLocaleChange, () => 0);
  const { ids } = useLocalSearchParams<{ ids: string }>();
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [templates, setTemplates] = useState<Map<string, ReceiptTemplate | null>>(new Map());
  const [printed, setPrinted] = useState(false);
  const [hasReceiptPrinter, setHasReceiptPrinter] = useState(false);
  const [printBusy, setPrintBusy] = useState(false);
  const [printError, setPrintError] = useState<string | null>(null);

  useEffect(() => {
    if (!ids) return;
    api
      .get<{ receipts: Receipt[] }>(`/orders/receipts?ids=${encodeURIComponent(ids)}`, { retries: 1 })
      .then((r) => setReceipts(r.receipts))
      .catch(() => undefined);
  }, [ids]);

  useEffect(() => {
    const storeIds = new Set(receipts.map((r) => r.store?.id ?? 's_demo'));
    storeIds.forEach((sid) => {
      if (templates.has(sid)) return;
      api
        .get<{ template: ReceiptTemplate }>(`/receipt-templates/active?storeId=${sid}`, { retries: 1 })
        .then((r) => setTemplates((prev) => new Map(prev).set(sid, r.template)))
        .catch(() => setTemplates((prev) => new Map(prev).set(sid, null)));
    });
  }, [receipts, templates]);

  useEffect(() => {
    api
      .get<{ printers: Printer[] }>('/printers?storeId=s_demo', { retries: 1 })
      .then((r) => setHasReceiptPrinter(r.printers.some((p) => p.status === 'connected' && p.purpose === 'receipt')))
      .catch(() => setHasReceiptPrinter(false));
  }, []);

  const doPrint = async () => {
    if (!receipts.length) return;
    setPrintBusy(true);
    setPrintError(null);
    try {
      // The reprint path goes through the print queue (POST /print-jobs,
      // jobType receipt) — never a silent window.print() bypass.
      await api.post<{ id: string }>(
        '/print-jobs',
        { jobType: 'receipt', orderIds: receipts.map((r) => r.order.id), copies: 1 },
        { idempotencyKey: `batch-print:${Date.now()}` },
      );
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      if (Platform.OS === 'web') {
        setTimeout(() => window.print(), 300);
      }
      setPrinted(true);
      setTimeout(() => setPrinted(false), 2200);
    } catch {
      setPrintError(t('print.offline'));
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      setPrintBusy(false);
    }
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: Colors.bg }} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.topBar}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Icon name="chevron-back" size={26} color={Colors.text} />
        </Pressable>
        <Text style={styles.topTitle}>{t('print.title', { n: receipts.length })}</Text>
        <View style={{ width: 26 }} />
      </View>

      <ScrollView contentContainerStyle={{ padding: Spacing.lg, gap: Spacing.md, paddingBottom: 40 }}>
        {printError ? (
          <Card>
            <Row gap={8} style={{ alignItems: 'flex-start' }}>
              <Icon name="alert-circle-outline" size={15} color={Colors.danger} />
              <Text style={{ fontSize: FontSize.xs, color: Colors.danger, fontWeight: '600', flex: 1 }}>
                {printError}
              </Text>
            </Row>
          </Card>
        ) : null}
        {!hasReceiptPrinter ? (
          <Card>
            <Row gap={8} style={{ alignItems: 'flex-start' }}>
              <Icon name="print-outline" size={15} color={Colors.warning} />
              <Text style={{ fontSize: FontSize.xs, color: Colors.warning, fontWeight: '600', flex: 1 }}>
                {t('print.noPrinter')}
              </Text>
            </Row>
          </Card>
        ) : null}
        {receipts.map((r) => {
          const template = templates.get(r.store?.id ?? 's_demo');
          return (
            <View key={r.order.id} style={styles.receipt}>
              {template?.showLogo && template.logoEmoji ? <Text style={styles.receiptEmoji}>{template.logoEmoji}</Text> : null}
              <Text style={styles.storeName}>{template?.headerText || r.store?.name || t('print.store')}</Text>
              <Text style={styles.storeMeta}>{r.store?.address} · {r.store?.phone}</Text>
              {template ? <Text style={styles.templateNote}>{t('print.template', { n: template.name })}</Text> : null}
              <View style={styles.receiptDivider} />
              <Row style={{ justifyContent: 'space-between' }}>
                <Text style={styles.receiptNo}>{r.order.no}</Text>
                <Text style={styles.receiptTime}>{fullTime(r.order.createdAt)}</Text>
              </Row>
              {r.order.scheduledAt ? (
                <Text style={styles.preorder}>{t('print.preorder', { t: fullTime(r.order.scheduledAt) })}</Text>
              ) : null}
              <View style={styles.receiptDivider} />
              {r.order.items.map((it, i) => (
                <Row key={i} style={{ justifyContent: 'space-between', paddingVertical: 3 }}>
                  <Text style={styles.item}>
                    {it.emoji} {it.name}
                    {it.variants.length ? ` (${it.variants.join('/')})` : ''} ×{it.qty}
                  </Text>
                  <Text style={styles.item}>{tzs(it.price * it.qty)}</Text>
                </Row>
              ))}
              <View style={styles.receiptDivider} />
              <Row style={{ justifyContent: 'space-between', paddingVertical: 2 }}>
                <Text style={styles.meta}>{t('print.subtotal')}</Text>
                <Text style={styles.meta}>{tzs(r.order.subtotal)}</Text>
              </Row>
              <Row style={{ justifyContent: 'space-between', paddingVertical: 2 }}>
                <Text style={styles.meta}>{r.order.deliveryType === 'pickup' ? t('print.pickup') : t('print.delivery')}</Text>
                <Text style={styles.meta}>{tzs(r.order.deliveryFee)}</Text>
              </Row>
              <Row style={{ justifyContent: 'space-between', paddingVertical: 4 }}>
                <Text style={styles.totalLabel}>{t('print.total')}</Text>
                <Text style={styles.totalValue}>{tzs(r.order.total)}</Text>
              </Row>
              {r.payment && template?.showPayment !== false ? (
                <Text style={styles.meta}>
                  {t('print.paidVia', { m: r.payment.method.toUpperCase(), s: r.payment.status.toUpperCase() })}
                  {r.payment.refundedAmount > 0 ? ` · ${t('print.refunded', { a: tzs(r.payment.refundedAmount) })}` : ''}
                </Text>
              ) : null}
              <Text style={styles.meta}>
                {t('print.customer', { n: r.order.customer.name, p: r.order.customer.phone })}
              </Text>
              <Text style={styles.meta}>{r.order.deliveryType === 'pickup' ? t('print.pickupAtStore') : r.order.customer.address}</Text>
              {r.order.note ? <Text style={styles.note}>{t('print.note', { n: r.order.note })}</Text> : null}
              {r.order.rider && template?.showRider !== false ? <Text style={styles.meta}>{t('print.rider', { n: r.order.rider })}</Text> : null}
              {template?.footerText ? <Text style={[styles.meta, { textAlign: 'center' }]}>{template.footerText}</Text> : null}
              {template?.showQRCode ? (
                <View style={styles.qrPlaceholder}>
                  <Text style={styles.qrText}>QR</Text>
                </View>
              ) : null}
              <View style={styles.barcode}>
                <Text style={styles.barcodeText}>{'||||||||||||||||||||||||||||||||||||'}</Text>
                <Text style={styles.meta}>{r.order.no}</Text>
              </View>
            </View>
          );
        })}
      </ScrollView>

      <View style={styles.footer}>
        <Btn
          label={Platform.OS === 'web' ? t('print.count', { n: receipts.length }) : t('print.sendToPrinter')}
          icon="print-outline"
          size="lg"
          disabled={!receipts.length}
          loading={printBusy}
          onPress={doPrint}
        />
        <Text style={styles.tip}>
          {Platform.OS === 'web' ? t('print.browserHint') : t('print.demoHint')}
        </Text>
      </View>

      <SheetModal visible={printed} onClose={() => setPrinted(false)} title={t('print.sent')}>
        <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary, textAlign: 'center', lineHeight: 20 }}>
          {t('print.queued', { n: receipts.length })}
        </Text>
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
  receipt: {
    backgroundColor: Colors.white,
    borderRadius: Radius.md,
    padding: Spacing.lg,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  storeName: { fontSize: FontSize.md, fontWeight: '800', color: Colors.text, textAlign: 'center' },
  receiptEmoji: { fontSize: 24, textAlign: 'center' },
  templateNote: { fontSize: 10, color: Colors.textFaint, textAlign: 'center', marginTop: 2 },
  storeMeta: { fontSize: FontSize.xs, color: Colors.textTertiary, textAlign: 'center', marginTop: 2 },
  receiptDivider: { height: 1, backgroundColor: Colors.border, marginVertical: 8 },
  receiptNo: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text },
  receiptTime: { fontSize: FontSize.xs, color: Colors.textTertiary },
  preorder: { fontSize: FontSize.xs, color: Colors.warning, fontWeight: '700', marginTop: 4 },
  item: { fontSize: FontSize.sm, color: Colors.textSecondary, flexShrink: 1 },
  meta: { fontSize: FontSize.xs, color: Colors.textTertiary, marginTop: 2 },
  totalLabel: { fontSize: FontSize.md, fontWeight: '800', color: Colors.text },
  totalValue: { fontSize: FontSize.md, fontWeight: '800', color: Colors.text },
  note: { fontSize: FontSize.xs, color: Colors.warning, fontWeight: '600', marginTop: 4 },
  qrPlaceholder: {
    alignSelf: 'center',
    marginTop: 10,
    width: 40,
    height: 40,
    borderWidth: 1.5,
    borderColor: Colors.text,
    borderRadius: Radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  qrText: { fontSize: FontSize.xs, fontWeight: '800', color: Colors.text },
  barcode: { alignItems: 'center', marginTop: 10, gap: 2 },
  barcodeText: { fontSize: 10, letterSpacing: 1, color: Colors.text, fontWeight: '700' },
  footer: { padding: Spacing.lg, paddingBottom: 28, backgroundColor: Colors.card, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: Colors.border },
  tip: { fontSize: FontSize.xs, color: Colors.textTertiary, textAlign: 'center', marginTop: 8 },
});
