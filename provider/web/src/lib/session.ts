import { useEffect, useState } from 'react'

export interface ProviderSession {
  userId: string
  phone: string
  displayName: string
  role: string
  permissions?: string[]
  mfaVerified?: boolean
  expiresAt: number
  accessToken?: string
  refreshToken?: string
  tokenIssuedAt?: number
}

export const SESSION_TTL_MS = 20 * 60 * 1000
export const SESSION_KEY = 'hudumika.provider.session'
export const SESSION_EVENT = 'hudumika.provider.session.change'

function readStoredSession(): ProviderSession | null {
  try {
    const raw = window.localStorage.getItem(SESSION_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as ProviderSession
    if (!parsed || typeof parsed.expiresAt !== 'number') return null
    return parsed
  } catch {
    return null
  }
}

function emitChange() {
  window.dispatchEvent(new CustomEvent(SESSION_EVENT))
}

export function getSession(): ProviderSession | null {
  const session = readStoredSession()
  if (!session) return null
  if (session.expiresAt < Date.now()) {
    clearSession()
    return null
  }
  return session
}

export function setSession(session: ProviderSession) {
  window.localStorage.setItem(SESSION_KEY, JSON.stringify(session))
  emitChange()
}

export function clearSession() {
  window.localStorage.removeItem(SESSION_KEY)
  emitChange()
}

export function refreshSession() {
  const session = getSession()
  if (!session) return
  setSession({ ...session, expiresAt: Date.now() + SESSION_TTL_MS })
}

export function sessionAccessToken(): string | null {
  return getSession()?.accessToken ?? null
}

export async function refreshAccessToken(): Promise<boolean> {
  // Minimal stub: provider portal uses same contract refresh endpoint when available.
  // If no refreshToken, keep session alive via TTL bump for mock mode.
  try {
    const session = getSession()
    if (!session?.refreshToken) return false
    const { refreshToken } = await import('@hudumika/contract')
    const res = await refreshToken({ refreshToken: session.refreshToken })
    if (res.status !== 200) {
      clearSession()
      return false
    }
    setSession({
      ...session,
      accessToken: res.data.accessToken,
      refreshToken: res.data.refreshToken,
      tokenIssuedAt: Date.now(),
      expiresAt: Date.now() + SESSION_TTL_MS,
    })
    return true
  } catch {
    return false
  }
}

export function useSession(): ProviderSession | null {
  const [session, setSessionState] = useState<ProviderSession | null>(() => getSession())

  useEffect(() => {
    const sync = () => setSessionState(getSession())
    const onFocus = () => setSessionState(getSession())
    window.addEventListener(SESSION_EVENT, sync)
    window.addEventListener('focus', onFocus)
    return () => {
      window.removeEventListener(SESSION_EVENT, sync)
      window.removeEventListener('focus', onFocus)
    }
  }, [])

  return session
}

export function makeMockProviderProfile(phone: string): ProviderSession {
  const suffix = phone.slice(-3) || '001'
  return {
    userId: `provider_${suffix}`,
    phone,
    displayName: `Provider ${suffix}`,
    role: 'Provider',
    permissions: ['bookings.read', 'bookings.manage', 'catalogue.manage', 'earnings.read'],
    mfaVerified: true,
    expiresAt: Date.now() + SESSION_TTL_MS,
  }
}

export function seedProviderSession(overrides?: Partial<ProviderSession>) {
  setSession({
    userId: 'provider_seed_001',
    phone: '+255 700 000 101',
    displayName: 'Demo Provider',
    role: 'Provider',
    permissions: ['bookings.read', 'bookings.manage', 'catalogue.manage', 'earnings.read'],
    mfaVerified: true,
    expiresAt: Date.now() + SESSION_TTL_MS,
    ...overrides,
  })
}
