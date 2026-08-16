/* Contract tests for the rider vehicle tools mock repository
 * (maintenance, expenses, goals, exports, training).
 *
 * These import the MOCK implementation directly (src/repos/mock/vehicle) — the
 * factories switch on env vars and are exercised by the app, not here.
 * Every case resets the shared mock store (seed 20260813) in beforeEach.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { ApiError } from '@/api/client';
import { resetMockState } from '@/repos/mock/mockState';
import { MockVehicleRepository } from '@/repos/mock/vehicle';

const vehicle = new MockVehicleRepository();

beforeEach(() => resetMockState());

async function rejectsApiError(promise: Promise<unknown>, status: number, code?: string): Promise<ApiError> {
  let caught: unknown;
  try {
    await promise;
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof ApiError, `expected ApiError, got ${String(caught)}`);
  assert.equal(caught.status, status);
  if (code) assert.equal(caught.code, code);
  return caught as ApiError;
}

/* ---------------- Maintenance ---------------- */

test('listMaintenance returns seeded records with integer costTZS and a nextDueAt', async () => {
  const records = await vehicle.listMaintenance();
  assert.ok(records.length >= 2, 'maintenance history should be seeded');
  for (const r of records) {
    assert.equal(typeof r.type, 'string');
    assert.ok(!Number.isNaN(Date.parse(r.performedAt)), 'performedAt must be a valid date');
    if (r.costTZS != null) assert.ok(Number.isInteger(r.costTZS), 'costTZS must be integer TZS');
    if (r.mileageKm != null) assert.ok(Number.isInteger(r.mileageKm));
  }
  assert.ok(records.some((r) => r.nextDueAt != null), 'at least one seeded record has a nextDueAt');
  const times = records.map((r) => Date.parse(r.performedAt));
  for (let i = 1; i < times.length; i += 1) {
    assert.ok(times[i - 1] >= times[i], 'records sorted by performedAt desc');
  }
});

test('createMaintenance adds a shaped record and it appears in the list', async () => {
  const created = await vehicle.createMaintenance({
    type: 'tire_pressure',
    performedAt: new Date().toISOString(),
    mileageKm: 12600,
    costTZS: 8000,
    notes: 'All tires topped up',
  });
  assert.ok(created.id, 'mock assigns an id');
  assert.equal(created.type, 'tire_pressure');
  assert.equal(created.costTZS, 8000);
  assert.equal(created.mileageKm, 12600);
  assert.ok(!Number.isNaN(Date.parse(created.performedAt)));
  const list = await vehicle.listMaintenance();
  assert.ok(list.some((r) => r.id === created.id));
});

test('createMaintenance with a type outside the enum throws 422 INVALID_INPUT', async () => {
  const err = await rejectsApiError(
    vehicle.createMaintenance({ type: 'wheel_alignment' as never, performedAt: new Date().toISOString() }),
    422,
    'INVALID_INPUT',
  );
  assert.ok(err.message.length > 0);
});

/* ---------------- Expenses ---------------- */

test('listExpenses returns seeded expenses with integer amountTZS', async () => {
  const expenses = await vehicle.listExpenses();
  assert.ok(expenses.length >= 3, 'expenses should be seeded');
  for (const e of expenses) {
    assert.equal(typeof e.category, 'string');
    assert.ok(Number.isInteger(e.amountTZS), 'amountTZS must be integer TZS');
    assert.ok(!Number.isNaN(Date.parse(e.incurredAt)), 'incurredAt must be a valid date');
    assert.equal(typeof e.deductible, 'boolean');
  }
  const times = expenses.map((e) => Date.parse(e.incurredAt));
  for (let i = 1; i < times.length; i += 1) {
    assert.ok(times[i - 1] >= times[i], 'expenses sorted by incurredAt desc');
  }
});

test('createExpense adds a deductible expense and it appears in the list', async () => {
  const created = await vehicle.createExpense({
    category: 'equipment',
    amountTZS: 45000,
    deductible: true,
    note: 'Rain gear',
    incurredAt: new Date().toISOString(),
  });
  assert.ok(created.id, 'mock assigns an id');
  assert.equal(created.category, 'equipment');
  assert.equal(created.amountTZS, 45000);
  assert.equal(created.deductible, true);
  const list = await vehicle.listExpenses();
  assert.ok(list.some((e) => e.id === created.id));
});

test('createExpense with a category outside the enum throws 422 INVALID_INPUT', async () => {
  await rejectsApiError(
    vehicle.createExpense({ category: 'parking' as never, amountTZS: 2000, incurredAt: new Date().toISOString() }),
    422,
    'INVALID_INPUT',
  );
});

test('listExpenses honors the from/to date filters', async () => {
  const all = await vehicle.listExpenses();
  const newest = all[0];
  const dayAfter = new Date(Date.parse(newest.incurredAt) + 24 * 3600_000).toISOString().slice(0, 10);
  const filtered = await vehicle.listExpenses(dayAfter, '9999-12-31');
  assert.equal(filtered.length, 0);
});

/* ---------------- Goals ---------------- */

