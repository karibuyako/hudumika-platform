/* Subscribe to live server events and trigger a refetch (realtime §7).
 * Pass the refetch fn from a useCallback; safe under mocks (bus never fires). */
import { useEffect } from 'react';
import { eventBus, type ServerEventType } from '@/store/events';

export function useLiveRefresh(types: ServerEventType[], refetch: () => void) {
  useEffect(() => {
    return eventBus.subscribe((type) => {
      if (types.includes(type)) refetch();
    });
  }, [types, refetch]);
}