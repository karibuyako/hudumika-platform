import { Ionicons } from '@expo/vector-icons';
import { Redirect, Tabs, usePathname } from 'expo-router';
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Colors, FontSize, Fonts } from '@/constants/theme';
import { onLocaleChange, t } from '@/i18n';
import { useNetworkStore } from '@/store/network';
import { useSessionStore } from '@/store/session';
import { useUnreadStore } from '@/store/unread';
import { eventBus } from '@/store/events';
import { getConversationsRepository } from '@/repos';

export default function TabsLayout() {
  useSyncExternalStore(onLocaleChange, () => 0);
  const status = useSessionStore((s) => s.status);
  const online = useNetworkStore((s) => s.online);
  const pathname = usePathname();
  const inDetail = pathname.startsWith('/order/') || pathname.startsWith('/merchant/') || pathname.startsWith('/checkout');

  // Messages tab unread badge (CHAT.md): GET /conversations/unread-count,
  // refreshed on focus (route change), on chat.message/message.received
  // events, on mount, and on app foreground (root layout AppState listener).
  const unreadCount = useUnreadStore((s) => s.conversations);
  const refreshUnread = useCallback(async () => {
    try {
      useUnreadStore.getState().apply({ conversations: await getConversationsRepository().unreadCount() });
    } catch {
      // Keep the last known count — the badge is advisory only.
    }
  }, []);

  useEffect(() => {
    void refreshUnread();
  }, [refreshUnread]);

  useEffect(() => {
    void refreshUnread();
  }, [pathname, refreshUnread]);

  useEffect(() => {
    return eventBus.subscribe((type) => {
      if (type === 'chat.message' || type === 'message.received') void refreshUnread();
    });
  }, [refreshUnread]);

  // Realtime: long-poll /events while the tab shell is mounted (mocks: off).
  useEffect(() => {
    import('@/api/events').then(({ startEventStream, stopEventStream }) => {
      startEventStream();
      return stopEventStream;
    });
    return () => {
      import('@/api/events').then(({ stopEventStream }) => stopEventStream());
    };
  }, []);

  if (status !== 'authed') return <Redirect href={status === 'onboarding' ? '/onboarding' : '/login'} />;

  return (
    <View style={{ flex: 1 }}>
      {!online ? (
        <View style={styles.offlineBanner} accessibilityRole="alert">
          <Text style={styles.offlineText}>{t('offline.banner')}</Text>
        </View>
      ) : null}
      <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: Colors.tabActive,
        tabBarInactiveTintColor: Colors.tabInactive,
        tabBarStyle: {
          backgroundColor: Colors.card,
          borderTopColor: Colors.border,
          height: 62,
          paddingBottom: 8,
          paddingTop: 6,
          display: inDetail ? 'none' : 'flex',
        },
        tabBarLabelStyle: { fontSize: 10, fontWeight: '600' },
      }}>
      <Tabs.Screen
        name="home"
        options={{
          title: t('tab.home'),
          tabBarIcon: ({ color, focused }) => (
            <Ionicons name={focused ? 'home' : 'home-outline'} size={22} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="orders"
        options={{
          title: t('tab.orders'),
          tabBarIcon: ({ color, focused }) => (
            <Ionicons name={focused ? 'receipt' : 'receipt-outline'} size={22} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="services"
        options={{
          title: t('tab.services'),
          tabBarIcon: ({ color, focused }) => (
            <Ionicons name={focused ? 'construct' : 'construct-outline'} size={22} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="messages"
        options={{
          title: t('tab.messages'),
          tabBarIcon: ({ color, focused }) => (
            <View style={styles.tabIconWrap}>
              <Ionicons name={focused ? 'chatbubbles' : 'chatbubbles-outline'} size={22} color={color} />
              {unreadCount > 0 ? (
                <View style={styles.tabBadge} accessibilityLabel={t('messages.unread')}>
                  <Text style={styles.tabBadgeText}>{unreadCount > 99 ? '99+' : unreadCount}</Text>
                </View>
              ) : null}
            </View>
          ),
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: t('tab.profile'),
          tabBarIcon: ({ color, focused }) => (
            <Ionicons name={focused ? 'person' : 'person-outline'} size={22} color={color} />
          ),
        }}
      />
    </Tabs>
    </View>
  );
}

const styles = StyleSheet.create({
  offlineBanner: {
    backgroundColor: Colors.warningSoft,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  offlineText: { color: Colors.warning, fontSize: FontSize.xs, fontFamily: Fonts.sansSemibold, textAlign: 'center' },
  tabIconWrap: { position: 'relative', alignItems: 'center', justifyContent: 'center' },
  tabBadge: {
    position: 'absolute',
    top: -5,
    right: -11,
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: Colors.danger,
    paddingHorizontal: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tabBadgeText: { color: Colors.white, fontSize: 9, fontFamily: Fonts.sansExtraBold, paddingTop: 1 },
});
