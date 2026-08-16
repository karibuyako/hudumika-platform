import { create } from 'zustand';

import { api, ApiError, getToken } from '@/api/client';
import type {
  ApiErrorBody,
  Catalogue,
  CatalogueBulkResult,
  CatalogueExportResult,
  CatalogueImportResult,
  CatalogueItemDto,
} from '@/api/types';

/** PUT — api has no put() and client.ts is frozen; mirrors the local fetch
 *  helper used in store/loyalty.ts / store/notifications-settings.ts. */
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
    const retryAfter = res.headers.get('retry-after');
    throw new ApiError(
      res.status,
      err?.code ?? 'HTTP_ERROR',
      err?.message ?? `Request failed (${res.status})`,
      err?.retriable,
      err?.details,
      undefined,
      retryAfter ? Number(retryAfter) || undefined : undefined,
    );
  }
  return data as T;
}

/** Contract POST /catalogues/import + /catalogue-items/bulk responses carry an
 *  app-extension `failures` list for per-row error summaries (see types.ts). */
export interface ImportFailure {
  row: number;
  reason: string;
}
export interface BulkFailure {
  index: number;
  reason: string;
}

/** Structured publish outcome — the screen renders per-state banners:
 *  success (new publishedAt), 422 validation list, 409 ORDER_PRICE_CHANGED
 *  item list, 429 retry-after. */
export type PublishOutcome =
  | { ok: true; catalogue: Catalogue }
  | {
      ok: false;
      code?: string;
      message: string;
      details?: Record<string, unknown>;
      retryAfterSeconds?: number;
    };

function errOutcome(e: unknown, fallback: string): Extract<PublishOutcome, { ok: false }> {
  if (e instanceof ApiError) {
    return { ok: false, code: e.code, message: e.message, details: e.details, retryAfterSeconds: e.retryAfterSeconds };
  }
  return { ok: false, message: fallback };
}

interface CataloguesState {
  catalogue: Catalogue | null;
  loading: boolean;
  error: string | null;
  publishError: string | null;
  hydrate: () => Promise<void>;
  publish: (items: CatalogueItemDto[]) => Promise<PublishOutcome>;
  exportCatalogue: () => Promise<CatalogueExportResult | null>;
  bulkUpsert: (items: CatalogueItemDto[], overwritePrices?: boolean) => Promise<(CatalogueBulkResult & { failures?: { index: number; reason: string }[] }) | null>;
  importRows: (rows: { name: string; priceTZS: number; category: string; description?: string; quantity?: number }[]) => Promise<CatalogueImportResult | null>;
}

export const useCataloguesStore = create<CataloguesState>()((set, get) => ({
  catalogue: null,
  loading: false,
  error: null,
  publishError: null,

  hydrate: async () => {
    set({ loading: true, error: null });
    try {
      const catalogue = await api.get<Catalogue>('/catalogues/me', { retries: 1 });
      set({ catalogue, loading: false });
    } catch (e) {
      set({ loading: false, error: e instanceof ApiError ? e.message : 'Failed to load catalogue' });
    }
  },

  publish: async (items) => {
    set({ publishError: null });
    try {
      const res = await put<Catalogue>('/catalogues/me', { merchantId: get().catalogue?.merchantId ?? 'm_demo', items });
      set({ catalogue: res, error: null });
      return { ok: true, catalogue: res };
    } catch (e) {
      const outcome = errOutcome(e, 'Failed to publish catalogue');
      set({ publishError: outcome.message });
      return outcome;
    }
  },

  exportCatalogue: async () => {
    try {
      const res = await api.get<CatalogueExportResult>('/catalogues/export', { retries: 1 });
      set({ error: null });
      return res;
    } catch (e) {
      set({ error: e instanceof ApiError ? e.message : 'Failed to export catalogue' });
      return null;
    }
  },

  bulkUpsert: async (items, overwritePrices) => {
    try {
      const res = await api.post<CatalogueBulkResult & { failures?: { index: number; reason: string }[] }>(
        '/catalogue-items/bulk',
        { items, overwritePrices: overwritePrices === true },
        { idempotencyKey: `cat:bulk:${Date.now()}` },
      );
      set({ error: null });
      return res;
    } catch (e) {
      set({ error: e instanceof ApiError ? e.message : 'Bulk update failed' });
      return null;
    }
  },

  importRows: async (rows) => {
    try {
      const res = await api.post<CatalogueImportResult>('/catalogues/import', { rows }, { idempotencyKey: `cat:import:${Date.now()}` });
      set({ error: null });
      return res;
    } catch (e) {
      set({ error: e instanceof ApiError ? e.message : 'Import failed' });
      return null;
    }
  },
}));
