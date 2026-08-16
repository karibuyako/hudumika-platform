import { Stack } from 'expo-router';
import { useSyncExternalStore } from 'react';

import { HeaderStyle } from '@/constants/theme';
import { onLocaleChange, t } from '@/i18n';

export default function ProfileLayout() {
  useSyncExternalStore(onLocaleChange, () => 0);
  return (
    <Stack screenOptions={{ ...HeaderStyle }}>
      <Stack.Screen name="index" options={{ headerShown: false }} />
      <Stack.Screen name="staff" options={{ title: t('staff.title') }} />
      <Stack.Screen name="certifications" options={{ title: t('cert.title') }} />
      <Stack.Screen name="settings" options={{ title: t('settings.title') }} />
      <Stack.Screen name="notifications" options={{ title: t('notifications.title') }} />
      <Stack.Screen name="preferences" options={{ title: t('prefs.title') }} />
      <Stack.Screen name="support" options={{ title: t('support.title') }} />
      <Stack.Screen name="tickets/[ticketId]" options={{ title: t('support.title') }} />
      <Stack.Screen name="catalog" options={{ title: t('catalog.title') }} />
      <Stack.Screen name="technicians" options={{ title: t('technicians.title') }} />
      <Stack.Screen name="dispatcher" options={{ title: t('dispatcher.title') }} />
      <Stack.Screen name="inventory" options={{ title: t('inventory.title') }} />
      <Stack.Screen name="contracts" options={{ title: t('contracts.title') }} />
      <Stack.Screen name="plans" options={{ title: t('plans.title') }} />
      <Stack.Screen name="trust" options={{ title: t('trust.title') }} />
      <Stack.Screen name="reviews" options={{ title: t('reviews.title') }} />
      <Stack.Screen name="copilot" options={{ title: t('copilot.title') }} />
    </Stack>
  );
}
