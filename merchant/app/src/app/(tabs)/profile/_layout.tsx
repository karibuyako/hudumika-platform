import { Stack } from 'expo-router';
import { useSyncExternalStore } from 'react';

import { t, onLocaleChange } from '@/i18n';
import { HeaderStyle } from '@/constants/theme';

export default function ProfileLayout() {
  useSyncExternalStore(onLocaleChange, () => 0);
  return (
    <Stack screenOptions={{ ...HeaderStyle, animation: 'slide_from_right' }}>
      <Stack.Screen name="index" options={{ title: t('tab.profile') }} />
      <Stack.Screen name="settings" options={{ title: t('set.title') }} />
      <Stack.Screen name="verification" options={{ title: t('ver.title') }} />
      <Stack.Screen name="sessions" options={{ title: t('ses.title') }} />
    </Stack>
  );
}