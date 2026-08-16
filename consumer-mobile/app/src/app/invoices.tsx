import { useRouter } from 'expo-router';
import * as Linking from 'expo-linking';
import { useCallback, useEffect, useState } from 'react';
import { FlatList, Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import {
  Btn,
  Card,
  EmptyState,
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
import { dateISO } from '@/lib/dates';
import { formatTZS } from '@/lib/format';
import type { Invoice } from '@hudumika/contract';

/** The Invoice model carries no orderId/bookingId — the reference to the
 * originating order/booking rides the contract's free-form buyerDetails map
 * (mock-only until the contract ships a reference field). */
function referenceLabel(item: Invoice): string | null {
  const details = item.buyerDetails ?? {};
  if (typeof details.orderId === 'string') return t('invoices.ref.order', { id: details.orderId });
  if (typeof details.bookingId === 'string') return t('invoices.ref.booking', { id: details.bookingId });
  return null;
}

function kindLabel(item: Invoice): string {
  return item.kind === 'vat' ? t('invoices.kind.vat') : t('invoices.kind.standard');
}

/** Contract DownloadInvoice200.downloadUrl is a signed PDF URL. Web can't hand
 * the file to a viewer app, so it opens the URL in a new tab instead. */
async function openDownload(url: string): Promise<void> {
  if (Platform.OS === 'web') {
    window.open(url, '_blank');
    return;
  }
  await Linking.openURL(url);
}

export default function InvoicesScreen() {
  const router = useRouter();
  const [invoices, setInvoices] = useState<Invoice[] | null>(null);
  const [error, setError] = useState('');
  const [downloadingId, setDownloadingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError('');
    try {
      setInvoices(await getFinanceRepository().listInvoices());
    } catch {
      setError(t('common.error'));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const onDownload = async (invoice: Invoice) => {
    if (invoice.status !== 'issued' && invoice.status !== 'paid') return;
    setDownloadingId(invoice.id);
    try {
      const res = await getFinanceRepository().downloadInvoice(invoice.id);
      if (!res.downloadUrl) {
        toast(t('invoices.receiptNote'));
        return;
      }
      await openDownload(res.downloadUrl);
    } catch (e) {
      toast(e instanceof ApiError ? e.message : t('invoices.downloadError'));
    } finally {
      setDownloadingId(null);
    }
  };

  if (error) {
    return (
      <Screen>
        <ErrorState message={error} onRetry={load} />
      </Screen>
    );
  }

  if (!invoices) {
    return (
      <Screen>
        <SkeletonCard rows={2} />
        <SkeletonCard rows={3} />
        <SkeletonCard rows={3} />
      </Screen>
    );
  }

  return (
    <Screen>
      <FlatList
        data={invoices}
        keyExtractor={(inv) => inv.id}
        onRefresh={load}
        refreshing={false}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ padding: Spacing.lg, paddingBottom: 60 }}
        ListHeaderComponent={<Text style={styles.title}>{t('invoices.title')}</Text>}
        ListEmptyComponent={
          <EmptyState icon="receipt-outline" title={t('invoices.noInvoices')} sub={t('invoices.noInvoicesSub')} />
        }
        renderItem={({ item }) => {
          const ref = referenceLabel(item);
          const downloadable = item.status === 'issued' || item.status === 'paid';
          return (
            <Card flat style={styles.card}>
              <Pressable
                onPress={() => router.push(`/invoices/${item.id}`)}
                accessibilityRole="button"
                accessibilityLabel={`${item.number}, ${formatTZS(item.amountTZS)}`}
                style={({ pressed }) => ({ opacity: pressed ? 0.85 : 1 })}>
                <Row style={{ justifyContent: 'space-between' }}>
                  <Text style={styles.number}>{item.number}</Text>
                  <StatusPill status={item.status} />
                </Row>
                <Row gap={6} style={{ marginTop: Spacing.sm }}>
                  <Pill label={kindLabel(item)} tone={item.kind === 'vat' ? 'info' : 'neutral'} />
                  {ref ? <Text style={styles.ref}>{ref}</Text> : null}
                </Row>
                <Row style={{ justifyContent: 'space-between', marginTop: Spacing.sm }}>
                  <Text style={styles.amount}>{formatTZS(item.amountTZS)}</Text>
                  <Text style={styles.meta}>{dateISO(item.createdAt)}</Text>
                </Row>
              </Pressable>
              {downloadable ? (
                <View style={styles.downloadWrap}>
                  <Btn
                    label={t('invoices.download')}
                    size="sm"
                    variant="outline"
                    icon="download-outline"
                    loading={downloadingId === item.id}
                    onPress={() => onDownload(item)}
                  />
                </View>
              ) : null}
            </Card>
          );
        }}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: FontSize.xxl, fontFamily: Fonts.displayBold, color: Colors.text, marginBottom: Spacing.md },
  card: { marginBottom: Spacing.md },
  number: { fontSize: FontSize.lg, fontFamily: Fonts.sansExtraBold, color: Colors.text },
  ref: { fontSize: FontSize.xs, color: Colors.textTertiary, fontFamily: Fonts.sans },
  amount: { fontSize: FontSize.lg, fontFamily: Fonts.displayBold, color: Colors.text },
  meta: { fontSize: FontSize.xs, color: Colors.textFaint, fontFamily: Fonts.sans },
  downloadWrap: { marginTop: Spacing.md, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: Colors.border, paddingTop: Spacing.md },
});
