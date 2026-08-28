import { useEffect, useState } from 'react'
import { refreshToken } from '@hudumika/contract'
import { rolePermissions, STAFF_ROLES, type StaffRoleDef } from './roles'

export interface StaffSession {
  userId: string
  phone: string
  displayName: string
  role: string
  permissions: string[]
  mfaVerified: boolean
  expiresAt: number
  accessToken?: string
  refreshToken?: string
  tokenIssuedAt?: number
}

export const SESSION_TTL_MS = 20 * 60 * 1000
export const SESSION_KEY = 'hudumika.staff.session'
export const SESSION_EVENT = 'hudumika.staff.session.change'

function readStoredSession(): StaffSession | null {
  try {
    const raw = window.localStorage.getItem(SESSION_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as StaffSession
    if (!parsed || typeof parsed.expiresAt !== 'number') return null
    return parsed
  } catch {
    return null
  }
}

function emitChange() {
  window.dispatchEvent(new CustomEvent(SESSION_EVENT))
}

export function getSession(): StaffSession | null {
  const session = readStoredSession()
  if (!session) return null
  if (session.expiresAt < Date.now()) {
    clearSession()
    return null
  }
  return session
}

export function setSession(session: StaffSession) {
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
  try {
    const session = getSession()
    if (!session?.refreshToken) return false
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

export function useSession(): StaffSession | null {
  const [session, setSessionState] = useState<StaffSession | null>(() => getSession())

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

interface StaffProfile {
  userId: string
  displayName: string
  role: string
  permissions: string[]
  mfaVerified: boolean
}

const AUDITOR_PROFILE: StaffProfile = {
  userId: 'staff_auditor_003',
  displayName: 'Read-only Auditor',
  role: 'Read-only Auditor',
  permissions: ['audit.read'],
  mfaVerified: true,
}

function staffProfileFor(def: StaffRoleDef, index: number): StaffProfile {
  return {
    userId: `staff_${String(index).padStart(3, '0')}`,
    displayName: def.name,
    role: def.name,
    permissions: rolePermissions(def.id),
    mfaVerified: true,
  }
}

function staffPhoneOf(n: number): string {
  return `+255 700 000 ${String(n).padStart(3, '0')}`
}

const LEGACY_PHONE_ROLES: Array<{ phone: string; roleId: string }> = [
  { phone: '+255 700 000 001', roleId: 'platform-owner' },
  { phone: '+255 700 000 002', roleId: 'operations-manager' },
  { phone: '+255 700 000 003', roleId: 'read-only-auditor' },
]

const STAFF_REGISTRY: Record<string, StaffProfile> = (() => {
  const registry: Record<string, StaffProfile> = {}
  const legacyRoleIds = new Set(LEGACY_PHONE_ROLES.map((entry) => entry.roleId))
  let index = 0
  for (const { phone, roleId } of LEGACY_PHONE_ROLES) {
    const def = STAFF_ROLES.find((r) => r.id === roleId)
    if (!def) continue
    registry[phone] = staffProfileFor(def, ++index)
  }
  for (const def of STAFF_ROLES) {
    if (legacyRoleIds.has(def.id)) continue
    registry[staffPhoneOf(index + 1)] = staffProfileFor(def, ++index)
  }
  return registry
})()

export function makeMockStaffProfile(phone: string): StaffSession {
  const profile = STAFF_REGISTRY[phone] ?? AUDITOR_PROFILE
  return { ...profile, phone, expiresAt: Date.now() + SESSION_TTL_MS }
}

export function seedStaffSession(overrides?: Partial<StaffSession>) {
  setSession({
    userId: 'staff_seed_001',
    phone: '+255 700 000 001',
    displayName: 'Platform Administrator',
    role: 'Platform Administrator',
    permissions: ['*'],
    mfaVerified: true,
    expiresAt: Date.now() + SESSION_TTL_MS,
    ...overrides,
  })
}
