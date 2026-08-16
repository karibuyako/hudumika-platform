import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';

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
import { Colors, Fonts, FontSize, Spacing } from '@/constants/theme';
import { t } from '@/i18n';
import { eventBus, type ServerEventType } from '@/store/events';
import { useUnreadStore } from '@/store/unread';
import { getNotificationsRepository } from '@/repos';
import { dateISO, shouldUseRelativeTime, timeAgoISO } from '@/lib/dates';
import { deepLinkHref, isAllowedDeepLink } from '@/lib/deep-link';
import { filterNotificationsByCategory, notificationCategories } from '@/lib/notifications';
import type { Notification } from '@hudumika/contract';

type CategoryFilter = string | 'all';

function isNotificationShape(value: unknown): value is Notification {
  const n = value as Notification | null;
  return (
    !!n &&
    typeof n.id === 'string' &&
    typeof n.type === 'string' &&
    typeof n.title === 'string' &&
    typeof n.body === 'string' &&
    typeof n.read === 'boolean' &&
    typeof n.createdAt === 'string'
  );
}

export default function NotificationsScreen() {
  const router = useRouter();
  const [items, setItems] = useState<Notification[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [category, setCategory] = useState<CategoryFilter>('all');
  const unreadCount = useUnreadStore((s) => s.notifications);
  const PAGE = 15;

  const load = useCallback(async () => {
    setError('');
    try {
      const page = await getNotificationsRepository().list({ limit: PAGE });
      setItems(page);
      setCursor(page.length === PAGE ? 'next' : null);
      void useUnreadStore.getState().refreshAll();
    } catch {
      setError(t('common.error'));
    }
  }, []);

  const loadMore = async () => {
    if (loadingMore || !cursor) return;
    setLoadingMore(true);
    try {
      const next = await getNotificationsRepository().list({ cursor, limit: PAGE });
      setItems((prev) => {
        const seen = new Set((prev ?? []).map((n) => n.id));
        return [...(prev ?? []), ...next.filter((n) => !seen.has(n.id))];
      });
      setCursor(next.length === PAGE ? 'next' : null);
    } catch {
      setCursor(null);
    } finally {
      setLoadingMore(false);
    }
  };

  // Realtime (blueprint §25): notification.created prepends the row (payload
  // carries the server-created notification) and refreshes the unread counter;
  // other order/payment events just reload. Cleaned up on unmount.
  useEffect(() => {
    const onEvent = (type: ServerEventType, payload?: Record<string, unknown>) => {
      if (type === 'notification.created') {
        if (payload && isNotificationShape(payload.notification)) {
          setItems((prev) => (prev ? [payload.notification as Notification, ...prev] : prev));
        } else {
          void load();
        }
        void useUnreadStore.getState().refreshAll();
        return;
      }
      void load();
    };
    return eventBus.subscribe(onEvent);
  }, [load]);

  useEffect(() => {
    load();
  }, [load]);

  const categories = useMemo(() => ['all', ...notificationCategories(items ?? [])], [items]);
  const visible = useMemo(() => filterNotificationsByCategory(items ?? [], category === 'all' ? null : category), [items, category]);

  const open = async (item: Notification) => {
    if (!item.read) {
      await getNotificationsRepository().markRead(item.id);
      setItems((prev) => prev?.map((n) => (n.id === item.id ? { ...n, read: true } : n)) ?? null);
      useUnreadStore.getState().apply({ notifications: Math.max(0, useUnreadStore.getState().notifications - 1) });
    }
    // Only allow-listed routes navigate; every target refetches on its screen.
    if (isAllowedDeepLink(item.deepLink)) {
      const href = deepLinkHref(item.deepLink);
      if (href) router.push(href);
    }
  };

  const markAllRead = () => {
    void getNotificationsRepository().markAllRead().then(load);
  };

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
          <Text style={styles.title}>{t('notifications.title')}</Text>
          <Row gap={Spacing.md}>
            <Pressable
              onPress={markAllRead}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={t('notifications.markAllRead')}>
              <Icon name="checkmark-done" size={18} color={Colors.primaryDeep} />
            </Pressable>
            <Pressable
              onPress={() => router.push('/notification-preferences')}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={t('notifications.preferences')}>
              <Icon name="options-outline" size={18} color={Colors.primaryDeep} />
            </Pressable>
          </Row>
        </Row>
        {unreadCount > 0 ? (
          <Text style={styles.unread}>{t('notifications.unread', { n: unreadCount })}</Text>
        ) : null}
        {items ? (
          <View style={styles.chips}>
            {categories.map((c) => (
              <Chip
                key={c}
                label={c === 'all' ? t('notifications.filterAll') : c.charAt(0).toUpperCase() + c.slice(1)}
                selected={category === c}
                onPress={() => setCategory(c)}
              />
            ))}
          </View>
        ) : null}
      </View>
      {!items ? (
        <SkeletonCard rows={4} />
      ) : visible.length === 0 ? (
        <EmptyState
          icon="notifications-off-outline"
          title={category === 'all' ? t('notifications.empty') : t('notifications.emptyCategory', { category: category.charAt(0).toUpperCase() + category.slice(1) })}
        />
      ) : (
        <FlatList
          data={visible}
          keyExtractor={(n) => n.id}
          onRefresh={load}
          refreshing={false}
          onEndReached={loadMore}
          onEndReachedThreshold={0.4}
          ListFooterComponent={
            loadingMore ? (
              <Text style={styles.footer}>{t('common.loadingMore')}</Text>
            ) : (
              <Text style={styles.footer}>{t('common.endOfList')}</Text>
            )
          }
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ padding: Spacing.lg, paddingBottom: 60 }}
          renderItem={({ item }) => (
            <Card style={[styles.card, item.read && { opacity: 0.6 }]} onPress={() => open(item)}>
              <Row gap={Spacing.md}>
                <View style={styles.icon}>
                  <Icon name="notifications" size={16} color={Colors.textSecondary} />
                </View>
                <View style={{ flex: 1 }}>
                  <Row style={{ justifyContent: 'space-between' }}>
                    <Text style={styles.title2} numberOfLines={1}>{item.title}</Text>
                    <Text style={styles.time}>
                      {shouldUseRelativeTime(item.createdAt) ? timeAgoISO(item.createdAt) : dateISO(item.createdAt)}
                    </Text>
                  </Row>
                  <Text style={styles.body} numberOfLines={2}>{item.body}</Text>
                </View>
                {!item.read ? <Badge count={1} /> : null}
              </Row>
            </Card>
          )}
        />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  footer: { textAlign: 'center', color: Colors.textFaint, fontSize: FontSize.xs, fontFamily: Fonts.sans, paddingVertical: Spacing.md },
  title: { fontSize: FontSize.xxl, fontFamily: Fonts.displayBold, color: Colors.text, marginBottom: Spacing.md },
  title2: { fontSize: FontSize.sm, fontFamily: Fonts.sansSemibold, color: Colors.text, flex: 1, paddingRight: Spacing.sm },
  body: { fontSize: FontSize.xs, color: Colors.textTertiary, fontFamily: Fonts.sans, marginTop: 2 },
  time: { fontSize: FontSize.xs, color: Colors.textFaint, fontFamily: Fonts.sans },
  card: { marginBottom: Spacing.md },
  unread: { fontSize: FontSize.xs, color: Colors.textSecondary, fontFamily: Fonts.sansSemibold, marginBottom: Spacing.sm },
  chips: { flexDirection: 'row', gap: Spacing.sm, marginBottom: Spacing.lg, flexWrap: 'wrap' },
  icon: {
    width: 34,
    height: 34,
    borderRadius: 12,
    backgroundColor: Colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
