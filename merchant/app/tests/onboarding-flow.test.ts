import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupServer } from 'msw/node';

import { ALL_HTTP_HANDLERS } from '@/mock/handlers';
import { db } from '@/mock/db';
import { seedDatabase } from '@/mock/seed';

const server = setupServer(...(ALL_HTTP_HANDLERS as never[]));

const base = 'http://localhost';
let token: string | null = null;
let merchantId = '';
let storeId = '';

async function call(
  method: string,
  path: string,
  opts: { body?: unknown; auth?: boolean; idem?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: any }> {
  const url = path.startsWith('/api') ? path : `/api${path}`;
  const headers: Record<string, string> = { 'content-type': 'application/json', ...opts.headers };
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

before(async () => {
  server.listen({ onUnhandledRequest: 'bypass' });
  db.reset();
  seedDatabase();
  const req = await call('POST', '/auth/request-otp', {
    auth: false,
    body: { channel: 'phone', destination: '+255711111111', purpose: 'register' },
  });
  assert.equal(req.status, 200);
  const ok = await call('POST', '/auth/verify-otp', {
    auth: false,
    body: { requestId: req.body.requestId, code: req.body.debugCode, purpose: 'register' },
  });
  assert.equal(ok.status, 200);
  token = ok.body.accessToken;
  merchantId = ok.body.me.merchant.id;
  storeId = db.table('stores').where((s) => s.merchantId === merchantId)[0].id;
});

beforeEach(() => {
  token = token;
});

after(() => {
  server.close();
});

/* ================= Onboarding wizard contract flow (ONBOARDING.md) ================= */

test('GET /onboarding/status: fresh account — pending, profile step current', async () => {
  const res = await call('GET', '/onboarding/status');
  assert.equal(res.status, 200);
  assert.equal(res.body.verification.status, 'pending');
  assert.deepEqual(res.body.steps.map((s: any) => s.key), ['profile', 'documents', 'submit']);
  assert.equal(res.body.steps[0].status, 'current');
  assert.equal(res.body.currentStep, 'profile');
  assert.equal(res.body.completed, false);
});

test('POST /onboarding/profile: saves businessName/category/city/address', async () => {
  const res = await call('POST', '/onboarding/profile', {
    body: {
      businessType: 'grocery',
      ownerName: 'Amina Hassan',
      storeName: 'Kariakoo Greens',
      category: 'grocery',
      city: 'Dar es Salaam',
      address: 'Kariakoo Market, Block C',
      contactPhone: '+255711111111',
      consent: true,
    },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.saved, true);

  const status = await call('GET', '/onboarding/status');
  assert.equal(status.body.steps[0].status, 'done', 'profile step done after profile submit');
  assert.equal(status.body.currentStep, 'documents');
});

test('POST /onboarding/docs: contract shape type+fileName; 422 unknown type; 400 empty', async () => {
  const res = await call('POST', '/onboarding/docs', {
    body: {
      docs: [
        { type: 'business_registration', fileName: 'breg.jpg', mime: 'image/jpeg', sizeBytes: 2.4 * 1024 * 1024 },
        { type: 'trading_license', fileName: 'license.png', mime: 'image/png', sizeBytes: 1024 * 1024 },
        { type: 'tin_certificate', fileName: 'tin.jpg', mime: 'image/jpeg', sizeBytes: 512 * 1024 },
      ],
    },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.received, 3);
  assert.equal(res.body.docs.length, 3);
  assert.ok(res.body.docs.every((d: any) => d.status === 'pending'), 'uploads are server-owned: pending');
  assert.equal(res.body.docs[0].fileName, 'breg.jpg');

  const badType = await call('POST', '/onboarding/docs', { body: { docs: [{ type: 'passport', fileName: 'x.jpg' }] } });
  assert.equal(badType.status, 422);
  assert.equal(badType.body.error.code, 'INVALID_DOCUMENT_TYPE');

  const empty = await call('POST', '/onboarding/docs', { body: { docs: [] } });
  assert.equal(empty.status, 400);
  assert.equal(empty.body.error.code, 'DOCS_REQUIRED');

  // legacy string-array shape still maps by filename keyword
  const legacy = await call('POST', '/onboarding/docs', { body: { docs: ['owner-id.jpg', 'business-license.jpg'] } });
  assert.equal(legacy.status, 200);
  assert.ok(legacy.body.docs.some((d: any) => d.type === 'owner_id'), 'filename keyword mapped to owner_id');
  assert.ok(legacy.body.docs.some((d: any) => d.type === 'trading_license'), 'filename keyword mapped to trading_license');
});

test('POST /onboarding/submit: documents_review; 409 ONBOARDING_ALREADY_SUBMITTED on re-submit', async () => {
  const res = await call('POST', '/onboarding/submit', {});
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'pending');
  assert.equal(res.body.verification.status, 'documents_review');
  assert.ok(res.body.verification.documents.length >= 3);

  const status = await call('GET', '/onboarding/status');
  assert.equal(status.body.verification.status, 'documents_review');
  assert.equal(status.body.currentStep, 'submit');
  assert.equal(status.body.submittedAt !== null, true);

  const again = await call('POST', '/onboarding/submit', {});
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, 'ONBOARDING_ALREADY_SUBMITTED');
});

test('onboarding docs retake: replaces the document and returns it to pending', async () => {
  const before = await call('GET', '/onboarding/status');
  const license = before.body.verification.documents.find((d: any) => d.type === 'trading_license');
  assert.equal(license.status, 'pending');

  const retake = await call('POST', '/onboarding/docs', {
    body: { docs: [{ type: 'trading_license', fileName: 'license-retake.jpg', mime: 'image/jpeg', sizeBytes: 3 * 1024 * 1024 }] },
  });
  assert.equal(retake.status, 200);
  const replaced = retake.body.docs.find((d: any) => d.type === 'trading_license');
  assert.equal(replaced.fileName, 'license-retake.jpg', 'retake replaced the previous file');
  assert.equal(replaced.status, 'pending', 're-upload returns the document to pending');
  assert.equal(retake.body.docs.filter((d: any) => d.type === 'trading_license').length, 1, 'no duplicate rows');
});

test('GET /merchants/me: contract MerchantPrivate surface (verification + commercial)', async () => {
  const res = await call('GET', '/merchants/me');
  assert.equal(res.status, 200);
  assert.equal(res.body.verification.status, 'documents_review');
  assert.ok(Array.isArray(res.body.verification.documents));
  assert.equal(typeof res.body.commercial, 'object');

  const approve = await call('POST', '/onboarding/demo-approve');
  assert.equal(approve.status, 200);
  assert.equal(approve.body.verification.status, 'approved');

  const approved = await call('GET', '/merchants/me');
  assert.equal(approved.body.verification.status, 'approved');
  assert.equal(approved.body.verification.documents.every((d: any) => d.status === 'approved'), true);
  assert.equal(approved.body.commercial.commissionRateBps, 600, 'commission from the server contract (600 bps)');
  assert.equal(approved.body.commercial.payoutCycleDays, 3);
});

test('GET /onboarding/status after approval: completed with all steps done', async () => {
  const res = await call('GET', '/onboarding/status');
  assert.equal(res.status, 200);
  assert.equal(res.body.verification.status, 'approved');
  assert.equal(res.body.completed, true);
  assert.ok(res.body.steps.every((s: any) => s.status === 'done'));
});

/* ================= Privacy export job lifecycle (PRIVACY-ACCOUNT.md) ================= */

test('POST /privacy/export: queued → processing → ready with short-lived downloadUrl; in-progress 409', async () => {
  const queued = await call('POST', '/privacy/export', { idem: 't-pex-1' });
  assert.equal(queued.status, 202);
  assert.equal(queued.body.status, 'queued');
  assert.ok(queued.body.jobId);

  const replay = await call('POST', '/privacy/export', { idem: 't-pex-1' });
  assert.equal(replay.body.jobId, queued.body.jobId, 'idempotent replay returns the same job');

  const blocked = await call('POST', '/privacy/export', { idem: 't-pex-2' });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.error.code, 'PRIVACY_EXPORT_IN_PROGRESS');

  const processing = await call('GET', `/privacy/export/${queued.body.jobId}`);
  assert.equal(processing.status, 200);
  assert.equal(processing.body.status, 'processing');

  const ready = await call('GET', `/privacy/export/${queued.body.jobId}`);
  assert.equal(ready.body.status, 'ready');
  assert.match(ready.body.downloadUrl, /^https:\/\/\S+\.json$/);
  assert.equal(ready.body.expiresInSeconds, 900);
  assert.ok(ready.body.completedAt);

  const missing = await call('GET', '/privacy/export/pex_nope');
  assert.equal(missing.status, 404);
});

/* ================= Account deletion cooling-off (PRIVACY-ACCOUNT.md) ================= */

test('POST /privacy/delete: DELETE confirmation required; 30-day cooling-off request; idempotent', async () => {
  const wrong = await call('POST', '/privacy/delete', { body: { confirmation: 'delete' } });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.body.error.code, 'ACCOUNT_DELETION_INVALID_CONFIRMATION');

  const erased = await call('POST', '/privacy/delete', { body: { confirmation: 'DELETE', reason: 'Moving platforms' } });
  assert.equal(erased.status, 200);
  assert.ok(erased.body.requestId);
  assert.equal(erased.body.status, 'pending');
  assert.equal(erased.body.estimatedDays, 30);
  assert.ok(erased.body.completesAt > erased.body.requestedAt);
  assert.equal(erased.body.reason, 'Moving platforms');

  const readBack = await call('GET', '/privacy/delete');
  assert.equal(readBack.body.request.requestId, erased.body.requestId, 'cooling-off state persisted');

  const again = await call('POST', '/privacy/delete', { body: { confirmation: 'DELETE' } });
  assert.equal(again.body.requestId, erased.body.requestId, 'repeat request returns the pending request');
});

