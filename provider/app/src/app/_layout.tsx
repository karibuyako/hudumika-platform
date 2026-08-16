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
import { AccessibilityInfo, ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { setForbiddenHandler, setUnauthorizedHandler } from '@/api/client';
import { Colors, Fonts, FontSize } from '@/constants/theme';
import { setReduceMotion } from '@/lib/motion';
import { useSessionStore } from '@/store/session';

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

  // Cross-cutting error handling (API.md): 401 → refresh once → retry → logout
  // (transport); 403 → refetch capabilities so the UI never renders stale actions.
  useEffect(() => {
    setUnauthorizedHandler(() => {
      void useSessionStore.getState().logout();
    });
    setForbiddenHandler(() => {
      void useSessionStore.getState().refreshCapabilities();
    });
  }, []);

  // Respect the OS reduce-motion setting (M6 a11y) — gates modal animations + haptics.
  useEffect(() => {
    let sub: { remove: () => void } | null = null;
    AccessibilityInfo.isReduceMotionEnabled().then((enabled) => setReduceMotion(enabled));
    sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    return () => sub?.remove();
  }, []);

  // Retry while boot — a slow or down mock should not trap the splash forever.
  useEffect(() => {
    if (status !== 'boot') return;
    const timer = setTimeout(() => useSessionStore.getState().restore(), 2000);
    return () => clearTimeout(timer);
  }, [status]);

  return (
    <SafeAreaProvider>
      <StatusBar style="dark" />
      {!fontsLoaded || status === 'boot' ? (
        <View style={styles.splash}>
          <ActivityIndicator size="large" color={Colors.primary} />
          <Text style={styles.splashText}>Connecting…</Text>
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
        </Stack>
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
