import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupServer } from 'msw/node';

import { ALL_HTTP_HANDLERS } from '@/mock/handlers';
import { db } from '@/mock/db';
import { seedDatabase } from '@/mock/seed';

/* P8b contract tests: /staff/shifts, /staff/attendance, /staff/performance,
 * /staff/commissions and /approvals (ENTERPRISE-STAFF.md, ENTERPRISE-FINANCE.md). */

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

async function loginAs(phone: string) {
  const req = await call('POST', '/auth/request-otp', { auth: false, body: { channel: 'phone', destination: phone, purpose: 'login' } });
  assert.equal(req.status, 200);
  const ok = await call('POST', '/auth/verify-otp', { auth: false, body: { requestId: req.body.requestId, code: req.body.debugCode, purpose: 'login' } });
  assert.equal(ok.status, 200);
  return ok.body.accessToken;
}

let ownerToken: string | null = null;

const DAY = 86400000;
/* Shift fixtures + assertions anchor to TOMORROW so the suite is immune to
 * the current time of day (SHIFT_IN_PAST would fire for "today" hours that
 * have already passed). */
const tomorrowAt = (hourOffsetH: number) => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime() + DAY + hourOffsetH * 3600000;
};
/* Local-date "tomorrow": the shift fixtures are anchored to LOCAL midnight,
 * so the query range must use local dates too (a UTC-ISO date drifts when the
 * host is not on UTC). */
