import { Redirect, Stack } from 'expo-router';
import { useSessionStore } from '@/store/session';

export default function AuthLayout() {
  const status = useSessionStore((s) => s.status);
  if (status === 'authed') return <Redirect href="/home" />;
  if (status === 'onboarding') return <Redirect href="/onboarding" />;
  return (
    <Stack screenOptions={{ headerShown: false, animation: 'fade' }}>
      <Stack.Screen name="login" />
      <Stack.Screen name="verify-otp" />
    </Stack>
  );
}
