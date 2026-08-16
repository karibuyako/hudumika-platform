import { http } from 'msw';

import type {
  ApprovalDecisionBody,
  ApprovalRequest,
  ApprovalType,
  AttendanceRecord,
  AttendanceSource,
  CommissionRule,
  CommissionRuleInput,
  CommissionRuleType,
  MerchantStaff,
  MerchantStaffRole,
  NotificationDto,
  ServerEvent,
  StaffOpsEvent,
  StaffPerformance,
  StaffShift,
  StaffShiftStatus,
} from '@/api/types';
import { db, uid } from '@/mock/db';
import { emit } from '@/mock/events';
import { audit, json, ok, requirePerm, requireSession } from '@/mock/security';
import { ApiHttpError, h, readJson } from '@/mock/handlers/common';
import type { Session } from '@/mock/types-internal';

/* P8b event types are appended to types.ts only (ServerEvent's union lives
 * mid-file, shared with a parallel agent) — cross the bus via the common
 * base event type, same as the chain handlers. */
function p8Emit(event: StaffOpsEvent) {
  emit(event as unknown as ServerEvent);
}

const DAY = 86400000;
const SHIFT_STATUSES: readonly StaffShiftStatus[] = ['scheduled', 'active', 'completed', 'cancelled'];
const APPROVAL_TYPES: readonly ApprovalType[] = [
  'price_change',
  'promotion',
  'refund_above_threshold',
  'inventory_adjustment',
  'staff_role_change',
  'bulk_operation',
];
const COMMISSION_TYPES: readonly CommissionRuleType[] = ['per_order', 'per_service', 'per_revenue'];

/** Base origin for handler registration (browser origin / localhost in Node). */
const BASE = typeof location !== 'undefined' ? location.origin : 'http://localhost';

function del(
  path: string,
  fn: (args: { request: Request; params: Record<string, string> }) => Promise<Response> | Response,
) {
  return http.delete(`${BASE}${path}`, async (info) => {
    try {
      return await fn({ request: info.request, params: (info.params ?? {}) as Record<string, string> });
    } catch (e) {
      if (e instanceof ApiHttpError) {
        return json(e.status, { error: { code: e.code, message: e.message, retriable: e.retriable, details: e.details } });
      }
      throw e;
    }
  });
}

function put(
  path: string,
  fn: (args: { request: Request; params: Record<string, string> }) => Promise<Response> | Response,
) {
  return http.put(`${BASE}${path}`, async (info) => {
    try {
      return await fn({ request: info.request, params: (info.params ?? {}) as Record<string, string> });
    } catch (e) {
      if (e instanceof ApiHttpError) {
        return json(e.status, { error: { code: e.code, message: e.message, retriable: e.retriable, details: e.details } });
      }
      throw e;
    }
  });
}

function isoDate(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** yyyy-mm-dd → epoch ms (UTC midnight); throws INVALID_DATE on malformed input. */
function parseDate(value: string | null, label: string): number {
  const raw = String(value ?? '').trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!match) throw new ApiHttpError(400, 'INVALID_DATE', `${label} must be yyyy-mm-dd`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    throw new ApiHttpError(400, 'INVALID_DATE', `${label} must be a valid yyyy-mm-dd date`);
  }
  const ts = Date.UTC(year, month - 1, day);
  if (Number.isNaN(ts)) throw new ApiHttpError(400, 'INVALID_DATE', `${label} must be yyyy-mm-dd`);
  return ts;
}

/** Optional range parsing — defaults to the current week (7 days). */
function rangeOf(url: URL, defaultDays = 7): { from: string; to: string; fromTs: number; toTs: number } {
  const to = url.searchParams.get('to') ?? isoDate(Date.now());
  const from = url.searchParams.get('from') ?? isoDate(Date.now() - (defaultDays - 1) * DAY);
  return { from, to, fromTs: parseDate(from, 'from'), toTs: parseDate(to, 'to') + DAY - 1 };
}