/* ================= Sessions (PRIVACY-ACCOUNT.md) ================= */

test('GET /sessions: current session listed; SELF_REVOKE + NOT_FOUND on revoke', async () => {
  const res = await call('GET', '/sessions');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.sessions));
  assert.ok(res.body.sessions.length >= 1);
  const current = res.body.sessions.find((s: any) => s.token === token);
  assert.ok(current, 'the current session is listed');
  assert.equal(current.revoked, false);

  const selfRevoke = await call('POST', `/sessions/${token}/revoke`);
  assert.equal(selfRevoke.status, 400);
  assert.equal(selfRevoke.body.error.code, 'SELF_REVOKE');

  const missing = await call('POST', '/sessions/token_nope/revoke');
  assert.equal(missing.status, 404);
});

/* ================= Compliance recheck job (STORE-MANAGEMENT.md) ================= */

test('POST /store/compliance/recheck: completed job + score; repeat 409 COMPLIANCE_RECHECK_IN_PROGRESS', async () => {
  const res = await call('POST', `/store/compliance/recheck?storeId=${storeId}`);
  assert.equal(res.status, 200);
  assert.ok(res.body.jobId);
  assert.equal(res.body.status, 'completed');
  assert.equal(typeof res.body.compliance.score, 'number');
  assert.ok(Array.isArray(res.body.compliance.checks));

  const blocked = await call('POST', `/store/compliance/recheck?storeId=${storeId}`);
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.error.code, 'COMPLIANCE_RECHECK_IN_PROGRESS');
});

/* ================= Settings + payout via the contract surface (impl-10) ================= */

test('GET/PUT /merchants/me/settings round-trip on the registered merchant', async () => {
  const res = await call('GET', '/merchants/me/settings');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.businessHours));

  const put = await call('PUT', '/merchants/me/settings', {
    body: {
      phoneOrderingHours: { enabled: true, open: '09:00', close: '19:00' },
      specialRules: 'No COD above TZS 50,000',
      deliverySettings: { radiusKm: 6, deliveryFeeTZS: 4000, minimumOrderTZS: 25000, sameDayCutoff: '19:30' },
      printSettings: { autoPrint: true, copies: 2, labelPrinter: false },
    },
  });
  assert.equal(put.status, 200);
  assert.deepEqual(put.body.phoneOrderingHours, { enabled: true, open: '09:00', close: '19:00' });
  assert.equal(put.body.specialRules, 'No COD above TZS 50,000');
  assert.equal(put.body.printSettings.copies, 2);

  const readBack = await call('GET', '/merchants/me/settings');
  assert.equal(readBack.body.deliverySettings.sameDayCutoff, '19:30');
});
