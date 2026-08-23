import { Redirect, Stack, type Href } from 'expo-router';

import { useSessionStore } from '@/store/session';

export default function AuthLayout() {
  const status = useSessionStore((s) => s.status);
  if (status === 'authed') return <Redirect href={"/home" as Href} />;
  if (status === 'onboarding') return <Redirect href={"/onboarding" as Href} />;
  return (
    <Stack screenOptions={{ headerShown: false, animation: 'fade' }}>
      <Stack.Screen name="login" />
    </Stack>
  );
}
