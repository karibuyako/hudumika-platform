/* M16n — LIVE STREAMING-LITE live chat: the mock-only live-deals broadcast
 * chat surface (GET/POST /marketing/live-deals/{id}/chat,
 * docs/CONTRACT-ADDITIONS.md #22, parity harness allow-list — the harness is
 * method-agnostic, so the one allow-list literal covers both paths).
 *
 * fetchLiveChat returns the module-local seeded viewer messages for the live
 * session (deterministic timestamps through the setMockNow() clock seam);
 * postLiveChat appends with per-key idempotency (a repeated key replays the
 * same message, never a double post); unknown sessions 404 NOT_FOUND on both
 * reads and writes. */
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

import { ApiError } from '@/api/client';
import { resetMockState, getState } from '@/repos/mock/mockState';
import { MockMarketingRepository, resetMockMarketingState, setMockNow } from '@/repos/mock/marketing';

const NOW = 1_800_000_000_000;

beforeEach(() => {
  resetMockState();
  resetMockMarketingState();
});

/* ---------------- seeded chat for the live session ---------------- */

test('fetchLiveChat returns the seeded viewer messages for the live session', async () => {
  const repo = new MockMarketingRepository();
  setMockNow(NOW);
  const chat = await repo.fetchLiveChat('lds_live_001');
  assert.ok(chat.length >= 3, 'the live session seed carries viewer chatter');
  for (const m of chat) {
    assert.ok(m.id.length > 0 && m.id.startsWith('chat_'), `seeded message has an id (${m.id})`);
    assert.ok(m.authorName.length > 0, 'authorName is present');
    assert.ok(m.body.length > 0, 'body is present');
    assert.ok(Number.isFinite(Date.parse(m.at)), 'at is a parseable ISO timestamp');
  }
  const times = chat.map((m) => Date.parse(m.at));
  assert.deepEqual(times, [...times].sort((a, b) => a - b), 'messages are oldest-first by at');
  assert.ok(times[times.length - 1] <= NOW, 'seed timestamps sit in the past relative to the clock');
});

/* ---------------- post appends + round-trips ---------------- */

test('postLiveChat appends and round-trips through fetchLiveChat', async () => {
  const repo = new MockMarketingRepository();
  setMockNow(NOW);
  const before = await repo.fetchLiveChat('lds_live_001');
  const sent = await repo.postLiveChat('lds_live_001', 'Who is buying the pilau bucket?', 'key-roundtrip-1');
  assert.equal(sent.authorName, getState().user.fullName, 'the echoed message is authored by the demo customer');
  assert.equal(sent.body, 'Who is buying the pilau bucket?');
  assert.ok(Number.isFinite(Date.parse(sent.at)), 'the echoed message carries an ISO timestamp');
  const after = await repo.fetchLiveChat('lds_live_001');
  assert.equal(after.length, before.length + 1, 'the posted message is persisted');
  assert.equal(after[after.length - 1].id, sent.id, 'the round-trip returns the posted message last');
});

/* ---------------- idempotency ---------------- */

test('postLiveChat is idempotent per key: a repeated key replays, never double-posts', async () => {
  const repo = new MockMarketingRepository();
  setMockNow(NOW);
  await repo.postLiveChat('lds_live_001', 'Asante — ordered!', 'key-dup-1');
  const replay = await repo.postLiveChat('lds_live_001', 'Asante — ordered!', 'key-dup-1');
  const chat = await repo.fetchLiveChat('lds_live_001');
  const matches = chat.filter((m) => m.id === replay.id);
  assert.equal(matches.length, 1, 'the replayed key returns the same message without duplicating it');
});

/* ---------------- unknown session ---------------- */

test('unknown sessions 404 NOT_FOUND on both fetch and post', async () => {
  const repo = new MockMarketingRepository();
  setMockNow(NOW);
  await assert.rejects(
    repo.fetchLiveChat('lds_ghost'),
    (e: unknown) => e instanceof ApiError && e.status === 404 && e.code === 'NOT_FOUND',
  );
  await assert.rejects(
    repo.postLiveChat('lds_ghost', 'hello?', 'key-ghost-1'),
    (e: unknown) => e instanceof ApiError && e.status === 404 && e.code === 'NOT_FOUND',
  );
});
