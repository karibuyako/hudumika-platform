import { Ionicons } from '@expo/vector-icons';
import { Redirect, Tabs, usePathname } from 'expo-router';
import { useSyncExternalStore } from 'react';

import { Colors } from '@/constants/theme';
import { onLocaleChange, t } from '@/i18n';
import { useSessionStore } from '@/store/session';

export default function TabsLayout() {
  useSyncExternalStore(onLocaleChange, () => 0);
  const status = useSessionStore((s) => s.status);
  const pathname = usePathname();
  const inOrderDetail = pathname.startsWith('/orders/');

  if (status !== 'authed') {
    return <Redirect href={status === 'onboarding' ? '/onboarding' : '/login'} />;
  }

  return (
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
          display: inOrderDetail ? 'none' : 'flex',
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
        name="earnings"
        options={{
          title: t('tab.earnings'),
          tabBarIcon: ({ color, focused }) => (
            <Ionicons name={focused ? 'wallet' : 'wallet-outline'} size={22} color={color} />
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
  );
}