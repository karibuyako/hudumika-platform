import { create } from 'zustand';

/* Connectivity + offline queue state. Used by src/api/queue.ts to surface
 * sync progress; screens read `online` to flip offline banners.
 */
interface NetworkState {
  online: boolean;
  syncing: boolean;
  queuedCount: number;
  lastSync: number | null;
  setOnline: (online: boolean) => void;
  setSyncing: (syncing: boolean) => void;
  setQueuedCount: (count: number) => void;
  setLastSync: (ts: number) => void;
}

export const useNetworkStore = create<NetworkState>()((set) => ({
  online: typeof navigator !== 'undefined' ? navigator.onLine : true,
  syncing: false,
  queuedCount: 0,
  lastSync: null,
  setOnline: (online) => set({ online }),
  setSyncing: (syncing) => set({ syncing }),
  setQueuedCount: (queuedCount) => set({ queuedCount }),
  setLastSync: (lastSync) => set({ lastSync }),
}));
