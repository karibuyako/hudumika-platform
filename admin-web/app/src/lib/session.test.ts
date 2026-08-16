import { beforeEach, describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { getRefreshTokenUrl } from '@hudumika/contract'
import { can, roleHasPermission } from './permissions'
import { allPermissionKeys, rolePermissions, STAFF_ROLES } from './roles'
import {
  clearSession,
  getSession,
  makeMockStaffProfile,
  refreshAccessToken,
  seedStaffSession,
  sessionAccessToken,
  SESSION_KEY,
  SESSION_TTL_MS,
  setSession,
  type StaffSession,
} from './session'
import { server } from '../test/setup'

const base: StaffSession = {
  userId: 'u_1',
  phone: '+255 700 000 001',
  displayName: 'Platform Owner',
  role: 'Platform Owner',
  permissions: ['*'],
  mfaVerified: true,
  expiresAt: Date.now() + SESSION_TTL_MS,
}

describe('session store', () => {
  beforeEach(() => {
    clearSession()
  })

  it('round-trips set/get/clear', () => {
    expect(getSession()).toBeNull()
    setSession(base)
    expect(getSession()).toEqual(base)
    clearSession()
    expect(getSession()).toBeNull()
    expect(localStorage.getItem(SESSION_KEY)).toBeNull()
  })

  it('sessionAccessToken returns null with no session', () => {
    expect(sessionAccessToken()).toBeNull()
  })

  it('returns null and clears when the session is expired', () => {
    setSession({ ...base, expiresAt: Date.now() - 1 })
    expect(getSession()).toBeNull()
    expect(localStorage.getItem(SESSION_KEY)).toBeNull()
  })

  it('ignores corrupted payloads', () => {
    localStorage.setItem(SESSION_KEY, 'not-json')
    expect(getSession()).toBeNull()
  })
})

describe('refreshAccessToken', () => {
  beforeEach(() => {
    clearSession()
  })

  it('returns false when no refreshToken is stored', async () => {
    setSession({ ...base })
    await expect(refreshAccessToken()).resolves.toBe(false)
    expect(getSession()).not.toBeNull()
    expect(localStorage.getItem(SESSION_KEY)).not.toBeNull()
  })

  it('calls the contract and updates the stored session on 200', async () => {
    setSession({
      ...base,
      accessToken: 'at_old',
      refreshToken: 'rt_old',
      tokenIssuedAt: Date.now() - 11 * 60 * 1000,
    })
    let body: Record<string, unknown> | null = null
    server.use(
      http.post(getRefreshTokenUrl(), async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>
        return HttpResponse.json({
          accessToken: 'at_new',
          refreshToken: 'rt_new',
          user: { id: 'user_1', phone: '+255 700 000 001', roles: [], createdAt: '2026-01-01T00:00:00.000Z' },
        })
      }),
    )
    const before = getSession()?.expiresAt ?? 0
    await expect(refreshAccessToken()).resolves.toBe(true)
    const stored = JSON.parse(localStorage.getItem(SESSION_KEY) ?? 'null') as StaffSession
    expect(getRefreshTokenUrl()).toBe('/auth/refresh')
    expect(body).toEqual({ refreshToken: 'rt_old' })
    expect(stored.accessToken).toBe('at_new')
    expect(stored.refreshToken).toBe('rt_new')
    expect(stored.expiresAt).toBeGreaterThan(before)
    expect(sessionAccessToken()).toBe('at_new')
  })

  it('returns false and clears the session on 401', async () => {
    setSession({ ...base, accessToken: 'at_old', refreshToken: 'rt_old' })
    server.use(
      http.post(getRefreshTokenUrl(), () =>
        HttpResponse.json(
          { code: 'INVALID_REFRESH_TOKEN', message: 'Session expired', requestId: 'req_9' },
          { status: 401 },
        ),
      ),
    )
    await expect(refreshAccessToken()).resolves.toBe(false)
    expect(getSession()).toBeNull()
    expect(localStorage.getItem(SESSION_KEY)).toBeNull()
  })
})

describe('seedStaffSession', () => {
  beforeEach(() => {
    clearSession()
  })

  it('seeds a full-permission staff session by default', () => {
    seedStaffSession()
    const session = getSession()
    expect(session?.role).toBe('Platform Administrator')
    expect(session?.permissions).toContain('*')
    expect(session?.mfaVerified).toBe(true)
    expect(session && session.expiresAt).toBeGreaterThan(Date.now())
  })

  it('merges overrides', () => {
    seedStaffSession({ role: 'Ops', permissions: ['dispatch.assign'] })
    const session = getSession()
    expect(session?.role).toBe('Ops')
    expect(session?.permissions).toEqual(['dispatch.assign'])
  })
})

