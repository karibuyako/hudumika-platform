import { useLocalSearchParams, useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useCallback, useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import {
  Btn,
  Card,
  Chip,
  EmptyState,
  ErrorState,
  Field,
  Pill,
  Row,
  Screen,
  SkeletonCard,
} from '@/components/ui';
import { Colors, Fonts, FontSize, Spacing } from '@/constants/theme';
import { t } from '@/i18n';
import { getSupportRepository } from '@/repos';
import { useSessionStore } from '@/store/session';
import type { Ticket } from '@hudumika/contract';
import { TicketCreateCategory } from '@hudumika/contract';
import { ApiError } from '@/api/client';
import { dateISO } from '@/lib/dates';
import { idempotencyKey } from '@/lib/idempotency';
import { track } from '@/lib/analytics';

/** Ticket categories: the six contract TicketCreateCategory values plus the
 * mock-first 'feedback' option (docs/CONTRACT-ADDITIONS.md #6) — a live
 * backend would reject 'feedback' until Team 6 ships the enum value, so the
 * chip is marked mock-only-until-adopted. */
type TicketCategory = TicketCreateCategory | 'feedback';

const CATEGORIES: { value: TicketCategory; label: string }[] = [
  { value: TicketCreateCategory.payment, label: t('support.category.payment') },
  { value: TicketCreateCategory.order, label: t('support.category.order') },
  { value: TicketCreateCategory.account, label: t('support.category.account') },
  { value: TicketCreateCategory.safety, label: t('support.category.safety') },
  { value: TicketCreateCategory.equipment, label: t('support.category.equipment') },
  { value: TicketCreateCategory.other, label: t('support.category.other') },
  // Mock-only until the contract ships the feedback category (CONTRACT-ADDITIONS #6).
  { value: 'feedback', label: t('support.category.feedback') },
];

export default function SupportScreen() {
  const router = useRouter();
  const { orderId, bookingId } = useLocalSearchParams<{ orderId?: string; bookingId?: string }>();
  const user = useSessionStore((s) => s.user);
  const [tickets, setTickets] = useState<Ticket[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [category, setCategory] = useState<TicketCategory>(TicketCreateCategory.other);
  const [error, setError] = useState('');
  const [formError, setFormError] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      setTickets(await getSupportRepository().listTickets());
    } catch {
      setError(t('common.error'));
    }
  }, []);

  useEffect(() => {
    load();
    track({ name: 'support_opened' });
    if (orderId) {
      setSubject(`${t('order.title')} ${orderId.slice(-8)}`);
      setCreating(true);
    } else if (bookingId) {
      setSubject(t('booking.problemSubject', { id: bookingId.slice(-8) }));
      setCreating(true);
    }
  }, [load, orderId, bookingId]);

  const submit = async () => {
    if (!subject.trim() || !body.trim()) {
      setFormError(t('common.error'));
      return;
    }
    setFormError('');
    try {
      const ticket = await getSupportRepository().createTicket(
        {
          subject: subject.trim(),
          body: body.trim(),
          // 'feedback' is a mock-first category (CONTRACT-ADDITIONS.md #6) —
          // it rides the contract field position until the enum ships the value.
          category: category === 'feedback' ? ('feedback' as TicketCreateCategory) : category,
          orderId: orderId ?? null,
          bookingId: bookingId ?? null,
        },
        idempotencyKey(user?.id ?? 'customer', 'ticket'),
      );
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setCreating(false);
      router.push(`/support/${ticket.id}`);
    } catch (e) {
      setFormError(e instanceof ApiError ? e.message : t('common.error'));
    }
  };

  if (creating) {
    return (
      <Screen scroll>
        <Row style={{ justifyContent: 'space-between', marginBottom: Spacing.md }}>
          <Btn label={t('common.back')} onPress={() => router.back()} variant="subtle" size="sm" icon="arrow-back" />
          <Text style={styles.title}>{t('support.create')}</Text>
        </Row>
        <Card style={{ gap: Spacing.lg }}>
          <Field label={t('support.subject')} value={subject} onChangeText={setSubject} maxLength={160} />
          <View>
            <Text style={styles.categoryLabel}>{t('support.category')}</Text>
            <View style={styles.categoryRow}>
              {CATEGORIES.map((c) => (
                <Chip
                  key={c.value}
                  label={c.label}
                  selected={category === c.value}
                  onPress={() => setCategory(c.value)}
                />
              ))}
            </View>
          </View>
          <Field label={t('support.body')} value={body} onChangeText={setBody} multiline maxLength={4000} />
          {orderId ? <Text style={styles.prefill}>{t('support.prefilled', { id: orderId })}</Text> : null}
          {bookingId && !orderId ? <Text style={styles.prefill}>{t('support.prefilledBooking', { id: bookingId })}</Text> : null}
          {formError ? <Text style={styles.error}>{formError}</Text> : null}
          <Btn label={t('support.send')} onPress={submit} size="lg" />
        </Card>
      </Screen>
    );
  }

  if (error) {
    return (
      <Screen>
        <ErrorState message={error} onRetry={load} />
      </Screen>
    );
  }

  return (
    <Screen>
      <View style={{ paddingHorizontal: Spacing.lg, paddingTop: Spacing.lg }}>
        <Row style={{ justifyContent: 'space-between' }}>
          <Text style={styles.title}>{t('support.title')}</Text>
          <Btn label={t('support.create')} onPress={() => setCreating(true)} size="sm" icon="add" />
        </Row>
      </View>
      {!tickets ? (
        <SkeletonCard rows={3} />
      ) : tickets.length === 0 ? (
        <EmptyState icon="headset-outline" title={t('support.empty')} />
      ) : (
        <ScrollView contentContainerStyle={{ padding: Spacing.lg, paddingBottom: 60 }}>
          {tickets.map((ticket) => (
            <Card key={ticket.id} style={styles.card} onPress={() => router.push(`/support/${ticket.id}`)}>
              <Row style={{ justifyContent: 'space-between' }}>
                <Text style={styles.subject} numberOfLines={1}>{ticket.subject}</Text>
                <Pill label={ticket.status} tone={ticket.status === 'resolved' || ticket.status === 'closed' ? 'success' : 'info'} />
              </Row>
              <Text style={styles.meta}>{dateISO(ticket.createdAt)} · {ticket.priority}</Text>
            </Card>
          ))}
        </ScrollView>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: FontSize.xxl, fontFamily: Fonts.displayBold, color: Colors.text, marginBottom: Spacing.md },
  card: { marginBottom: Spacing.md },
  subject: { fontSize: FontSize.md, fontFamily: Fonts.sansSemibold, color: Colors.text, flex: 1, paddingRight: Spacing.sm },
  meta: { fontSize: FontSize.xs, color: Colors.textTertiary, fontFamily: Fonts.sans, marginTop: 4 },
  prefill: { fontSize: FontSize.xs, color: Colors.primaryDeep, fontFamily: Fonts.sansSemibold },
  error: { color: Colors.danger, fontSize: FontSize.sm, fontFamily: Fonts.sansSemibold },
  categoryLabel: { fontSize: FontSize.xs, color: Colors.textTertiary, fontFamily: Fonts.sansSemibold, marginBottom: Spacing.sm },
  categoryRow: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm },
});
