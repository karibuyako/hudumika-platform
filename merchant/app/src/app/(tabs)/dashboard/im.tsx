import { Stack, router } from 'expo-router';
import { useEffect, useSyncExternalStore } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { t, onLocaleChange } from '@/i18n';
import { Btn, Card, Chip, Empty, Icon, Row, Screen } from '@/components/ui';
import { Colors, FontSize, Radius, Spacing } from '@/constants/theme';
import { clock } from '@/lib/format';
import { useChatStore, type ChatFilter } from '@/store/chat';

export default function ChatListScreen() {
  useSyncExternalStore(onLocaleChange, () => 0);
  const threads = useChatStore((s) => s.threads);
  const filter = useChatStore((s) => s.filter);
  const loading = useChatStore((s) => s.loading);
  const error = useChatStore((s) => s.error);
  const hydrate = useChatStore((s) => s.hydrate);
  const setFilter = useChatStore((s) => s.setFilter);

  const FILTERS: { key: ChatFilter; label: string }[] = [
    { key: 'all', label: t('im.filterAll') },
    { key: 'open', label: t('im.filterOpen') },
    { key: 'archived', label: t('im.filterArchived') },
    { key: 'blocked', label: t('im.filterBlocked') },
  ];

  useEffect(() => {
    hydrate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const visible = threads.filter((t) => (filter === 'all' ? true : (t.status ?? 'open') === filter));
  const sorted = [...visible].sort((a, b) => b.lastTs - a.lastTs);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: Colors.bg }} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.topBar}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Icon name="chevron-back" size={26} color={Colors.text} />
        </Pressable>
        <Text style={styles.topTitle}>{t('im.title')}</Text>
        <View style={{ width: 26 }} />
      </View>

      <Screen scroll>
        <Row gap={8} style={{ marginBottom: Spacing.md, flexWrap: 'wrap' }}>
          {FILTERS.map((f) => (
            <Chip key={f.key} label={f.label} selected={filter === f.key} onPress={() => setFilter(f.key)} count={f.key === 'all' ? threads.length : threads.filter((x) => (x.status ?? 'open') === f.key).length} />
          ))}
        </Row>

        {loading && sorted.length === 0 ? (
          <View style={{ gap: Spacing.md }}>
            {[1, 2, 3].map((i) => (
              <View key={i} style={styles.skeletonRow}>
                <View style={styles.skeletonAvatar} />
                <View style={{ flex: 1, gap: 6 }}>
                  <View style={styles.skeletonLine} />
                  <View style={[styles.skeletonLine, { width: '60%' }]} />
                </View>
              </View>
            ))}
          </View>
        ) : null}

        {error && sorted.length === 0 ? (
          <Card style={{ gap: Spacing.sm, alignItems: 'center' }}>
            <Icon name="cloud-offline-outline" size={22} color={Colors.danger} />
            <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary, textAlign: 'center' }}>{t('im.loadFailed')}</Text>
            <Btn label={t('common.retry')} size="sm" variant="outline" onPress={() => hydrate()} />
          </Card>
        ) : null}

        {!loading && !error && sorted.length === 0 ? <Empty icon="chatbubbles-outline" title={t('im.empty')} /> : null}
        <View style={{ gap: Spacing.md }}>
          {sorted.map((th) => (
            <Pressable key={th.id} onPress={() => router.push(`/dashboard/im/${th.id}`)} style={({ pressed }) => [{ opacity: pressed ? 0.7 : 1 }]}>
              <Card style={[styles.thread, th.unread > 0 && styles.threadUnread]}>
                <View style={[styles.avatar, { backgroundColor: th.unread > 0 ? Colors.primarySoft : Colors.surface }]}>
                  <Text style={[styles.avatarText, th.unread > 0 && { color: Colors.primaryDark }]}>{th.customerInitial}</Text>
                </View>
                <View style={{ flex: 1, gap: 3 }}>
                  <Row style={{ justifyContent: 'space-between' }}>
                    <Text style={styles.name} numberOfLines={1}>{th.customerName}</Text>
                    <Text style={styles.time}>{clock(th.lastTs)}</Text>
                  </Row>
                  <Text style={styles.lastMsg} numberOfLines={1}>{th.lastMessage}</Text>
                  <Row gap={6}>
                    <Text style={styles.context} numberOfLines={1}>{th.context}</Text>
                    {(th.status ?? 'open') === 'blocked' ? (
                      <View style={styles.blockedBadge}>
                        <Text style={styles.blockedText}>{t('im.blocked')}</Text>
                      </View>
                    ) : null}
                  </Row>
                </View>
                {th.unread > 0 ? (
                  <View style={styles.badge}>
                    <Text style={styles.badgeText}>{th.unread}</Text>
                  </View>
                ) : null}
              </Card>
            </Pressable>
          ))}
        </View>
      </Screen>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    backgroundColor: Colors.card,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.border,
  },
  topTitle: { fontSize: FontSize.lg, fontWeight: '800', color: Colors.text },
  thread: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 14 },
  threadUnread: { borderLeftWidth: 3, borderLeftColor: Colors.primary },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { fontSize: FontSize.md, fontWeight: '800', color: Colors.textSecondary },
  name: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text, flex: 1 },
  time: { fontSize: FontSize.xs, color: Colors.textTertiary },
  lastMsg: { fontSize: FontSize.sm, color: Colors.textSecondary },
  context: { fontSize: FontSize.xs, color: Colors.textTertiary, flex: 1 },
  blockedBadge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: Radius.pill,
    backgroundColor: Colors.dangerSoft,
  },
  blockedText: { fontSize: 10, fontWeight: '800', color: Colors.danger },
  badge: {
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: Colors.danger,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 5,
  },
  badgeText: { color: Colors.white, fontSize: 10, fontWeight: '800' },
  empty: { fontSize: FontSize.sm, color: Colors.textTertiary, textAlign: 'center', marginTop: Radius.lg },
  skeletonRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 14 },
  skeletonAvatar: { width: 44, height: 44, borderRadius: 22, backgroundColor: Colors.surface },
  skeletonLine: { height: 12, borderRadius: 6, backgroundColor: Colors.surface },
});
