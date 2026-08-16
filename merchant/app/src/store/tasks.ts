import { create } from 'zustand';

import { api } from '@/api/client';
import type { ActivitySubmission, SetupStep, SubmitActivityBody, TaskDto, TaskItem, TaskStatus, UpdateTaskStatusBody } from '@/api/types';
import type { Task } from '@/types';

interface TaskState {
  /* Legacy dashboard task list (GET /tasks → {tasks}, ops.ts) — kept for the
   * analytics widget; contract work lives in the P8b fields below. */
  tasks: Task[];
  hydrate: () => Promise<void>;
  complete: (id: string) => Promise<void>;
  /* P8b tasks center (contract /tasks/*) */
  taskItems: TaskItem[];
  detail: TaskItem | null;
  anomalies: TaskItem[];
  violations: TaskItem[];
  activities: ActivitySubmission[];
  setupGuide: SetupStep[];
  loaded: boolean;
  error: string | null;
  hydrateTasks: () => Promise<void>;
  getTask: (id: string) => Promise<void>;
  updateStatus: (id: string, body: UpdateTaskStatusBody) => Promise<{ ok: boolean; code?: string; message?: string }>;
  hydrateAnomalies: () => Promise<void>;
  hydrateViolations: () => Promise<void>;
  hydrateActivities: () => Promise<void>;
  submitActivity: (input: SubmitActivityBody) => Promise<{ ok: boolean; code?: string; message?: string }>;
  hydrateSetupGuide: () => Promise<void>;
  completeStep: (stepId: string) => Promise<{ ok: boolean; code?: string; message?: string }>;
}

export const useTaskStore = create<TaskState>()((set, get) => ({
  tasks: [],

  hydrate: async () => {
    try {
      const res = await api.get<{ tasks: TaskDto[] }>('/tasks', { retries: 1 });
      set({ tasks: res.tasks });
    } catch {
      /* keep stale */
    }
  },

  complete: async (id) => {
    try {
      const res = await api.post<{ task: Task }>(`/tasks/${id}/complete`, {}, { idempotencyKey: `task:${id}:${Date.now()}` });
      set((s) => ({ tasks: s.tasks.map((t) => (t.id === id ? res.task : t)) }));
    } catch {
      /* keep stale */
    }
  },

  /* ---- P8b tasks center ---- */

  taskItems: [],
  detail: null,
  anomalies: [],
  violations: [],
  activities: [],
  setupGuide: [],
  loaded: false,
  error: null,

  hydrateTasks: async () => {
    try {
      const [anomalies, violations, activities] = await Promise.all([
        api.get<TaskItem[]>('/tasks/anomalies', { retries: 1 }),
        api.get<TaskItem[]>('/tasks/violations', { retries: 1 }),
        api.get<ActivitySubmission[]>('/tasks/activities', { retries: 1 }),
      ]);
      set({
        taskItems: [...anomalies, ...violations],
        anomalies,
        violations,
        activities,
        loaded: true,
        error: null,
      });
    } catch (e) {
      const err = e as { code?: string; message?: string };
      set({ loaded: true, error: err.message ?? null });
    }
  },

  getTask: async (id) => {
    try {
      const detail = await api.get<TaskItem>(`/tasks/${id}`, { retries: 1 });
      set({ detail, error: null });
    } catch (e) {
      const err = e as { code?: string; message?: string };
      set({ error: err.message ?? null });
    }
  },

  updateStatus: async (id, body) => {
    try {
      const updated = await api.patch<TaskItem>(`/tasks/${id}`, body, { idempotencyKey: `task:${id}:${Date.now()}` });
      set((s) => ({
        detail: s.detail?.id === id ? updated : s.detail,
        taskItems: s.taskItems.map((t) => (t.id === id ? updated : t)),
        anomalies: s.anomalies.map((t) => (t.id === id ? updated : t)),
        violations: s.violations.map((t) => (t.id === id ? updated : t)),
      }));
      return { ok: true };
    } catch (e) {
      const err = e as { code?: string; message?: string };
      return { ok: false, code: err.code, message: err.message };
    }
  },

  hydrateAnomalies: async () => {
    try {
      const anomalies = await api.get<TaskItem[]>('/tasks/anomalies', { retries: 1 });
      set({ anomalies, error: null });
    } catch (e) {
      const err = e as { code?: string; message?: string };
      set({ error: err.message ?? null });
    }
  },

  hydrateViolations: async () => {
    try {
      const violations = await api.get<TaskItem[]>('/tasks/violations', { retries: 1 });
      set({ violations, error: null });
    } catch (e) {
      const err = e as { code?: string; message?: string };
      set({ error: err.message ?? null });
    }
  },

  hydrateActivities: async () => {
    try {
      const activities = await api.get<ActivitySubmission[]>('/tasks/activities', { retries: 1 });
      set({ activities, error: null });
    } catch (e) {
      const err = e as { code?: string; message?: string };
      set({ error: err.message ?? null });
    }
  },

  submitActivity: async (input) => {
    try {
      await api.post<ActivitySubmission>('/tasks/activities', input, { idempotencyKey: `act:${input.platformEventId}:${Date.now()}` });
      await get().hydrateActivities();
      return { ok: true };
    } catch (e) {
      const err = e as { code?: string; message?: string };
      return { ok: false, code: err.code, message: err.message };
    }
  },

  hydrateSetupGuide: async () => {
    try {
      const setupGuide = await api.get<SetupStep[]>('/tasks/setup-guide', { retries: 1 });
      set({ setupGuide, error: null });
    } catch (e) {
      const err = e as { code?: string; message?: string };
      set({ error: err.message ?? null });
    }
  },

  completeStep: async (stepId) => {
    try {
      const setupGuide = await api.post<SetupStep[]>(`/tasks/setup-guide/${stepId}/complete`, {}, { idempotencyKey: `step:${stepId}:${Date.now()}` });
      set({ setupGuide });
      return { ok: true };
    } catch (e) {
      const err = e as { code?: string; message?: string };
      return { ok: false, code: err.code, message: err.message };
    }
  },
}));

export type { TaskStatus };
