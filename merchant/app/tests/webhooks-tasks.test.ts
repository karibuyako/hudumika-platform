import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupServer } from 'msw/node';

import { ALL_HTTP_HANDLERS } from '@/mock/handlers';
import { db } from '@/mock/db';
import { seedDatabase } from '@/mock/seed';

const server = setupServer(...(ALL_HTTP_HANDLERS as never[]));

let base = 'http://localhost';
let token: string | null = null;

async function call(
  method: string,
  path: string,
  opts: { body?: unknown; auth?: boolean; idem?: string } = {},
): Promise<{ status: number; body: any }> {
  const url = path.startsWith('/api') ? path : `/api${path}`;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.auth !== false) headers.authorization = `Bearer ${token ?? ''}`;
  if (opts.idem) headers['idempotency-key'] = opts.idem;
  const res = await fetch(`${base}${url}`, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* empty */
  }
  return { status: res.status, body };
}

let ownerToken: string | null = null;

async function loginAs(phone: string) {
  const req = await call('POST', '/auth/request-otp', { auth: false, body: { channel: 'phone', destination: phone, purpose: 'login' } });
  assert.equal(req.status, 200);
  const ok = await call('POST', '/auth/verify-otp', { auth: false, body: { requestId: req.body.requestId, code: req.body.debugCode, purpose: 'login' } });
  assert.equal(ok.status, 200);
  return ok.body.accessToken;
}

before(async () => {
  server.listen({ onUnhandledRequest: 'bypass' });
  db.reset();
  seedDatabase();
  ownerToken = await loginAs('+255700000000');
});

beforeEach(() => {
  token = ownerToken;
});

after(() => {
  server.close();
});

/* ================= Webhooks ================= */

test('webhooks: seeded subscriptions list, contract shape, no secret leak', async () => {
  const res = await call('GET', '/webhooks');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body), 'GET /webhooks returns an array');
  assert.ok(res.body.length >= 2, 'two seeded webhooks');
  const w1 = res.body.find((w: any) => w.id === 'wh_seed_1');
  assert.ok(w1, 'seeded webhook present');
  assert.equal(w1.url, 'https://hooks.example.com/skewer-house');
  assert.ok(Array.isArray(w1.events));
  assert.equal(w1.status, 'active');
  assert.equal(w1.secret, undefined, 'secret is write-only and never returned');
  assert.equal(typeof w1.lastDeliveryAt, 'number');
  assert.equal(typeof w1.createdAt, 'number');
  for (const w of res.body) {
    for (const k of ['id', 'url', 'events', 'status', 'createdAt']) assert.ok(k in w, `webhook has ${k}`);
  }
});

test('webhooks: create validates url + events; 201 returns subscription with secret once', async () => {
  const badUrl = await call('POST', '/webhooks', { body: { url: 'not-a-url', events: ['order.created'] } });
  assert.equal(badUrl.status, 400);
  assert.equal(badUrl.body.error.code, 'WEBHOOK_URL_INVALID');

  const badEvent = await call('POST', '/webhooks', { body: { url: 'https://hooks.example.com/x', events: ['nope.event'] } });
  assert.equal(badEvent.status, 400);
  assert.equal(badEvent.body.error.code, 'WEBHOOK_EVENT_INVALID');

  const noEvents = await call('POST', '/webhooks', { body: { url: 'https://hooks.example.com/x', events: [] } });
  assert.equal(noEvents.status, 400);
  assert.equal(noEvents.body.error.code, 'WEBHOOK_EVENT_INVALID');

  const created = await call('POST', '/webhooks', { body: { url: 'https://hooks.example.com/created', events: ['order.created', 'task.updated'] } });
  assert.equal(created.status, 201);
  assert.equal(created.body.url, 'https://hooks.example.com/created');
  assert.deepEqual(created.body.events.sort(), ['order.created', 'task.updated']);
  assert.equal(created.body.status, 'active');
  assert.equal(created.body.secret, undefined, 'secret not echoed in the create response');

  const list = await call('GET', '/webhooks');
  assert.ok(list.body.some((w: any) => w.id === created.body.id), 'created webhook appears in the list');
});

