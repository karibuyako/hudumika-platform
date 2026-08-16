import { router } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, RefreshControl, StyleSheet, Text, View } from 'react-native';

import { ApiError } from '@/api/client';
import { Btn, Empty, ErrorCard, Field, ListRow, Pill, Screen, SheetModal } from '@/components/ui';
import { Colors, FontSize, Spacing } from '@/constants/theme';
import { t } from '@/i18n';
import { dateISO } from '@/lib/format';
import { getSupportRepository } from '@/repos';
import type { Ticket, TicketStatus } from '@hudumika/contract';

const STATUS_TONE: Record<TicketStatus, 'info' | 'neutral' | 'warning' | 'success'> = {
  open: 'info',
  assigned: 'neutral',
  in_progress: 'warning',
  resolved: 'success',
  closed: 'neutral',
};

export default function SupportScreen() {
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  const [creating, setCreating] = useState(false);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [bookingId, setBookingId] = useState('');
  const [formError, setFormError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    try {
      setTickets(await getSupportRepository().list());
      setError('');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('misc.error'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const openCreate = () => {
    setSubject('');
    setBody('');
    setBookingId('');
    setFormError('');
    setCreating(true);
  };

  const onCreate = async () => {
    if (!subject.trim() || !body.trim()) {
      setFormError(t('misc.error'));
      return;
    }
    setSubmitting(true);
    setFormError('');
    try {
      await getSupportRepository().create({
        subject: subject.trim(),
        body: body.trim(),
        bookingId: bookingId.trim() || undefined,
      });
      setCreating(false);
      await load();
    } catch (e) {
      setFormError(e instanceof ApiError ? e.message : t('misc.error'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Screen>
      <FlatList
        data={tickets}
        keyExtractor={(tkt) => tkt.id}
        contentContainerStyle={styles.list}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Colors.primary} />}
        ListHeaderComponent={
          <View style={styles.header}>
            <Btn label={t('support.new')} icon="add" onPress={openCreate} />
          </View>
        }
        ListEmptyComponent={
          loading && !refreshing ? (
            <View style={styles.center}>
              <ActivityIndicator color={Colors.primary} />
            </View>
          ) : error && tickets.length === 0 ? (
            <ErrorCard message={error} onRetry={load} />
          ) : (
            <Empty icon="chatbubbles-outline" title={t('support.empty')} sub={t('support.emptySub')} />
          )
        }
        renderItem={({ item }) => (
          <View style={styles.rowWrap}>
            <ListRow
              title={item.subject}
              sub={dateISO(item.createdAt)}
              onPress={() => router.push(`/profile/tickets/${item.id}` as never)}
              trailing={<Pill label={t(`support.status.${item.status}`)} tone={STATUS_TONE[item.status]} />}
            />
          </View>
        )}
      />

      <SheetModal visible={creating} onClose={() => setCreating(false)} title={t('support.new')}>
        <Field label={t('support.subject')} value={subject} onChangeText={setSubject} placeholder="Payout not received" />
        <Field label={t('support.body')} value={body} onChangeText={setBody} multiline placeholder={t('support.body')} />
        <Field label={t('booking.id')} value={bookingId} onChangeText={setBookingId} hint={t('misc.optional')} />
        {formError ? <Text style={styles.error}>{formError}</Text> : null}
        <Btn label={t('support.create')} onPress={onCreate} loading={submitting} icon="checkmark" />
      </SheetModal>
    </Screen>
  );
}

const styles = StyleSheet.create({
  list: { padding: Spacing.lg, paddingBottom: 120 },
  header: { marginBottom: Spacing.md },
  rowWrap: { marginBottom: Spacing.sm },
  center: { alignItems: 'center', paddingVertical: 80 },
  error: { color: Colors.danger, fontSize: FontSize.sm },
});
