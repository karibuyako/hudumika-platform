import { Ionicons } from '@expo/vector-icons';
import { Redirect, Tabs } from 'expo-router';
import { useSyncExternalStore } from 'react';

import { Colors } from '@/constants/theme';
import { onLocaleChange, t } from '@/i18n';
import { useAuthStore } from '@/store/auth';
import { useMessageStore } from '@/store/messages';
import { useOrderStore } from '@/store/orders';

export default function TabsLayout() {
  useSyncExternalStore(onLocaleChange, () => 0);
  const authed = useAuthStore((s) => s.authed);
  const newCount = useOrderStore((s) => s.orders.filter((o) => o.status === 'new' && !o.seen).length);
  const unreadMessages = useMessageStore((s) => s.messages.filter((m) => !m.read).length);

  if (!authed) return <Redirect href="/login" />;

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
        },
        tabBarLabelStyle: { fontSize: 10, fontWeight: '600' },
      }}>
      <Tabs.Screen
        name="dashboard"
        options={{
          title: t('tab.home'),
          tabBarIcon: ({ color, focused }) => (
            <Ionicons name={focused ? 'grid' : 'grid-outline'} size={22} color={color} />
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
          tabBarBadge: newCount || undefined,
          tabBarBadgeStyle: { backgroundColor: Colors.danger, color: Colors.white, fontSize: 10 },
        }}
      />
      <Tabs.Screen
        name="products"
        options={{
          title: t('tab.menu'),
          tabBarIcon: ({ color, focused }) => (
            <Ionicons name={focused ? 'restaurant' : 'restaurant-outline'} size={22} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="marketing"
        options={{
          title: t('tab.promos'),
          tabBarIcon: ({ color, focused }) => (
            <Ionicons name={focused ? 'megaphone' : 'megaphone-outline'} size={22} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="store"
        options={{
          title: t('tab.store'),
          tabBarIcon: ({ color, focused }) => (
            <Ionicons name={focused ? 'storefront' : 'storefront-outline'} size={22} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="ops"
        options={{
          title: t('tab.ops'),
          tabBarIcon: ({ color, focused }) => (
            <Ionicons name={focused ? 'people' : 'people-outline'} size={22} color={color} />
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
          tabBarBadge: unreadMessages || undefined,
          tabBarBadgeStyle: { backgroundColor: Colors.danger, color: Colors.white, fontSize: 10 },
        }}
      />
    </Tabs>
  );
}