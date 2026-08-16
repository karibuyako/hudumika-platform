import { useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { FlatList, StyleSheet, Text, View } from 'react-native';

import {
  Badge,
  Card,
  Chip,
  EmptyState,
  ErrorState,
  Icon,
  Row,
  Screen,
  SkeletonCard,
} from '@/components/ui';
import { Colors, Fonts, FontSize, Radius, Spacing } from '@/constants/theme';
import { t, type Key } from '@/i18n';
import { useLiveRefresh } from '@/hooks/useLiveRefresh';
import { getConversationsRepository } from '@/repos';
import { dateISO } from '@/lib/dates';
import type { Conversation } from '@hudumika/contract';
import { ConversationStatus } from '@hudumika/contract';

type ConversationTab = 'all' | 'open' | 'archived' | 'blocked';

const TABS: { key: ConversationTab; labelKey: Key }[] = [
  { key: 'all', labelKey: 'messages.filterAll' },
  { key: 'open', labelKey: 'messages.filterOpen' },
  { key: 'archived', labelKey: 'messages.filterArchived' },
  { key: 'blocked', labelKey: 'messages.filterBlocked' },
];

export default function MessagesScreen() {
  const router = useRouter();
  const [tab, setTab] = useState<ConversationTab>('all');
  const [conversations, setConversations] = useState<Conversation[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      const page = await getConversationsRepository().list(tab === 'all' ? undefined : tab, undefined);
      setConversations(page);
      setCursor(page.length === 20 ? 'next' : null);
    } catch {
      setError(t('common.error'));
    }
  }, [tab]);

  const loadMore = async () => {
    if (loadingMore || !cursor) return;
    setLoadingMore(true);
    try {
      const next = await getConversationsRepository().list(tab === 'all' ? undefined : tab, cursor);
      setConversations((prev) => {
        const seen = new Set((prev ?? []).map((c) => c.id));
        return [...(prev ?? []), ...next.filter((c) => !seen.has(c.id))];
      });
      setCursor(next.length === 20 ? 'next' : null);
    } catch {
      setCursor(null);
    } finally {
      setLoadingMore(false);
    }
  };

  const switchTab = (next: ConversationTab) => {
    if (next === tab) return;
    setConversations(null);
    setCursor(null);
    setTab(next);
  };

  // Realtime: chat.message (in-thread sends) and message.received (incoming
  // from the merchant) both refresh the list + unread badge; notification.created
  // covers conversation.blocked-style rows arriving through the feed.
  useLiveRefresh(['chat.message', 'message.received', 'notification.created'], load);

  useEffect(() => {
    load();
  }, [load]);

  const renderConversation = ({ item }: { item: Conversation }) => (
    <Card style={styles.card} onPress={() => router.push(`/messages/${item.id}`)}>
      <Row gap={Spacing.md}>
        <View style={styles.avatar}>
          <Icon name="storefront" size={18} color={Colors.textSecondary} />
        </View>
        <View style={{ flex: 1 }}>
          <Row style={{ justifyContent: 'space-between' }}>
            <Text style={styles.name} numberOfLines={1}>{item.subject ?? 'General'}</Text>
            <Text style={styles.time}>{dateISO(item.updatedAt)}</Text>
          </Row>
          <Row style={{ justifyContent: 'space-between', marginTop: 4 }}>
            <Text style={styles.preview} numberOfLines={1}>{item.lastMessagePreview}</Text>
            <View style={{ minWidth: 20, alignItems: 'flex-end' }}>
              {item.status === ConversationStatus.blocked ? (
                <Icon name="lock-closed" size={13} color={Colors.warning} />
              ) : (
                <Badge count={item.unreadCount} />
              )}
            </View>
          </Row>
        </View>
      </Row>
    </Card>
  );

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
        <Text style={styles.title}>{t('messages.title')}</Text>
        <View style={styles.tabs}>
          {TABS.map((tb) => (
            <Chip key={tb.key} label={t(tb.labelKey)} selected={tab === tb.key} onPress={() => switchTab(tb.key)} />
          ))}
        </View>
      </View>
      {!conversations ? (
        <View style={{ gap: Spacing.md, padding: Spacing.lg }}>
          <SkeletonCard rows={1} />
          <SkeletonCard rows={1} />
        </View>
      ) : conversations.length === 0 ? (
        <EmptyState
          icon="chatbubbles-outline"
          title={
            tab === 'archived'
              ? t('messages.emptyArchived')
              : tab === 'blocked'
                ? t('messages.emptyBlocked')
                : t('messages.empty')
          }
        />
      ) : (
        <FlatList
          data={conversations}
          keyExtractor={(c) => c.id}
          renderItem={renderConversation}
          onEndReached={loadMore}
          onEndReachedThreshold={0.4}
          ListFooterComponent={
            loadingMore ? (
              <Text style={styles.footer}>{t('common.loadingMore')}</Text>
            ) : (
              <Text style={styles.footer}>{t('common.endOfList')}</Text>
            )
          }
          onRefresh={load}
          refreshing={false}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ padding: Spacing.lg, paddingBottom: 60 }}
        />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  footer: { textAlign: 'center', color: Colors.textFaint, fontSize: FontSize.xs, fontFamily: Fonts.sans, paddingVertical: Spacing.md },
  title: { fontSize: FontSize.xxl, fontFamily: Fonts.displayBold, color: Colors.text, marginBottom: Spacing.md },
  tabs: { flexDirection: 'row', gap: Spacing.sm, marginBottom: Spacing.lg, flexWrap: 'wrap' },
  card: { marginBottom: Spacing.md },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: Radius.md,
    backgroundColor: Colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  name: { fontSize: FontSize.md, fontFamily: Fonts.sansSemibold, color: Colors.text, flex: 1 },
  preview: { fontSize: FontSize.sm, color: Colors.textTertiary, fontFamily: Fonts.sans, flex: 1, paddingRight: Spacing.sm },
  time: { fontSize: FontSize.xs, color: Colors.textFaint, fontFamily: Fonts.sans },
});
