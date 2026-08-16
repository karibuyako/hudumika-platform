/* Print-job queue (contract /print-jobs, /print-jobs/{printJobId}) — P6d.
 * The queue is server-tracked; the store keeps the local projection for the
 * queue screen and re-queues retries as fresh jobs (the contract has no
 * retry endpoint — a retry is a new POST with the same payload).
 * Print-failure contract (STAFF-AND-DEVICES.md §54/§59): DEVICE_OFFLINE and
 * PRINT_QUEUE_FULL codes are surfaced so the screen can offer queue-until-
 * online / fallback / retry-with-backoff dialogs.
 */
import { create } from 'zustand';

import { api, ApiError } from '@/api/client';
import type { PrintJob, PrintJobCreate } from '@/api/types';

export interface PrintJobError {
  code: string;
  message: string;
  retryAfterSeconds?: number;
  details?: Record<string, unknown>;
}

interface PrintJobsState {
  jobs: PrintJob[];
  loading: boolean;
  error: string | null;
  lastError: PrintJobError | null;
  hydrate: () => Promise<void>;
  createJob: (input: PrintJobCreate) => Promise<PrintJob | null>;
  retryJob: (job: PrintJob) => Promise<PrintJob | null>;
  clearError: () => void;
}

export const usePrintJobsStore = create<PrintJobsState>()((set, get) => ({
  jobs: [],
  loading: false,
  error: null,
  lastError: null,

  hydrate: async () => {
    set({ loading: true, error: null });
    try {
      const res = await api.get<PrintJob[]>('/print-jobs', { retries: 1 });
      set({ jobs: res, loading: false });
    } catch (e) {
      set({ loading: false, error: e instanceof ApiError ? e.message : 'Failed to load print jobs' });
    }
  },

  createJob: async (input) => {
    set({ lastError: null });
    try {
      const res = await api.post<PrintJob>('/print-jobs', input);
      set((s) => ({ jobs: [res, ...s.jobs] }));
      return res;
    } catch (e) {
      const err = e as { code?: string; message?: string; details?: Record<string, unknown> };
      set({
        error: err.message ?? 'Failed to queue print job',
        lastError: { code: err.code ?? 'PRINT_JOB_FAILED', message: err.message ?? 'Failed to queue print job', details: err.details },
      });
      return null;
    }
  },

  retryJob: async (job) => {
    const input: PrintJobCreate = {
      jobType: job.jobType,
      orderIds: job.orderIds,
      tableId: job.tableId,
      deviceId: job.deviceId,
      copies: job.copies,
      label: job.label,
    };
    return get().createJob(input);
  },

  clearError: () => set({ lastError: null, error: null }),
}));