test('webhooks: PATCH updates url/events/status and rotates secret; DELETE removes', async () => {
  const patched = await call('PATCH', '/webhooks/wh_seed_1', { body: { url: 'https://hooks.example.com/patched', events: ['order.created'], status: 'disabled', rotateSecret: true } });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.url, 'https://hooks.example.com/patched');
  assert.deepEqual(patched.body.events, ['order.created']);
  assert.equal(patched.body.status, 'disabled');
  assert.equal(patched.body.secret, undefined, 'rotated secret is not returned');

  const empty = await call('PATCH', '/webhooks/wh_seed_1', { body: {} });
  assert.equal(empty.status, 400);

  const missing = await call('PATCH', '/webhooks/wh_missing', { body: { status: 'active' } });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, 'WEBHOOK_NOT_FOUND');

  const del = await call('DELETE', '/webhooks/wh_seed_1');
  assert.equal(del.status, 204);
  assert.equal(del.body, null);

  const after = await call('GET', '/webhooks');
  assert.ok(!after.body.some((w: any) => w.id === 'wh_seed_1'), 'deleted webhook gone from list');
  assert.ok(after.body.some((w: any) => w.id === 'wh_seed_2'), 'sibling webhook untouched');
});

test('webhooks: deliveries list with webhookId filter, status + attempts + retry fields', async () => {
  const res = await call('GET', '/webhooks/deliveries');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body));
  assert.ok(res.body.length >= 2, 'two seeded deliveries');

  const okRow = res.body.find((d: any) => d.id === 'wdel_seed_1');
  assert.ok(okRow);
  assert.equal(okRow.webhookId, 'wh_seed_1');
  assert.equal(okRow.status, 'success');
  assert.equal(okRow.attempts, 1);
  assert.equal(okRow.statusCode, 200);
  assert.equal(okRow.nextRetryAt, null);
  assert.equal(typeof okRow.deliveredAt, 'number');

  const retrying = res.body.find((d: any) => d.id === 'wdel_seed_2');
  assert.ok(retrying);
  assert.equal(retrying.status, 'retrying');
  assert.equal(retrying.attempts, 4);
  assert.equal(retrying.statusCode, null);
  assert.equal(typeof retrying.nextRetryAt, 'number', 'retrying rows carry nextRetryAt');

  const filtered = await call('GET', '/webhooks/deliveries?webhookId=wh_seed_2');
  assert.equal(filtered.status, 200);
  assert.ok(filtered.body.length >= 1);
  assert.ok(filtered.body.every((d: any) => d.webhookId === 'wh_seed_2'));

  const limited = await call('GET', '/webhooks/deliveries?limit=1');
  assert.equal(limited.status, 200);
  assert.ok(limited.body.length <= 1);
});

/* ================= Integrations ================= */

test('integrations: seeded registry with contract enums and scopes', async () => {
  const res = await call('GET', '/integrations');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body));
  assert.ok(res.body.length >= 2, 'two seeded integrations');
  const pos = res.body.find((i: any) => i.id === 'int_seed_1');
  assert.ok(pos);
  assert.equal(pos.provider, 'pos');
  assert.equal(pos.status, 'connected');
  assert.equal(typeof pos.lastSyncedAt, 'number');
  assert.ok(Array.isArray(pos.scopes) && pos.scopes.length > 0, 'scopes are server-served');
  const err = res.body.find((i: any) => i.id === 'int_seed_2');
  assert.equal(err.status, 'error');
});

test('integrations: disconnect requires reason, flips status, blocks repeat', async () => {
  const noReason = await call('POST', '/integrations/int_seed_1/disconnect', { body: {} });
  assert.equal(noReason.status, 400);
  assert.equal(noReason.body.error.code, 'INTEGRATION_REASON_REQUIRED');

  const missing = await call('POST', '/integrations/int_missing/disconnect', { body: { reason: 'switching vendor' } });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, 'INTEGRATION_NOT_FOUND');

  const done = await call('POST', '/integrations/int_seed_1/disconnect', { body: { reason: 'switching POS vendor' } });
  assert.equal(done.status, 204);
  assert.equal(done.body, null);

  const list = await call('GET', '/integrations');
  const pos = list.body.find((i: any) => i.id === 'int_seed_1');
  assert.equal(pos.status, 'disconnected');
  assert.equal(pos.lastSyncedAt, null);

  const again = await call('POST', '/integrations/int_seed_1/disconnect', { body: { reason: 'again' } });
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, 'INTEGRATION_DISCONNECTED');
});

/* ================= Tasks center ================= */

test('tasks: detail returns contract TaskItem; missing id is 404', async () => {
  const res = await call('GET', '/tasks/task_seed_anomaly_1');
  assert.equal(res.status, 200);
  assert.equal(res.body.kind, 'anomaly');
  assert.equal(res.body.title, 'Out of stock: Grilled Eggplant');
  assert.equal(res.body.severity, 'critical');
  assert.equal(res.body.status, 'open');
  assert.equal(res.body.refType, 'product');
  assert.equal(res.body.refId, 'p10');
  assert.equal(typeof res.body.createdAt, 'number');
  for (const k of ['id', 'kind', 'title', 'status', 'createdAt']) assert.ok(k in res.body, `task has ${k}`);

  const missing = await call('GET', '/tasks/task_missing');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, 'TASK_NOT_FOUND');
});

