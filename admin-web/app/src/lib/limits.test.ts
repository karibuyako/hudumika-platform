import { describe, expect, it, vi, beforeEach } from 'vitest'

const mockAdminGetLimits = vi.fn()

vi.mock('@hudumika/contract', () => ({
  adminGetLimits: (...args: unknown[]) => mockAdminGetLimits(...args),
}))

async function loadLimitsModule() {
  vi.resetModules()
  const limits = await import('./limits')
  return { mockGetLimits: mockAdminGetLimits, limits }
}

describe('limits', () => {
  beforeEach(() => {
    mockAdminGetLimits.mockReset()
  })

  it('returns defaults when no data loaded', async () => {
    const { limits } = await loadLimitsModule()
    const result = limits.getLimits()
    expect(result.twoPersonThresholdTzs).toBe(5_000_000)
    expect(result.maxRefundAmountTzs).toBe(10_000_000)
    expect(result.maxExportRows).toBe(10000)
    expect(result.sessionTimeoutMinutes).toBe(60)
    expect(result.maxLoginAttempts).toBe(5)
    expect(result.rateLimitPerMinute).toBe(100)
  })

  it('getLimits returns cached values after loadLimits', async () => {
    const { mockGetLimits, limits } = await loadLimitsModule()
    mockGetLimits.mockResolvedValue({
      status: 200,
      data: {
        twoPersonThresholdTzs: 10_000_000,
        maxRefundAmountTzs: 20_000_000,
      },
      headers: new Headers(),
    })

    await limits.loadLimits()
    const result = limits.getLimits()
    expect(result.twoPersonThresholdTzs).toBe(10_000_000)
    expect(result.maxRefundAmountTzs).toBe(20_000_000)
    expect(result.rateLimitPerMinute).toBe(100)
    expect(result.maxExportRows).toBe(10000)
  })

  it('falls back to defaults on API error', async () => {
    const { mockGetLimits, limits } = await loadLimitsModule()
    mockGetLimits.mockRejectedValue(new Error('network'))

    await limits.loadLimits()
    expect(limits.getLimits().twoPersonThresholdTzs).toBe(5_000_000)
    expect(limits.getLimits().maxRefundAmountTzs).toBe(10_000_000)
  })

  it('falls back to defaults on non-200 status', async () => {
    const { mockGetLimits, limits } = await loadLimitsModule()
    mockGetLimits.mockResolvedValue({
      status: 500,
      data: {},
      headers: new Headers(),
    })

    await limits.loadLimits()
    expect(limits.getLimits().twoPersonThresholdTzs).toBe(5_000_000)
  })

  it('merges partial data with defaults', async () => {
    const { mockGetLimits, limits } = await loadLimitsModule()
    mockGetLimits.mockResolvedValue({
      status: 200,
      data: {
        maxLoginAttempts: 10,
      },
      headers: new Headers(),
    })

    await limits.loadLimits()
    const result = limits.getLimits()
    expect(result.maxLoginAttempts).toBe(10)
    expect(result.twoPersonThresholdTzs).toBe(5_000_000)
    expect(result.rateLimitPerMinute).toBe(100)
  })
})
