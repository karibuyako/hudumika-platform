import { create } from 'zustand';

/** Connectivity + sync state: online/offline, queue depth, last sync time. */
interface NetworkState {
  online: boolean;
  syncing: boolean;
  queuedCount: number;
  lastSyncAt: number | null;
  setOnline: (v: boolean) => void;
  setSyncing: (v: boolean) => void;
  setQueuedCount: (n: number) => void;
  setLastSync: (ts: number) => void;
}

export const useNetworkStore = create<NetworkState>()((set) => ({
  online: true,
  syncing: false,
  queuedCount: 0,
  lastSyncAt: null,
  setOnline: (v) => set({ online: v }),
  setSyncing: (v) => set({ syncing: v }),
  setQueuedCount: (n) => set({ queuedCount: n }),
  setLastSync: (ts) => set({ lastSyncAt: ts }),
}));

// React Native has no window/navigator.onLine — the store stays online:true
// and no listeners attach (platform check via EXPO_OS, inlined by
// babel-preset-expo; undefined in Node tests → web behavior).
const IS_NATIVE = process.env.EXPO_OS === 'ios' || process.env.EXPO_OS === 'android';

if (!IS_NATIVE && typeof window !== 'undefined') {
  const apply = () => {
    useNetworkStore.getState().setOnline(navigator.onLine);
    if (navigator.onLine) {
      import('@/api/queue').then((m) => m.flushQueue());
    }
  };
  window.addEventListener('online', apply);
  window.addEventListener('offline', apply);
}
