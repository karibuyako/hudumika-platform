import { describe, expect, it, vi, beforeEach } from 'vitest'

async function loadRolesModule() {
  vi.resetModules()
  return import('./roles')
}

describe('roles', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('rolePermissions returns wildcard for platform-owner', async () => {
    const { rolePermissions } = await loadRolesModule()
    const perms = rolePermissions('platform-owner')
    expect(perms).toContain('*')
  })

  it('rolePermissions returns empty array for unknown role', async () => {
    const { rolePermissions } = await loadRolesModule()
    const perms = rolePermissions('nonexistent')
    expect(perms).toEqual([])
  })

  it('allPermissionKeys returns unique permission keys', async () => {
    const { allPermissionKeys } = await loadRolesModule()
    const keys = allPermissionKeys()
    expect(keys.length).toBeGreaterThan(0)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('allPermissionKeys is sorted', async () => {
    const { allPermissionKeys } = await loadRolesModule()
    const keys = allPermissionKeys()
    expect(keys).toEqual([...new Set(keys)].sort())
  })

  it('rolePermissions returns permissions for admin role', async () => {
    const { rolePermissions } = await loadRolesModule()
    const perms = rolePermissions('platform-administrator')
    expect(perms.length).toBeGreaterThan(0)
    expect(perms).toContain('order.read')
    expect(perms).toContain('iam.manage')
    expect(perms).toContain('audit.read')
  })

  it('rolePermissions returns permissions for finance role', async () => {
    const { rolePermissions } = await loadRolesModule()
    const perms = rolePermissions('finance')
    expect(perms).toContain('finance.refund')
    expect(perms).toContain('finance.read')
    expect(perms).toContain('finance.payout_adjust')
  })

  it('rolePermissions returns permissions for ops role', async () => {
    const { rolePermissions } = await loadRolesModule()
    const perms = rolePermissions('operations-manager')
    expect(perms.length).toBeGreaterThan(0)
    expect(perms).toContain('order.read')
    expect(perms).toContain('shipment.reassign')
    expect(perms).toContain('dispatch.assign')
  })

  it('rolePermissions returns a copy (not mutable reference)', async () => {
    const { rolePermissions } = await loadRolesModule()
    const perms1 = rolePermissions('finance')
    const perms2 = rolePermissions('finance')
    expect(perms1).toEqual(perms2)
    expect(perms1).not.toBe(perms2)
  })

  it('read-only-auditor has only audit.read', async () => {
    const { rolePermissions } = await loadRolesModule()
    const perms = rolePermissions('read-only-auditor')
    expect(perms).toEqual(['audit.read'])
  })

  it('effectiveRoles returns static STAFF_ROLES when not loaded from API', async () => {
    const { effectiveRoles, STAFF_ROLES } = await loadRolesModule()
    expect(effectiveRoles()).toBe(STAFF_ROLES)
  })

  it('getLoadedRoles returns null when not loaded', async () => {
    const { getLoadedRoles } = await loadRolesModule()
    expect(getLoadedRoles()).toBeNull()
  })
})
