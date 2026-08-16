import { StyleSheet, Text, View } from 'react-native';

import { Card, Divider, Icon, Row } from '@/components/ui';
import { Colors, FontSize, NumberStyle, Spacing } from '@/constants/theme';
import { formatTZS, t } from '@/i18n';
import type { ServiceInvoice } from '@hudumika/contract';

const STATUS_TONE: Record<string, 'neutral' | 'info' | 'success'> = {
  draft: 'neutral',
  issued: 'info',
  paid: 'success',
};

/** Read-only invoice breakdown — totals are always server-computed. */
export function InvoiceCard({ invoice, showStatus }: { invoice: ServiceInvoice; showStatus?: boolean }) {
  const rows: { label: string; value: number }[] = [
    { label: t('invoice.labor'), value: invoice.laborTZS },
    { label: t('invoice.trip'), value: invoice.tripFeeTZS ?? 0 },
    { label: t('invoice.parts'), value: invoice.partsTZS ?? 0 },
  ];
  const visible = rows.filter((r) => r.value > 0);
  const discount = invoice.discountTZS ?? 0;
  const tax = invoice.taxTZS ?? 0;

  return (
    <Card style={{ gap: Spacing.sm }}>
      <Row style={{ justifyContent: 'space-between' }}>
        <Text style={styles.title}>{t('invoice.title')}</Text>
        {showStatus ? (
          <Text style={[styles.status, { color: STATUS_TONE[invoice.status] === 'success' ? Colors.success : STATUS_TONE[invoice.status] === 'info' ? Colors.info : Colors.textSecondary }]}>
            {t(`invoice.${invoice.status}`)}
          </Text>
        ) : null}
      </Row>
      {visible.map((r) => (
        <Row key={r.label} style={{ justifyContent: 'space-between' }}>
          <Text style={styles.label}>{r.label}</Text>
          <Text style={[styles.value, { fontVariant: NumberStyle.fontVariant }]}>{formatTZS(r.value)}</Text>
        </Row>
      ))}
      {discount > 0 ? (
        <Row style={{ justifyContent: 'space-between' }}>
          <Text style={styles.label}>{t('invoice.discount')}</Text>
          <Text style={[styles.value, { color: Colors.danger }, { fontVariant: NumberStyle.fontVariant }]}>−{formatTZS(discount)}</Text>
        </Row>
      ) : null}
      {tax > 0 ? (
        <Row style={{ justifyContent: 'space-between' }}>
          <Text style={styles.label}>{t('invoice.tax')}</Text>
          <Text style={[styles.value, { fontVariant: NumberStyle.fontVariant }]}>{formatTZS(tax)}</Text>
        </Row>
      ) : null}
      <Divider />
      <Row style={{ justifyContent: 'space-between' }}>
        <Text style={styles.totalLabel}>{t('invoice.total')}</Text>
        <Text style={[styles.total, { fontVariant: NumberStyle.fontVariant }]}>{formatTZS(invoice.totalTZS)}</Text>
      </Row>
      {invoice.note ? (
        <View style={{ gap: 2 }}>
          <Text style={styles.noteLabel}>{t('invoice.note')}</Text>
          <Text style={styles.note}>{invoice.note}</Text>
        </View>
      ) : null}
      {invoice.status === 'paid' ? (
        <Row gap={6}>
          <Icon name="checkmark-circle" size={14} color={Colors.success} />
          <Text style={styles.paidNote}>{t('invoice.paid')}</Text>
        </Row>
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: FontSize.md, fontFamily: 'PlusJakartaSans_800ExtraBold', color: Colors.text },
  status: { fontSize: FontSize.xs, fontFamily: 'PlusJakartaSans_700Bold' },
  label: { fontSize: FontSize.sm, color: Colors.textSecondary },
  value: { fontSize: FontSize.sm, color: Colors.text, fontFamily: 'PlusJakartaSans_600SemiBold' },
  totalLabel: { fontSize: FontSize.md, fontFamily: 'PlusJakartaSans_800ExtraBold', color: Colors.text },
  total: { fontSize: FontSize.lg, color: Colors.primaryDeep, fontFamily: 'PlusJakartaSans_800ExtraBold' },
  noteLabel: { fontSize: FontSize.xs, color: Colors.textTertiary, fontFamily: 'PlusJakartaSans_700Bold' },
  note: { fontSize: FontSize.sm, color: Colors.textSecondary, lineHeight: 18 },
  paidNote: { fontSize: FontSize.xs, color: Colors.success, fontFamily: 'PlusJakartaSans_700Bold' },
});
