import { router } from 'expo-router';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Btn, Card, Chip, Empty, Icon, IconName, Row, Screen } from '@/components/ui';
import { Colors, FontSize } from '@/constants/theme';
import { timeAgo } from '@/lib/format';
import { t, onLocaleChange, type I18nKey } from '@/i18n';
import type { NotificationDto } from '@/api/types';
import { useChatStore } from '@/store/chat';
import { useMessageStore } from '@/store/messages';
import type { AppMessage, MessageType } from '@/types';

const TYPE_ICONS: Record<MessageType, IconName> = {
  order: 'receipt-outline',
  review: 'star-outline',
  system: 'megaphone-outline',
};

const CATEGORY_META: Record<Exclude<AppMessage['category'], undefined>, { icon: IconName; tint: string }> = {
  important: { icon: 'alert-circle-outline', tint: Colors.danger },
  feature: { icon: 'sparkles-outline', tint: 'Colors.violet' },
  campaign: { icon: 'megaphone-outline', tint: Colors.warning },
  marketing: { icon: 'trending-up-outline', tint: Colors.success },
  im: { icon: 'chatbubbles-outline', tint: Colors.info },
  system: { icon: 'settings-outline', tint: Colors.textSecondary },
};

/** Deep links are `deepLink` values from the API (NOTIFICATIONS.md §Rules) —
 * only known app route prefixes are pushed; anything else toasts and stays. */
const KNOWN_DEEP_LINK_PREFIXES = ['/orders/', '/dashboard/', '/store', '/products', '/ops', '/marketing/', '/finance'];

function isKnownDeepLink(link: string): boolean {
  return KNOWN_DEEP_LINK_PREFIXES.some((p) => link.startsWith(p));
}

type Filter = 'all' | MessageType;
type CatFilter = 'all' | keyof typeof CATEGORY_META;

