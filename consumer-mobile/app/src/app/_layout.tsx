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
import { Stack, useRouter } from 'expo-router';
import * as Linking from 'expo-linking';
import { useFonts } from 'expo-font';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { AccessibilityInfo, ActivityIndicator, AppState, Platform, StyleSheet, Text } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

import { Colors, Fonts, FontSize } from '@/constants/theme';
import { t } from '@/i18n';
import { isAccessTokenNearExpiry, safeRefresh } from '@/api/client';
import { track } from '@/lib/analytics';
import { deepLinkHref, parseAndValidateDeepLink } from '@/lib/deep-link';
import { pushResponseDeepLink } from '@/lib/push';
import { useSessionStore } from '@/store/session';
import { useNetworkStore } from '@/store/network';
import { useUiStore } from '@/store/ui';
import { useUnreadStore } from '@/store/unread';
import { Toast } from '@/components/toast';

import * as Sentry from '@sentry/react-native';

// Sentry — enabled only when EXPO_PUBLIC_SENTRY_DSN is truthy (eas.json
// staging/production placeholder is "" so local/dev builds stay silent).
// Wrapped in try/catch so a bad DSN never breaks boot.
const SENTRY_DSN = process.env.EXPO_PUBLIC_SENTRY_DSN;
if (SENTRY_DSN) {
  try {
    Sentry.init({
      dsn: SENTRY_DSN,
      enabled: true,
      tracesSampleRate: 0.1,
    });
  } catch {
    /* Sentry init failure is non-fatal */
  }
}

export default function RootLayout() {
  const status = useSessionStore((s) => s.status);
  const router = useRouter();
  const [pendingDeepLink, setPendingDeepLink] = useState<string | null>(null);
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

  // First render of the app shell — the session-level open event.
  useEffect(() => {
    track({ name: 'app_open' });
  }, []);

  // Reduced motion (DESIGN-SYSTEM): no infinite animations when set.
  useEffect(() => {
    AccessibilityInfo.isReduceMotionEnabled().then((v) => useUiStore.getState().setReducedMotion(v));
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', (v) => useUiStore.getState().setReducedMotion(v));
    return () => sub.remove();
  }, []);

  // Retry while boot — a slow or down mock should not trap the splash forever.
  useEffect(() => {
    if (status !== 'boot') return;
    const timer = setTimeout(() => useSessionStore.getState().restore(), 2000);
    return () => clearTimeout(timer);
  }, [status]);

  // Offline banner wiring: connectivity → queue flush.
  useEffect(() => {
    const onOnline = () => {
      useNetworkStore.getState().setOnline(true);
      import('@/api/queue').then(({ flushQueue }) => flushQueue());
    };
    const onOffline = () => useNetworkStore.getState().setOnline(false);
    if (typeof window === 'undefined') return;
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);

  // App lifecycle refresh (SECURITY.md realtime): returning to the foreground
  // proactively rotates a near-expiry access token BEFORE the 401 path (the
  // client's single-flight safeRefresh — never force-logs-out), then refetches
  // the notifications + conversations unread counters. Web benefits too.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active' && useSessionStore.getState().status === 'authed') {
        if (isAccessTokenNearExpiry()) void safeRefresh();
        void useUnreadStore.getState().refreshAll();
      }
    });
    return () => sub.remove();
  }, []);

  // Cold-start + background deep links (SECURITY.md allow-list): validate the
  // raw URL against the allow-list; valid payloads navigate once the session
  // is restored, unknown payloads land on the app root (no navigation).
  useEffect(() => {
    let mounted = true;
    Linking.getInitialURL().then((url) => {
      if (mounted && url) setPendingDeepLink(parseAndValidateDeepLink(url));
    });
    const sub = Linking.addEventListener('url', ({ url }) => setPendingDeepLink(parseAndValidateDeepLink(url)));
    return () => {
      mounted = false;
      sub.remove();
    };
  }, []);

  // Push notification taps (NOTIFICATIONS.md step 5): a tapped notification's
  // deepLink is validated against the same allow-list as cold-start links and
  // routed through the identical pendingDeepLink flow — unknown payloads are
  // ignored. Native-only: expo-notifications is lazy-imported and guarded, so
  // the web demo is unaffected.
  useEffect(() => {
    if (Platform.OS === 'web') return;
    let mounted = true;
    let subscription: { remove: () => void } | null = null;
    void import('expo-notifications')
      .then(async (Notifications) => {
        // Cold start: the app may have been launched by a notification tap.
        const last = await Notifications.getLastNotificationResponseAsync();
        if (mounted && last) {
          const target = pushResponseDeepLink(last);
          if (target) setPendingDeepLink(target);
        }
        subscription = Notifications.addNotificationResponseReceivedListener((response: unknown) => {
          const target = pushResponseDeepLink(response);
          if (target) setPendingDeepLink(target);
        });
      })
      .catch(() => {
        /* native-only module unavailable — push taps do nothing */
      });
    return () => {
      mounted = false;
      subscription?.remove();
    };
  }, []);

  useEffect(() => {
    if (status !== 'authed' || !pendingDeepLink) return;
    const href = deepLinkHref(pendingDeepLink);
    if (href) router.replace(href);
    setPendingDeepLink(null);
  }, [status, pendingDeepLink, router]);

  return (
    <SafeAreaProvider>
      <StatusBar style="dark" />
      {!fontsLoaded || status === 'boot' ? (
        <SafeAreaView style={styles.splash} edges={['top', 'bottom']}>
          <ActivityIndicator size="large" color={Colors.primary} />
          <Text style={styles.splashText}>{t('common.connecting')}</Text>
        </SafeAreaView>
      ) : (
        <>
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
          </Stack>
          <Toast />
        </>
      )}
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  splash: {
    flex: 1,
    backgroundColor: Colors.bg,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
  splashText: { color: Colors.textTertiary, fontSize: FontSize.sm, fontFamily: Fonts.sans },
});
