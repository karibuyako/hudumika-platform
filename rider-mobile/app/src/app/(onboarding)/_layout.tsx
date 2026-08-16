import { Redirect, Stack } from 'expo-router';

import { useSessionStore } from '@/store/session';

export default function OnboardingLayout() {
  const status = useSessionStore((s) => s.status);
  if (status === 'authed') return <Redirect href="/home" />;
  if (status === 'anon') return <Redirect href="/login" />;
  return (
    <Stack screenOptions={{ headerShown: false, animation: 'fade' }}>
      <Stack.Screen name="index" />
    </Stack>
  );
}