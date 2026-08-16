/* M2d — Preferred providers (OPERATIONS-COVERAGE #140, mock-first until the
 * contract ships the surface — docs/CONTRACT-ADDITIONS.md #21). Pins the
 * mock-as-server semantics: the module-local registry seeds one preferred
 * provider, setPreferred toggles + round-trips through listPreferred, unknown
 * providers 404, and replays are idempotent per key. */
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

import { rejectsApiError, resetMockState } from './helpers';
import { getState } from '@/repos/mock/mockState';
import { MockProvidersRepository, resetMockPreferredProvidersState } from '@/repos/mock/providers';

const providers = new MockProvidersRepository();

beforeEach(() => {
  resetMockState();
  resetMockPreferredProvidersState();
});

test('preferred providers seed one provider and setPreferred toggles round-trip through listPreferred', async () => {
  const seeded = getState().home.providers ?? [];
  assert.ok(seeded.length >= 1, 'seeded providers exist');

  const first = seeded[0];
  const second = seeded[1] ?? seeded[0];

  // Seed: exactly the first seeded provider is preferred (deterministic per
  // MOCK_SEED — fixture ids are seed-deterministic UUIDs).
  const initial = await providers.listPreferred();
  assert.deepEqual(initial.map((p) => p.id), [first.id]);

  // Toggle off — the seed provider leaves the preferred list.
  await providers.setPreferred(first.id, false, 'pref-1');
  assert.deepEqual(await providers.listPreferred(), []);

  // Toggle a different provider on, then off again.
  await providers.setPreferred(second.id, true, 'pref-2');
  const preferred = await providers.listPreferred();
  assert.equal(preferred.length, 1);
  assert.equal(preferred[0].id, second.id);
  assert.equal(preferred[0].name, second.name);

  await providers.setPreferred(second.id, false, 'pref-3');
  assert.deepEqual(await providers.listPreferred(), []);
});

test('setPreferred validates the provider — unknown id → 404 NOT_FOUND', async () => {
  await rejectsApiError(providers.setPreferred('prov_does_not_exist', true, 'pref-x'), 404, 'NOT_FOUND');
  // A failed mutation never touches the registry.
  assert.deepEqual(await providers.listPreferred(), [(getState().home.providers ?? [])[0]]);
});

test('setPreferred is idempotent per key — replaying a key never double-applies', async () => {
  const first = (getState().home.providers ?? [])[0];
  const key = 'pref-same-key';

  const on = await providers.setPreferred(first.id, true, key);
  assert.equal(on.id, first.id);
  const replayed = await providers.setPreferred(first.id, true, key);
  assert.equal(replayed.id, first.id);

  const list = await providers.listPreferred();
  assert.equal(list.filter((p) => p.id === first.id).length, 1, 'one entry, not two');
});
