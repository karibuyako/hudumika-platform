import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { PartsList } from '@/components/PartsList';
import { Btn, Card, ErrorCard, Field, Icon, Row, Screen } from '@/components/ui';
import { Colors, FontSize, Spacing } from '@/constants/theme';
import { t } from '@/i18n';
import { dateISO } from '@/lib/format';
import { getBookingsRepository } from '@/repos';
import type { BookingDetail, PartsLine } from '@hudumika/contract';

export default function PartsScreen() {
  const { bookingId } = useLocalSearchParams<{ bookingId: string }>();
  const [booking, setBooking] = useState<BookingDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [rows, setRows] = useState<PartsLine[]>([]);
  const [saved, setSaved] = useState<PartsLine[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');

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

  const updateRow = (idx: number, patch: Partial<PartsLine>) => {
    setRows((rs) => rs.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  };

  const onSubmit = async () => {
    const clean = rows
      .filter((p) => p.name.trim())
      .map((p) => ({ name: p.name.trim(), quantity: Math.max(1, Math.round(p.quantity)), unitCostTZS: Math.round(p.unitCostTZS) }));
    if (clean.length === 0) return;
    setSubmitting(true);
    setSubmitError('');
    try {
      await getBookingsRepository().addParts(bookingId, clean);
      setSaved((prev) => [...prev, ...clean]);
      setRows([]);
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

      {saved.length > 0 ? (
        <>
          <PartsList parts={saved} />
          <Btn label={t('booking.done')} variant="success" onPress={() => router.back()} />
        </>
      ) : null}

      {submitError ? <Text style={styles.error}>{submitError}</Text> : null}

      <Card style={{ gap: Spacing.sm }}>
        {rows.map((p, i) => (
          <Row key={i} gap={Spacing.sm}>
            <View style={{ flex: 2 }}>
              <Field label={t('parts.name')} value={p.name} onChangeText={(v) => updateRow(i, { name: v })} />
            </View>
            <View style={{ flex: 1 }}>
              <Field label={t('parts.qty')} value={String(p.quantity)} onChangeText={(v) => updateRow(i, { quantity: Number(v) || 1 })} keyboardType="number-pad" />
            </View>
            <View style={{ flex: 1 }}>
              <Field label={t('parts.unitCost')} value={String(p.unitCostTZS)} onChangeText={(v) => updateRow(i, { unitCostTZS: Number(v) || 0 })} keyboardType="number-pad" />
            </View>
            <Pressable onPress={() => setRows((rs) => rs.filter((_, idx) => idx !== i))} accessibilityRole="button" accessibilityLabel={t('parts.title')} hitSlop={8} style={{ paddingTop: Spacing.lg }}>
              <Icon name="trash-outline" size={18} color={Colors.danger} />
            </Pressable>
          </Row>
        ))}
        <Pressable
          onPress={() => setRows((rs) => [...rs, { name: '', quantity: 1, unitCostTZS: 0 }])}
          accessibilityRole="button"
          style={({ pressed }) => [styles.addRow, pressed && { opacity: 0.7 }]}>
          <Icon name="add" size={16} color={Colors.primaryDeep} />
          <Text style={styles.addText}>{t('parts.add')}</Text>
        </Pressable>
        <Btn label={t('parts.submit')} onPress={onSubmit} loading={submitting} disabled={rows.length === 0} size="lg" />
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: Spacing.md, padding: Spacing.lg },
  error: { color: Colors.danger, fontSize: FontSize.sm },
  service: { fontSize: FontSize.lg, fontWeight: '800', color: Colors.text },
  meta: { fontSize: FontSize.xs, color: Colors.textTertiary, fontWeight: '600' },
  addRow: { flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-start' },
  addText: { color: Colors.primaryDeep, fontSize: FontSize.sm, fontWeight: '700' },
});
