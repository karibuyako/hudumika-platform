import { Ionicons } from '@expo/vector-icons';
import { Redirect, Tabs, usePathname, type Href } from 'expo-router';
import { useSyncExternalStore } from 'react';

import { Colors } from '@/constants/theme';
import { onLocaleChange, t } from '@/i18n';
import { useSessionStore } from '@/store/session';

const STATIC_JOB_ROUTES = ['marketplace', 'calendar', 'quotes', 'invoice', 'parts', 'proof', 'warranty', 'tickets'];

export default function TabsLayout() {
  useSyncExternalStore(onLocaleChange, () => 0);
  const status = useSessionStore((s) => s.status);
  const pathname = usePathname();
  const jobSegment = pathname.split('/')[2];
  const inBookingDetail = pathname.startsWith('/jobs/') && !!jobSegment && !STATIC_JOB_ROUTES.includes(jobSegment);

  if (status !== 'authed') {
    return <Redirect href={(status === 'onboarding' ? '/onboarding' : '/login') as Href} />;
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
          display: inBookingDetail ? 'none' : 'flex',
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
        name="jobs"
        options={{
          title: t('tab.jobs'),
          tabBarIcon: ({ color, focused }) => (
            <Ionicons name={focused ? 'briefcase' : 'briefcase-outline'} size={22} color={color} />
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
