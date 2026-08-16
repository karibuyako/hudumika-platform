import { Stack } from 'expo-router';

import { HeaderStyle } from '@/constants/theme';
import { t } from '@/i18n';

export default function ProfileLayout() {
  return (
    <Stack screenOptions={{ ...HeaderStyle }}>
      <Stack.Screen name="index" options={{ title: t('tab.profile') }} />
      <Stack.Screen name="safety" options={{ title: t('safety.title') }} />
      <Stack.Screen name="vehicle" options={{ title: t('vehicle.title') }} />
      <Stack.Screen name="penalties" options={{ title: t('penalties.title') }} />
    </Stack>
  );
}
