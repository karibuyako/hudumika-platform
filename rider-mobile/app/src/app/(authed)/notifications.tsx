import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { ApiError } from '@/api/client';
import { Btn, Card, Empty, Icon, Row, Screen, Spinner } from '@/components/ui';
import { Colors, FontSize, Radius, Spacing } from '@/constants/theme';
import { t } from '@/i18n';
import { dateISO } from '@/lib/format';
import { getNotificationsRepository } from '@/repos';
import type { NotificationItem } from '@/repos';
import type { ComponentProps } from 'react';

type IconName = ComponentProps<typeof Icon>['name'];

const TYPE_ICONS: Record<NotificationItem['type'], IconName> = {
  order: 'receipt-outline',
  earnings: 'cash-outline',
  system: 'information-circle-outline',
  warning: 'warning-outline',
};

/** Only navigate to routes we own; ignore everything else. */
function resolveDeepLink(link: string | null | undefined): string | null {
  if (!link) return null;
  if (/^\/orders\/.+/.test(link)) return link;
  if (/^\/tickets\/.+/.test(link)) return link.replace(/^\/tickets/, '/ticket');
  if (link === '/earnings') return link;
  return null;
}

export default function NotificationsScreen() {
  const [items, setItems] = useState<NotificationItem[] | null>(null);
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');

  useEffect(() => {
    let cancelled = false;
    getNotificationsRepository()
      .list()
      .then((list) => {
        if (cancelled) return;
        setItems(list);
        setError('');
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof ApiError ? e.message : t('notifications.loadFailed'));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const reload = async () => {
    try {
      setItems(await getNotificationsRepository().list());
      setError('');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('notifications.loadFailed'));
    }
  };

  const openItem = async (item: NotificationItem) => {
    const target = resolveDeepLink(item.deepLink);
    if (!item.read) {
      setItems((prev) => (prev ? prev.map((n) => (n.id === item.id ? { ...n, read: true } : n)) : prev));
      try {
        await getNotificationsRepository().markRead(item.id);
      } catch {
        setActionError(t('notifications.markAllFailed'));
        return;
      }
    }
    if (target) router.push(target as never);
  };

  const markAllRead = async () => {
    if (!items?.some((n) => !n.read)) return;
    setActionError('');
    try {
      await getNotificationsRepository().markAllRead();
      setItems((prev) => (prev ? prev.map((n) => ({ ...n, read: true })) : prev));
    } catch {
      setActionError(t('notifications.markAllFailed'));
    }
  };

  const unreadCount = items?.filter((n) => !n.read).length ?? 0;

  return (
    <Screen>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} accessibilityRole="button" accessibilityLabel={t('common.back')} hitSlop={12} style={styles.backBtn}>
          <Icon name="chevron-back" size={22} color={Colors.text} />
        </Pressable>
        <Text style={styles.title}>{t('notifications.title')}</Text>
        <Pressable
          onPress={markAllRead}
          disabled={unreadCount === 0}
          accessibilityRole="button"
          accessibilityLabel={t('notifications.markAllRead')}
          hitSlop={8}
          style={styles.markBtn}>
          <Text style={[styles.markText, unreadCount === 0 && { color: Colors.textFaint }]}>{t('notifications.markAllRead')}</Text>
        </Pressable>
      </View>

      {items === null && !error ? (
        <View style={styles.center}>
          <Spinner color={Colors.primary} />
        </View>
      ) : error ? (
        <View style={styles.center}>
          <Text style={styles.error}>{error}</Text>
          <Btn label={t('common.retry')} variant="ghost" onPress={reload} />
        </View>
      ) : items && items.length === 0 ? (
        <Empty icon="notifications-off-outline" title={t('notifications.empty')} sub={t('notifications.emptySub')} />
      ) : (
        <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
          {items?.map((item) => {
            const unread = !item.read;
            return (
              <Pressable
                key={item.id}
                onPress={() => void openItem(item)}
                accessibilityRole="button"
                accessibilityLabel={`${item.title}. ${item.body}`}
                accessibilityHint={t('notifications.tapHint')}
                style={({ pressed }) => [pressed && { opacity: 0.7 }]}>
                <Card style={styles.itemCard}>
                  <View style={styles.itemIcon}>
                    <Icon name={TYPE_ICONS[item.type]} size={18} color={Colors.primary} />
                  </View>
                  <View style={{ flex: 1, gap: 2 }}>
                    <Row style={{ justifyContent: 'space-between', alignItems: 'center', gap: Spacing.sm }}>
                      <Text style={[styles.itemTitle, unread && styles.itemTitleUnread]} numberOfLines={1}>{item.title}</Text>
                      {unread ? <View style={styles.unreadDot} accessible={false} /> : null}
                    </Row>
                    <Text style={styles.itemBody} numberOfLines={2}>{item.body}</Text>
                    <Text style={styles.itemTime}>{dateISO(item.ts)}</Text>
                  </View>
                </Card>
              </Pressable>
            );
          })}
          {actionError ? <Text style={styles.error}>{actionError}</Text> : null}
        </ScrollView>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.lg,
    paddingBottom: Spacing.sm,
    gap: Spacing.sm,
  },
  backBtn: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: Radius.pill,
    backgroundColor: Colors.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
  },
  title: { flex: 1, fontSize: FontSize.xl, fontWeight: '900', color: Colors.text },
  markBtn: { paddingVertical: 4 },
  markText: { fontSize: FontSize.sm, color: Colors.primary, fontWeight: '700' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: Spacing.md },
  error: { color: Colors.danger, fontSize: FontSize.sm },
  content: { padding: Spacing.lg, gap: Spacing.sm, paddingBottom: Spacing.xl },
  itemCard: { flexDirection: 'row', gap: Spacing.md, alignItems: 'flex-start' },
  itemIcon: {
    width: 36,
    height: 36,
    borderRadius: Radius.pill,
    backgroundColor: Colors.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  itemTitle: { flex: 1, fontSize: FontSize.md, fontWeight: '600', color: Colors.textSecondary },
  itemTitleUnread: { fontWeight: '800', color: Colors.text },
  unreadDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: Colors.primary,
  },
  itemBody: { fontSize: FontSize.sm, color: Colors.textSecondary, lineHeight: 18 },
  itemTime: { fontSize: FontSize.xs, color: Colors.textTertiary },
});
