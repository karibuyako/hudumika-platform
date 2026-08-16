/* P6b/P6d contract tests — store settings (kitchen camera, qualifications,
 * self-pickup, QR codes, receipt templates), reservations, loyalty ledger,
 * memberships/me and print jobs. Same harness as contract.test.ts.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupServer } from 'msw/node';

import { ALL_HTTP_HANDLERS } from '@/mock/handlers';
import { db } from '@/mock/db';
import { seedDatabase } from '@/mock/seed';

const server = setupServer(...(ALL_HTTP_HANDLERS as never[]));

const base = 'http://localhost';
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
  token = await loginAs('+255700000000');
});

beforeEach(() => {
  token = token;
});

after(() => {
  server.close();
});

/* ================= Kitchen camera (GET/PATCH /store/kitchen-camera) ================= */

test('kitchen camera: seeded config round-trips; unconfigured store is 404 KITCHEN_CAMERA_NOT_CONFIGURED', async () => {
  const get = await call('GET', '/store/kitchen-camera');
  assert.equal(get.status, 200);
  assert.equal(get.body.enabled, false);
  assert.equal(get.body.videoQuality, 'hd');
  assert.equal(get.body.recordingDurationMinutes, 30);
  assert.equal(get.body.storageCapacityGb, 10);
  assert.equal(get.body.storageUsedGb, 2.4);
  assert.ok(get.body.streamUrl.startsWith('rtsp://'), 'streamUrl echoes the configured camera');

  const s2 = await call('GET', '/store/kitchen-camera?storeId=s_demo_2');
  assert.equal(s2.status, 404);
  assert.equal(s2.body.error.code, 'KITCHEN_CAMERA_NOT_CONFIGURED');
});

test('kitchen camera: PATCH partial round-trip persists; invalid videoQuality 422', async () => {
  const on = await call('PATCH', '/store/kitchen-camera', { body: { enabled: true, videoQuality: 'fhd', publicAccess: true } });
  assert.equal(on.status, 200);
  assert.equal(on.body.enabled, true);
  assert.equal(on.body.videoQuality, 'fhd');
  assert.equal(on.body.publicAccess, true);
  assert.equal(on.body.recordingDurationMinutes, 30, 'absent fields keep their values (PATCH semantics)');
  assert.equal(on.body.streamUrl, db.table('kitchenCameras').find('kc_seed_1')?.streamUrl, 'streamUrl untouched by partial PATCH');

  const readBack = await call('GET', '/store/kitchen-camera');
  assert.equal(readBack.body.enabled, true, 'PATCH persists across GET');
  assert.equal(readBack.body.videoQuality, 'fhd');

  const bad = await call('PATCH', '/store/kitchen-camera', { body: { videoQuality: '4k' } });
  assert.equal(bad.status, 422);
  assert.equal(bad.body.error.code, 'VALIDATION_FAILED');

  const badUrl = await call('PATCH', '/store/kitchen-camera', { body: { streamUrl: 'not-a-url' } });
  assert.equal(badUrl.status, 422);

  // cross-store isolation: patching s_demo_2 never touches s_demo
  const other = await call('PATCH', '/store/kitchen-camera?storeId=s_demo_2', { body: { enabled: true } });
  assert.equal(other.status, 200);
  assert.equal(db.table('kitchenCameras').find('kc_seed_1')?.enabled, true, 's_demo camera unaffected by s_demo_2 PATCH');
  db.table('kitchenCameras').remove(db.table('kitchenCameras').where((c: any) => c.storeId === 's_demo_2')[0]?.id ?? '');

  // restore seed state for later tests
  await call('PATCH', '/store/kitchen-camera', { body: { enabled: false, videoQuality: 'hd', publicAccess: false } });
});

/* ================= Qualifications (GET/POST /store/qualifications) ================= */

