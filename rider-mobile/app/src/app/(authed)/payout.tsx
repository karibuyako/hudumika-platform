import { Redirect } from 'expo-router';

/** Deep link hudumika-rider://payout → the earnings tab (payout statement). */
export default function PayoutDeepLink() {
  return <Redirect href="/earnings" />;
}
