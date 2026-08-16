/* UI state store — purely local flags (never server state, never money). */
import { create } from 'zustand';

const SOUND_KEY = 'consumer.ui.sound';
const MARKETING_KEY = 'consumer.ui.marketing';

function loadFlag(key: string, def: boolean): boolean {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? def : raw === '1';
  } catch {
    return def;
  }
}

function saveFlag(key: string, v: boolean) {
  try {
    localStorage.setItem(key, v ? '1' : '0');
  } catch {
    /* storage unavailable */
  }
}

export type SearchViewMode = 'list' | 'grid';

interface UiState {
  /** accessibilityReduceMotion — kills infinite animations (DESIGN-SYSTEM). */
  reducedMotion: boolean;
  setReducedMotion: (v: boolean) => void;
  /** Search results layout — grid/list toggle (MASTER-BLUEPRINT §6). */
  searchViewMode: SearchViewMode;
  setSearchViewMode: (v: SearchViewMode) => void;
  /** Local notification sounds + marketing consent toggles (Settings). */
  soundEnabled: boolean;
  setSoundEnabled: (v: boolean) => void;
  marketingEnabled: boolean;
  setMarketingEnabled: (v: boolean) => void;
  /** Top-positioned toast (DESIGN-SYSTEM) — success/error/info, auto-dismiss. */
  toast: { id: number; kind: 'success' | 'error' | 'info'; message: string } | null;
  showToast: (message: string, kind?: 'success' | 'error' | 'info') => void;
  dismissToast: () => void;
}

let toastId = 0;

export const useUiStore = create<UiState>()((set) => ({
  reducedMotion: false,
  setReducedMotion: (reducedMotion) => set({ reducedMotion }),
  searchViewMode: 'list',
  setSearchViewMode: (searchViewMode) => set({ searchViewMode }),
  soundEnabled: loadFlag(SOUND_KEY, true),
  setSoundEnabled: (soundEnabled) => {
    saveFlag(SOUND_KEY, soundEnabled);
    set({ soundEnabled });
  },
  marketingEnabled: loadFlag(MARKETING_KEY, true),
  setMarketingEnabled: (marketingEnabled) => {
    saveFlag(MARKETING_KEY, marketingEnabled);
    set({ marketingEnabled });
  },
  toast: null,
  showToast: (message, kind = 'success') => set({ toast: { id: ++toastId, kind, message } }),
  dismissToast: () => set({ toast: null }),
}));

/** Convenience for screens that are not hooked into the store. */
export function toast(message: string, kind: 'success' | 'error' | 'info' = 'success') {
  useUiStore.getState().showToast(message, kind);
}
