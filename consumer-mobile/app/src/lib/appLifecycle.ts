/* App-lifecycle refresh (task: app foreground). Pure handler so tests cover
 * it without React Native: on 'active' the app refetches the two unread
 * counters (notifications feed + conversations badge) via injected repo
 * refetchers. Failures keep the last known count (the badge is advisory). */
export interface UnreadCounts {
  notifications: number;
  conversations: number;
}

export interface UnreadRefetchers {
  notifications: () => Promise<number>;
  conversations: () => Promise<number>;
}

/** Refetch both counters independently; a failed refetcher simply does not
 * contribute a value (the caller keeps its previous state). */
export async function handleAppForeground(refetchers: UnreadRefetchers): Promise<Partial<UnreadCounts>> {
  const [notifications, conversations] = await Promise.allSettled([
    refetchers.notifications(),
    refetchers.conversations(),
  ]);
  const out: Partial<UnreadCounts> = {};
  if (notifications.status === 'fulfilled') out.notifications = notifications.value;
  if (conversations.status === 'fulfilled') out.conversations = conversations.value;
  return out;
}
