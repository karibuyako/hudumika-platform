/**
 * Live-API base override for the provider web.
 *
 * The generated contract client (@hudumika/contract) uses RELATIVE paths —
 * e.g. getProviderListBookingsUrl() returns `/provider/bookings` — and has no
 * base-url injection point. Per docs/API-BASE-CONVENTION.md, web apps keep
 * API_BASE = origin: the same-origin gateway at the ops hostname terminates
 * `/api/v1` and proxies the relative path to the Go service.
 *
 * VITE_PROVIDER_API_URL is reserved for the live-API flip (injected per
 * environment) when the API is NOT same-origin. Nothing consumes API_BASE yet
 * — it documents the convention; callers compose `${API_BASE}${path}` only when
 * it is set.
 */
export const API_BASE = (import.meta.env.VITE_PROVIDER_API_URL ?? '').replace(/\/$/, '')

/** Prefix `path` with API_BASE when set; otherwise return `path` untouched. */
export function withApiBase(path: string): string {
  return API_BASE ? `${API_BASE}${path}` : path
}