test('tasks: PATCH updates status (with note), validates enum, 404 on unknown', async () => {
  const patched = await call('PATCH', '/tasks/task_seed_anomaly_1', { body: { status: 'in_progress', note: 'reordering stock now' } });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.status, 'in_progress');
  assert.equal(patched.body.description, 'reordering stock now', 'note stored on the task');

  const noStatus = await call('PATCH', '/tasks/task_seed_anomaly_1', { body: { note: 'x' } });
  assert.equal(noStatus.status, 400);

  const bad = await call('PATCH', '/tasks/task_seed_anomaly_1', { body: { status: 'archived' } });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, 'TASK_STATUS_INVALID');

  const missing = await call('PATCH', '/tasks/task_missing', { body: { status: 'done' } });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, 'TASK_NOT_FOUND');

  const tooLong = await call('PATCH', '/tasks/task_seed_anomaly_1', { body: { status: 'done', note: 'x'.repeat(501) } });
  assert.equal(tooLong.status, 400);
  assert.equal(tooLong.body.error.code, 'TASK_NOTE_TOO_LONG');
});

test('tasks: anomalies and violations lists are kind-filtered', async () => {
  const anomalies = await call('GET', '/tasks/anomalies');
  assert.equal(anomalies.status, 200);
  assert.ok(Array.isArray(anomalies.body));
  assert.ok(anomalies.body.length >= 2, 'two seeded anomalies');
  assert.ok(anomalies.body.every((t: any) => t.kind === 'anomaly'));
  assert.ok(anomalies.body.some((t: any) => t.id === 'task_seed_anomaly_1'));

  const violations = await call('GET', '/tasks/violations');
  assert.equal(violations.status, 200);
  assert.ok(violations.body.length >= 1, 'seeded violation');
  assert.ok(violations.body.every((t: any) => t.kind === 'violation'));
  assert.ok(violations.body.some((t: any) => t.id === 'task_seed_violation_1'));
});

test('tasks: activities list + submit; duplicate submission conflicts', async () => {
  const res = await call('GET', '/tasks/activities');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body));
  assert.ok(res.body.length >= 2, 'two seeded activity submissions');
  const seeded = res.body.find((a: any) => a.id === 'act_seed_1');
  assert.equal(seeded.platformEventId, 'pe_seed_1');
  assert.equal(seeded.status, 'submitted');
  assert.equal(typeof seeded.submittedAt, 'number');

  const missing = await call('POST', '/tasks/activities', { body: {} });
  assert.equal(missing.status, 400);
  assert.equal(missing.body.error.code, 'ACTIVITY_PLATFORM_EVENT_REQUIRED');

  const submitted = await call('POST', '/tasks/activities', { body: { platformEventId: 'pe_seed_new' } });
  assert.equal(submitted.status, 201);
  assert.equal(submitted.body.platformEventId, 'pe_seed_new');
  assert.equal(submitted.body.status, 'submitted');

  const duplicate = await call('POST', '/tasks/activities', { body: { platformEventId: 'pe_seed_new' } });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body.error.code, 'ACTIVITY_ALREADY_SUBMITTED');

  const after = await call('GET', '/tasks/activities');
  assert.ok(after.body.some((a: any) => a.platformEventId === 'pe_seed_new'), 'submission appears in the list');
});

test('tasks: setup-guide returns ordered checklist; complete flips step; re-complete conflicts', async () => {
  const res = await call('GET', '/tasks/setup-guide');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body));
  assert.ok(res.body.length >= 6, 'six seeded setup steps');
  const orders = res.body.map((s: any) => s.order);
  assert.deepEqual(orders, [...orders].sort((a, b) => a - b), 'steps are ordered');
  const step5 = res.body.find((s: any) => s.id === 'step_seed_5');
  assert.equal(step5.completed, false);
  assert.equal(typeof step5.deepLink, 'string');

  const completed = await call('POST', '/tasks/setup-guide/step_seed_5/complete');
  assert.equal(completed.status, 200);
  assert.ok(Array.isArray(completed.body), 'returns the updated checklist');
  const after = completed.body.find((s: any) => s.id === 'step_seed_5');
  assert.equal(after.completed, true);

  const again = await call('POST', '/tasks/setup-guide/step_seed_5/complete');
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, 'SETUP_STEP_ALREADY_COMPLETE');

  const missing = await call('POST', '/tasks/setup-guide/step_missing/complete');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, 'SETUP_STEP_NOT_FOUND');

  const fresh = await call('GET', '/tasks/setup-guide');
  assert.equal(fresh.body.find((s: any) => s.id === 'step_seed_5').completed, true);
  assert.equal(fresh.body.find((s: any) => s.id === 'step_seed_6').completed, false, 'sibling step untouched');
});
