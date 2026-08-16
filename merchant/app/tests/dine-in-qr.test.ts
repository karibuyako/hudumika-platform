import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupServer } from 'msw/node';

import { ALL_HTTP_HANDLERS } from '@/mock/handlers';
import { db } from '@/mock/db';
import { seedDatabase } from '@/mock/seed';
import { subscribe } from '@/mock/events';
import { runSweeperJobs } from '@/mock/sweeper';
import type { Withdrawal } from '@/api/types';

const server = setupServer(...(ALL_HTTP_HANDLERS as never[]));

let base = 'http://localhost';
let token: string | null = null;

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

async function tableByName(name: string): Promise<{ id: string; storeId: string }> {
  const list = await call('GET', `/tables?storeId=s_demo`);
  const t = list.body.tables.find((x: any) => x.name === name);
  assert.ok(t, `seeded table ${name} exists`);
  return t;
}

before(async () => {
  server.listen({ onUnhandledRequest: 'bypass' });
  db.reset();
  seedDatabase();
  const req = await call('POST', '/auth/request-otp', { auth: false, body: { channel: 'phone', destination: '+255700000000', purpose: 'login' } });
  assert.equal(req.status, 200);
  const ok = await call('POST', '/auth/verify-otp', { auth: false, body: { requestId: req.body.requestId, code: req.body.debugCode, purpose: 'login' } });
  assert.equal(ok.status, 200);
  token = ok.body.accessToken;
});

after(() => {
  server.close();
});

/* ================= QR consumption (DI-01 / RM-02): contract QR -> print job ================= */

test('dine-in-qr: contract QR payload feeds a print-job (POST /print-jobs, jobType label)', async () => {
  const table = await tableByName('C2');
  const qr = await call('GET', `/dine-in/tables/${table.id}/qr`);
  assert.equal(qr.status, 200);
  assert.equal(qr.body.qrPayload, `hudumika:dinein:table:${table.id}`);
  assert.match(qr.body.menuUrl, new RegExp(`^https://order\\.example\\.com/q/s_demo/${table.id}\\?t=`));

  const job = await call('POST', '/print-jobs', { body: { jobType: 'label', tableId: table.id, label: `QR ${table.id.slice(-4)}` } });
  assert.equal(job.status, 201, JSON.stringify(job.body));
  assert.equal(job.body.jobType, 'label');
  assert.equal(job.body.tableId, table.id);
  assert.equal(job.body.status, 'queued');

  const jobs = await call('GET', '/print-jobs');
  assert.ok(jobs.body.some((j: any) => j.id === job.body.id && j.jobType === 'label' && j.tableId === table.id), 'label job listed');
});

test('dine-in-qr: print-jobs rejects a bad jobType 422', async () => {
  const res = await call('POST', '/print-jobs', { body: { jobType: 'qr' } });
  assert.equal(res.status, 422);
  assert.equal(res.body.error.code, 'VALIDATION_FAILED');
});

/* ================= Reservations (DI-05): notifications + merchant confirm ================= */

test('reservation: create pushes reservation.requested + an in-app notification row', async () => {
  const events: string[] = [];
  const unsub = subscribe((e) => {
    if (e.type === 'reservation.requested') events.push(e.type);
  });
  const table = await tableByName('A3');
  const before = db.table('notifications').where((n: any) => n.merchantId === 'm_demo').length;

  const res = await call('POST', '/reservations', {
    body: { merchantId: 'm_demo', partySize: 3, scheduledFor: Date.now() + 5 * 3600000, note: 'Birthday', tableId: table.id },
    idem: 't-rsv-note-1',
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.status, 'pending');

  assert.ok(events.includes('reservation.requested'), 'reservation.requested emitted');
  const notes = db.table('notifications').where((n: any) => n.merchantId === 'm_demo');
  assert.equal(notes.length, before + 1, 'notification row created');
  assert.match(notes[notes.length - 1].title, /reservation/i);
  unsub();
});

test('reservation: merchant confirm (mock-only path) -> confirmed + reservation.confirmed + notification', async () => {
  const events: string[] = [];
  const unsub = subscribe((e) => {
    if (e.type === 'reservation.confirmed') events.push(e.type);
  });
  const table = await tableByName('A4');
  const res = await call('POST', '/reservations', {
    body: { merchantId: 'm_demo', partySize: 2, scheduledFor: Date.now() + 6 * 3600000, tableId: table.id },
    idem: 't-rsv-confirm-1',
  });
  const id = res.body.id;

  const confirmed = await call('POST', `/dine-in/reservations/${id}/confirm`, {});
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.body.status, 'confirmed');

  const replay = await call('POST', `/dine-in/reservations/${id}/confirm`, {});
  assert.equal(replay.status, 200, 'replay confirm is idempotent');

  assert.ok(events.includes('reservation.confirmed'), 'reservation.confirmed emitted');

  const cancelled = await call('POST', `/reservations/${id}/cancel`, {});
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.status, 'cancelled');

  const lateConfirm = await call('POST', `/dine-in/reservations/${id}/confirm`, {});
  assert.equal(lateConfirm.status, 409);
  assert.equal(lateConfirm.body.error.code, 'RESERVATION_NOT_CONFIRMABLE');
  unsub();
});

