/* M16 — Voice + image search: the mock wire for POST /search/voice and
 * POST /search/image returns typed contract SearchResults; the speech
 * wrapper is Node-safe (never touches browser APIs under node).
 * (Endpoint parity: consumer-contract.test.ts — this suite pins repo + lib
 * semantics for the two new search surfaces.)
 */
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

import { resetMockState } from './helpers';
import { MockHomeRepository } from '@/repos/mock/home';
import { MockSearchRepository } from '@/repos/mock/search';
import { startVoiceInput } from '@/lib/speech';
import { SearchResultsResultsItemEntityType } from '@hudumika/contract';

const search = new MockSearchRepository();

beforeEach(() => {
  resetMockState();
});

test('voiceSearch returns typed SearchResults mirroring search for the same query', async () => {
  const feed = await new MockHomeRepository().getHomeFeed();
  const q = feed.merchants![0].businessName.split(' ')[0];

  const voice = await search.voiceSearch(q);
  const text = await search.search(q);
  // The mock IS the server: a voice transcript runs the same corpus scan.
  assert.deepEqual(voice, text);
  assert.equal(voice.query, q);
  assert.ok(Array.isArray(voice.results));
  assert.equal(typeof voice.total, 'number');
  for (const r of voice.results) {
    assert.ok(r.title.length > 0, 'every voice result carries a title');
  }
});

test('voiceSearch with an empty transcript returns an empty typed result set', async () => {
  const res = await search.voiceSearch('');
  assert.equal(res.query, '');
  assert.equal(res.results.length, 0);
  assert.equal(res.total, 0);
  assert.equal(res.nextCursor, null);
});

test('imageSearch returns curated dish results for a known image key', async () => {
  const res = await search.imageSearch({ imageUrl: 'file:///gallery/pilau_plate_2026.jpg' });
  assert.ok(res.results.length > 0, 'a known image key yields curated results');
  assert.ok(
    res.results.every((r) => r.entityType === SearchResultsResultsItemEntityType.dish),
    'visual search results are dishes only (never whole stores)',
  );
  assert.ok(res.results.some((r) => r.title.toLowerCase().includes('pilau')), 'the curated set matches the image subject');
});

test('imageSearch returns an honest empty set for an unknown image', async () => {
  const res = await search.imageSearch({ imageUrl: 'file:///photos/random_landscape_2026.jpg' });
  assert.equal(res.results.length, 0, 'unrecognized images never fabricate hits');
  assert.equal(res.total, 0);
  assert.equal(res.nextCursor, null);
});

test('speech wrapper is node-safe — startVoiceInput resolves VOICE_UNSUPPORTED without touching browser APIs', async () => {
  const result = await startVoiceInput((text) => {
    throw new Error(`must not fire a transcript under node: ${text}`);
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error, 'VOICE_UNSUPPORTED');
});
