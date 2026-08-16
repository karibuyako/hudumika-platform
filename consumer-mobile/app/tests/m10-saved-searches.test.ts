/* M10 — Saved searches (app-local store, no contract surface yet):
 * save/list/delete round-trip, dedupe, empty-query guard, localStorage
 * persistence (same shim pattern as tests/m1-auth.test.ts). The store is
 * the honest seam until the contract ships a saved-searches endpoint. */
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

import { useSavedSearchesStore } from '@/store/savedSearches';

const KEY = 'consumer.savedSearches';

/* localStorage shim — the saved-searches store persists through it (node has
 * no storage; the app falls back to localStorage like the web demo). */
const store = new Map<string, string>();
(globalThis as Record<string, unknown>).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, String(v)),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
};

beforeEach(() => {
  store.clear();
  useSavedSearchesStore.setState({ saved: [] });
});

test('saved searches: save → list → delete round-trip', () => {
  const s = useSavedSearchesStore.getState();
  assert.equal(s.saveSearch('chicken and chips'), true);
  assert.deepEqual(useSavedSearchesStore.getState().saved, ['chicken and chips']);
  s.removeSavedSearch('chicken and chips');
  assert.deepEqual(useSavedSearchesStore.getState().saved, []);
});

test('saved searches: most-recent-first ordering, dedupe, empty guard', () => {
  const s = useSavedSearchesStore.getState();
  s.saveSearch('plumber');
  s.saveSearch('mango smoothie');
  assert.deepEqual(useSavedSearchesStore.getState().saved, ['mango smoothie', 'plumber']);
  assert.equal(s.saveSearch('plumber'), false, 'saving an existing query is a no-op');
  assert.equal(s.saveSearch('  '), false, 'blank queries are rejected');
  assert.deepEqual(useSavedSearchesStore.getState().saved, ['mango smoothie', 'plumber']);
});

test('saved searches: persisted to localStorage and loaded back', () => {
  useSavedSearchesStore.getState().saveSearch('beef pilau');
  const persisted = JSON.parse(store.get(KEY) ?? '[]') as string[];
  assert.deepEqual(persisted, ['beef pilau']);
  useSavedSearchesStore.getState().removeSavedSearch('beef pilau');
  assert.deepEqual(JSON.parse(store.get(KEY) ?? '[]'), []);
});

test('saved searches: capped at 20 queries', () => {
  const s = useSavedSearchesStore.getState();
  for (let i = 0; i < 25; i++) {
    s.saveSearch(`query ${i}`);
  }
  const saved = useSavedSearchesStore.getState().saved;
  assert.equal(saved.length, 20);
  assert.equal(saved[0], 'query 24', 'newest first');
  assert.ok(!saved.includes('query 0'), 'oldest dropped');
});
