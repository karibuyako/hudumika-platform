import { Stack } from 'expo-router';
import { useSyncExternalStore } from 'react';

import { t, onLocaleChange } from '@/i18n';
import { HeaderStyle } from '@/constants/theme';

export default function OrdersLayout() {
  useSyncExternalStore(onLocaleChange, () => 0);
  return (
    <Stack screenOptions={{ ...HeaderStyle, animation: 'slide_from_right' }}>
      <Stack.Screen name="index" options={{ title: t('tab.orders') }} />
      <Stack.Screen name="[id]" options={{ title: t('od.layoutTitle') }} />
      <Stack.Screen name="refunds" options={{ title: t('rf.title') }} />
      <Stack.Screen name="search" options={{ title: t('sr.title') }} />
    </Stack>
  );
}