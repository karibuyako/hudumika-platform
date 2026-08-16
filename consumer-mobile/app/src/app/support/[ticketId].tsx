import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { Btn, Card, EmptyState, ErrorState, Row, Screen, SkeletonCard } from '@/components/ui';
import { Colors, Fonts, FontSize, Radius, Spacing } from '@/constants/theme';
import { t } from '@/i18n';
import { getSupportRepository } from '@/repos';
import { useSessionStore } from '@/store/session';
import type { TicketDetail } from '@hudumika/contract';
import { ApiError } from '@/api/client';
import { dateISO } from '@/lib/dates';
import { idempotencyKey } from '@/lib/idempotency';

export default function TicketDetailScreen() {
  const router = useRouter();
  const { ticketId } = useLocalSearchParams<{ ticketId: string }>();
  const user = useSessionStore((s) => s.user);
  const [ticket, setTicket] = useState<TicketDetail | null>(null);
  const [reply, setReply] = useState('');
  const [error, setError] = useState('');
  const [replyError, setReplyError] = useState('');
  const [sending, setSending] = useState(false);

  const load = useCallback(async () => {
    setError('');
    try {
      setTicket(await getSupportRepository().getTicket(ticketId));
    } catch {
      setError(t('common.error'));
    }
  }, [ticketId]);

  useEffect(() => {
    load();
  }, [load]);

  const send = async () => {
    if (!reply.trim()) return;
    setSending(true);
    setReplyError('');
    try {
      await getSupportRepository().reply(ticketId, reply.trim(), idempotencyKey(user?.id ?? 'customer', 'reply'));
      setReply('');
      load();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'TICKET_CLOSED') setReplyError(t('support.closed'));
      else setReplyError(t('common.error'));
      load(); // server state wins
    } finally {
      setSending(false);
    }
  };

  if (error) {
    return (
      <Screen>
        <ErrorState message={error} onRetry={load} />
      </Screen>
    );
  }

  if (!ticket) {
    return (
      <Screen>
        <SkeletonCard rows={4} />
      </Screen>
    );
  }

  const closed = ticket.status === 'closed' || ticket.status === 'resolved';

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ padding: Spacing.lg, paddingBottom: 120 }} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
        <Row style={{ justifyContent: 'space-between', marginBottom: Spacing.md }}>
          <Btn label={t('common.back')} onPress={() => router.back()} variant="subtle" size="sm" icon="arrow-back" />
          <Text style={styles.title} numberOfLines={1}>{ticket.subject}</Text>
        </Row>

        {closed ? (
          <Card style={[styles.banner, { backgroundColor: Colors.dangerSoft }]}>
            <Text style={{ color: Colors.danger, fontSize: FontSize.sm, fontFamily: Fonts.sansSemibold }}>{t('support.closed')}</Text>
          </Card>
        ) : null}

        <Card style={{ gap: Spacing.lg }}>
          {ticket.messages.length === 0 ? (
            <EmptyState icon="chatbubble-ellipses-outline" title={t('messages.noMessages')} />
          ) : (
            ticket.messages.map((m, i) => (
              <View key={`${m.id}-${i}`} style={[styles.bubble, m.authorRole === 'customer' ? styles.bubbleMine : styles.bubbleTheirs]}>
                <Text style={[styles.bubbleText, m.authorRole === 'customer' && { color: Colors.white }]}>{m.body}</Text>
                <Text style={[styles.bubbleMeta, m.authorRole === 'customer' && { color: Colors.gold }]}>{dateISO(m.createdAt)}</Text>
              </View>
            ))
          )}
        </Card>

        {!closed ? (
          <View style={styles.composer}>
            <TextInput
              value={reply}
              onChangeText={setReply}
              placeholder={t('support.reply')}
              placeholderTextColor={Colors.textFaint}
              multiline
              maxLength={4000}
              accessibilityLabel={t('support.reply')}
              style={styles.input}
            />
            <Btn label={t('messages.send')} onPress={send} size="sm" loading={sending} />
          </View>
        ) : null}
        {replyError ? <Text style={styles.error}>{replyError}</Text> : null}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: FontSize.lg, fontFamily: Fonts.sansBold, color: Colors.text, flex: 1, textAlign: 'center' },
  banner: { marginBottom: Spacing.md },
  bubble: { padding: Spacing.md, borderRadius: Radius.md, maxWidth: '85%' },
  bubbleMine: { alignSelf: 'flex-end', backgroundColor: Colors.primary, borderBottomRightRadius: 4 },
  bubbleTheirs: { alignSelf: 'flex-start', backgroundColor: Colors.surface, borderBottomLeftRadius: 4 },
  bubbleText: { fontSize: FontSize.sm, color: Colors.text, fontFamily: Fonts.sans },
  bubbleMeta: { fontSize: FontSize.xs, color: Colors.textFaint, fontFamily: Fonts.sans, marginTop: 4 },
  composer: { flexDirection: 'row', alignItems: 'flex-end', gap: Spacing.sm, marginTop: Spacing.lg },
  input: {
    flex: 1,
    borderWidth: 1,
    borderColor: Colors.borderStrong,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.md,
    paddingVertical: 10,
    fontSize: FontSize.sm,
    color: Colors.text,
    fontFamily: Fonts.sans,
    backgroundColor: Colors.card,
    maxHeight: 90,
  },
  error: { color: Colors.danger, fontSize: FontSize.xs, fontFamily: Fonts.sansSemibold, marginTop: Spacing.sm },
});
