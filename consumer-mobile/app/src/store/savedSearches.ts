/* Saved searches (app-local, persisted — the offline cache).
 *
 * Server sync: the contract has NO saved-searches surface today. The search
 * surface is GET /search, GET /search/suggest and GET/DELETE /search/history
 * only — there is no POST/GET/DELETE /search/saved endpoint, even though
 * MASTER-BLUEPRINT §6 lists `saved_searches` as a backend entity ("saved
 * searches (profile surface)") and §30 wants saved-search management. This
 * store therefore follows the addresses.ts pattern: localStorage persistence,
 * dedupe by query, most-recent-first. When the contract gains a
 * saved-searches surface, swap this store for SearchRepository-backed calls
 * at the same call sites (search.tsx, favorites.tsx) — no screen change
 * beyond the data source.
 */
import { create } from 'zustand';

const KEY = 'consumer.savedSearches';
const MAX = 20;

function load(): string[] {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

function persist(saved: string[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(saved));
  } catch {
    /* storage unavailable — keep in-memory draft */
  }
}

interface SavedSearchesState {
  saved: string[];
  /** Returns false when the query is empty or already saved (UI toasts the
   * "already saved" case instead of duplicating the chip). */
  saveSearch: (query: string) => boolean;
  removeSavedSearch: (query: string) => void;
}

export const useSavedSearchesStore = create<SavedSearchesState>()((set, get) => ({
  saved: load(),

  saveSearch: (query) => {
    const q = query.trim();
    if (!q) return false;
    if (get().saved.includes(q)) return false;
    const saved = [q, ...get().saved].slice(0, MAX);
    persist(saved);
    set({ saved });
    return true;
  },

  removeSavedSearch: (query) => {
    const saved = get().saved.filter((s) => s !== query);
    persist(saved);
    set({ saved });
  },
}));
