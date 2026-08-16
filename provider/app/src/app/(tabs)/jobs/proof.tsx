import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { ProofUpload } from '@/components/ProofUpload';
import { Btn, Card, ErrorCard, Screen } from '@/components/ui';
import { Colors, FontSize, Spacing } from '@/constants/theme';
import { t } from '@/i18n';
import { dateISO } from '@/lib/format';
import { getBookingsRepository } from '@/repos';
import type { BookingDetail, ProofOfServiceType } from '@hudumika/contract';

export default function ProofScreen() {
  const { bookingId } = useLocalSearchParams<{ bookingId: string }>();
  const [booking, setBooking] = useState<BookingDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [submitted, setSubmitted] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setBooking(await getBookingsRepository().getBooking(bookingId));
    } catch (e) {
      setError(e instanceof Error ? e.message : t('misc.error'));
    } finally {
      setLoading(false);
    }
  }, [bookingId]);

  useEffect(() => {
    load();
  }, [load]);

  const onSubmit = async (type: ProofOfServiceType, value: string) => {
    setSubmitting(true);
    setSubmitError('');
    try {
      await getBookingsRepository().submitProof(bookingId, type, value);
      setSubmitted(true);
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

  return (
    <Screen scroll>
      <Card style={{ gap: Spacing.sm }}>
        <Text style={styles.service}>{booking.serviceId}</Text>
        <Text style={styles.meta}>{dateISO(booking.scheduledFor)}</Text>
      </Card>

      {submitError ? <Text style={styles.error}>{submitError}</Text> : null}

      <ProofUpload onSubmit={onSubmit} loading={submitting} submitted={submitted} />

      {submitted ? <Btn label={t('booking.done')} variant="success" onPress={() => router.back()} /> : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: Spacing.md, padding: Spacing.lg },
  error: { color: Colors.danger, fontSize: FontSize.sm },
  service: { fontSize: FontSize.lg, fontWeight: '800', color: Colors.text },
  meta: { fontSize: FontSize.xs, color: Colors.textTertiary, fontWeight: '600' },
});
