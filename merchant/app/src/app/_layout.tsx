import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useFonts } from 'expo-font';
import * as SecureStore from 'expo-secure-store';
import {
  PlusJakartaSans_400Regular,
  PlusJakartaSans_500Medium,
  PlusJakartaSans_600SemiBold,
  PlusJakartaSans_700Bold,
  PlusJakartaSans_800ExtraBold,
} from '@expo-google-fonts/plus-jakarta-sans';
import { SpaceGrotesk_500Medium, SpaceGrotesk_700Bold } from '@expo-google-fonts/space-grotesk';
import { useEffect, useSyncExternalStore } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ToastHost } from '@/components/toast';
import { Colors, FontSize } from '@/constants/theme';
import { t, onLocaleChange } from '@/i18n';
import { startMockApi } from '@/mock';
import { restoreToken, setTokenPersister } from '@/api/client';
import { startEventPolling, onServerEvent } from '@/api/events';
import { flushQueue, queuedOps } from '@/api/queue';
import { startEventSocket, wireSocketTo } from '@/api/socket';
import type { ServerEvent } from '@/api/types';
import { useCampaignStore } from '@/store/campaigns';
import { useAnalyticsStore } from '@/store/analytics';
import { useCatalogStore } from '@/store/catalog';
import { useChatStore } from '@/store/chat';
import { useCouponStore } from '@/store/coupons';
import { useCustomerStore } from '@/store/customers';
import { useFinanceStore } from '@/store/finance';
import { useMessageStore } from '@/store/messages';
import { useNetworkStore } from '@/store/network';
import { useOrderStore } from '@/store/orders';
import { setRefreshTokenPersister, useSessionStore } from '@/store/session';
import { useStoreStore } from '@/store/store';
import { useTaskStore } from '@/store/tasks';
import { startSimulator } from '@/simulator';

const TOKEN_KEY = 'merchant.token';
const REFRESH_KEY = 'merchant.refreshToken';

// Native: persist the session token in the device keychain (expo-secure-store).
// Web keeps sessionStorage/localStorage via the client's storage fallback.
if (Platform.OS !== 'web') {
  setTokenPersister({
    get: () => SecureStore.getItemAsync(TOKEN_KEY),
    set: (token) => (token ? SecureStore.setItemAsync(TOKEN_KEY, token) : SecureStore.deleteItemAsync(TOKEN_KEY)),
  });
  // Refresh token (SECURITY.md §10): keychain on native; sessionStorage on web.
  setRefreshTokenPersister({
    get: () => SecureStore.getItemAsync(REFRESH_KEY),
    set: (token) => (token ? SecureStore.setItemAsync(REFRESH_KEY, token) : SecureStore.deleteItemAsync(REFRESH_KEY)),
  });
}

function applyServerEvent(event: ServerEvent) {
  switch (event.type) {
    case 'order.created':
    case 'order.updated':
      useOrderStore.getState().upsert(event.order);
      break;
    case 'notification.created':
      useMessageStore.getState().upsert(event.notification);
      break;
    case 'chat.message':
      useChatStore.getState().upsert(event.thread);
      break;
    case 'campaign.updated':
      useCampaignStore.getState().upsert(event.campaign);
      break;
    case 'merchant.updated':
      useStoreStore.getState().hydrate(event.store);
      break;
    case 'task.updated':
      useTaskStore.setState((s) => ({ tasks: s.tasks.map((t) => (t.id === event.task.id ? event.task : t)) }));
      break;
    case 'payment.captured':
    case 'settlement.created':
    case 'ledger.updated':
      useFinanceStore.getState().hydrate();
      break;
  }
}

async function boot() {
  await startMockApi();
  await restoreToken();
  await useSessionStore.getState().restore();
  const status = useSessionStore.getState().status;

  if (status === 'authed') {
    const me = useSessionStore.getState().me!;
    useStoreStore.getState().hydrate(me.store);
    await Promise.all([
      useOrderStore.getState().hydrate(),
      useCatalogStore.getState().hydrate(),
      useFinanceStore.getState().hydrate(),
      useMessageStore.getState().hydrate(),
      useChatStore.getState().hydrate(),
      useCampaignStore.getState().hydrate(),
      useCustomerStore.getState().hydrate(),
      useTaskStore.getState().hydrate(),
      useAnalyticsStore.getState().hydrate(),
      useCouponStore.getState().hydrate(),
    ]);
    startEventPolling();
    wireSocketTo(applyServerEvent);
    startEventSocket();
    if (queuedOps().length) {
      useNetworkStore.getState().setQueuedCount(queuedOps().length);
      flushQueue();
    }
    startSimulator();
  }
}

export default function RootLayout() {
  const [fontsLoaded] = useFonts({
    PlusJakartaSans_400Regular,
    PlusJakartaSans_500Medium,
    PlusJakartaSans_600SemiBold,
    PlusJakartaSans_700Bold,
    PlusJakartaSans_800ExtraBold,
    SpaceGrotesk_500Medium,
    SpaceGrotesk_700Bold,
  });
  const online = useNetworkStore((s) => s.online);
  const syncing = useNetworkStore((s) => s.syncing);
  const queuedCount = useNetworkStore((s) => s.queuedCount);
  useSyncExternalStore(onLocaleChange, () => 0);
  const noun = queuedCount === 1 ? t('offline.change') : t('offline.changes');

  useEffect(() => {
    const unsub = onServerEvent(applyServerEvent);
    const unsubMessages = useMessageStore.subscribe((state, prev) => {
      const msg = state.messages[0];
      const prevMsg = prev.messages[0];
      if (msg && msg.id !== prevMsg?.id && msg.type === 'order' && msg.title?.startsWith('New order')) {
        const settings = useStoreStore.getState().orderSettings;
        import('@/lib/sound').then((m) => m.playNewOrderSound(settings.ringtone, settings.voiceAnnounce));
      }
    });
    boot();
    return () => {
      unsub();
      unsubMessages();
      stopPolling();
      import('@/api/socket').then((m) => m.stopEventSocket());
    };
  }, []);

  if (!fontsLoaded) return null;

  return (
    <SafeAreaProvider>
      <View style={{ flex: 1, backgroundColor: Colors.bg }}>
        <StatusBar style="dark" />
        {!online ? (
          <View style={styles.offlineBar}>
            <Text style={styles.offlineText}>{t('offline.banner', { count: queuedCount, noun })}</Text>
          </View>
        ) : syncing ? (
          <View style={[styles.offlineBar, { backgroundColor: Colors.primary }]}>
            <Text style={[styles.offlineText, { color: Colors.text }]}>{t('offline.syncing', { count: queuedCount, noun })}</Text>
          </View>
        ) : null}
        <ToastHost />
        <Stack screenOptions={{ headerShown: false }}>
          <Stack.Screen name="index" />
          <Stack.Screen name="(auth)" />
          <Stack.Screen name="(tabs)" />
        </Stack>
      </View>
    </SafeAreaProvider>
  );
}

function stopPolling() {
  import('@/api/events').then((m) => m.stopEventPolling());
}

const styles = StyleSheet.create({
  offlineBar: {
    backgroundColor: Colors.warning,
    paddingVertical: 6,
    paddingHorizontal: 16,
    alignItems: 'center',
    zIndex: 100,
  },
  offlineText: { color: Colors.text, fontSize: FontSize.xs, fontWeight: '700' },
});