/* ---------------- Scoping helpers ---------------- */

type StaffShiftRow = StaffShift & { merchantId: string };
type AttendanceRow = AttendanceRecord & { merchantId: string };
type CommissionRuleRow = CommissionRule & { merchantId: string };
type ApprovalRow = ApprovalRequest & { merchantId: string };

function merchantStaffOf(session: Session, id: string): MerchantStaff {
  const row = db.table<MerchantStaff & { merchantId: string }>('merchantStaff').find(id);
  if (!row || row.merchantId !== session.merchantId) throw new ApiHttpError(404, 'STAFF_NOT_FOUND', 'Staff member not found');
  return row;
}

/** Map the session's own staff account (legacy `staff` table) to the contract
 *  merchantStaff roster by phone; falls back to the session staffId. */
function rosterStaffId(session: Session): string {
  const me = db.table<{ id: string; phone: string; name: string }>('staff').find(session.staffId);
  const match = me
    ? db
        .table<MerchantStaff & { merchantId: string }>('merchantStaff')
        .where((s) => s.merchantId === session.merchantId && s.phone === me.phone)[0]
    : undefined;
  return match?.id ?? session.staffId;
}

function shiftOfRow(session: Session, id: string): StaffShiftRow {
  const row = db.table<StaffShiftRow>('staffShifts').find(id);
  if (!row || row.merchantId !== session.merchantId) throw new ApiHttpError(404, 'SHIFT_NOT_FOUND', 'Shift not found');
  return row;
}

/** True when two [start,end] intervals overlap. */
function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

function assertNoOverlap(session: Session, staffId: string, startAt: number, endAt: number, exceptId?: string) {
  const clash = db
    .table<StaffShiftRow>('staffShifts')
    .where(
      (s) =>
        s.merchantId === session.merchantId &&
        s.staffId === staffId &&
        s.status !== 'cancelled' &&
        s.id !== exceptId &&
        overlaps(startAt, endAt, s.startAt, s.endAt),
    );
  if (clash.length) {
    throw new ApiHttpError(409, 'SHIFT_OVERLAP', 'This shift overlaps another shift for the same staff member');
  }
}

function staffNameOf(session: Session, staffId: string): string {
  const row = db.table<MerchantStaff & { merchantId: string }>('merchantStaff').find(staffId);
  if (row && row.merchantId === session.merchantId) return row.name;
  return staffId;
}

function approverRole(session: Session): boolean {
  return session.role === 'owner' || session.role === 'manager';
}

function approverNames(session: Session): string[] {
  return db
    .table<MerchantStaff & { merchantId: string }>('merchantStaff')
    .where((s) => s.merchantId === session.merchantId && (s.role === 'owner' || s.role === 'manager'))
    .map((s) => s.name);
}

/* ---------------- Shifts (/staff/shifts) ---------------- */

function parseShiftInput(body: Record<string, unknown>, partial: boolean): { staffId?: string; role?: MerchantStaffRole; startAt?: number; endAt?: number; storeId?: string | null } {
  const out: { staffId?: string; role?: MerchantStaffRole; startAt?: number; endAt?: number; storeId?: string | null } = {};
  if (body.staffId !== undefined || !partial) {
    out.staffId = String(body.staffId ?? '');
    if (!out.staffId) throw new ApiHttpError(400, 'STAFF_REQUIRED', 'staffId is required');
  }
  if (body.role !== undefined) {
    const role = (['owner', 'manager', 'cashier', 'kitchen', 'waiter'] as const).find((r) => r === body.role);
    if (!role) throw new ApiHttpError(400, 'INVALID_ROLE', 'role must be one of owner, manager, cashier, kitchen, waiter');
    out.role = role;
  }
  if (body.startAt !== undefined || !partial) {
    const startAt = Number(body.startAt);
    if (!Number.isFinite(startAt)) throw new ApiHttpError(400, 'INVALID_TIME', 'startAt must be an epoch timestamp (ms)');
    out.startAt = startAt;
  }
  if (body.endAt !== undefined || !partial) {
    const endAt = Number(body.endAt);
    if (!Number.isFinite(endAt)) throw new ApiHttpError(400, 'INVALID_TIME', 'endAt must be an epoch timestamp (ms)');
    out.endAt = endAt;
  }
  if (body.storeId !== undefined) out.storeId = body.storeId === null ? null : String(body.storeId);
  return out;
}

