import { Redirect, type Href } from 'expo-router';

import { useSessionStore } from '@/store/session';

export default function IndexRoute() {
  const status = useSessionStore((s) => s.status);
  if (status === 'boot') return null;
  const href = status === 'authed' ? '/home' : status === 'onboarding' ? '/onboarding' : '/login';
  return <Redirect href={href as Href} />;
}
