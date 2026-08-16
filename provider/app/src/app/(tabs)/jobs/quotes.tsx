import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { QuoteComposer } from '@/components/QuoteComposer';
import { Btn, Card, ErrorCard, Icon, Screen } from '@/components/ui';
import { Colors, FontSize, Spacing } from '@/constants/theme';
import { formatTZS, t } from '@/i18n';
import { dateISO } from '@/lib/format';
import { getBookingsRepository } from '@/repos';
import type { BookingDetail, BookingQuote } from '@hudumika/contract';

export default function QuotesScreen() {
  const { bookingId } = useLocalSearchParams<{ bookingId: string }>();
  const [booking, setBooking] = useState<BookingDetail | null>(null);
  const [estimateHint, setEstimateHint] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [done, setDone] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setBooking(await getBookingsRepository().getBooking(bookingId));
      try {
        const e = await getBookingsRepository().getEstimatePreview(bookingId);
        setEstimateHint(`${formatTZS(e.lowTZS)}–${formatTZS(e.highTZS)}`);
      } catch {
        setEstimateHint(null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : t('misc.error'));
    } finally {
      setLoading(false);
    }
  }, [bookingId]);

  useEffect(() => {
    load();
  }, [load]);

  const onSubmit = async (quote: BookingQuote) => {
    setSubmitting(true);
    setSubmitError('');
    try {
      await getBookingsRepository().submitQuote(bookingId, quote);
      setDone(true);
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

  const alreadyIssued = booking.quoteStatus === 'quote_issued' || booking.quoteStatus === 'quote_approved';

  return (
    <Screen scroll>
      <Card style={{ gap: Spacing.sm }}>
        <Text style={styles.service}>{booking.serviceId}</Text>
        <Text style={styles.meta}>{dateISO(booking.scheduledFor)}</Text>
      </Card>

      {done || alreadyIssued ? (
        <Card style={{ alignItems: 'center', gap: Spacing.sm, backgroundColor: Colors.successSoft }}>
          <Icon name="checkmark-circle" size={44} color={Colors.success} />
          <Text style={styles.doneTitle}>{t('quotes.issued')}</Text>
          <Btn label={t('booking.done')} variant="success" onPress={() => router.back()} style={{ alignSelf: 'stretch' }} />
        </Card>
      ) : (
        <>
          {submitError ? <Text style={styles.error}>{submitError}</Text> : null}
          <QuoteComposer
            onCancel={() => router.back()}
            onSubmit={onSubmit}
            loading={submitting}
            estimateHint={estimateHint}
          />
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
  doneTitle: { fontSize: FontSize.md, fontWeight: '800', color: Colors.success, textAlign: 'center' },
});