test('qualifications: seeded list; upload starts pending; duplicates allowed', async () => {
  const list = await call('GET', '/store/qualifications');
  assert.equal(list.status, 200);
  assert.ok(Array.isArray(list.body));
  assert.equal(list.body.length, 1);
  assert.equal(list.body[0].type, 'business_license');
  assert.equal(list.body[0].status, 'approved');
  assert.equal(list.body[0].id, 'q_seed_1');

  const created = await call('POST', '/store/qualifications', { body: { type: 'food_hygiene_cert', url: 'https://files.example.com/hygiene.pdf' } });
  assert.equal(created.status, 201);
  assert.equal(created.body.type, 'food_hygiene_cert');
  assert.equal(created.body.status, 'pending');
  assert.equal(created.body.url, 'https://files.example.com/hygiene.pdf', 'url echoed back');
  assert.ok(created.body.id);

  const dup = await call('POST', '/store/qualifications', { body: { type: 'food_hygiene_cert', url: 'https://files.example.com/hygiene-2.pdf' } });
  assert.equal(dup.status, 201, 'duplicate type submissions are allowed (no dedup in contract)');
  assert.notEqual(dup.body.id, created.body.id);

  const after = await call('GET', '/store/qualifications');
  assert.equal(after.body.length, 3);
  assert.equal(after.body[0].id, dup.body.id, 'newest first');

  const noType = await call('POST', '/store/qualifications', { body: { type: '   ', url: 'https://x.example.com/a.pdf' } });
  assert.equal(noType.status, 422);
  assert.equal(noType.body.error.code, 'VALIDATION_FAILED');

  const badUrl = await call('POST', '/store/qualifications', { body: { type: 'tax_clearance', url: 'nope' } });
  assert.equal(badUrl.status, 422);

  // cleanup so the count stays stable for other suites
  db.table('qualifications').remove(created.body.id);
  db.table('qualifications').remove(dup.body.id);
});

/* ================= Self-pickup (GET/PUT /store/self-pickup) ================= */

test('self-pickup: seeded config; PUT round-trip; bounds 5–120 and equal-hours 422', async () => {
  const get = await call('GET', '/store/self-pickup');
  assert.equal(get.status, 200);
  assert.equal(get.body.enabled, true);
  assert.equal(get.body.pickupReadyMinutes, 15);
  assert.deepEqual(get.body.pickupHours, { open: '08:00', close: '21:00' });

  const unconfigured = await call('GET', '/store/self-pickup?storeId=s_demo_2');
  assert.equal(unconfigured.status, 200);
  assert.equal(unconfigured.body.enabled, false, 'unconfigured store answers the honest default');

  const updated = await call('PUT', '/store/self-pickup', { body: { enabled: false, pickupReadyMinutes: 45, pickupHours: { open: '10:00', close: '22:00' } } });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.enabled, false);
  assert.equal(updated.body.pickupReadyMinutes, 45);
  assert.deepEqual(updated.body.pickupHours, { open: '10:00', close: '22:00' });

  const readBack = await call('GET', '/store/self-pickup');
  assert.equal(readBack.body.pickupReadyMinutes, 45, 'PUT persists across GET');

  const low = await call('PUT', '/store/self-pickup', { body: { enabled: true, pickupReadyMinutes: 4 } });
  assert.equal(low.status, 422);
  assert.equal(low.body.error.code, 'SELF_PICKUP_INVALID_CONFIG');
  const high = await call('PUT', '/store/self-pickup', { body: { enabled: true, pickupReadyMinutes: 121 } });
  assert.equal(high.status, 422);
  assert.equal(high.body.error.code, 'SELF_PICKUP_INVALID_CONFIG');

  const equalHours = await call('PUT', '/store/self-pickup', { body: { enabled: true, pickupHours: { open: '12:00', close: '12:00' } } });
  assert.equal(equalHours.status, 422);
  assert.equal(equalHours.body.error.code, 'HOURS_INVALID');

  const missingEnabled = await call('PUT', '/store/self-pickup', { body: { pickupReadyMinutes: 30 } });
  assert.equal(missingEnabled.status, 422);

  // restore seed
  await call('PUT', '/store/self-pickup', { body: { enabled: true, pickupReadyMinutes: 15, pickupHours: { open: '08:00', close: '21:00' } } });
});

/* ================= Store QR codes (GET/POST /store/qr-codes, DELETE …/{id}) ================= */

