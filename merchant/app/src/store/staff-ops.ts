import { create } from 'zustand';

import { api, ApiError, getToken } from '@/api/client';
import type {
  ApiErrorBody,
  ApprovalDecisionBody,
  ApprovalInput,
  ApprovalRequest,
  AttendanceRecord,
  CommissionRule,
  CommissionRuleInput,
  CommissionRulesBody,
  StaffPerformance,
  StaffShift,
  StaffShiftInput,
} from '@/api/types';

interface SectionState<T> {
  rows: T[];
  loaded: boolean;
  loading: boolean;
  error: string | null;
}

const EMPTY: SectionState<never> = { rows: [], loaded: false, loading: false, error: null };

/** PUT — api has no put() and client.ts is frozen; mirrors the local fetch
 *  helper used in store/supply-chain.ts. */
async function put<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${getToken() ?? ''}`,
    },
    body: JSON.stringify(body),
  });
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    /* non-JSON */
  }
  if (!res.ok) {
    const err = (data as ApiErrorBody | null)?.error;
    throw new ApiError(res.status, err?.code ?? 'HTTP_ERROR', err?.message ?? `Request failed (${res.status})`, err?.retriable, err?.details);
  }
  return data as T;
}

export interface StaffOpsState {
  shifts: SectionState<StaffShift>;
  attendance: SectionState<AttendanceRecord>;
  performance: SectionState<StaffPerformance>;
  commissionRules: SectionState<CommissionRule>;
  approvals: SectionState<ApprovalRequest>;

  hydrateShifts: (from: string, to: string) => Promise<void>;
  hydrateAttendance: (from?: string, to?: string, staffId?: string) => Promise<void>;
  hydratePerformance: (from?: string, to?: string) => Promise<void>;
  hydrateCommissionRules: () => Promise<void>;
  hydrateApprovals: (scope?: 'submitted' | 'inbox' | 'all', status?: string) => Promise<void>;

  createShift: (input: StaffShiftInput) => Promise<{ ok: boolean; id?: string; code?: string; message?: string }>;
  updateShift: (id: string, input: Partial<StaffShiftInput> & { status?: StaffShift['status'] }) => Promise<{ ok: boolean; code?: string; message?: string }>;
  deleteShift: (id: string) => Promise<{ ok: boolean; code?: string; message?: string }>;

  clockIn: () => Promise<{ ok: boolean; code?: string; message?: string }>;
  clockOut: () => Promise<{ ok: boolean; code?: string; message?: string }>;

  saveCommissionRules: (rules: CommissionRuleInput[]) => Promise<{ ok: boolean; code?: string; message?: string }>;

  submitApproval: (input: ApprovalInput) => Promise<{ ok: boolean; id?: string; code?: string; message?: string }>;
  decideApproval: (id: string, body: ApprovalDecisionBody) => Promise<{ ok: boolean; code?: string; message?: string }>;
}

const fail = (e: unknown): { ok: false; code?: string; message?: string } => {
  const err = e as { code?: string; message?: string };
  return { ok: false, code: err.code, message: err.message };
};

export const useStaffOpsStore = create<StaffOpsState>()((set) => {
  const hydrateOne = async <T>(
    key: 'shifts' | 'attendance' | 'performance' | 'commissionRules' | 'approvals',
    fn: () => Promise<T[]>,
  ) => {
    set((s) => ({ [key]: { ...s[key], loading: true, error: null } }) as Partial<StaffOpsState>);
    try {
      const rows = await fn();
      set((s) => ({ [key]: { ...s[key], rows, loaded: true, loading: false } }) as Partial<StaffOpsState>);
    } catch (e) {
      const err = e as { message?: string };
      set((s) => ({ [key]: { ...s[key], loading: false, error: err.message ?? 'load failed' } }) as Partial<StaffOpsState>);
    }
  };

  const qs = (params: Record<string, string | undefined>): string => {
    const parts = Object.entries(params).filter(([, v]) => v !== undefined && v !== '');
    return parts.length ? `?${parts.map(([k, v]) => `${k}=${encodeURIComponent(v!)}`).join('&')}` : '';
  };

  return {
    shifts: { ...EMPTY },
    attendance: { ...EMPTY },
    performance: { ...EMPTY },
    commissionRules: { ...EMPTY },
    approvals: { ...EMPTY },

    hydrateShifts: (from, to) =>
      hydrateOne('shifts', async () => {
        const res = await api.get<{ shifts: StaffShift[] }>(`/staff/shifts?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, { retries: 1 });
        return res.shifts;
      }),

    hydrateAttendance: (from, to, staffId) =>
      hydrateOne('attendance', async () => {
        const res = await api.get<{ records: AttendanceRecord[] }>(`/staff/attendance${qs({ from, to, staffId })}`, { retries: 1 });
        return res.records;
      }),

    hydratePerformance: (from, to) =>
      hydrateOne('performance', async () => {
        const res = await api.get<{ staff: StaffPerformance[] }>(`/staff/performance${qs({ from, to })}`, { retries: 1 });
        return res.staff;
      }),

    hydrateCommissionRules: () =>
      hydrateOne('commissionRules', async () => {
        const res = await api.get<{ rules: CommissionRule[] }>('/staff/commissions', { retries: 1 });
        return res.rules;
      }),

    hydrateApprovals: (scope, status) =>
      hydrateOne('approvals', async () => {
        const res = await api.get<{ approvals: ApprovalRequest[] }>(`/approvals${qs({ scope, status })}`, { retries: 1 });
        return res.approvals;
      }),

    createShift: async (input) => {
      try {
        const shift = await api.post<StaffShift>('/staff/shifts', input, { idempotencyKey: `so:shift:${Date.now()}` });
        set((s) => ({ shifts: { ...s.shifts, rows: [...s.shifts.rows, shift].sort((a, b) => a.startAt - b.startAt) } }));
        return { ok: true, id: shift.id };
      } catch (e) {
        return fail(e);
      }
    },

    updateShift: async (id, input) => {
      try {
        const shift = await api.patch<StaffShift>(`/staff/shifts/${id}`, input, { idempotencyKey: `so:shift:${id}:${Date.now()}` });
        set((s) => ({ shifts: { ...s.shifts, rows: s.shifts.rows.map((r) => (r.id === id ? shift : r)) } }));
        return { ok: true };
      } catch (e) {
        return fail(e);
      }
    },

    deleteShift: async (id) => {
      try {
        await api.delete<never>(`/staff/shifts/${id}`);
        set((s) => ({ shifts: { ...s.shifts, rows: s.shifts.rows.filter((r) => r.id !== id) } }));
        return { ok: true };
      } catch (e) {
        return fail(e);
      }
    },

    clockIn: async () => {
      try {
        const res = await api.post<{ record: AttendanceRecord }>('/staff/attendance/clock-in', {}, { idempotencyKey: `so:clock-in:${Date.now()}` });
        set((s) => ({ attendance: { ...s.attendance, rows: [res.record, ...s.attendance.rows] } }));
        return { ok: true };
      } catch (e) {
        return fail(e);
      }
    },

    clockOut: async () => {
      try {
        const res = await api.post<{ record: AttendanceRecord }>('/staff/attendance/clock-out', {}, { idempotencyKey: `so:clock-out:${Date.now()}` });
        set((s) => ({ attendance: { ...s.attendance, rows: s.attendance.rows.map((r) => (r.id === res.record.id ? res.record : r)) } }));
        return { ok: true };
      } catch (e) {
        return fail(e);
      }
    },

    saveCommissionRules: async (rules) => {
      try {
        const body: CommissionRulesBody = { rules };
        const res = await put<{ rules: CommissionRule[] }>('/staff/commissions', body);
        set({ commissionRules: { rows: res.rules, loaded: true, loading: false, error: null } });
        return { ok: true };
      } catch (e) {
        return fail(e);
      }
    },

    submitApproval: async (input) => {
      try {
        const res = await api.post<{ approval: ApprovalRequest }>('/approvals', input, { idempotencyKey: `so:approval:${Date.now()}` });
        set((s) => ({ approvals: { ...s.approvals, rows: [res.approval, ...s.approvals.rows] } }));
        return { ok: true, id: res.approval.id };
      } catch (e) {
        return fail(e);
      }
    },

    decideApproval: async (id, body) => {
      try {
        const res = await api.post<{ approval: ApprovalRequest }>(`/approvals/${id}/decision`, body, { idempotencyKey: `so:decide:${id}:${Date.now()}` });
        set((s) => ({ approvals: { ...s.approvals, rows: s.approvals.rows.map((r) => (r.id === id ? res.approval : r)) } }));
        return { ok: true };
      } catch (e) {
        return fail(e);
      }
    },
  };
});
