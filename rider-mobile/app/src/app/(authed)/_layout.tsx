import { Stack } from 'expo-router';

import { HeaderStyle } from '@/constants/theme';
import { t } from '@/i18n';

/** Authed deep-link group: hudumika-rider://order/{orderId}, ticket/{ticketId}, payout. */
export default function AuthedLayout() {
  return (
    <Stack screenOptions={{ ...HeaderStyle }}>
      <Stack.Screen name="order/[orderId]" options={{ title: t('orders.detailTitle') }} />
      <Stack.Screen name="ticket/[ticketId]" options={{ title: t('tickets.title') }} />
      <Stack.Screen name="payout" options={{ title: t('earnings.payouts') }} />
      <Stack.Screen name="notifications" options={{ headerShown: false }} />
    </Stack>
  );
}
