import { Stack } from 'expo-router';

import { HeaderStyle } from '@/constants/theme';
import { t } from '@/i18n';

export default function OrdersLayout() {
  return (
    <Stack screenOptions={{ ...HeaderStyle }}>
      <Stack.Screen name="index" options={{ title: t('tab.orders') }} />
      <Stack.Screen name="[orderId]" options={{ title: 'Delivery' }} />
    </Stack>
  );
}