const tomorrow = () => {
  const d = new Date(Date.now() + DAY);
  d.setHours(0, 0, 0, 0);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

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

/* ================= Shifts (/staff/shifts) ================= */

test('shifts: seeded schedule listed for the week, day-role shape intact', async () => {
  const from = tomorrow();
  const to = new Date(Date.now() + 7 * DAY).toISOString().slice(0, 10);
  const res = await call('GET', `/staff/shifts?from=${from}&to=${to}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.shifts.length, 2, 'two seeded shifts');
  const [s1, s2] = res.body.shifts;
  assert.equal(s1.staffId, 'ms_seed_2');
  assert.equal(s1.role, 'manager');
  assert.equal(s1.status, 'scheduled');
  assert.ok(s1.startAt < s1.endAt);
  assert.equal(s2.staffId, 'ms_seed_3');
  assert.equal(s2.role, 'cashier');
});

test('shifts: range params are required (400) and malformed dates rejected', async () => {
  const missing = await call('GET', '/staff/shifts');
  assert.equal(missing.status, 400);
  assert.equal(missing.body.error.code, 'INVALID_DATE');
  const bad = await call('GET', '/staff/shifts?from=2026-13-99&to=2026-01-01');
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, 'INVALID_DATE');
});

test('shifts: create -> 201, appears in list; PATCH round-trip; DELETE -> 204', async () => {
  const created = await call('POST', '/staff/shifts', {
    body: { staffId: 'ms_seed_4', role: 'waiter', startAt: tomorrowAt(10), endAt: tomorrowAt(14) },
    idem: 't-shift-create-1',
  });
  assert.equal(created.status, 201);
  const shift = created.body;
  assert.equal(shift.status, 'scheduled');
  assert.equal(shift.role, 'waiter');
  assert.equal(shift.storeId, null);

  const from = tomorrow();
  const to = from;
  const listed = await call('GET', `/staff/shifts?from=${from}&to=${to}`);
  assert.ok(listed.body.shifts.some((s: any) => s.id === shift.id), 'created shift listed');

  const patched = await call('PATCH', `/staff/shifts/${shift.id}`, {
    body: { endAt: tomorrowAt(16), status: 'active' },
    idem: 't-shift-patch-1',
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.endAt, tomorrowAt(16));
  assert.equal(patched.body.status, 'active');

  const deleted = await call('DELETE', `/staff/shifts/${shift.id}`, {});
  assert.equal(deleted.status, 204);
  const after = await call('GET', `/staff/shifts?from=${from}&to=${to}`);
  assert.ok(!after.body.shifts.some((s: any) => s.id === shift.id), 'deleted shift gone');
});

test('shifts: overlap for the same staff -> 409 SHIFT_OVERLAP; PATCH into overlap too', async () => {
  // ms_seed_3 (Kai) already has 17:00-22:00 today
  const clash = await call('POST', '/staff/shifts', {
    body: { staffId: 'ms_seed_3', role: 'cashier', startAt: tomorrowAt(18), endAt: tomorrowAt(21) },
    idem: 't-shift-overlap-1',
  });
  assert.equal(clash.status, 409);
  assert.equal(clash.body.error.code, 'SHIFT_OVERLAP');

  // non-overlapping window is fine, then PATCH into overlap
  const ok = await call('POST', '/staff/shifts', {
    body: { staffId: 'ms_seed_3', role: 'cashier', startAt: tomorrowAt(22), endAt: tomorrowAt(23) },
    idem: 't-shift-overlap-2',
  });
  assert.equal(ok.status, 201);
  const moved = await call('PATCH', `/staff/shifts/${ok.body.id}`, {
    body: { startAt: tomorrowAt(19), endAt: tomorrowAt(20) },
    idem: 't-shift-overlap-3',
  });
  assert.equal(moved.status, 409);
  assert.equal(moved.body.error.code, 'SHIFT_OVERLAP');

  // a different staff member may overlap freely
  const other = await call('POST', '/staff/shifts', {
    body: { staffId: 'ms_seed_4', role: 'waiter', startAt: tomorrowAt(10), endAt: tomorrowAt(22) },
    idem: 't-shift-overlap-4',
  });
  assert.equal(other.status, 201);
});

test('shifts: past start blocked SHIFT_IN_PAST, unknown staff SHIFT_NOT_FOUND, inverted range 400', async () => {
  const past = await call('POST', '/staff/shifts', {
    body: { staffId: 'ms_seed_4', role: 'waiter', startAt: Date.now() - 2 * 3600000, endAt: Date.now() + 3600000 },
    idem: 't-shift-past-1',
  });
  assert.equal(past.status, 400);
  assert.equal(past.body.error.code, 'SHIFT_IN_PAST');

  const inverted = await call('POST', '/staff/shifts', {
    body: { staffId: 'ms_seed_4', role: 'waiter', startAt: tomorrowAt(14), endAt: tomorrowAt(12) },
    idem: 't-shift-range-1',
  });
  assert.equal(inverted.status, 400);
  assert.equal(inverted.body.error.code, 'INVALID_RANGE');

  const unknownStaff = await call('POST', '/staff/shifts', {
    body: { staffId: 'nope', role: 'waiter', startAt: tomorrowAt(11), endAt: tomorrowAt(12) },
    idem: 't-shift-staff-1',
  });
  assert.equal(unknownStaff.status, 404);
  assert.equal(unknownStaff.body.error.code, 'STAFF_NOT_FOUND');

  const missing = await call('PATCH', '/staff/shifts/no-such-shift', { body: { status: 'cancelled' } });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, 'SHIFT_NOT_FOUND');
});

test('shifts: staff role cannot manage shifts (403)', async () => {
  token = await loginAs('+255700000003');
  const res = await call('POST', '/staff/shifts', {
    body: { staffId: 'ms_seed_3', role: 'cashier', startAt: tomorrowAt(23), endAt: tomorrowAt(24) },
    idem: 't-shift-rbac-1',
  });
  assert.equal(res.status, 403);
  assert.equal(res.body.error.code, 'STAFF_ROLE_FORBIDDEN');
});

/* ================= Attendance (/staff/attendance) ================= */

test('attendance: roster shape, staff filter, seeded open record', async () => {
  const from = new Date(Date.now() - 2 * DAY).toISOString().slice(0, 10);
  const to = tomorrow();
  const roster = await call('GET', `/staff/attendance?from=${from}&to=${to}`);
  assert.equal(roster.status, 200);
  assert.equal(roster.body.records.length, 2, 'two seeded attendance rows');
  const kai = roster.body.records.find((r: any) => r.staffId === 'ms_seed_3');
  assert.ok(kai);
  assert.equal(kai.clockedOutAt, null, 'Kai has an open record');
  assert.equal(kai.durationMinutes, null);
  assert.equal(kai.source, 'app');

  const filtered = await call('GET', `/staff/attendance?staffId=ms_seed_2`);
  assert.equal(filtered.status, 200);
  assert.equal(filtered.body.records.length, 1);
  const mia = filtered.body.records[0];
  assert.ok(mia.clockedOutAt > mia.clockedInAt);
  assert.ok(mia.durationMinutes > 0);
});

test('attendance: clock-in -> 200, double clock-in 409, clock-out -> 200 with duration, double clock-out 409', async () => {
  const in1 = await call('POST', '/staff/attendance/clock-in', {});
  assert.equal(in1.status, 200);
  const record = in1.body.record;
  assert.equal(record.staffId, 'ms_seed_1', 'owner session maps to ms_seed_1 by phone');
  assert.equal(record.clockedOutAt, null);
  assert.ok(record.id);

  const in2 = await call('POST', '/staff/attendance/clock-in', {});
  assert.equal(in2.status, 409);
  assert.equal(in2.body.error.code, 'ATTENDANCE_ALREADY_CLOCKED_IN');

  const out = await call('POST', '/staff/attendance/clock-out', {});
  assert.equal(out.status, 200);
  assert.ok(out.body.record.clockedOutAt > out.body.record.clockedInAt);
  assert.ok(out.body.record.durationMinutes >= 0);

  const out2 = await call('POST', '/staff/attendance/clock-out', {});
  assert.equal(out2.status, 409);
  assert.equal(out2.body.error.code, 'ATTENDANCE_NOT_CLOCKED_IN');
});

test('attendance: staff self-service — Kai is already clocked in (seeded open record), can clock out', async () => {
  token = await loginAs('+255700000003');
  const inAgain = await call('POST', '/staff/attendance/clock-in', {});
  assert.equal(inAgain.status, 409);
  assert.equal(inAgain.body.error.code, 'ATTENDANCE_ALREADY_CLOCKED_IN');

  const out = await call('POST', '/staff/attendance/clock-out', {});
  assert.equal(out.status, 200);
  assert.equal(out.body.record.staffId, 'ms_seed_3');
  assert.ok(out.body.record.durationMinutes > 0, 'duration computed from seeded clock-in');
});

test('attendance: staff can clock in/out but cannot view the roster (403)', async () => {
  token = await loginAs('+255700000003');
  const roster = await call('GET', '/staff/attendance');
  assert.equal(roster.status, 403);
  assert.equal(roster.body.error.code, 'STAFF_ROLE_FORBIDDEN');
});

/* ================= Performance (/staff/performance) ================= */

test('performance: derived rows match the contract shape with real values', async () => {
  const res = await call('GET', '/staff/performance');
  assert.equal(res.status, 200);
  assert.ok(res.body.from && res.body.to, 'range echoed');
  assert.ok(res.body.staff.length >= 4, 'roster covered');
  for (const p of res.body.staff) {
    assert.ok(p.staffId && p.name, 'identity present');
    assert.ok(Number.isInteger(p.ordersProcessed) && p.ordersProcessed >= 0, 'ordersProcessed integer >= 0');
    assert.ok(Number.isInteger(p.avgHandleTimeMinutes) && p.avgHandleTimeMinutes >= 0, 'handle time derived (0 when no attributed orders)');
    assert.ok(Number.isInteger(p.cancellations) && p.cancellations >= 0);
    assert.ok(p.ratingAverage === null || (p.ratingAverage >= 1 && p.ratingAverage <= 5), 'rating in range or null');
    assert.ok(p.attendanceRate >= 0 && p.attendanceRate <= 100, 'attendance rate derived from attendance rows');
    assert.ok(Number.isInteger(p.commissionTZS) && p.commissionTZS >= 0, 'commissionTZS integer TZS');
  }
  // Derived from real rows: seeded completed orders are all accepted by s2
  // (Mia, roster ms_seed_2) — she must show the attributed volume; staff with
  // no attributed orders are honest zeros.
  const mia = res.body.staff.find((p: any) => p.staffId === 'ms_seed_2');
  assert.ok(mia && mia.ordersProcessed > 0, 'Mia has attributed completed orders in the range');
  assert.ok(mia.ratingAverage !== null, 'rating derives from order ratings');
  const kai = res.body.staff.find((p: any) => p.staffId === 'ms_seed_3');
  assert.ok(kai && kai.ordersProcessed === 0, 'Kai has no attributed orders (honest zero)');
});

test('performance: range with no data -> 422 STAFF_PERFORMANCE_UNAVAILABLE (empty state, never zeros)', async () => {
  const far = new Date(Date.now() + 400 * DAY).toISOString().slice(0, 10);
  const res = await call('GET', `/staff/performance?from=${far}&to=${far}`);
  assert.equal(res.status, 422);
  assert.equal(res.body.error.code, 'STAFF_PERFORMANCE_UNAVAILABLE');
});

/* ================= Commissions (/staff/commissions) ================= */

test('commissions: seeded rules listed; PUT round-trip persists staffId/type/rateBps/active', async () => {
  const list = await call('GET', '/staff/commissions');
  assert.equal(list.status, 200);
  assert.equal(list.body.rules.length, 2);
  assert.ok(list.body.rules.some((r: any) => r.staffId === null && r.type === 'per_order' && r.rateBps === 500));

  const put = await call('PUT', '/staff/commissions', {
    body: {
      rules: [
        { staffId: null, type: 'per_order', rateBps: 750, active: true },
        { staffId: 'ms_seed_4', type: 'per_service', rateBps: 1200, active: false },
      ],
    },
    idem: 't-comm-put-1',
  });
  assert.equal(put.status, 200);
  assert.equal(put.body.rules.length, 2);
  const order = put.body.rules.find((r: any) => r.type === 'per_order');
  assert.equal(order.rateBps, 750, 'updated rate persisted');
  assert.equal(order.staffId, null);

  const readBack = await call('GET', '/staff/commissions');
  assert.equal(readBack.body.rules.length, 2);
  const service = readBack.body.rules.find((r: any) => r.type === 'per_service');
  assert.equal(service.staffId, 'ms_seed_4');
  assert.equal(service.rateBps, 1200);
  assert.equal(service.active, false);
});

test('commissions: invalid shapes -> 422 COMMISSION_RULE_INVALID with field errors', async () => {
  const badBps = await call('PUT', '/staff/commissions', {
    body: { rules: [{ staffId: null, type: 'per_order', rateBps: 15000 }] },
    idem: 't-comm-bad-1',
  });
  assert.equal(badBps.status, 422);
  assert.equal(badBps.body.error.code, 'COMMISSION_RULE_INVALID');
  assert.ok(badBps.body.error.details.fieldErrors['rules.0.rateBps']);

  const badType = await call('PUT', '/staff/commissions', {
    body: { rules: [{ staffId: null, type: 'per_burger', rateBps: 500 }] },
    idem: 't-comm-bad-2',
  });
  assert.equal(badType.status, 422);
  assert.equal(badType.body.error.code, 'COMMISSION_RULE_INVALID');
  assert.ok(badType.body.error.details.fieldErrors['rules.0.type']);

  const nonArray = await call('PUT', '/staff/commissions', { body: { rules: 'nope' }, idem: 't-comm-bad-3' });
  assert.equal(nonArray.status, 422);
  assert.equal(nonArray.body.error.code, 'COMMISSION_RULE_INVALID');

  const rulesBefore = await call('GET', '/staff/commissions');
  assert.equal(rulesBefore.body.rules.length, 2, 'failed PUT leaves the saved rules untouched');
});

/* ================= Approvals (/approvals) ================= */

test('approvals: seeded pending request listed; scope=inbox filters pending', async () => {
  const all = await call('GET', '/approvals');
  assert.equal(all.status, 200);
  assert.ok(all.body.approvals.length >= 1);
  const seeded = all.body.approvals.find((a: any) => a.id === 'ap_seed_1');
  assert.ok(seeded);
  assert.equal(seeded.type, 'refund_above_threshold');
  assert.equal(seeded.amountTZS, 180000, 'integer TZS');
  assert.equal(seeded.status, 'pending');
  assert.equal(seeded.decisionBy, null);

  const inbox = await call('GET', '/approvals?scope=inbox');
  assert.ok(inbox.body.approvals.every((a: any) => a.status === 'pending'));
  const decided = await call('GET', '/approvals?status=approved');
  assert.equal(decided.body.approvals.length, 0, 'no approved requests seeded');
});

test('approvals: submit -> 201 pending; validation on type/summary/amount', async () => {
  const created = await call('POST', '/approvals', {
    body: {
      type: 'price_change',
      refType: 'product',
      refId: 'p1',
      summary: 'Raise Signature Lamb Skewer from TZS 12,000 to TZS 14,000',
      amountTZS: 14000,
    },
    idem: 't-ap-create-1',
  });
  assert.equal(created.status, 201);
  const approval = created.body.approval;
  assert.equal(approval.status, 'pending');
  assert.equal(approval.requestedBy, 'Juma Mwenda', 'requester is the session staff name');
  assert.equal(approval.decidedAt, null);

  const listed = await call('GET', '/approvals?scope=submitted');
  assert.ok(listed.body.approvals.some((a: any) => a.id === approval.id));

  const badType = await call('POST', '/approvals', { body: { type: 'nope', summary: 'x' }, idem: 't-ap-bad-1' });
  assert.equal(badType.status, 400);
  assert.equal(badType.body.error.code, 'INVALID_TYPE');

  const longSummary = await call('POST', '/approvals', {
    body: { type: 'promotion', summary: 'x'.repeat(301) },
    idem: 't-ap-bad-2',
  });
  assert.equal(longSummary.status, 400);
  assert.equal(longSummary.body.error.code, 'SUMMARY_TOO_LONG');

  const floatAmount = await call('POST', '/approvals', {
    body: { type: 'refund_above_threshold', summary: 'refund', amountTZS: 12.5 },
    idem: 't-ap-bad-3',
  });
  assert.equal(floatAmount.status, 400);
  assert.equal(floatAmount.body.error.code, 'INVALID_AMOUNT');
});

test('approvals: approve -> 200; re-decision -> 409 APPROVAL_ALREADY_DECIDED; comment required', async () => {
  const decided = await call('POST', '/approvals/ap_seed_1/decision', {
    body: { decision: 'approved', comment: 'Customer story checks out — approve the refund.' },
    idem: 't-ap-decide-1',
  });
  assert.equal(decided.status, 200);
  assert.equal(decided.body.approval.status, 'approved');
  assert.equal(decided.body.approval.decisionBy, 'Juma Mwenda');
  assert.equal(decided.body.approval.decisionComment, 'Customer story checks out — approve the refund.');
  assert.ok(decided.body.approval.decidedAt);

  const again = await call('POST', '/approvals/ap_seed_1/decision', {
    body: { decision: 'rejected', comment: 'changed my mind' },
    idem: 't-ap-decide-2',
  });
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, 'APPROVAL_ALREADY_DECIDED');
  assert.equal(again.body.error.details.status, 'approved', 'conflict surfaces the prior decision');

  const noComment = await call('POST', '/approvals', {
    body: { type: 'inventory_adjustment', summary: 'Write off 5 damaged cartons' },
    idem: 't-ap-decide-3',
  });
  assert.equal(noComment.status, 201);
  const missing = await call('POST', `/approvals/${noComment.body.approval.id}/decision`, {
    body: { decision: 'rejected' },
    idem: 't-ap-decide-4',
  });
  assert.equal(missing.status, 400);
  assert.equal(missing.body.error.code, 'APPROVAL_REASON_REQUIRED');

  const reject = await call('POST', `/approvals/${noComment.body.approval.id}/decision`, {
    body: { decision: 'rejected', comment: 'Insufficient paperwork.' },
    idem: 't-ap-decide-5',
  });
  assert.equal(reject.status, 200);
  assert.equal(reject.body.approval.status, 'rejected');
});

test('approvals: unknown id -> 404 APPROVAL_NOT_FOUND; staff cannot decide (403)', async () => {
  const missing = await call('POST', '/approvals/no-such/decision', {
    body: { decision: 'approved', comment: 'x' },
    idem: 't-ap-404-1',
  });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, 'APPROVAL_NOT_FOUND');

  token = await loginAs('+255700000003');
  const forbidden = await call('POST', '/approvals/ap_seed_1/decision', {
    body: { decision: 'approved', comment: 'x' },
    idem: 't-ap-403-1',
  });
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.body.error.code, 'APPROVAL_FORBIDDEN');
});