test('store qr-codes: seeded list newest first; create 201; invalid kind 422; delete 204; delete unknown 404', async () => {
  const list = await call('GET', '/store/qr-codes');
  assert.equal(list.status, 200);
  assert.ok(Array.isArray(list.body));
  assert.equal(list.body.length, 2);
  assert.equal(list.body[0].id, 'sq_seed_2', 'newest first');
  assert.equal(list.body[0].kind, 'collection');
  assert.match(list.body[0].qrPayload, /^https:\/\/hudumika\.app\/qr\//);

  const created = await call('POST', '/store/qr-codes', { body: { kind: 'ordering' } });
  assert.equal(created.status, 201);
  assert.equal(created.body.kind, 'ordering');
  assert.match(created.body.qrPayload, /^https:\/\/hudumika\.app\/qr\//);
  assert.ok(created.body.id);

  const bad = await call('POST', '/store/qr-codes', { body: { kind: 'poster' } });
  assert.equal(bad.status, 422);
  assert.equal(bad.body.error.code, 'VALIDATION_FAILED');

  const del = await call('DELETE', `/store/qr-codes/${created.body.id}`, {});
  assert.equal(del.status, 204);
  const after = await call('GET', '/store/qr-codes');
  assert.equal(after.body.length, 2, 'deleted QR gone from the list');

  const miss = await call('DELETE', '/store/qr-codes/does-not-exist', {});
  assert.equal(miss.status, 404);
  assert.equal(miss.body.error.code, 'STORE_QR_NOT_FOUND');
});

/* ================= Receipt templates (PUT …/{id}, POST …/{id}/activate) ================= */

test('receipt templates: contract PUT replaces fields; activate flips default + clears others', async () => {
  const list = await call('GET', '/store/receipt-templates');
  assert.equal(list.status, 200);
  assert.ok(Array.isArray(list.body));
  assert.equal(list.body.length, 1);
  assert.equal(list.body[0].id, 'rt1');
  assert.equal(list.body[0].isActive, true, 'seeded rt1 is the active default');

  const put = await call('PUT', '/store/receipt-templates/rt1', {
    body: { name: 'Standard v2', headerText: 'Skewer House BBQ · Kariakoo', footerText: 'Thanks!', paperSize: '58mm', copies: 2, fields: { logo: true, qrCode: true, paymentMethod: true, cashierName: false } },
  });
  assert.equal(put.status, 200);
  assert.equal(put.body.name, 'Standard v2');
  assert.equal(put.body.paperSize, '58mm');
  assert.equal(put.body.copies, 2);
  assert.equal(put.body.font, 'monospace');
  assert.equal(put.body.isActive, true, 'the active flag is never changed by an update');
  assert.equal(put.body.fields.qrCode, true, 'contract fields round-trip onto the app row (showQRCode)');
  assert.equal(put.body.fields.cashierName, false);

  const readBack = await call('GET', '/store/receipt-templates');
  assert.equal(readBack.body[0].name, 'Standard v2', 'PUT persists');

  const missingName = await call('PUT', '/store/receipt-templates/rt1', { body: { name: '', headerText: 'x' } });
  assert.equal(missingName.status, 422);
  assert.equal(missingName.body.error.code, 'VALIDATION_FAILED');
  const missingHeader = await call('PUT', '/store/receipt-templates/rt1', { body: { name: 'x', headerText: '  ' } });
  assert.equal(missingHeader.status, 422);
  const unknown = await call('PUT', '/store/receipt-templates/nope', { body: { name: 'x', headerText: 'y' } });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.error.code, 'RECEIPT_TEMPLATE_NOT_FOUND');
  const badCopies = await call('PUT', '/store/receipt-templates/rt1', { body: { name: 'x', headerText: 'y', copies: 9 } });
  assert.equal(badCopies.status, 422);

  // create a second template via the contract POST, activate it → rt1 loses the default flag
  const created = await call('POST', '/store/receipt-templates', { body: { name: 'Counter Night', headerText: 'Skewer House BBQ · Counter' } });
  assert.equal(created.status, 201);
  assert.equal(created.body.isActive, false, 'first template keeps the default; new ones start inactive');
  const secondId = created.body.id;
  const activate = await call('POST', `/store/receipt-templates/${secondId}/activate`, {});
  assert.equal(activate.status, 200);
  assert.equal(activate.body.isActive, true);
  const afterActivate = await call('GET', '/store/receipt-templates');
  assert.equal(afterActivate.body.find((t: any) => t.id === 'rt1').isActive, false, 'previous default cleared');
  assert.equal(afterActivate.body.find((t: any) => t.id === secondId).isActive, true);

  const again = await call('POST', `/store/receipt-templates/${secondId}/activate`, {});
  assert.equal(again.status, 200, 'activating the already-active template is idempotent');
  assert.equal(again.body.isActive, true);

  const activateUnknown = await call('POST', '/store/receipt-templates/nope/activate', {});
  assert.equal(activateUnknown.status, 404);
  assert.equal(activateUnknown.body.error.code, 'RECEIPT_TEMPLATE_NOT_FOUND');

  // restore seed: rt1 active again, drop the second template
  await call('POST', '/store/receipt-templates/rt1/activate', {});
  await call('DELETE', `/receipt-templates/${secondId}`, {});
  await call('PUT', '/store/receipt-templates/rt1', { body: { name: 'Standard', headerText: 'Skewer House BBQ · Wangjing', paperSize: '80mm', copies: 1 } });
});

/* ================= Reservations (POST /reservations, GET /reservations/me, cancel) ================= */

test('reservations: seeded pending list; create 201 + idempotency; validation; cancel lifecycle', async () => {
  const list = await call('GET', '/reservations/me');
  assert.equal(list.status, 200);
  assert.ok(Array.isArray(list.body));
  assert.equal(list.body.length, 1);
  assert.equal(list.body[0].id, 'rsv_seed_1');
  assert.equal(list.body[0].status, 'pending');
  assert.equal(list.body[0].partySize, 4);
  assert.equal(list.body[0].merchantId, 'm_demo');

  const noIdem = await call('POST', '/reservations', { body: { merchantId: 'm_demo', partySize: 2, scheduledFor: Date.now() + 3600000 } });
  assert.equal(noIdem.status, 400);
  assert.equal(noIdem.body.error.code, 'IDEMPOTENCY_KEY_REQUIRED');

  const tableA3 = db.table('tables').where((t: any) => t.storeId === 's_demo' && t.name === 'A3')[0];
  const created = await call('POST', '/reservations', {
    idem: 't-res-1',
    body: { merchantId: 'm_demo', partySize: 2, scheduledFor: Date.now() + 3 * 3600000, note: 'Birthday dinner', tableId: tableA3.id },
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.status, 'pending');
  assert.equal(created.body.partySize, 2);
  assert.equal(created.body.tableId, tableA3.id);
  assert.equal(created.body.note, 'Birthday dinner');
  assert.ok(created.body.id);

  const replay = await call('POST', '/reservations', {
    idem: 't-res-1',
    body: { merchantId: 'm_demo', partySize: 2, scheduledFor: Date.now() + 3 * 3600000, note: 'Birthday dinner', tableId: tableA3.id },
  });
  assert.equal(replay.status, 201, 'idempotent replay returns the same reservation');
  assert.equal(replay.body.id, created.body.id);

  const past = await call('POST', '/reservations', { idem: 't-res-2', body: { merchantId: 'm_demo', partySize: 2, scheduledFor: Date.now() - 3600000 } });
  assert.equal(past.status, 422);
  assert.equal(past.body.error.code, 'RESERVATION_TIME_IN_PAST');

  const tiny = await call('POST', '/reservations', { idem: 't-res-3', body: { merchantId: 'm_demo', partySize: 0, scheduledFor: Date.now() + 3600000 } });
  assert.equal(tiny.status, 422);
  const huge = await call('POST', '/reservations', { idem: 't-res-4', body: { merchantId: 'm_demo', partySize: 51, scheduledFor: Date.now() + 3600000 } });
  assert.equal(huge.status, 422);

  const noTable = await call('POST', '/reservations', { idem: 't-res-5', body: { merchantId: 'm_demo', partySize: 2, scheduledFor: Date.now() + 3600000, tableId: 'nope' } });
  assert.equal(noTable.status, 404);
  assert.equal(noTable.body.error.code, 'DINE_IN_TABLE_NOT_FOUND');

  const tableA1 = db.table('tables').where((t: any) => t.storeId === 's_demo' && t.name === 'A1')[0];
  const tooBig = await call('POST', '/reservations', { idem: 't-res-6', body: { merchantId: 'm_demo', partySize: 4, scheduledFor: Date.now() + 3600000, tableId: tableA1.id } });
  assert.equal(tooBig.status, 409);
  assert.equal(tooBig.body.error.code, 'RESERVATION_TABLE_FULL', 'party exceeds table capacity');

  const cancel = await call('POST', `/reservations/${created.body.id}/cancel`, {});
  assert.equal(cancel.status, 200);
  assert.equal(cancel.body.status, 'cancelled');

  const again = await call('POST', `/reservations/${created.body.id}/cancel`, {});
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, 'RESERVATION_NOT_CANCELLABLE');

  const unknown = await call('POST', '/reservations/does-not-exist/cancel', {});
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.error.code, 'RESERVATION_NOT_FOUND');

  db.table('reservations').remove(created.body.id);
});

