import { Stack } from 'expo-router';
import { useSyncExternalStore } from 'react';

import { t, onLocaleChange } from '@/i18n';
import { HeaderStyle } from '@/constants/theme';

export default function ProductsLayout() {
  useSyncExternalStore(onLocaleChange, () => 0);
  return (
    <Stack screenOptions={{ ...HeaderStyle, animation: 'slide_from_right' }}>
      <Stack.Screen name="index" options={{ title: t('tab.menu') }} />
      <Stack.Screen name="editor" options={{ title: t('prde.layoutTitle') }} />
    </Stack>
  );
}