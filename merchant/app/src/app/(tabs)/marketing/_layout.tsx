import { Stack } from 'expo-router';
import { useSyncExternalStore } from 'react';

import { t, onLocaleChange } from '@/i18n';
import { HeaderStyle } from '@/constants/theme';

export default function MarketingLayout() {
  useSyncExternalStore(onLocaleChange, () => 0);
  return (
    <Stack screenOptions={{ ...HeaderStyle, animation: 'slide_from_right' }}>
      <Stack.Screen name="index" options={{ title: t('mkt.layoutTitle') }} />
      <Stack.Screen name="builder" options={{ title: t('mktb.layoutTitle') }} />
      <Stack.Screen name="deals" options={{ title: t('gb.layoutTitle') }} />
      <Stack.Screen name="deal/[id]" options={{ title: t('gb.detailTitle') }} />
      <Stack.Screen name="deal/new" options={{ title: t('gb.newDeal') }} />
      <Stack.Screen name="promotions" options={{ title: t('pm.layoutTitle') }} />
      <Stack.Screen name="coupons" options={{ title: t('cc.layoutTitle') }} />
      <Stack.Screen name="flash-sales" options={{ title: t('fs.layoutTitle') }} />
      <Stack.Screen name="dianjin" options={{ title: t('dj.layoutTitle') }} />
      <Stack.Screen name="precision" options={{ title: t('pr.layoutTitle') }} />
      <Stack.Screen name="self-service" options={{ title: t('ss.layoutTitle') }} />
      <Stack.Screen name="brand" options={{ title: t('bd.layoutTitle') }} />
    </Stack>
  );
}