import { create } from 'zustand';

import { api } from '@/api/client';
import type {
  CustomerJourney,
  CustomerJourneyInput,
  DataExportJob,
  DataExportRequest,
  PrivacyExportResult,
  ScheduledReport,
  ScheduledReportInput,
  UpdateScheduledReportBody,
} from '@/api/types';
import { uid } from '@/lib/format';

interface ReportsState {
  reports: ScheduledReport[];
  journeys: CustomerJourney[];
  dataExports: DataExportJob[];
  loaded: boolean;
  error: string | null;
  hydrate: () => Promise<void>;
  createReport: (input: ScheduledReportInput) => Promise<{ ok: boolean; code?: string; message?: string }>;
  updateReport: (id: string, patch: UpdateScheduledReportBody) => Promise<{ ok: boolean; code?: string; message?: string }>;
  deleteReport: (id: string) => Promise<{ ok: boolean; code?: string; message?: string }>;
  createJourney: (input: CustomerJourneyInput) => Promise<{ ok: boolean; code?: string; message?: string }>;
  updateJourney: (id: string, status: CustomerJourney['status']) => Promise<{ ok: boolean; code?: string; message?: string }>;
  createDataExport: (input: DataExportRequest) => Promise<{ ok: boolean; code?: string; message?: string }>;
  requestPrivacyExport: () => Promise<{ ok: boolean; code?: string; message?: string }>;
}

export const useReportsStore = create<ReportsState>()((set, get) => ({
  reports: [],
  journeys: [],
  dataExports: [],
  loaded: false,
  error: null,

  hydrate: async () => {
    try {
      const [reports, journeys, dataExports] = await Promise.all([
        api.get<ScheduledReport[]>('/reports', { retries: 1 }),
        api.get<CustomerJourney[]>('/journeys', { retries: 1 }),
        api.get<DataExportJob[]>('/data/exports', { retries: 1 }),
      ]);
      set({ reports, journeys, dataExports, loaded: true, error: null });
    } catch (e) {
      const err = e as { code?: string; message?: string };
      set({ error: err.message ?? null, loaded: true });
    }
  },

  createReport: async (input) => {
    try {
      await api.post<ScheduledReport>('/reports', input, { idempotencyKey: `report:${uid()}` });
      await get().hydrate();
      return { ok: true };
    } catch (e) {
      const err = e as { code?: string; message?: string };
      return { ok: false, code: err.code, message: err.message };
    }
  },

  updateReport: async (id, patch) => {
    try {
      await api.patch<ScheduledReport>(`/reports/${id}`, patch, { idempotencyKey: `report:${id}:${Date.now()}` });
      await get().hydrate();
      return { ok: true };
    } catch (e) {
      const err = e as { code?: string; message?: string };
      return { ok: false, code: err.code, message: err.message };
    }
  },

  deleteReport: async (id) => {
    try {
      await api.delete<never>(`/reports/${id}`);
      await get().hydrate();
      return { ok: true };
    } catch (e) {
      const err = e as { code?: string; message?: string };
      return { ok: false, code: err.code, message: err.message };
    }
  },

  createJourney: async (input) => {
    try {
      await api.post<CustomerJourney>('/journeys', input, { idempotencyKey: `journey:${uid()}` });
      await get().hydrate();
      return { ok: true };
    } catch (e) {
      const err = e as { code?: string; message?: string };
      return { ok: false, code: err.code, message: err.message };
    }
  },

  updateJourney: async (id, status) => {
    try {
      await api.patch<CustomerJourney>(`/journeys/${id}`, { status }, { idempotencyKey: `journey:${id}:${Date.now()}` });
      await get().hydrate();
      return { ok: true };
    } catch (e) {
      const err = e as { code?: string; message?: string };
      return { ok: false, code: err.code, message: err.message };
    }
  },

  createDataExport: async (input) => {
    try {
      await api.post<DataExportJob>('/data/exports', input, { idempotencyKey: `dex:${uid()}` });
      await get().hydrate();
      return { ok: true };
    } catch (e) {
      const err = e as { code?: string; message?: string };
      return { ok: false, code: err.code, message: err.message };
    }
  },

  requestPrivacyExport: async () => {
    try {
      await api.post<PrivacyExportResult>('/privacy/export', {}, { idempotencyKey: `pex:${Date.now()}` });
      return { ok: true };
    } catch (e) {
      const err = e as { code?: string; message?: string };
      return { ok: false, code: err.code, message: err.message };
    }
  },
}));
