import { Redirect, useLocalSearchParams } from 'expo-router';

/** Deep link hudumika-rider://order/{orderId} → the delivery detail screen. */
export default function OrderDeepLink() {
  const { orderId } = useLocalSearchParams<{ orderId: string }>();
  if (!orderId) return <Redirect href="/home" />;
  return <Redirect href={`/orders/${orderId}`} />;
}
