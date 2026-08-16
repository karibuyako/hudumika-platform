/* M12c — QueryCache (ARCHITECTURE.md "React Query: all server state"
 * decision, README §Server state). Tests the pure core directly — no React
 * renderer: registerQuery caches, invalidateQuery drops exact keys and
 * prefixes, subscribe/notify fans out, and the queryKeys builders round-trip
 * through the cache's key serialization. */
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  clearQueryCache,
  getCacheEntry,
  invalidateQuery,
  peekQuery,
  registerQuery,
  serializeCacheKey,
  subscribeCache,
} from '@/hooks/queryCache';
import { queryKeys } from '@/hooks/query';

beforeEach(() => clearQueryCache());

test('registerQuery caches the loader result and never reloads on a hit', async () => {
  let calls = 0;
  const loader = async () => {
    calls += 1;
    return { id: 'o1', status: 'paid' };
  };

  const first = await registerQuery(queryKeys.orders.detail('o1'), loader);
  assert.equal(calls, 1);
  assert.equal(first.fromCache, false);
  assert.deepEqual(first.data, { id: 'o1', status: 'paid' });

  const second = await registerQuery(queryKeys.orders.detail('o1'), loader);
  assert.equal(calls, 1, 'a cached key never reloads');
  assert.equal(second.fromCache, true);
  assert.deepEqual(second.data, { id: 'o1', status: 'paid' });

  assert.equal(peekQuery(queryKeys.orders.detail('o1'))?.status, 'paid');
  const entry = getCacheEntry(queryKeys.orders.detail('o1'));
  assert.ok(entry && Number.isFinite(entry.at), 'entry carries a load timestamp');
});

test('invalidateQuery by exact key forces the next register to reload', async () => {
  let calls = 0;
  const loader = async () => {
    calls += 1;
    return calls;
  };

  await registerQuery(queryKeys.wallet.me, loader);
  await registerQuery(queryKeys.wallet.me, loader);
  assert.equal(calls, 1);

  invalidateQuery(queryKeys.wallet.me);
  assert.equal(peekQuery(queryKeys.wallet.me), undefined, 'exact key is dropped');

  const reloaded = await registerQuery(queryKeys.wallet.me, loader);
  assert.equal(calls, 2, 'invalidation makes the next register hit the loader');
  assert.equal(reloaded.fromCache, false);
  assert.equal(reloaded.data, 2);
});

test('invalidateQuery by prefix clears every nested key but never siblings', async () => {
  let orders = 0;
  let catalogue = 0;
  await registerQuery(queryKeys.orders.me({ status: 'active' }), async () => ++orders);
  await registerQuery(queryKeys.orders.track('o1'), async () => ++orders);
  await registerQuery(queryKeys.orders.detail('o1'), async () => ++orders);
  await registerQuery(queryKeys.merchants.catalogue('m1'), async () => ++catalogue);

  invalidateQuery(['orders']);

  assert.equal(peekQuery(queryKeys.orders.me({ status: 'active' })), undefined);
  assert.equal(peekQuery(queryKeys.orders.track('o1')), undefined);
  assert.equal(peekQuery(queryKeys.orders.detail('o1')), undefined);
  assert.equal(catalogue, 1, 'unrelated key is never reloaded by a foreign prefix invalidation');
  assert.equal(peekQuery(queryKeys.merchants.catalogue('m1')), 1, 'unrelated cached data is still served');

  await registerQuery(queryKeys.orders.detail('o1'), async () => ++orders);
  assert.equal(orders, 4, 'prefix invalidation makes nested keys reload');
});

test('prefix invalidation never collides across key boundaries', async () => {
  await registerQuery(['orders'], async () => 'exact');
  await registerQuery(['orders', 'me'], async () => 'nested');
  await registerQuery(['ordersx'], async () => 'sibling');
  await registerQuery(['order'], async () => 'shorter-prefix');

  invalidateQuery(['orders']);

  assert.equal(peekQuery(['orders']), undefined);
  assert.equal(peekQuery(['orders', 'me']), undefined);
  assert.equal(peekQuery(['ordersx']), 'sibling', '["ordersx"] is not under ["orders"]');
  assert.equal(peekQuery(['order']), 'shorter-prefix', '["order"] is not under ["orders"]');
});

test('object params serialize stably and invalidate by the same key shape', async () => {
  assert.equal(serializeCacheKey(queryKeys.orders.me({ status: 'active' })), '["orders","me",{"status":"active"}]');
  await registerQuery(queryKeys.orders.me({ status: 'active' }), async () => 'page1');
  assert.equal(peekQuery(['orders', 'me', { status: 'active' }]), 'page1', 'structurally equal params hit the same entry');
  invalidateQuery(['orders', 'me', { status: 'active' }]);
  assert.equal(peekQuery(queryKeys.orders.me({ status: 'active' })), undefined);
});

test('subscribeCache notifies on register and invalidate, unsubscribe stops it', async () => {
  const seen: string[] = [];
  const unsubscribe = subscribeCache(() => seen.push('notify'));

  await registerQuery(['a'], async () => 1);
  assert.deepEqual(seen, ['notify'], 'a fresh load notifies');

  invalidateQuery(['a']);
  assert.deepEqual(seen, ['notify', 'notify'], 'invalidation notifies');

  await registerQuery(['a'], async () => 1);
  await registerQuery(['a'], async () => 2);
  assert.equal(seen.length, 3, 'cache hits do not notify');

  unsubscribe();
  invalidateQuery(['a']);
  assert.equal(seen.length, 3, 'unsubscribed listeners never fire');
});

test('clearQueryCache drops everything and notifies', async () => {
  const seen: string[] = [];
  const unsubscribe = subscribeCache(() => seen.push('notify'));
  await registerQuery(['orders'], async () => 1);
  await registerQuery(['merchants'], async () => 2);
  clearQueryCache();
  assert.equal(peekQuery(['orders']), undefined);
  assert.equal(peekQuery(['merchants']), undefined);
  assert.deepEqual(seen, ['notify', 'notify', 'notify']);
  unsubscribe();
});

test('server failures are never cached — the next register retries the loader', async () => {
  let calls = 0;
  const flaky = async () => {
    calls += 1;
    if (calls === 1) throw new Error('boom');
    return 'ok';
  };

  await assert.rejects(registerQuery(['flaky'], flaky));
  assert.equal(peekQuery(['flaky']), undefined, 'a failed load leaves no entry');

  const retried = await registerQuery(['flaky'], flaky);
  assert.equal(calls, 2);
  assert.equal(retried.fromCache, false);
  assert.equal(retried.data, 'ok');
});

test('string keys work for exact-key use', async () => {
  await registerQuery('orders.me', async () => 42);
  assert.equal(peekQuery('orders.me'), 42);
  invalidateQuery('orders.me');
  assert.equal(peekQuery('orders.me'), undefined);
  await registerQuery(['orders', 'me'], async () => 7);
  assert.equal(peekQuery('orders.me'), undefined, 'string keys never cross-match array keys');
});
