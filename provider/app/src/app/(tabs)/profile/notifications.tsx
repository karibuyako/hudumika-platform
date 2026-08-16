import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, FlatList, RefreshControl, StyleSheet, Text, View } from 'react-native';

import { ApiError } from '@/api/client';
import { NotificationRow } from '@/components/NotificationRow';
import { Btn, Empty, ErrorCard, Row, Screen } from '@/components/ui';
import { Colors, FontSize, Spacing } from '@/constants/theme';
import { t } from '@/i18n';
import { getNotificationsRepository } from '@/repos';
import type { Notification } from '@hudumika/contract';

const openDeepLink = (link?: string | null) => {
  if (!link) return;
  if (link.startsWith('/jobs/')) {
    router.push(link as never);
    return;
  }
  if (link.startsWith('/tickets/')) {
    router.push(link.replace('/tickets/', '/profile/tickets/') as never);
    return;
  }
  if (link === '/earnings') {
    router.push('/earnings' as never);
    return;
  }
  if (link === '/support') {
    router.push('/profile/support' as never);
    return;
  }
  if (link === '/reviews') {
    router.push('/profile/reviews' as never);
    return;
  }
  // Whitelisted profile routes (trust, certifications, contracts, plans, settings).
  const PROFILE_LINKS = ['/profile/trust', '/profile/certifications', '/profile/contracts', '/profile/plans', '/profile/settings', '/profile/staff', '/profile/inventory'];
  if (PROFILE_LINKS.includes(link)) {
    router.push(link as never);
  }
};

export default function NotificationsScreen() {
  const [items, setItems] = useState<Notification[]>([]);
  const [nextCursor, setNextCursor] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (cursor?: string) => {
    try {
      const { items: page, nextCursor: next } = await getNotificationsRepository().list(cursor);
      if (cursor) {
        setItems((prev) => {
          const seen = new Set(prev.map((n) => n.id));
          return [...prev, ...page.filter((n) => !seen.has(n.id))];
        });
      } else {
        setItems(page);
      }
      setNextCursor(next);
      setError('');
    } catch (e) {
      if (!cursor) setError(e instanceof ApiError ? e.message : t('misc.error'));
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const onLoadMore = () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    load(nextCursor);
  };

  const onOpen = useCallback(
    async (n: Notification) => {
      if (!n.read) {
        const prev = items;
        setItems((all) => all.map((x) => (x.id === n.id ? { ...x, read: true } : x)));
        try {
          await getNotificationsRepository().markRead(n.id);
        } catch {
          setItems(prev);
        }
      }
      openDeepLink(n.deepLink);
    },
    [items],
  );

  const onMarkAllRead = async () => {
    if (items.length === 0) return;
    const prev = items;
    setItems((all) => all.map((x) => ({ ...x, read: true })));
    try {
      await getNotificationsRepository().markAllRead();
    } catch {
      setItems(prev);
    }
  };

  const unread = items.filter((n) => !n.read).length;

  // Hoisted renderItem (M6 perf) — no inline list render functions.
  const renderNotification = useCallback(
    ({ item }: { item: Notification }) => <NotificationRow notification={item} onPress={() => onOpen(item)} />,
    [onOpen],
  );

  return (
    <Screen>
      <FlatList
        data={items}
        keyExtractor={(n) => n.id}
        contentContainerStyle={styles.list}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Colors.primary} />}
        ListHeaderComponent={
          <Row style={{ justifyContent: 'space-between', marginBottom: Spacing.md }}>
            <Text style={styles.unread}>
              {unread} {t('notifications.unread')}
            </Text>
            <Btn label={t('notifications.markAllRead')} variant="ghost" size="sm" onPress={onMarkAllRead} disabled={unread === 0} />
          </Row>
        }
        ListEmptyComponent={
          loading && !refreshing ? (
            <View style={styles.center}>
              <ActivityIndicator color={Colors.primary} />
            </View>
          ) : error ? (
            <ErrorCard message={error} onRetry={load} />
          ) : (
            <Empty icon="notifications-outline" title={t('notifications.empty')} sub={t('notifications.emptySub')} />
          )
        }
        ListFooterComponent={
          nextCursor ? (
            <View style={styles.loadMore}>
              <Btn label={t('misc.loadMore')} variant="outline" size="sm" onPress={onLoadMore} loading={loadingMore} />
            </View>
          ) : null
        }
        renderItem={renderNotification}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  list: { padding: Spacing.lg, paddingBottom: 120 },
  center: { alignItems: 'center', paddingVertical: 80 },
  unread: { fontSize: FontSize.sm, color: Colors.textSecondary, fontFamily: 'PlusJakartaSans_600SemiBold' },
  loadMore: { alignItems: 'center', paddingVertical: Spacing.md },
});
