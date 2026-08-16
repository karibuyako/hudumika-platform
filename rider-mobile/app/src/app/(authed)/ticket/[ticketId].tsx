import { useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { ApiError } from '@/api/client';
import { Btn, Card, Empty, Pill, Row, Screen, Spinner } from '@/components/ui';
import { Colors, FontSize, Spacing } from '@/constants/theme';
import { t } from '@/i18n';
import { dateISO } from '@/lib/format';
import { getSupportRepository } from '@/repos';
import type { Ticket } from '@hudumika/contract';

/** Deep link hudumika-rider://ticket/{ticketId} → ticket status. */
export default function TicketDeepLink() {
  const { ticketId } = useLocalSearchParams<{ ticketId: string }>();
  const [ticket, setTicket] = useState<Ticket | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!ticketId) return;
    let cancelled = false;
    getSupportRepository()
      .listTickets()
      .then((tickets) => {
        if (cancelled) return;
        setTicket(tickets.find((t) => t.id === ticketId) ?? null);
        setError('');
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof ApiError ? e.message : t('tickets.loadFailed'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [ticketId]);

  const reload = async () => {
    try {
      const tickets = await getSupportRepository().listTickets();
      setTicket(tickets.find((t) => t.id === ticketId) ?? null);
      setError('');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('tickets.loadFailed'));
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <Screen>
        <View style={styles.center}>
          <Spinner color={Colors.primary} />
        </View>
      </Screen>
    );
  }

  if (error) {
    return (
      <Screen>
        <View style={styles.center}>
          <Text style={styles.error}>{error}</Text>
          <Btn label={t('common.retry')} variant="ghost" onPress={reload} />
        </View>
      </Screen>
    );
  }

  if (!ticket) {
    return (
      <Screen>
        <Empty icon="document-text-outline" title={t('tickets.notFound')} sub={ticketId ? `ID: ${ticketId}` : undefined} />
      </Screen>
    );
  }

  return (
    <Screen>
      <View style={styles.content}>
        <Card style={{ gap: Spacing.sm }}>
          <Row style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <Text style={styles.subject}>{ticket.subject}</Text>
            <Pill label={ticket.status.toUpperCase()} tone={ticket.status === 'resolved' || ticket.status === 'closed' ? 'success' : 'info'} />
          </Row>
          <Text style={styles.sub}>{dateISO(ticket.createdAt)}</Text>
          <Row gap={Spacing.sm}>
            <Pill label={ticket.priority.toUpperCase()} tone="neutral" />
            {ticket.assignedAgentId ? <Text style={styles.sub}>{t('tickets.assigned')}</Text> : null}
          </Row>
        </Card>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: Spacing.md },
  content: { padding: Spacing.lg, gap: Spacing.md },
  subject: { flex: 1, fontSize: FontSize.lg, fontWeight: '800', color: Colors.text },
  sub: { fontSize: FontSize.xs, color: Colors.textTertiary },
  error: { color: Colors.danger, fontSize: FontSize.sm },
});
