import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { InvoiceCard } from '@/components/InvoiceCard';
import { Btn, Card, ErrorCard, Field, Icon, Screen } from '@/components/ui';
import { Colors, FontSize, Spacing } from '@/constants/theme';
import { t } from '@/i18n';
import { dateISO } from '@/lib/format';
import { getBookingsRepository } from '@/repos';
import type { BookingDetail, ServiceInvoice } from '@hudumika/contract';

const INVOICE_ISSUABLE = ['in_progress', 'completion_review', 'awaiting_customer_confirmation', 'completed', 'settled', 'warranty'];

export default function InvoiceScreen() {
  const { bookingId } = useLocalSearchParams<{ bookingId: string }>();
  const [booking, setBooking] = useState<BookingDetail | null>(null);
  const [invoice, setInvoice] = useState<ServiceInvoice | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [labor, setLabor] = useState('');
  const [discount, setDiscount] = useState('');
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [b, inv] = await Promise.all([getBookingsRepository().getBooking(bookingId), getBookingsRepository().getInvoice(bookingId)]);
      setBooking(b);
      setInvoice(inv);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('misc.error'));
    } finally {
      setLoading(false);
    }
  }, [bookingId]);

  useEffect(() => {
    load();
  }, [load]);

  const onSubmit = async () => {
    const laborTZS = Number(labor);
    if (!Number.isInteger(laborTZS) || laborTZS <= 0) {
      setSubmitError(t('misc.error'));
      return;
    }
    setSubmitting(true);
    setSubmitError('');
    try {
      const inv = await getBookingsRepository().issueInvoice(bookingId, laborTZS, discount ? Math.round(Number(discount)) : undefined, note.trim() || undefined);
      setInvoice(inv);
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : t('misc.error'));
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <Screen>
        <View style={styles.center}>
          <ActivityIndicator color={Colors.primary} />
        </View>
      </Screen>
    );
  }

  if (error || !booking) {
    return (
      <Screen>
        <View style={styles.center}>
          <ErrorCard message={error || t('misc.error')} onRetry={load} />
        </View>
      </Screen>
    );
  }

  const issuable = INVOICE_ISSUABLE.includes(booking.status);

  return (
    <Screen scroll>
      <Card style={{ gap: Spacing.sm }}>
        <Text style={styles.service}>{booking.serviceId}</Text>
        <Text style={styles.meta}>{dateISO(booking.scheduledFor)}</Text>
      </Card>

      {invoice ? (
        <>
          <InvoiceCard invoice={invoice} showStatus />
          <Btn label={t('booking.done')} variant="success" onPress={() => router.back()} />
        </>
      ) : (
        <>
          {!issuable ? (
            <View style={styles.warnBox}>
              <Icon name="information-circle" size={14} color={Colors.info} />
              <Text style={styles.warnText}>{t('invoice.notIssuable')}</Text>
            </View>
          ) : null}
          {submitError ? <Text style={styles.error}>{submitError}</Text> : null}
          <Card style={{ gap: Spacing.md }}>
            <Field label={`${t('invoice.labor')} (TZS)`} value={labor} onChangeText={setLabor} keyboardType="number-pad" />
            <Field label={`${t('invoice.discount')} (TZS)`} value={discount} onChangeText={setDiscount} keyboardType="number-pad" hint={t('misc.optional')} />
            <Field label={t('invoice.note')} value={note} onChangeText={setNote} multiline placeholder={t('quotes.notePlaceholder')} maxLength={500} />
            <Btn label={t('invoice.issue')} onPress={onSubmit} loading={submitting} disabled={!issuable} size="lg" />
          </Card>
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: Spacing.md, padding: Spacing.lg },
  error: { color: Colors.danger, fontSize: FontSize.sm },
  service: { fontSize: FontSize.lg, fontWeight: '800', color: Colors.text },
  meta: { fontSize: FontSize.xs, color: Colors.textTertiary, fontWeight: '600' },
  warnBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    backgroundColor: Colors.infoSoft,
    borderRadius: 12,
    padding: Spacing.sm,
  },
  warnText: { flex: 1, color: Colors.info, fontSize: FontSize.xs, fontWeight: '700' },
});
