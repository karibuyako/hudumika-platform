/* My event tickets — GET /entertainment/event-tickets/me. Each card shows
 * the ticket code prominently (EV-XXXX), event/tier/venue/startsAt and a
 * status pill (active/used/refunded via StatusPill). */
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { FlatList, StyleSheet, Text, View } from 'react-native';

import { Btn, Card, EmptyState, ErrorState, Row, Screen, SkeletonCard, StatusPill } from '@/components/ui';
import { Colors, Fonts, FontSize, Spacing } from '@/constants/theme';
import { t } from '@/i18n';
import { getEventsRepository } from '@/repos';
import { fullDateISO } from '@/lib/dates';
import type { EventTicket } from '@hudumika/contract';

export default function EventTicketsScreen() {
  const router = useRouter();
  const [tickets, setTickets] = useState<EventTicket[] | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      setTickets(await getEventsRepository().listMyTickets());
    } catch {
      setError(t('common.error'));
    }
  }, []);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
        <Row style={{ justifyContent: 'space-between', marginBottom: Spacing.md }}>
          <Btn label={t('common.back')} onPress={() => router.back()} variant="subtle" size="sm" icon="arrow-back" />
          <Text style={styles.title}>{t('events.myTickets')}</Text>
          <View style={{ width: 48 }} />
        </Row>
      </View>

      {!tickets ? (
        <View style={{ gap: Spacing.md, padding: Spacing.lg }}>
          <SkeletonCard rows={3} />
          <SkeletonCard rows={3} />
        </View>
      ) : (
        <FlatList
          data={tickets}
          keyExtractor={(tkt) => tkt.id}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ padding: Spacing.lg, paddingBottom: 60 }}
          ListEmptyComponent={<EmptyState icon="ticket-outline" title={t('events.noTickets')} />}
          renderItem={({ item }) => (
            <Card style={styles.card}>
              <Row style={{ justifyContent: 'space-between', marginBottom: Spacing.sm }}>
                <Text style={styles.name} numberOfLines={1}>{item.eventTitle ?? item.eventId}</Text>
                <StatusPill status={item.status} />
              </Row>
              <Text style={styles.code}>{item.code}</Text>
              <Text style={styles.meta}>{item.tierName}</Text>
              <Text style={styles.meta}>{item.venue}</Text>
              {item.startsAt ? <Text style={styles.meta}>{t('events.startsAt')} · {fullDateISO(item.startsAt)}</Text> : null}
            </Card>
          )}
        />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: FontSize.xl, fontFamily: Fonts.sansExtraBold, color: Colors.text, flex: 1, textAlign: 'center' },
  card: { marginBottom: Spacing.md, gap: 3 },
  name: { fontSize: FontSize.md, fontFamily: Fonts.sansSemibold, color: Colors.text, flex: 1, paddingRight: Spacing.md },
  code: { fontSize: FontSize.xl, fontFamily: Fonts.displayBold, color: Colors.primaryDeep, letterSpacing: 2, fontVariant: ['tabular-nums'] },
  meta: { fontSize: FontSize.xs, color: Colors.textTertiary, fontFamily: Fonts.sans, marginTop: 2 },
});
