/* M16p — Trip share (OPERATIONS-COVERAGE #77 "Share live location — trip-
 * share pattern", mock-first, docs/CONTRACT-ADDITIONS.md #27): the view-only
 * tracking share token lifecycle (create → resolve), the error paths
 * (unknown → 404, expired → 410 TRIP_SHARE_EXPIRED), the deep-link allow-list
 * entry (hudumika://track-share/{token}) and the share payload link. */
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

import { resetMockState, rejectsApiError } from './helpers';
import {
  MockOrdersRepository,
  resetMockOrdersState,
  SEED_TRACKING_SHARE_TOKEN,
  TRACKING_SHARE_TTL_MS,
  expireTrackingShare,
} from '@/repos/mock/orders';
import { deepLinkHref, isAllowedDeepLink, parseAndValidateDeepLink } from '@/lib/deep-link';
import { t } from '@/i18n';

const orders = new MockOrdersRepository();

beforeEach(() => {
  resetMockState();
  resetMockOrdersState();
});

test('createTrackingShare issues a ts_ token with a ~2h expiry and replays idempotently', async () => {
  const share = await orders.createTrackingShare('ord_active_001', 'ts-key-1');
  assert.match(share.token, /^ts_ord_active_001_[a-z0-9]{6,}$/, 'token embeds the order id + randoms');
  const ttl = Date.parse(share.expiresAt) - Date.now();
  assert.ok(ttl > TRACKING_SHARE_TTL_MS - 60_000 && ttl <= TRACKING_SHARE_TTL_MS, `expiry is ~2h out (${ttl}ms)`);
  const replay = await orders.createTrackingShare('ord_active_001', 'ts-key-1');
  assert.equal(replay.token, share.token, 'the same idempotency key replays the stored token');
  assert.equal(replay.expiresAt, share.expiresAt);
});

test('resolveTrackingShare returns the order id (created and seeded tokens)', async () => {
  const share = await orders.createTrackingShare('ord_active_001', 'ts-key-2');
  assert.deepEqual(await orders.resolveTrackingShare(share.token), { orderId: 'ord_active_001' });
  // Seeded demo token — the track-share screen renders on first load.
  assert.deepEqual(await orders.resolveTrackingShare(SEED_TRACKING_SHARE_TOKEN), { orderId: 'ord_warehouse_003' });
});

test('unknown token → 404 NOT_FOUND; expired token → 410 TRIP_SHARE_EXPIRED', async () => {
  await rejectsApiError(orders.resolveTrackingShare('ts_nope_000000'), 404, 'NOT_FOUND');
  const share = await orders.createTrackingShare('ord_active_001', 'ts-key-3');
  expireTrackingShare(share.token);
  await rejectsApiError(orders.resolveTrackingShare(share.token), 410, 'TRIP_SHARE_EXPIRED');
});

test('createTrackingShare validates the order (404 ORDER_NOT_FOUND)', async () => {
  await rejectsApiError(orders.createTrackingShare('ord_nope', 'ts-key-4'), 404, 'ORDER_NOT_FOUND');
});

test('deep-link allow-list accepts hudumika://track-share/{token} and maps to the route', () => {
  assert.equal(isAllowedDeepLink('track-share/ts_abc'), true);
  assert.equal(parseAndValidateDeepLink('hudumika://track-share/ts_abc'), 'track-share/ts_abc');
  assert.equal(parseAndValidateDeepLink('hudumika://nope/ts_abc'), null, 'unknown routes stay rejected');
  assert.deepEqual(deepLinkHref('track-share/ts_abc'), { pathname: '/track-share/[token]', params: { token: 'ts_abc' } });
});

test('the trip-share payload embeds the tracking-share deep link', () => {
  const payload = t('tripShare.message', { link: `hudumika://track-share/${SEED_TRACKING_SHARE_TOKEN}` });
  assert.ok(payload.includes(`hudumika://track-share/${SEED_TRACKING_SHARE_TOKEN}`), 'the share link rides the payload');
  assert.ok(payload.includes('Hudumika'), 'the message names the platform');
});
