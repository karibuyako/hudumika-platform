import { useLocalSearchParams } from 'expo-router';
import * as Linking from 'expo-linking';
import { useCallback, useEffect, useState } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';

import {
  Btn,
  Card,
  Divider,
  ErrorState,
  Pill,
  Row,
  Screen,
  SkeletonCard,
  StatusPill,
} from '@/components/ui';
import { Colors, Fonts, FontSize, Spacing } from '@/constants/theme';
import { t } from '@/i18n';
import { getFinanceRepository } from '@/repos';
import { toast } from '@/store/ui';
import { ApiError } from '@/api/client';
import { dateISO, fullDateISO } from '@/lib/dates';
import { formatTZS } from '@/lib/format';
import type { Invoice } from '@hudumika/contract';

/** buyerDetails is the contract's free-form map — the reference ids ride it
 * (mock-only until the contract ships a reference field); render the rest as
 * buyer details, never the reference ids. */
function buyerRows(item: Invoice): [string, string][] {
  const details = item.buyerDetails ?? {};
  return Object.entries(details).filter(
    ([k, v]) => k !== 'orderId' && k !== 'bookingId' && (typeof v === 'string' || typeof v === 'number'),
  ) as [string, string][];
}

function percentLabel(bps: number): string {
  return `${(bps / 100).toFixed(0)}%`;
}

export default function InvoiceDetailScreen() {
  const { invoiceId } = useLocalSearchParams<{ invoiceId: string }>();
  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [error, setError] = useState('');
  const [downloading, setDownloading] = useState(false);

  const load = useCallback(async () => {
    setError('');
    try {
      setInvoice(await getFinanceRepository().getInvoice(invoiceId));
    } catch (e) {
      setError(e instanceof ApiError && e.status === 404 ? t('invoices.notFound') : t('common.error'));
    }
  }, [invoiceId]);

  useEffect(() => {
    load();
  }, [load]);

  const onDownload = async () => {
    if (!invoice || (invoice.status !== 'issued' && invoice.status !== 'paid')) return;
    setDownloading(true);
    try {
      const res = await getFinanceRepository().downloadInvoice(invoice.id);
      if (!res.downloadUrl) {
        toast(t('invoices.receiptNote'));
        return;
      }
      if (Platform.OS === 'web') {
        window.open(res.downloadUrl, '_blank');
      } else {
        await Linking.openURL(res.downloadUrl);
      }
    } catch (e) {
      toast(e instanceof ApiError ? e.message : t('invoices.downloadError'));
    } finally {
      setDownloading(false);
    }
  };

  if (error) {
    return (
      <Screen>
        <ErrorState message={error} onRetry={load} />
      </Screen>
    );
  }

  if (!invoice) {
    return (
      <Screen>
        <SkeletonCard rows={2} />
        <SkeletonCard rows={4} />
      </Screen>
    );
  }

  const downloadable = invoice.status === 'issued' || invoice.status === 'paid';

  const detailRows: { label: string; value: string }[] = [
    { label: t('invoices.number'), value: invoice.number },
    { label: t('invoices.kind'), value: invoice.kind === 'vat' ? t('invoices.kind.vat') : t('invoices.kind.standard') },
    { label: t('invoices.amount'), value: formatTZS(invoice.amountTZS) },
  ];
  if (invoice.taxRateBps != null) {
    detailRows.push({ label: t('invoices.taxRate'), value: percentLabel(invoice.taxRateBps) });
  }
  if (invoice.taxAmountTZS != null) {
    detailRows.push({ label: t('invoices.taxAmount'), value: formatTZS(invoice.taxAmountTZS) });
  }
  if (invoice.taxId) detailRows.push({ label: t('invoices.taxId'), value: invoice.taxId });
  if (invoice.periodFrom || invoice.periodTo) {
    detailRows.push({ label: t('invoices.period'), value: `${dateISO(invoice.periodFrom)} – ${dateISO(invoice.periodTo)}` });
  }
  detailRows.push({ label: t('invoices.createdAt'), value: fullDateISO(invoice.createdAt) });
  if (invoice.issuedAt) detailRows.push({ label: t('invoices.issuedAt'), value: fullDateISO(invoice.issuedAt) });

  return (
    <Screen scroll>
      <Row style={{ justifyContent: 'space-between' }}>
        <Text style={styles.number}>{invoice.number}</Text>
        <StatusPill status={invoice.status} />
      </Row>

      <Row gap={6} style={{ marginTop: Spacing.sm }}>
        <Pill label={invoice.kind === 'vat' ? t('invoices.kind.vat') : t('invoices.kind.standard')} tone={invoice.kind === 'vat' ? 'info' : 'neutral'} />
      </Row>

      <Text style={styles.amount}>{formatTZS(invoice.amountTZS)}</Text>

      <Card flat style={styles.card}>
        {detailRows.map((r, i) => (
          <View key={r.label}>
            <Row style={{ justifyContent: 'space-between', paddingVertical: Spacing.sm }}>
              <Text style={styles.rowLabel}>{r.label}</Text>
              <Text style={styles.rowValue}>{r.value}</Text>
            </Row>
            {i < detailRows.length - 1 ? <Divider /> : null}
          </View>
        ))}
      </Card>

      {buyerRows(invoice).length > 0 ? (
        <Card flat style={styles.card}>
          <Text style={styles.sectionLabel}>{t('invoices.buyer')}</Text>
          {buyerRows(invoice).map(([k, v], i, arr) => (
            <View key={k}>
              <Row style={{ justifyContent: 'space-between', paddingVertical: Spacing.sm }}>
                <Text style={styles.rowLabel}>{k}</Text>
                <Text style={styles.rowValue}>{v}</Text>
              </Row>
              {i < arr.length - 1 ? <Divider /> : null}
            </View>
          ))}
        </Card>
      ) : null}

      {downloadable ? (
        <Btn label={t('invoices.download')} onPress={onDownload} loading={downloading} size="lg" icon="download-outline" />
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  number: { fontSize: FontSize.xxl, fontFamily: Fonts.displayBold, color: Colors.text },
  amount: { fontSize: 28, fontFamily: Fonts.displayBold, color: Colors.primaryDeep, marginTop: Spacing.lg },
  card: { marginTop: Spacing.lg },
  sectionLabel: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    fontFamily: Fonts.sansSemibold,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    marginBottom: Spacing.xs,
  },
  rowLabel: { fontSize: FontSize.sm, color: Colors.textTertiary, fontFamily: Fonts.sans },
  rowValue: { fontSize: FontSize.sm, color: Colors.text, fontFamily: Fonts.sansSemibold },
});
