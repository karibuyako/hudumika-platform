import { adminGetLimits, type PlatformLimits } from '@hudumika/contract'

const DEFAULTS: PlatformLimits = {
  twoPersonThresholdTzs: 5_000_000,
  maxRefundAmountTzs: 10_000_000,
  maxExportRows: 10000,
  sessionTimeoutMinutes: 60,
  maxLoginAttempts: 5,
  rateLimitPerMinute: 100,
}

let cached: PlatformLimits | null = null

export async function loadLimits(): Promise<PlatformLimits> {
  try {
    const res = await adminGetLimits()
    if (res.status === 200) {
      cached = { ...DEFAULTS, ...res.data }
      return cached
    }
  } catch {
    // fall through to defaults
  }
  return DEFAULTS
}

export function getLimits(): PlatformLimits {
  return cached || DEFAULTS
}