test('getGoals returns the contract shape with defaults', async () => {
  const goals = await vehicle.getGoals();
  assert.ok(Number.isInteger(goals.hoursGoalPerWeek), 'hoursGoalPerWeek must be an integer');
  assert.ok(goals.hoursGoalPerWeek >= 1 && goals.hoursGoalPerWeek <= 100);
  assert.ok(Number.isInteger(goals.earningsGoalTZS), 'earningsGoalTZS must be an integer');
  assert.ok(goals.earningsGoalTZS >= 0);
  assert.ok(Array.isArray(goals.weeklyAvailability));
  for (const day of goals.weeklyAvailability ?? []) {
    assert.ok(day.dayOfWeek >= 0 && day.dayOfWeek <= 6);
    assert.equal(typeof day.startTime, 'string');
    assert.equal(typeof day.endTime, 'string');
  }
  assert.equal(typeof goals.peakHourAlerts, 'boolean');
});

test('putGoals round-trips hours, earnings, availability and alerts', async () => {
  const base = await vehicle.getGoals();
  const updated = await vehicle.putGoals({
    hoursGoalPerWeek: 30,
    earningsGoalTZS: 250000,
    weeklyAvailability: [{ dayOfWeek: 2, startTime: '07:00', endTime: '19:00' }],
    peakHourAlerts: false,
  });
  assert.equal(updated.hoursGoalPerWeek, 30);
  assert.equal(updated.earningsGoalTZS, 250000);
  assert.deepEqual(updated.weeklyAvailability, [{ dayOfWeek: 2, startTime: '07:00', endTime: '19:00' }]);
  assert.equal(updated.peakHourAlerts, false);
  const fetched = await vehicle.getGoals();
  assert.deepEqual(fetched, updated);
  assert.notDeepEqual(fetched, base, 'goals must be replaced, not merged');
});

test('putGoals with hours 0 or 101 throws 422 INVALID_INPUT', async () => {
  for (const hours of [0, 101]) {
    await rejectsApiError(
      vehicle.putGoals({ hoursGoalPerWeek: hours, earningsGoalTZS: 100000 }),
      422,
      'INVALID_INPUT',
    );
  }
});

test('putGoals with a negative or fractional earnings goal throws 422 INVALID_INPUT', async () => {
  await rejectsApiError(vehicle.putGoals({ hoursGoalPerWeek: 40, earningsGoalTZS: -1 }), 422, 'INVALID_INPUT');
  await rejectsApiError(vehicle.putGoals({ hoursGoalPerWeek: 40, earningsGoalTZS: 1.5 }), 422, 'INVALID_INPUT');
});

test('putGoals validation failure does not mutate stored goals', async () => {
  const base = await vehicle.getGoals();
  await rejectsApiError(vehicle.putGoals({ hoursGoalPerWeek: 0, earningsGoalTZS: 100000 }), 422);
  const after = await vehicle.getGoals();
  assert.deepEqual(after, base);
});

/* ---------------- Exports ---------------- */

test('requestExport returns an accepted job with status queued', async () => {
  const job = await vehicle.requestExport({ reportType: 'tax', format: 'pdf', from: '2026-01-01', to: '2026-01-31' });
  assert.ok(job.jobId.length > 0, 'mock assigns a jobId');
  assert.equal(job.status, 'queued');
});

test('requestExport with a reportType outside the enum throws 422 INVALID_INPUT', async () => {
  await rejectsApiError(vehicle.requestExport({ reportType: 'invoices' as never, format: 'csv' }), 422, 'INVALID_INPUT');
});

test('requestExport with a format outside the enum throws 422 INVALID_INPUT', async () => {
  await rejectsApiError(vehicle.requestExport({ reportType: 'trips', format: 'xlsx' as never }), 422, 'INVALID_INPUT');
});

/* ---------------- Training ---------------- */

test('listTraining returns modules with progress and status', async () => {
  const modules = await vehicle.listTraining();
  assert.ok(modules.length >= 3, 'training modules should be seeded');
  for (const m of modules) {
    assert.ok(m.id.length > 0);
    assert.ok(m.title.length > 0);
    assert.ok(['not_started', 'in_progress', 'completed', 'certified'].includes(m.status));
    assert.ok((m.progressPct ?? 0) >= 0 && (m.progressPct ?? 0) <= 100);
    if (m.status === 'certified') {
      assert.equal(m.progressPct, 100);
      assert.ok(m.certificateUrl, 'certified modules carry a certificateUrl');
    }
  }
});

test('completeTraining flips a module to certified with a certificate and is idempotent', async () => {
  const modules = await vehicle.listTraining();
  const target = modules.find((m) => m.status !== 'certified');
  assert.ok(target, 'at least one uncompleted module is seeded');
  const completed = await vehicle.completeTraining(target.id);
  assert.equal(completed.status, 'certified');
  assert.equal(completed.progressPct, 100);
  assert.ok(completed.certificateUrl, 'completion sets a certificateUrl');
  assert.ok(completed.completedAt && !Number.isNaN(Date.parse(completed.completedAt)), 'completion sets completedAt');
  const again = await vehicle.completeTraining(target.id);
  assert.equal(again.status, 'certified');
  assert.equal(again.certificateUrl, completed.certificateUrl, 'second completion is idempotent');
  const listed = await vehicle.listTraining();
  const stored = listed.find((m) => m.id === target.id);
  assert.equal(stored?.status, 'certified');
});

test('completeTraining with an unknown module throws 404 TRAINING_MODULE_NOT_FOUND', async () => {
  await rejectsApiError(vehicle.completeTraining('module_missing'), 404, 'TRAINING_MODULE_NOT_FOUND');
});
