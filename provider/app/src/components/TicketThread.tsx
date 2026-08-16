import { useState } from 'react';
import { FlatList, StyleSheet, Text, TextInput, View } from 'react-native';

import { Btn } from '@/components/ui';
import { Colors, FontSize, Radius, Spacing } from '@/constants/theme';
import { t } from '@/i18n';
import { dateISO } from '@/lib/format';
import type { TicketDetailMessagesItem } from '@hudumika/contract';

/** Support ticket thread + reply composer. */
export function TicketThread({ ticketId, messages, closed, onReply, sending }: {
  ticketId: string;
  messages: TicketDetailMessagesItem[];
  closed?: boolean;
  onReply: (body: string) => void;
  sending?: boolean;
}) {
  const [draft, setDraft] = useState('');

  const submit = () => {
    if (!draft.trim() || closed) return;
    onReply(draft.trim());
    setDraft('');
  };

  return (
    <View style={{ flex: 1 }}>
      <FlatList
        data={messages}
        keyExtractor={(m, i) => `${ticketId}-${m.createdAt}-${i}`}
        contentContainerStyle={styles.thread}
        renderItem={({ item, index }) => {
          const mine = item.authorRole === 'provider';
          const prev = messages[index - 1];
          const grouped = prev && prev.authorRole === item.authorRole;
          return (
            <View style={[styles.bubble, mine ? styles.mine : styles.theirs, !grouped && { marginTop: Spacing.sm }]}>
              {!grouped ? (
                <Text style={styles.author}>{item.authorRole === 'customer' ? 'Customer' : item.authorRole === 'agent' ? 'Support' : 'You'}</Text>
              ) : null}
              <Text style={[styles.body, mine ? styles.bodyMine : null]}>{item.body}</Text>
              <Text style={styles.ts}>{dateISO(item.createdAt)}</Text>
            </View>
          );
        }}
      />
      {closed ? (
        <Text style={styles.closed}>{t('support.closed')}</Text>
      ) : (
        <View style={styles.composer}>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            placeholder={t('support.replyPlaceholder')}
            placeholderTextColor={Colors.textFaint}
            multiline
            maxLength={4000}
            style={styles.input}
          />
          <Btn label={t('support.reply')} onPress={submit} loading={sending} disabled={!draft.trim()} size="sm" icon="send" />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  thread: { padding: Spacing.lg, gap: 2 },
  bubble: { maxWidth: '85%', borderRadius: Radius.md, padding: Spacing.md, gap: 2 },
  mine: { alignSelf: 'flex-end', backgroundColor: Colors.primarySoft, borderTopRightRadius: 4 },
  theirs: { alignSelf: 'flex-start', backgroundColor: Colors.card, borderTopLeftRadius: 4 },
  author: { fontSize: FontSize.xs, color: Colors.textTertiary, fontFamily: 'PlusJakartaSans_700Bold' },
  body: { fontSize: FontSize.sm, color: Colors.text, lineHeight: 19 },
  bodyMine: { color: Colors.primaryDeep },
  ts: { fontSize: FontSize.xs, color: Colors.textFaint, marginTop: 2 },
  closed: { textAlign: 'center', color: Colors.textTertiary, fontSize: FontSize.sm, padding: Spacing.lg },
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: Spacing.sm,
    padding: Spacing.lg,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Colors.border,
    backgroundColor: Colors.card,
  },
  input: {
    flex: 1,
    borderWidth: 1,
    borderColor: Colors.borderStrong,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.md,
    paddingVertical: 10,
    fontSize: FontSize.sm,
    color: Colors.text,
    maxHeight: 100,
  },
});