test('reservation: sweeper emits reservation.reminder for confirmed reservations within 3h', async () => {
  const events: string[] = [];
  const unsub = subscribe((e) => {
    if (e.type === 'reservation.reminder') events.push(e.type);
  });
  const table = await tableByName('B1');
  const res = await call('POST', '/reservations', {
    body: { merchantId: 'm_demo', partySize: 4, scheduledFor: Date.now() + 2 * 3600000, tableId: table.id },
    idem: 't-rsv-reminder-1',
  });
  await call('POST', `/dine-in/reservations/${res.body.id}/confirm`, {});

  runSweeperJobs();

  assert.ok(events.includes('reservation.reminder'), 'reservation.reminder emitted');
  const row = db.table('reservations').find(res.body.id) as any;
  assert.equal(row.reminderSent, true, 'reminder marked sent');

  runSweeperJobs();
  assert.equal(events.filter((e) => e === 'reservation.reminder').length, 1, 'reminder emitted exactly once');
  unsub();
});

/* ================= Payout statuses (PY-02): pending -> processing -> paid|failed|exception ================= */

/* The sweeper resolves a processing withdrawal deterministically from its id:
 * charcode-sum % 10 == 0 -> failed, == 1 -> exception, else paid. The test
 * picks ids that hit each branch and asserts the transition. */
function withdrawalFate(id: string): 'paid' | 'failed' | 'exception' {
  const n = id.split('').reduce((s, c) => s + c.charCodeAt(0), 0) % 10;
  return n === 0 ? 'failed' : n === 1 ? 'exception' : 'paid';
}

function pickId(want: 'paid' | 'failed' | 'exception'): string {
  for (let i = 0; i < 200; i += 1) {
    const id = `wd_${want}_${i}`;
    if (withdrawalFate(id) === want) return id;
  }
  throw new Error('could not find a matching id');
}

function insertWithdrawal(id: string, createdAt: number): void {
  db.table<Withdrawal & { merchantId: string }>('walletWithdrawals').insert({
    id,
    merchantId: 'm_demo',
    amountTZS: 15000,
    feeTZS: 0,
    status: 'pending',
    method: 'bank',
    estimatedArrivalDays: 1,
    createdAt,
    paidAt: null,
    reason: null,
  });
}

test('sweeper: pending withdrawal advances to processing after 60s', async () => {
  const id = pickId('paid');
  insertWithdrawal(id, Date.now() - 120000);
  runSweeperJobs();
  const row = db.table('walletWithdrawals').find(id) as Withdrawal;
  assert.equal(row.status, 'processing');
});

test('sweeper: processing resolves to paid after 60s; failed and exception branches work', async () => {
  const paidId = pickId('paid');
  const failedId = pickId('failed');
  const exceptionId = pickId('exception');
  const ts = Date.now();
  for (const id of [paidId, failedId, exceptionId]) {
    db.table<Withdrawal & { merchantId: string }>('walletWithdrawals').insert({
      id,
      merchantId: 'm_demo',
      amountTZS: 25000,
      feeTZS: 0,
      status: 'processing',
      method: 'bank',
      estimatedArrivalDays: 1,
      createdAt: ts - 5 * 60000,
      processingAt: ts - 120000,
      paidAt: null,
      reason: null,
    } as Withdrawal & { merchantId: string; processingAt: number });
  }
  runSweeperJobs();
  const byId = (id: string) => db.table('walletWithdrawals').find(id) as Withdrawal;
  assert.equal(byId(paidId).status, 'paid');
  assert.ok(byId(paidId).paidAt, 'paid sets paidAt');
  assert.equal(byId(failedId).status, 'failed');
  assert.equal(byId(exceptionId).status, 'exception');
  const notifications = db.table('notifications').where((n: any) => n.merchantId === 'm_demo');
  assert.ok(notifications.some((n: any) => /Withdrawal/i.test(n.title)), 'withdrawal outcome notified');
});

/* ================= refund.processed (PY-03) ================= */

test('refund: approving a requested refund emits refund.processed', async () => {
  const events: string[] = [];
  const unsub = subscribe((e) => {
    if (e.type === 'refund.processed') events.push(e.type);
  });
  const refund = db.table('refunds').find('rf_o_seed_8') as any;
  assert.ok(refund, 'seeded requested refund exists');
  assert.equal(refund.status, 'requested');

  const res = await call('POST', '/refunds/rf_o_seed_8/approve', { body: { reason: 'Approve in full' } });
  assert.equal(res.status, 200, JSON.stringify(res.body));

  assert.ok(events.includes('refund.processed'), 'refund.processed emitted');
  const processed = db.table('notifications').where((n: any) => n.merchantId === 'm_demo');
  assert.ok(processed.some((n: any) => n.title.includes('Refund approved')), 'in-app refund notification exists');
  unsub();
});