export default function MessagesScreen() {
  useSyncExternalStore(onLocaleChange, () => 0);
  const messages = useMessageStore((s) => s.messages);
  const loading = useMessageStore((s) => s.loading);
  const error = useMessageStore((s) => s.error);
  const hasMore = useMessageStore((s) => s.hasMore);
  const hydrate = useMessageStore((s) => s.hydrate);
  const loadMore = useMessageStore((s) => s.loadMore);
  const markOneRead = useMessageStore((s) => s.markOneRead);
  const markAllRead = useMessageStore((s) => s.markAllRead);
  const chatUnread = useChatStore((s) => s.unreadTotal);
  const conversationUnread = useChatStore((s) => s.conversationUnread);
  const refreshUnread = useChatStore((s) => s.refreshUnread);
  const pushSystem = useMessageStore((s) => s.pushSystem);
  const [filter, setFilter] = useState<Filter>('all');
  const [cat, setCat] = useState<CatFilter>('all');

  useEffect(() => {
    hydrate();
    refreshUnread();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const unreadCount = messages.filter((m) => !m.read).length;
  const chatBadge = Math.max(conversationUnread, chatUnread);
  const filtered = messages
    .filter((m) => (filter === 'all' ? true : m.type === filter))
    .filter((m) => (cat === 'all' ? true : m.category === cat));

  const open = (m: (typeof messages)[0]) => {
    markOneRead(m.id);
    const deepLink = (m as NotificationDto).deepLink;
    if (deepLink && isKnownDeepLink(deepLink)) {
      router.push(deepLink as never);
    } else if (deepLink) {
      /* missing/unknown target → toast + stay on the list */
      pushSystem(t('msg.deepLinkMissing'), deepLink, 'system');
    } else if (m.orderId) {
      router.push(`/orders/${m.orderId}`);
    }
  };

  return (
    <Screen scroll>
      <Pressable
        onPress={() => router.push('/dashboard/im')}
        style={({ pressed }) => [{ opacity: pressed ? 0.88 : 1 }]}>
        <Card style={styles.chatCard}>
          <View style={[styles.iconWrap, { backgroundColor: Colors.infoSoft }]}>
            <Icon name="chatbubbles-outline" size={20} color={Colors.info} />
          </View>
          <View style={{ flex: 1, gap: 3 }}>
            <Text style={styles.title}>{t('msg.title')}</Text>
            <Text style={styles.body}>
              {chatBadge > 0 ? t('msg.unread', { n: chatBadge }) : t('msg.noUnread')}
            </Text>
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            {chatBadge > 0 ? (
              <View style={[styles.unreadDot, { width: 18, height: 18, borderRadius: 9, alignItems: 'center', justifyContent: 'center' }]}>
                <Text style={{ color: Colors.white, fontSize: 10, fontWeight: '800' }}>{chatBadge}</Text>
              </View>
            ) : null}
            <Icon name="chevron-forward" size={14} color={Colors.textFaint} />
          </View>
        </Card>
      </Pressable>

      <Row style={{ justifyContent: 'space-between', marginTop: 16 }}>
        <Row gap={8} style={{ flex: 1 }}>
          <Chip label={t('msg.all')} selected={filter === 'all'} onPress={() => setFilter('all')} count={messages.length} />
          <Chip label={t('msg.orders')} selected={filter === 'order'} onPress={() => setFilter('order')} tone="danger" count={messages.filter((m) => m.type === 'order').length} />
          <Chip label={t('msg.reviews')} selected={filter === 'review'} onPress={() => setFilter('review')} tone="success" count={messages.filter((m) => m.type === 'review').length} />
          <Chip label={t('msg.system')} selected={filter === 'system'} onPress={() => setFilter('system')} tone="info" count={messages.filter((m) => m.type === 'system').length} />
        </Row>
        {unreadCount > 0 ? (
          <Pressable onPress={markAllRead} hitSlop={8}>
            <Text style={styles.readAll}>{t('msg.readAll')}</Text>
          </Pressable>
        ) : null}
      </Row>

      <Row gap={8} style={{ marginTop: 10, flexWrap: 'wrap' }}>
        {(['important', 'feature', 'campaign', 'marketing', 'im', 'system'] as CatFilter[]).map((c) => {
          const count = messages.filter((m) => m.category === c).length;
          if (!count) return null;
          return (
            <Chip
              key={c}
              label={t(('msg.cat' + c[0].toUpperCase() + c.slice(1)) as I18nKey)}
              selected={cat === c}
              onPress={() => setCat(cat === c ? 'all' : c)}
              count={count}
            />
          );
        })}
      </Row>

      <Text style={styles.summary}>
        {t('msg.count', { n: messages.length, m: unreadCount })}
      </Text>

      <View style={{ gap: SpacingOpts.md, marginTop: SpacingOpts.md }}>
        {loading && messages.length === 0 ? (
          <View style={{ gap: SpacingOpts.md }}>
            {[1, 2, 3].map((i) => (
              <Card key={i} style={styles.skeletonCard}>
                <View style={styles.skeletonIcon} />
                <View style={{ flex: 1, gap: 6 }}>
                  <View style={styles.skeletonLine} />
                  <View style={[styles.skeletonLine, { width: '70%' }]} />
                </View>
              </Card>
            ))}
          </View>
        ) : null}

        {error && messages.length === 0 ? (
          <Card style={{ gap: SpacingOpts.md, alignItems: 'center', paddingVertical: SpacingOpts.lg }}>
            <Icon name="cloud-offline-outline" size={22} color={Colors.danger} />
            <Text style={{ fontSize: FontSize.sm, color: Colors.textSecondary, textAlign: 'center' }}>{t('msg.loadFailed')}</Text>
            <Btn label={t('common.retry')} size="sm" variant="outline" onPress={() => hydrate()} />
          </Card>
        ) : null}

        {!loading && !error && filtered.length === 0 ? <Empty icon="mail-outline" title={t('msg.empty')} /> : null}
        {filtered.map((m) => (
          <Pressable key={m.id} onPress={() => open(m)} style={({ pressed }) => [{ opacity: pressed ? 0.7 : 1 }]}>
            <Card style={[styles.msg, !m.read ? styles.msgUnread : null]}>
              <View style={[styles.iconWrap, m.type === 'order' && { backgroundColor: Colors.dangerSoft }]}>
                <Icon
                  name={m.category && m.category !== 'system' ? CATEGORY_META[m.category].icon : TYPE_ICONS[m.type]}
                  size={20}
                  color={m.type === 'order' ? Colors.danger : m.category ? CATEGORY_META[m.category].tint : Colors.textSecondary}
                />
              </View>
              <View style={{ flex: 1, gap: 3 }}>
                <Row gap={8}>
                  <Text style={[styles.title, !m.read && { fontWeight: '800' }]} numberOfLines={1}>{m.title}</Text>
                </Row>
                <Text style={styles.body} numberOfLines={2}>{m.body}</Text>
                <Text style={styles.time}>{timeAgo(m.ts)}</Text>
              </View>
              <Row gap={6}>
                {!m.read ? <View style={styles.unreadDot} /> : null}
                {(m as NotificationDto).deepLink || m.orderId ? <View style={{ justifyContent: 'center' }}><Icon name="chevron-forward" size={14} color={Colors.textFaint} /></View> : null}
              </Row>
            </Card>
          </Pressable>
        ))}

        {hasMore ? (
          <Btn label={t('msg.loadMore')} variant="outline" loading={loading} onPress={() => loadMore()} />
        ) : null}
      </View>
    </Screen>
  );
}

const SpacingOpts = { md: 12, lg: 16 };

const styles = StyleSheet.create({
  readAll: { fontSize: FontSize.sm, color: Colors.info, fontWeight: '700' },
  summary: { fontSize: FontSize.xs, color: Colors.textTertiary, marginBottom: 4, marginTop: 12 },
  chatCard: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 14 },
  msg: { flexDirection: 'row', gap: 12, paddingVertical: 14 },
  msgUnread: { borderLeftWidth: 3, borderLeftColor: Colors.primary },
  iconWrap: {
    width: 42,
    height: 42,
    borderRadius: 12,
    backgroundColor: Colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: { fontSize: FontSize.md, color: Colors.text, fontWeight: '600', flex: 1 },
  body: { fontSize: FontSize.sm, color: Colors.textSecondary, lineHeight: 19 },
  time: { fontSize: FontSize.xs, color: Colors.textTertiary },
  unreadDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: Colors.danger },
  skeletonCard: { flexDirection: 'row', gap: 12, paddingVertical: 14 },
  skeletonIcon: { width: 42, height: 42, borderRadius: 12, backgroundColor: Colors.surface },
  skeletonLine: { height: 12, borderRadius: 6, backgroundColor: Colors.surface },
});