function validateShiftWindow(session: Session, input: { staffId: string; role?: MerchantStaffRole; startAt: number; endAt: number; storeId?: string | null }, exceptId?: string) {
  if (input.endAt <= input.startAt) throw new ApiHttpError(400, 'INVALID_RANGE', 'endAt must be after startAt');
  if (input.startAt < Date.now() - 60 * 1000) throw new ApiHttpError(400, 'SHIFT_IN_PAST', 'Shifts cannot start in the past');
  merchantStaffOf(session, input.staffId);
  assertNoOverlap(session, input.staffId, input.startAt, input.endAt, exceptId);
}

export const staffOpsHandlers = [
  h.get('/api/staff/shifts', ({ request }) => {
    const session = requireSession(request);
    requirePerm(session, 'team:manage');
    const url = new URL(request.url);
    // Contract: from + to are required for the schedule range.
    const rawFrom = url.searchParams.get('from');
    const rawTo = url.searchParams.get('to');
    if (!rawFrom || !rawTo) throw new ApiHttpError(400, 'INVALID_DATE', 'from and to (yyyy-mm-dd) are required');
    const fromTs = parseDate(rawFrom, 'from');
    const toTs = parseDate(rawTo, 'to');
    const rows = db
      .table<StaffShiftRow>('staffShifts')
      .where((s) => s.merchantId === session.merchantId && s.startAt <= toTs + DAY - 1 && s.endAt >= fromTs)
      .sort((a, b) => a.startAt - b.startAt);
    return ok({ shifts: rows.map(({ merchantId: _m, ...s }) => s) });
  }),

  h.post('/api/staff/shifts', async ({ request }) => {
    const session = requireSession(request);
    requirePerm(session, 'team:manage');
    const body = await readJson(request);
    const input = parseShiftInput(body, false);
    const shiftInput: { staffId: string; role: MerchantStaffRole; startAt: number; endAt: number; storeId: string | null } = {
      staffId: input.staffId!,
      role: input.role ?? merchantStaffOf(session, input.staffId!).role,
      startAt: input.startAt!,
      endAt: input.endAt!,
      storeId: input.storeId ?? null,
    };
    validateShiftWindow(session, shiftInput);
    const shift: StaffShiftRow = { id: uid('sh'), merchantId: session.merchantId, status: 'scheduled', ...shiftInput };
    db.table<StaffShiftRow>('staffShifts').insert(shift);
    p8Emit({ type: 'staff.shift_created', shift, at: Date.now() });
    audit(session.merchantId, session.staffId, session.role, 'team:shift', 'shift', shift.id, `scheduled ${staffNameOf(session, shift.staffId)} ${new Date(shift.startAt).toISOString()}`);
    return json(201, { id: shift.id, staffId: shift.staffId, role: shift.role, startAt: shift.startAt, endAt: shift.endAt, status: shift.status, storeId: shift.storeId });
  }),

  h.patch('/api/staff/shifts/:shiftId', async ({ request, params }) => {
    const session = requireSession(request);
    requirePerm(session, 'team:manage');
    const row = shiftOfRow(session, String(params.shiftId));
    const body = await readJson(request);
    const input = parseShiftInput(body, true);
    const next: StaffShiftRow = {
      ...row,
      staffId: input.staffId ?? row.staffId,
      role: input.role ?? row.role,
      startAt: input.startAt ?? row.startAt,
      endAt: input.endAt ?? row.endAt,
      storeId: input.storeId !== undefined ? input.storeId : row.storeId,
    };
    if (body.status !== undefined) {
      const status = SHIFT_STATUSES.find((s) => s === body.status);
      if (!status) throw new ApiHttpError(400, 'INVALID_STATUS', `status must be one of ${SHIFT_STATUSES.join(', ')}`);
      next.status = status;
    }
    validateShiftWindow(session, next, row.id);
    const updated = db.table<StaffShiftRow>('staffShifts').update(row.id, next)!;
    p8Emit({ type: 'staff.shift_updated', shift: updated, at: Date.now() });
    audit(session.merchantId, session.staffId, session.role, 'team:shift', 'shift', updated.id, 'updated a shift');
    return ok({ id: updated.id, staffId: updated.staffId, role: updated.role, startAt: updated.startAt, endAt: updated.endAt, status: updated.status, storeId: updated.storeId });
  }),

  del('/api/staff/shifts/:shiftId', ({ request, params }) => {
    const session = requireSession(request);
    requirePerm(session, 'team:manage');
    const row = shiftOfRow(session, String(params.shiftId));
    db.table<StaffShiftRow>('staffShifts').remove(row.id);
    p8Emit({ type: 'staff.shift_deleted', shiftId: row.id, at: Date.now() });
    audit(session.merchantId, session.staffId, session.role, 'team:shift', 'shift', row.id, 'deleted a shift');
    return new Response(null, { status: 204 });
  }),

  /* ---------------- Attendance (/staff/attendance) ---------------- */

  h.get('/api/staff/attendance', ({ request }) => {
    const session = requireSession(request);
    requirePerm(session, 'team:manage');
    const url = new URL(request.url);
    const staffId = url.searchParams.get('staffId');
    const { fromTs, toTs } = rangeOf(url, 7);
    let rows = db
      .table<AttendanceRow>('attendance')
      .where((r) => r.merchantId === session.merchantId && r.clockedInAt >= fromTs && r.clockedInAt <= toTs);
    if (staffId) rows = rows.filter((r) => r.staffId === staffId);
    return ok({ records: [...rows].sort((a, b) => b.clockedInAt - a.clockedInAt) });
  }),

  h.post('/api/staff/attendance/clock-in', async ({ request }) => {
    const session = requireSession(request);
    const staffId = rosterStaffId(session);
    const open = db
      .table<AttendanceRow>('attendance')
      .where((r) => r.merchantId === session.merchantId && r.staffId === staffId && r.clockedOutAt === null);
    if (open.length) {
      throw new ApiHttpError(409, 'ATTENDANCE_ALREADY_CLOCKED_IN', 'You are already clocked in — clock out first');
    }
    const activeShift = db
      .table<StaffShiftRow>('staffShifts')
      .where((s) => s.merchantId === session.merchantId && s.staffId === staffId && s.status === 'scheduled' && s.startAt <= Date.now() && s.endAt >= Date.now())[0];
    if (activeShift) {
      db.table<StaffShiftRow>('staffShifts').update(activeShift.id, { status: 'active' });
    }
    const source: AttendanceSource = 'app';
    const record: AttendanceRow = {
      id: uid('att'),
      merchantId: session.merchantId,
      staffId,
      shiftId: activeShift?.id ?? null,
      clockedInAt: Date.now(),
      clockedOutAt: null,
      durationMinutes: null,
      source,
    };
    db.table<AttendanceRow>('attendance').insert(record);
    p8Emit({ type: 'attendance.clocked_in', record, at: Date.now() });
    audit(session.merchantId, session.staffId, session.role, 'attendance:clock-in', 'attendance', record.id, 'clocked in');
    return ok({ record });
  }),

  h.post('/api/staff/attendance/clock-out', async ({ request }) => {
    const session = requireSession(request);
    const staffId = rosterStaffId(session);
    const open = db
      .table<AttendanceRow>('attendance')
      .where((r) => r.merchantId === session.merchantId && r.staffId === staffId && r.clockedOutAt === null)
      .sort((a, b) => a.clockedInAt - b.clockedInAt);
    if (!open.length) throw new ApiHttpError(409, 'ATTENDANCE_NOT_CLOCKED_IN', 'You are not clocked in');
    const row = open[0];
    const clockedOutAt = Date.now();
    const durationMinutes = Math.max(0, Math.round((clockedOutAt - row.clockedInAt) / 60000));
    const updated = db.table<AttendanceRow>('attendance').update(row.id, { clockedOutAt, durationMinutes })!;
    if (updated.shiftId) {
      const shift = db.table<StaffShiftRow>('staffShifts').find(updated.shiftId);
      if (shift) db.table<StaffShiftRow>('staffShifts').update(shift.id, { status: 'completed' });
    }
    p8Emit({ type: 'attendance.clocked_out', record: updated, at: Date.now() });
    audit(session.merchantId, session.staffId, session.role, 'attendance:clock-out', 'attendance', updated.id, 'clocked out');
    return ok({ record: updated });
  }),

  /* ---------------- Performance (/staff/performance) ---------------- */

  h.get('/api/staff/performance', ({ request }) => {
    const session = requireSession(request);
    requirePerm(session, 'team:manage');
    const url = new URL(request.url);
    const { from, to, fromTs, toTs } = rangeOf(url, 7);
    const ordersInRange = db
      .table<{ id: string; merchantId: string; status: string; total: number; completedAt?: number }>('orders')
      .where((o) => o.merchantId === session.merchantId && o.status === 'completed' && (o.completedAt ?? 0) >= fromTs && (o.completedAt ?? 0) <= toTs);
    const attendanceInRange = db
      .table<AttendanceRow>('attendance')
      .where((r) => r.merchantId === session.merchantId && r.clockedInAt >= fromTs && r.clockedInAt <= toTs);
    // Derived view: no orders AND no attendance in range → the analytics job
    // has nothing to report; the client renders the empty state, never zeros.
    if (!ordersInRange.length && !attendanceInRange.length) {
      throw new ApiHttpError(422, 'STAFF_PERFORMANCE_UNAVAILABLE', 'No performance data in this range');
    }
    const days = Math.max(1, Math.round((toTs - fromTs) / DAY));
    const avgOrderTZS = ordersInRange.length ? Math.round(ordersInRange.reduce((s, o) => s + o.total, 0) / ordersInRange.length) : 35000;
    const globalRules = db.table<CommissionRuleRow>('commissionRules').where((r) => r.merchantId === session.merchantId && r.active && r.staffId === null);
    const perStaffRules = db.table<CommissionRuleRow>('commissionRules').where((r) => r.merchantId === session.merchantId && r.active && r.staffId !== null);
    const roster = db.table<MerchantStaff & { merchantId: string }>('merchantStaff').where((s) => s.merchantId === session.merchantId);
    const legacyById = new Map(db.table<{ id: string; phone: string }>('staff').all().map((s) => [s.id, s.phone]));
    /* Order attribution: the order timeline records the accepting staff
     * (legacy id, roster id, or staff name). Performance rows are a derived
     * view over those real rows — never hash-fabricated (ENTERPRISE-STAFF.md
     * §45). */
    const attributedByStaff = new Map<string, { completed: typeof ordersInRange; cancelled: { id: string; acceptedAt?: number; cancelledAt?: number }[] }>();
    const legacyStaffIdOf = (s: MerchantStaff): string | null => {
      for (const [id, phone] of legacyById) {
        if (phone === s.phone) return id;
      }
      return null;
    };
    const attributedOrders = (s: MerchantStaff): { completed: typeof ordersInRange; cancelled: { id: string; acceptedAt?: number; cancelledAt?: number }[] } => {
      const cached = attributedByStaff.get(s.id);
      if (cached) return cached;
      const legacyId = legacyStaffIdOf(s);
      const acceptors = new Set([legacyId, s.id, s.name].filter((x): x is string => !!x));
      const isAcceptedBy = (o: { timeline?: { event: string; actor?: string }[] }): boolean =>
        (o.timeline ?? []).some((e) => e.event === 'accepted' && e.actor !== undefined && acceptors.has(e.actor));
      const completed = ordersInRange.filter((o) => isAcceptedBy(o as { timeline?: { event: string; actor?: string }[] }));
      const cancelled = db
        .table<{ id: string; merchantId: string; status: string; cancelledAt?: number; acceptedAt?: number; timeline?: { event: string; actor?: string }[] }>('orders')
        .where((o) => o.merchantId === session.merchantId && o.status === 'cancelled' && (o.cancelledAt ?? 0) >= fromTs && (o.cancelledAt ?? 0) <= toTs)
        .filter((o) => isAcceptedBy(o));
      attributedByStaff.set(s.id, { completed, cancelled });
      return attributedByStaff.get(s.id)!;
    };
    const attendanceDays = (s: MerchantStaff): number => {
      const seen = new Set<string>();
      for (const r of attendanceInRange) {
        if (r.staffId === s.id) {
          const d = new Date(r.clockedInAt);
          seen.add(`${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`);
        }
      }
      return seen.size;
    };
    const rows: StaffPerformance[] = roster.map((s) => {
      const { completed: mine, cancelled: cancelledMine } = attributedOrders(s);
      const ordersProcessed = mine.length;
      const cancellations = cancelledMine.length;
      const handleTimes = mine
        .map((o) => {
          const row = o as { completedAt?: number; acceptedAt?: number };
          return row.completedAt && row.acceptedAt && row.completedAt > row.acceptedAt ? (row.completedAt - row.acceptedAt) / 60000 : null;
        })
        .filter((v): v is number => v !== null);
      const avgHandleTimeMinutes = handleTimes.length ? Math.round((handleTimes.reduce((a, b) => a + b, 0) / handleTimes.length) * 10) / 10 : 0;
      const rated = mine.filter((o) => typeof (o as { rating?: unknown }).rating === 'number').map((o) => (o as unknown as { rating: number }).rating);
      const ratingAverage = rated.length ? Math.round((rated.reduce((a, b) => a + b, 0) / rated.length) * 10) / 10 : null;
      const present = attendanceDays(s);
      const attendanceRate = Math.round((present / days) * 1000) / 10;
      const ownRule = perStaffRules.find((r) => r.staffId === s.id);
      const rateBps = ownRule?.rateBps ?? globalRules.reduce((acc, r) => acc + r.rateBps, 0);
      return {
        staffId: s.id,
        name: s.name,
        ordersProcessed,
        avgHandleTimeMinutes,
        cancellations,
        ratingAverage,
        attendanceRate,
        commissionTZS: Math.round((ordersProcessed * rateBps * avgOrderTZS) / 10000 / 100) * 100,
      };
    });
    return ok({ from, to, staff: rows });
  }),

  /* ---------------- Commissions (/staff/commissions) ---------------- */

  h.get('/api/staff/commissions', ({ request }) => {
    const session = requireSession(request);
    requirePerm(session, 'team:manage');
    const rows = db.table<CommissionRuleRow>('commissionRules').where((r) => r.merchantId === session.merchantId);
    return ok({ rules: rows.map(({ merchantId: _m, ...r }) => r) });
  }),

  put('/api/staff/commissions', async ({ request }) => {
    const session = requireSession(request);
    requirePerm(session, 'team:manage');
    const body = await readJson(request);
    if (!Array.isArray(body.rules)) throw new ApiHttpError(422, 'COMMISSION_RULE_INVALID', 'rules must be an array', false, { fieldErrors: { rules: 'must be an array' } });
    const fieldErrors: Record<string, string> = {};
    const parsed: CommissionRuleInput[] = [];
    (body.rules as unknown[]).forEach((raw, i) => {
      const rule = (raw ?? {}) as Record<string, unknown>;
      const type = COMMISSION_TYPES.find((ct) => ct === rule.type);
      if (!type) fieldErrors[`rules.${i}.type`] = 'type must be one of per_order, per_service, per_revenue';
      const rateBps = Number(rule.rateBps);
      if (!Number.isInteger(rateBps) || rateBps < 0 || rateBps > 10000) {
        fieldErrors[`rules.${i}.rateBps`] = 'rateBps must be an integer between 0 and 10,000';
      }
      if (rule.staffId !== undefined && rule.staffId !== null && typeof rule.staffId !== 'string') {
        fieldErrors[`rules.${i}.staffId`] = 'staffId must be a string or null';
      }
      if (rule.active !== undefined && typeof rule.active !== 'boolean') {
        fieldErrors[`rules.${i}.active`] = 'active must be a boolean';
      }
      parsed.push({
        type: type ?? 'per_order',
        rateBps: Number.isInteger(rateBps) ? rateBps : 0,
        staffId: rule.staffId === undefined ? null : (rule.staffId as string | null),
        active: rule.active === undefined ? true : (rule.active as boolean),
      });
    });
    if (Object.keys(fieldErrors).length) {
      throw new ApiHttpError(422, 'COMMISSION_RULE_INVALID', 'One or more commission rules are invalid', false, { fieldErrors });
    }
    const table = db.table<CommissionRuleRow>('commissionRules');
    const existing = table.where((r) => r.merchantId === session.merchantId);
    for (const old of existing) table.remove(old.id);
    const saved: CommissionRule[] = parsed.map((r) => {
      const prior = existing.find((e) => e.staffId === r.staffId && e.type === r.type);
      const row: CommissionRuleRow = {
        id: prior?.id ?? uid('cr'),
        merchantId: session.merchantId,
        staffId: r.staffId ?? null,
        type: r.type,
        rateBps: r.rateBps,
        active: r.active === undefined ? true : r.active,
      };
      table.insert(row);
      return { id: row.id, staffId: row.staffId, type: row.type, rateBps: row.rateBps, active: row.active };
    });
    audit(session.merchantId, session.staffId, session.role, 'team:commission', 'commissionRules', session.merchantId, `saved ${saved.length} commission rule(s)`);
    return ok({ rules: saved });
  }),

  /* ---------------- Approvals (/approvals) ---------------- */

  h.get('/api/approvals', ({ request }) => {
    const session = requireSession(request);
    const url = new URL(request.url);
    const scope = url.searchParams.get('scope');
    const status = url.searchParams.get('status');
    let rows = db.table<ApprovalRow>('approvals').where((a) => a.merchantId === session.merchantId);
    if (scope === 'submitted') {
      const myName = staffNameOf(session, rosterStaffId(session)) || session.staffId;
      rows = rows.filter((a) => a.requestedBy === myName || a.requestedBy === session.staffId);
    } else if (scope === 'inbox') {
      rows = rows.filter((a) => a.status === 'pending');
    }
    if (status) rows = rows.filter((a) => a.status === status);
    return ok({ approvals: [...rows].sort((a, b) => b.createdAt - a.createdAt) });
  }),

  h.post('/api/approvals', async ({ request }) => {
    const session = requireSession(request);
    const body = await readJson(request);
    const type = APPROVAL_TYPES.find((t) => t === body.type);
    if (!type) throw new ApiHttpError(400, 'INVALID_TYPE', 'type must be one of the approved approval types');
    const summary = String(body.summary ?? '').trim();
    if (summary.length > 300) throw new ApiHttpError(400, 'SUMMARY_TOO_LONG', 'summary must be at most 300 characters');
    let amountTZS: number | null = null;
    if (body.amountTZS !== undefined && body.amountTZS !== null) {
      amountTZS = Number(body.amountTZS);
      if (!Number.isInteger(amountTZS)) throw new ApiHttpError(400, 'INVALID_AMOUNT', 'amountTZS must be an integer');
    }
    const refType = body.refType === undefined ? undefined : String(body.refType);
    const refId = body.refId === undefined ? undefined : String(body.refId);
    const approval: ApprovalRow = {
      id: uid('ap'),
      merchantId: session.merchantId,
      type,
      refType,
      refId,
      summary: summary || undefined,
      amountTZS,
      status: 'pending',
      requestedBy: staffNameOf(session, rosterStaffId(session)) || session.staffId,
      decisionBy: null,
      decisionComment: null,
      createdAt: Date.now(),
      decidedAt: null,
    };
    db.table<ApprovalRow>('approvals').insert(approval);
    // Notify every approver (owner/manager) — the mock inbox acts as the in-app queue.
    for (const name of approverNames(session)) {
      db.table<NotificationDto>('notifications').insert({
        id: uid('n'),
        merchantId: session.merchantId,
        type: 'system',
        category: 'important',
        title: `Approval requested · ${type}`,
        body: `${name}: ${summary || `${type} request`} awaits your review.`,
        ts: Date.now(),
        read: false,
      });
    }
    p8Emit({ type: 'approvals.requested', approval, at: Date.now() });
    audit(session.merchantId, session.staffId, session.role, 'approvals:submit', 'approval', approval.id, `submitted ${type} request`);
    return json(201, { approval });
  }),

  h.post('/api/approvals/:approvalId/decision', async ({ request, params }) => {
    const session = requireSession(request);
    if (!approverRole(session)) throw new ApiHttpError(403, 'APPROVAL_FORBIDDEN', 'Only owners and managers can decide approvals');
    requirePerm(session, 'team:manage');
    const approval = db.table<ApprovalRow>('approvals').find(String(params.approvalId));
    if (!approval || approval.merchantId !== session.merchantId) throw new ApiHttpError(404, 'APPROVAL_NOT_FOUND', 'Approval request not found');
    if (approval.status !== 'pending') {
      throw new ApiHttpError(409, 'APPROVAL_ALREADY_DECIDED', 'This request was already decided', false, {
        status: approval.status,
        decidedBy: approval.decisionBy,
        decidedAt: approval.decidedAt,
      });
    }
    const body = (await readJson(request)) as Partial<ApprovalDecisionBody>;
    const decision = body.decision;
    if (decision !== 'approved' && decision !== 'rejected') {
      throw new ApiHttpError(400, 'INVALID_DECISION', 'decision must be approved or rejected');
    }
    const comment = String(body.comment ?? '').trim();
    if (!comment) throw new ApiHttpError(400, 'APPROVAL_REASON_REQUIRED', 'A comment is required with the decision');
    if (comment.length > 500) throw new ApiHttpError(400, 'COMMENT_TOO_LONG', 'comment must be at most 500 characters');
    const updated = db.table<ApprovalRow>('approvals').update(approval.id, {
      status: decision,
      decisionBy: staffNameOf(session, rosterStaffId(session)) || session.staffId,
      decisionComment: comment,
      decidedAt: Date.now(),
    })!;
    db.table<NotificationDto>('notifications').insert({
      id: uid('n'),
      merchantId: session.merchantId,
      type: 'system',
      category: 'important',
      title: `Approval ${decision}`,
      body: `Your ${updated.type} request was ${decision}. ${comment}`,
      ts: Date.now(),
      read: false,
    });
    p8Emit({ type: 'approvals.decided', approval: updated, at: Date.now() });
    audit(session.merchantId, session.staffId, session.role, 'approvals:decide', 'approval', updated.id, `${decision} ${updated.type} request`);
    return ok({ approval: updated });
  }),
];
