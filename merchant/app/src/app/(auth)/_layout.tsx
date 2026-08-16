import { Redirect, Stack } from 'expo-router';

import { useAuthStore } from '@/store/auth';

export default function AuthLayout() {
  const authed = useAuthStore((s) => s.authed);
  if (authed) return <Redirect href="/dashboard" />;
  return (
    <Stack screenOptions={{ headerShown: false, animation: 'fade' }}>
      <Stack.Screen name="login" />
      <Stack.Screen name="register" />
    </Stack>
  );
}