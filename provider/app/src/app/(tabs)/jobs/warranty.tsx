import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { Btn, Card, ErrorCard, Field, Pill, Row, Screen } from '@/components/ui';
import { Colors, FontSize, NumberStyle, Spacing } from '@/constants/theme';
import { t } from '@/i18n';
import { dateISO } from '@/lib/format';
import { getBookingsRepository } from '@/repos';
import type { BookingDetail, ServiceWarranty } from '@hudumika/contract';

export default function WarrantyScreen() {
  const { bookingId } = useLocalSearchParams<{ bookingId: string }>();
  const [booking, setBooking] = useState<BookingDetail | null>(null);
  const [warranty, setWarranty] = useState<ServiceWarranty | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [validDays, setValidDays] = useState('');
  const [coverage, setCoverage] = useState('');
  const [followUp, setFollowUp] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [b, wr] = await Promise.all([getBookingsRepository().getBooking(bookingId), getBookingsRepository().getWarranty(bookingId)]);
      setBooking(b);
      setWarranty(wr);
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
    const days = Number(validDays);
    if (!Number.isInteger(days) || days < 1) {
      setSubmitError(t('misc.error'));
      return;
    }
    setSubmitting(true);
    setSubmitError('');
    try {
      const wr = await getBookingsRepository().issueWarranty(bookingId, days, coverage.trim() || undefined, followUp.trim() || undefined);
      setWarranty(wr);
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

      {warranty ? (
        <>
          <Card style={{ gap: Spacing.sm }}>
            <Row style={{ justifyContent: 'space-between' }}>
              <Text style={styles.cardTitle}>{t('warranty.title')}</Text>
              {warranty.status ? <Pill label={t(`warranty.status.${warranty.status}`)} tone={warranty.status === 'active' ? 'success' : 'neutral'} /> : null}
            </Row>
            <Row style={{ justifyContent: 'space-between' }}>
              <Text style={styles.meta}>{t('warranty.validDays')}</Text>
              <Text style={styles.metaNum}>{warranty.validDays}</Text>
            </Row>
            {warranty.coverage ? (
              <View style={{ gap: 2 }}>
                <Text style={styles.meta}>{t('warranty.coverage')}</Text>
                <Text style={styles.coverage}>{warranty.coverage}</Text>
              </View>
            ) : null}
            {warranty.followUpAt ? (
              <Row style={{ justifyContent: 'space-between' }}>
                <Text style={styles.meta}>{t('warranty.followUp')}</Text>
                <Text style={styles.meta}>{dateISO(warranty.followUpAt)}</Text>
              </Row>
            ) : null}
            {warranty.issuedAt ? (
              <Row style={{ justifyContent: 'space-between' }}>
                <Text style={styles.meta}>{t('invoice.issued')}</Text>
                <Text style={styles.meta}>{dateISO(warranty.issuedAt)}</Text>
              </Row>
            ) : null}
          </Card>
          <Btn label={t('booking.done')} variant="success" onPress={() => router.back()} />
        </>
      ) : (
        <>
          {submitError ? <Text style={styles.error}>{submitError}</Text> : null}
          <Card style={{ gap: Spacing.md }}>
            <Field label={t('warranty.validDays')} value={validDays} onChangeText={setValidDays} keyboardType="number-pad" />
            <Field label={t('warranty.coverage')} value={coverage} onChangeText={setCoverage} multiline placeholder={t('warranty.coveragePlaceholder')} maxLength={1000} />
            <Field label={t('warranty.followUp')} value={followUp} onChangeText={setFollowUp} placeholder="YYYY-MM-DD" />
            <Btn label={t('warranty.issue')} onPress={onSubmit} loading={submitting} size="lg" />
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
  metaNum: { fontSize: FontSize.xs, color: Colors.textTertiary, fontWeight: '600', fontVariant: NumberStyle.fontVariant },
  cardTitle: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text },
  coverage: { fontSize: FontSize.sm, color: Colors.textSecondary, lineHeight: 18 },
});