describe('makeMockStaffProfile', () => {
  it('maps the owner phone to a wildcard-permission session', () => {
    const session = makeMockStaffProfile('+255 700 000 001')
    expect(session.role).toBe('Platform Owner')
    expect(session.permissions).toContain('*')
    expect(session.mfaVerified).toBe(true)
    expect(session.phone).toBe('+255 700 000 001')
  })

  it('falls back to the read-only auditor for unknown phones', () => {
    const session = makeMockStaffProfile('+255 999 000 000')
    expect(session.role).toBe('Read-only Auditor')
    expect(session.permissions).toEqual(['audit.read'])
  })
})

describe('can()', () => {
  it('is false without a session', () => {
    expect(can(null, 'order.read')).toBe(false)
    expect(can(undefined, 'order.read')).toBe(false)
  })

  it('grants everything when permissions include the wildcard', () => {
    expect(can(base, 'order.read')).toBe(true)
    expect(can(base, 'whatever.else')).toBe(true)
  })

  it('matches exact permission strings', () => {
    const ops: StaffSession = { ...base, permissions: ['dispatch.assign', 'audit.read'] }
    expect(can(ops, 'dispatch.assign')).toBe(true)
    expect(can(ops, 'audit.read')).toBe(true)
    expect(can(ops, 'dispatch.reassign')).toBe(false)
    expect(can(ops, 'merchant.approve')).toBe(false)
  })
})

describe('20-role staff registry', () => {
  it('defines twenty roles', () => {
    expect(STAFF_ROLES).toHaveLength(20)
  })

  it('resolves every role phone to its role name', () => {
    const expectations: Array<[string, string]> = [
      ['+255 700 000 001', 'Platform Owner'],
      ['+255 700 000 002', 'Operations Manager'],
      ['+255 700 000 003', 'Read-only Auditor'],
      ['+255 700 000 004', 'Platform Administrator'],
      ['+255 700 000 005', 'Dispatch Manager'],
      ['+255 700 000 006', 'Regional Operations Manager'],
      ['+255 700 000 007', 'Merchant Operations'],
      ['+255 700 000 008', 'Provider Operations'],
      ['+255 700 000 009', 'Rider Operations'],
      ['+255 700 000 010', 'Customer Support'],
      ['+255 700 000 011', 'Finance'],
      ['+255 700 000 012', 'Payments'],
      ['+255 700 000 013', 'Risk & Fraud'],
      ['+255 700 000 014', 'Trust & Safety'],
      ['+255 700 000 015', 'Compliance'],
      ['+255 700 000 016', 'Marketing'],
      ['+255 700 000 017', 'Analytics'],
      ['+255 700 000 018', 'Content Manager'],
      ['+255 700 000 019', 'Technical Operations'],
      ['+255 700 000 020', 'Security Administrator'],
    ]
    for (const [phone, roleName] of expectations) {
      expect(makeMockStaffProfile(phone).role).toBe(roleName)
      expect(makeMockStaffProfile(phone).mfaVerified).toBe(true)
    }
  })

  it('maps the legacy phones to their historic roles', () => {
    expect(makeMockStaffProfile('+255 700 000 002').role).toBe('Operations Manager')
    expect(makeMockStaffProfile('+255 700 000 003').role).toBe('Read-only Auditor')
    expect(makeMockStaffProfile('+255 700 000 003').permissions).toEqual(['audit.read'])
  })
})

describe('rolePermissions', () => {
  it('grants the wildcard to the platform owner', () => {
    expect(rolePermissions('platform-owner')).toContain('*')
  })

  it('grants only audit.read to the read-only auditor', () => {
    expect(rolePermissions('read-only-auditor')).toEqual(['audit.read'])
  })
})

describe('roleHasPermission', () => {
  it('grants refund.approve to customer support', () => {
    expect(roleHasPermission('customer-support', 'refund.approve')).toBe(true)
  })

  it('denies refund.approve to the read-only auditor', () => {
    expect(roleHasPermission('read-only-auditor', 'refund.approve')).toBe(false)
  })

  it('grants everything to the platform owner', () => {
    expect(roleHasPermission('platform-owner', 'iam.manage')).toBe(true)
    expect(roleHasPermission('platform-owner', 'anything.at.all')).toBe(true)
  })
})

describe('allPermissionKeys', () => {
  it('contains the extended logistics and moderation keys', () => {
    const keys = allPermissionKeys()
    expect(keys).toContain('shipment.hold')
    expect(keys).toContain('approval.decide')
    expect(keys).toContain('review.moderate')
    expect(keys).toContain('audit.unmask')
  })

  it('is sorted and deduped', () => {
    const keys = allPermissionKeys()
    expect(keys).toEqual([...new Set(keys)].sort())
  })
})
