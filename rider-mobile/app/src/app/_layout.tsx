import {
  PlusJakartaSans_400Regular,
  PlusJakartaSans_500Medium,
  PlusJakartaSans_600SemiBold,
  PlusJakartaSans_700Bold,
  PlusJakartaSans_800ExtraBold,
} from '@expo-google-fonts/plus-jakarta-sans';
import {
  SpaceGrotesk_400Regular,
  SpaceGrotesk_500Medium,
  SpaceGrotesk_600SemiBold,
  SpaceGrotesk_700Bold,
} from '@expo-google-fonts/space-grotesk';
import { Stack } from 'expo-router';
import { useFonts } from 'expo-font';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { Spinner } from '@/components/ui';
import { Colors, Fonts, FontSize } from '@/constants/theme';
import { t } from '@/i18n';
import { useSessionStore } from '@/store/session';
import { eventBus } from '@/store/events';
import { isValidApiBase } from '@/api/client';

// Registers the background location task at app launch (module-scope defineTask).
import '@/lib/locationTask';

export default function RootLayout() {
  const status = useSessionStore((s) => s.status);
  const [fontsLoaded] = useFonts({
    PlusJakartaSans_400Regular,
    PlusJakartaSans_500Medium,
    PlusJakartaSans_600SemiBold,
    PlusJakartaSans_700Bold,
    PlusJakartaSans_800ExtraBold,
    SpaceGrotesk_400Regular,
    SpaceGrotesk_500Medium,
    SpaceGrotesk_600SemiBold,
    SpaceGrotesk_700Bold,
  });

  useEffect(() => {
    useSessionStore.getState().restore();
  }, []);

  // Retry while boot — a slow or down mock should not trap the splash forever.
  useEffect(() => {
    if (status !== 'boot') return;
    const timer = setTimeout(() => useSessionStore.getState().restore(), 2000);
    return () => clearTimeout(timer);
  }, [status]);

  // Realtime: WS preferred, long-poll fallback. Starts when authed, stops otherwise.
  useEffect(() => {
    if (status !== 'authed') {
      import('@/api/websocket').then(({ stopRiderRealtime }) => stopRiderRealtime()).catch(() => {});
      return;
    }
    let unsub: (() => void) | null = null;
    import('@/api/websocket')
      .then(({ startRiderRealtime }) => startRiderRealtime())
      .catch(() => import('@/api/events').then(({ startEventStream }) => startEventStream()));
    // Invalidate jobs/notifications on live events (single subscriber, no per-screen cost).
    unsub = eventBus.subscribe((type) => {
      if (type.startsWith('order.') || type.startsWith('surge.') || type.startsWith('forecast.')) {
        import('@/store/jobs').then(({ useJobsStore }) => void useJobsStore.getState().refresh());
      }
    });
    // Connectivity → flush offline queue (native + web). Also listen for online event on web.
    const flush = () => import('@/api/queue').then(({ flushQueue }) => void flushQueue());
    const onOnline = () => void flush();
    if (typeof window !== 'undefined') window.addEventListener('online', onOnline);
    // App foreground re-sync (visibility change)
    const onVisible = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') void flush();
    };
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible);
    return () => {
      if (unsub) unsub();
      if (typeof window !== 'undefined') window.removeEventListener('online', onOnline);
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible);
      import('@/api/websocket').then(({ stopRiderRealtime }) => stopRiderRealtime()).catch(() => {});
    };
  }, [status]);

  const showMockBanner =
    !isValidApiBase() &&
    (process.env.EXPO_PUBLIC_ENV === 'staging' || process.env.EXPO_PUBLIC_ENV === 'production') &&
    status !== 'boot';

  return (
    <SafeAreaProvider>
      <StatusBar style="dark" />
      {showMockBanner ? (
        <View style={styles.mockBanner}>
          <Text style={styles.mockBannerText}>Demo mode — mock data (API URL not configured). Builds work without custom domain; run `eas update` when DNS is ready.</Text>
        </View>
      ) : null}
      {!fontsLoaded || status === 'boot' ? (
        <View style={styles.splash}>
          <Spinner size="large" color={Colors.primary} />
          <Text style={styles.splashText}>{t('common.connecting')}</Text>
        </View>
      ) : (
        <Stack screenOptions={{ headerShown: false }}>
          <Stack.Protected guard={status === 'anon'}>
            <Stack.Screen name="(auth)" />
          </Stack.Protected>
          <Stack.Protected guard={status === 'onboarding'}>
            <Stack.Screen name="(onboarding)" />
          </Stack.Protected>
          <Stack.Protected guard={status === 'authed'}>
            <Stack.Screen name="(tabs)" />
          </Stack.Protected>
          <Stack.Protected guard={status === 'authed'}>
            <Stack.Screen name="(authed)" />
          </Stack.Protected>
        </Stack>
      )}
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  mockBanner: {
    backgroundColor: Colors.warningSoft,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.warning,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  mockBannerText: { color: Colors.warning, fontSize: 11, fontFamily: Fonts.sansBold, textAlign: 'center' },
  splash: {
    flex: 1,
    backgroundColor: Colors.bg,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
  splashText: { color: Colors.textTertiary, fontSize: FontSize.sm, fontFamily: Fonts.sans },
});