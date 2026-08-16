import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.unstubAllEnvs()
})

async function loadApiBase() {
  vi.resetModules()
  return import('./api-base')
}

describe('API_BASE', () => {
  it('defaults to empty string when VITE_ADMIN_API_URL is unset', async () => {
    const { API_BASE } = await loadApiBase()
    expect(API_BASE).toBe('')
  })

  it('reflects the configured override with trailing slash stripped', async () => {
    vi.stubEnv('VITE_ADMIN_API_URL', 'https://api.hudumika.co.tz/api/v1/')
    const { API_BASE } = await loadApiBase()
    expect(API_BASE).toBe('https://api.hudumika.co.tz/api/v1')
  })
})

describe('withApiBase', () => {
  it('returns the relative path untouched when API_BASE is empty (same-origin)', async () => {
    const { withApiBase } = await loadApiBase()
    expect(withApiBase('/admin/orders')).toBe('/admin/orders')
  })

  it('prefixes the path when API_BASE is set', async () => {
    vi.stubEnv('VITE_ADMIN_API_URL', 'https://api.hudumika.co.tz/api/v1')
    const { withApiBase } = await loadApiBase()
    expect(withApiBase('/admin/orders')).toBe('https://api.hudumika.co.tz/api/v1/admin/orders')
  })
})