/* ================= Loyalty (GET /loyalty-transactions, GET /memberships/me) ================= */

test('loyalty-transactions: contract ledger shape, signed points, newest first, limit', async () => {
  const list = await call('GET', '/loyalty-transactions');
  assert.equal(list.status, 200);
  assert.ok(Array.isArray(list.body));
  assert.equal(list.body.length, 2);
  assert.equal(list.body[0].id, 'lpl_seed_2', 'newest first');
  assert.equal(list.body[0].type, 'redeem');
  assert.equal(list.body[0].points, -50, 'redeem points are signed negative');
  assert.equal(list.body[0].balance, 70);
  assert.equal(list.body[0].reference, 'VOUCHER-50K');
  assert.ok(typeof list.body[0].at === 'number');
  assert.equal(list.body[1].type, 'earn');
  assert.equal(list.body[1].points, 120);
  assert.equal(list.body[1].balance, 120);

  const limited = await call('GET', '/loyalty-transactions?limit=1');
  assert.equal(limited.body.length, 1);
  assert.equal(limited.body[0].id, 'lpl_seed_2');
});

test('memberships/me: customer membership shape (mock-only)', async () => {
  const res = await call('GET', '/memberships/me');
  assert.equal(res.status, 200);
  assert.equal(typeof res.body.points, 'number');
  assert.equal(typeof res.body.level, 'string');
  assert.ok(Array.isArray(res.body.benefits));
  assert.ok(res.body.benefits.length >= 1);
  assert.ok(res.body.memberSince === null || typeof res.body.memberSince === 'string');
});

