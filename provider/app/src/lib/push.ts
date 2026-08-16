/* Push registration — degrades gracefully.
 *
 * M5: push token is registered at login via the Expo Push Service. There is
 * NO push-token endpoint in API-CONTRACT.yaml yet (tracked Team 6 gap), so the
 * token is never sent anywhere live. expo-notifications is also not a declared
 * dependency in this build; the dynamic loader below resolves it only when it
 * exists, so bundling and node tests are unaffected.
 *
 * Until both land: token stays client-side (in-memory) and in-app polling
 * keeps the notification center live.
 */

let pushToken: string | null = null;

const loadNotifications = new Function('id', 'return import(id)') as (id: string) => Promise<unknown>;

export async function registerPushToken(): Promise<string | null> {
  try {
    const Notifications = await loadNotifications('expo-notifications');
    const mod = Notifications as {
      getPermissionsAsync: () => Promise<{ status: string }>;
      requestPermissionsAsync: () => Promise<{ status: string }>;
      getExpoPushTokenAsync: () => Promise<{ data: string }>;
    };
    const { status } = await mod.getPermissionsAsync();
    if (status !== 'granted') {
      const req = await mod.requestPermissionsAsync();
      if (req.status !== 'granted') return null;
    }
    const token = await mod.getExpoPushTokenAsync();
    pushToken = token.data;
    return pushToken;
  } catch {
    // Module absent or permissions unavailable — in-app polling still works.
    pushToken = null;
    return null;
  }
}

export function getPushToken(): string | null {
  return pushToken;
}
