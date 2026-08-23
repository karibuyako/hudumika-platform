import { Stack } from 'expo-router';
import { useSyncExternalStore } from 'react';

import { t, onLocaleChange } from '@/i18n';
import { HeaderStyle } from '@/constants/theme';

export default function DashboardLayout() {
  useSyncExternalStore(onLocaleChange, () => 0);
  return (
    <Stack screenOptions={{ ...HeaderStyle, animation: 'slide_from_right' }}>
      <Stack.Screen name="index" options={{ headerShown: false }} />
      <Stack.Screen name="revenue-detail" options={{ title: t('revd.layoutTitle') }} />
      <Stack.Screen name="analytics" options={{ title: t('an.layoutTitle') }} />
      <Stack.Screen name="reviews" options={{ title: t('rev.title') }} />
      <Stack.Screen name="coupon" options={{ title: t('vch.layoutTitle') }} />
      <Stack.Screen name="finance" options={{ title: t('fin.layoutTitle') }} />
      <Stack.Screen name="messages" options={{ title: t('msg.layoutTitle') }} />
      <Stack.Screen name="notifications-settings" options={{ title: t('notif.layoutTitle') }} />
      <Stack.Screen name="reports" options={{ title: t('rpt.layoutTitle') }} />
      <Stack.Screen name="journeys" options={{ title: t('jrn.layoutTitle') }} />
      <Stack.Screen name="exports" options={{ title: t('dex.layoutTitle') }} />
      <Stack.Screen name="analytics-ext" options={{ title: t('axe.layoutTitle') }} />
      <Stack.Screen name="education" options={{ title: t('edu.title') }} />
      <Stack.Screen name="diagnostics" options={{ title: t('diag.title') }} />
    </Stack>
  );
}