/* ================= Print jobs (POST /print-jobs, GET /print-jobs, GET …/{id}) ================= */

test('print jobs: seeded history; create → queued; detail round-trip; validation; 404', async () => {
  const list = await call('GET', '/print-jobs');
  assert.equal(list.status, 200);
  assert.ok(Array.isArray(list.body));
  assert.equal(list.body.length, 1);
  assert.equal(list.body[0].id, 'pj_seed_1');
  assert.equal(list.body[0].jobType, 'receipt');
  assert.equal(list.body[0].status, 'done');
  assert.deepEqual(list.body[0].orderIds, ['o_seed_0']);

  const created = await call('POST', '/print-jobs', { body: { jobType: 'kitchen_ticket', tableId: db.table('tables').where((t: any) => t.storeId === 's_demo')[0].id, copies: 2, label: 'Table A1 tickets' } });
  assert.equal(created.status, 201);
  assert.equal(created.body.jobType, 'kitchen_ticket');
  assert.equal(created.body.status, 'queued');
  assert.equal(created.body.copies, 2);
  assert.equal(created.body.label, 'Table A1 tickets');
  assert.equal(created.body.error, null);
  assert.ok(created.body.id);

  const detail = await call('GET', `/print-jobs/${created.body.id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.id, created.body.id);
  assert.equal(detail.body.status, 'queued', 'status flows through the detail endpoint');

  const filtered = await call('GET', '/print-jobs?status=queued');
  assert.ok(filtered.body.some((j: any) => j.id === created.body.id));

  const badType = await call('POST', '/print-jobs', { body: { jobType: 'poster' } });
  assert.equal(badType.status, 422);
  assert.equal(badType.body.error.code, 'VALIDATION_FAILED');
  const badCopies = await call('POST', '/print-jobs', { body: { jobType: 'receipt', copies: 6 } });
  assert.equal(badCopies.status, 422);
  const badLabel = await call('POST', '/print-jobs', { body: { jobType: 'receipt', label: 'x'.repeat(81) } });
  assert.equal(badLabel.status, 422);
  const badStatus = await call('GET', '/print-jobs?status=nope');
  assert.equal(badStatus.status, 422);

  const miss = await call('GET', '/print-jobs/does-not-exist');
  assert.equal(miss.status, 404);
  assert.equal(miss.body.error.code, 'PRINT_JOB_NOT_FOUND');

  db.table('printJobs').remove(created.body.id);
});
