/**
 * Live-API base override for the admin web.
 *
 * The generated contract client (@hudumika/contract) uses RELATIVE paths —
 * e.g. getAdminListOrdersUrl() returns `/admin/orders` — and has no
 * base-url injection point. Per docs/API-BASE-CONVENTION.md the live API is
 * injected via VITE_ADMIN_API_URL when the API is NOT same-origin (Railway
 * prod `https://hudumika-api-production.up.railway.app/api/v1`).
 *
 * This module both exposes `withApiBase(path)` for manual fetch calls and
 * patches `globalThis.fetch` via `installApiBaseFetch()` so the generated
 * contract client automatically prefixes the live base without codegen changes.
 */
export const API_BASE = (import.meta.env.VITE_ADMIN_API_URL ?? '').replace(/\/$/, '')

/** Prefix `path` with API_BASE when set; otherwise return `path` untouched. */
export function withApiBase(path: string): string {
  return API_BASE ? `${API_BASE}${path}` : path
}

/** Patch global fetch to prepend API_BASE for relative contract URLs. */
export function installApiBaseFetch(): void {
  if (typeof window === 'undefined') return
  const w = window as unknown as Record<string, unknown>
  if (w.__hudumikaFetchInstalled) return
  w.__hudumikaFetchInstalled = true
  const originalFetch = window.fetch.bind(window)
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (!API_BASE) return originalFetch(input as RequestInfo, init)
    let url: string | null = null
    if (typeof input === 'string') url = input
    else if (input instanceof Request) url = input.url
    else if (input instanceof URL) url = input.pathname + input.search + input.hash

    // Only prefix bare relative paths like `/admin/...` or `/auth/...`
    if (url && url.startsWith('/') && !url.startsWith('//')) {
      const prefixed = `${API_BASE}${url}`
      if (typeof input === 'string') return originalFetch(prefixed, init)
      if (input instanceof Request) return originalFetch(new Request(prefixed, input), init)
      return originalFetch(prefixed, init)
    }
    return originalFetch(input as RequestInfo, init)
  }) as typeof fetch
}
