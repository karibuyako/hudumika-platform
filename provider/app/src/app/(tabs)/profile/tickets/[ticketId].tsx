import { useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { ApiError } from '@/api/client';
import { TicketThread } from '@/components/TicketThread';
import { ErrorCard, Pill, Row, Screen } from '@/components/ui';
import { Colors, FontSize, Spacing } from '@/constants/theme';
import { t } from '@/i18n';
import { dateISO } from '@/lib/format';
import { getSupportRepository } from '@/repos';
import type { TicketDetail, TicketStatus } from '@hudumika/contract';

const STATUS_TONE: Record<TicketStatus, 'info' | 'neutral' | 'warning' | 'success'> = {
  open: 'info',
  assigned: 'neutral',
  in_progress: 'warning',
  resolved: 'success',
  closed: 'neutral',
};

export default function TicketDetailScreen() {
  const { ticketId } = useLocalSearchParams<{ ticketId: string }>();
  const [ticket, setTicket] = useState<TicketDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);

  const load = useCallback(async () => {
    if (!ticketId) return;
    try {
      setTicket(await getSupportRepository().get(ticketId));
      setError('');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('misc.error'));
    } finally {
      setLoading(false);
    }
  }, [ticketId]);

  useEffect(() => {
    load();
  }, [load]);

  const onReply = async (body: string) => {
    if (!ticketId) return;
    setSending(true);
    try {
      setTicket(await getSupportRepository().reply(ticketId, body));
      setError('');
    } catch (e) {
      if (e instanceof ApiError && e.code === 'TICKET_CLOSED') {
        setError(t('support.closed'));
        load();
      } else {
        setError(e instanceof ApiError ? e.message : t('misc.error'));
      }
    } finally {
      setSending(false);
    }
  };

  if (loading && !ticket) {
    return (
      <Screen>
        <View style={styles.center}>
          <ActivityIndicator color={Colors.primary} />
        </View>
      </Screen>
    );
  }

  if (error && !ticket) {
    return (
      <Screen>
        <ErrorCard message={error} onRetry={load} />
      </Screen>
    );
  }

  if (!ticket) return null;

  return (
    <Screen>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <Row style={{ justifyContent: 'space-between', paddingHorizontal: Spacing.lg, paddingBottom: Spacing.sm }}>
        <Text style={styles.subject}>{ticket.subject}</Text>
        <Pill label={t(`support.status.${ticket.status}`)} tone={STATUS_TONE[ticket.status]} />
      </Row>
      <Text style={styles.meta}>{dateISO(ticket.createdAt)}</Text>
      <TicketThread
        ticketId={ticket.id}
        messages={ticket.messages}
        closed={ticket.status === 'closed'}
        onReply={onReply}
        sending={sending}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', paddingVertical: 80 },
  error: { color: Colors.danger, fontSize: FontSize.sm, paddingHorizontal: Spacing.lg, paddingTop: Spacing.md },
  subject: { flex: 1, fontSize: FontSize.md, fontFamily: 'PlusJakartaSans_700Bold', color: Colors.text, paddingRight: Spacing.sm },
  meta: { color: Colors.textTertiary, fontSize: FontSize.xs, paddingHorizontal: Spacing.lg, marginBottom: Spacing.sm },
});
