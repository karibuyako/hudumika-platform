import { Stack } from 'expo-router';

import { HeaderStyle } from '@/constants/theme';
import { t } from '@/i18n';

export default function JobsLayout() {
  return (
    <Stack screenOptions={{ ...HeaderStyle }}>
      <Stack.Screen name="index" options={{ headerShown: false }} />
      <Stack.Screen name="[bookingId]" options={{ title: t('tab.jobs') }} />
      <Stack.Screen name="marketplace" options={{ title: t('jobs.section.marketplace') }} />
      <Stack.Screen name="calendar" options={{ title: t('calendar.title') }} />
      <Stack.Screen name="quotes" options={{ title: t('quotes.title') }} />
      <Stack.Screen name="invoice" options={{ title: t('invoice.title') }} />
      <Stack.Screen name="parts" options={{ title: t('parts.title') }} />
      <Stack.Screen name="proof" options={{ title: t('proof.title') }} />
      <Stack.Screen name="warranty" options={{ title: t('warranty.title') }} />
    </Stack>
  );
}
