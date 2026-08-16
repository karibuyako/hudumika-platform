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

  return (
    <SafeAreaProvider>
      <StatusBar style="dark" />
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
  splash: {
    flex: 1,
    backgroundColor: Colors.bg,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
  splashText: { color: Colors.textTertiary, fontSize: FontSize.sm, fontFamily: Fonts.sans },
});