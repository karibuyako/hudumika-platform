import { useEffect, useMemo, useRef, useState } from 'react'
import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import { logout } from '@hudumika/contract'
import { LoginPage } from './features/auth/LoginPage'
import { CommandPalette, type PaletteItem } from './components/CommandPalette'
import { clearSession, getSession, refreshAccessToken, useSession, SESSION_TTL_MS } from './lib/session'
import { loadStaffRoles } from './lib/roles'
import { can, loadPermissionCatalog } from './lib/permissions'
import { loadLimits } from './lib/limits'

const REFRESH_AFTER_MS = SESSION_TTL_MS / 2

let refreshInFlight = false

const NAV_GROUPS: Array<{ label: string; items: Array<{ to: string; label: string; permission?: string | null }> }> = [
  { label: 'Overview', items: [
    { to: '/', label: 'Control Tower', permission: null },
    { to: '/operations/overview', label: 'Operations Overview', permission: 'order.read' },
    { to: '/admin/map', label: 'Map', permission: null },
    { to: '/admin/map/traffic', label: 'Traffic & Incidents', permission: 'fleet.read' },
  ]},
  {
    label: 'Operations',
    items: [
      { to: '/operations/dispatch', label: 'Dispatch', permission: 'dispatch.assign' },
      { to: '/operations/dispatch-monitor', label: 'Dispatch Monitor', permission: 'dispatch.read' },
      { to: '/operations/fleet-tower', label: 'Fleet Tower', permission: 'fleet.read' },
      { to: '/operations/fleet', label: 'Fleet', permission: 'fleet.read' },
      { to: '/operations/hubs', label: 'Hubs', permission: 'hub.read' },
      { to: '/operations/hubs/dashboard', label: 'Hub Dashboard', permission: 'hub.manage' },
      { to: '/operations/consignments', label: 'Consignments', permission: 'consignment.read' },
      { to: '/operations/exceptions', label: 'Exceptions', permission: 'exception.read' },
    ],
  },
  {
    label: 'Commerce',
    items: [
      { to: '/commerce/orders', label: 'Orders', permission: 'order.read' },
      { to: '/bookings', label: 'Bookings', permission: 'order.read' },
      { to: '/commerce/merchants', label: 'Merchants', permission: 'merchant.read' },
    ],
  },
  {
    label: 'Services',
    items: [{ to: '/services/providers', label: 'Providers', permission: 'provider.read' }],
  },
  {
    label: 'Logistics',
    items: [
      { to: '/logistics/control-tower', label: 'Control Tower', permission: 'order.read' },
      { to: '/logistics/reconciliation', label: 'Reconciliation', permission: 'reconciliation.read' },
      { to: '/logistics/shipments', label: 'Shipments', permission: 'shipment.read' },
      { to: '/logistics/riders', label: 'Riders', permission: 'dispatch.read' },
      { to: '/logistics/riders/cod', label: 'Rider COD', permission: 'cod.read' },
      { to: '/logistics/waybills', label: 'Waybills', permission: 'waybill.read' },
      { to: '/logistics/warehouses', label: 'Warehouses', permission: 'warehouse.read' },
      { to: '/carriers', label: 'Carriers', permission: 'carrier.read' },
      { to: '/facilities', label: 'Facilities', permission: 'facility.read' },
      { to: '/fleet-accounts', label: 'Fleet Accounts', permission: 'fleet.admin' },
    ],
  },
  {
    label: 'Customers',
    items: [{ to: '/customers', label: 'Customers', permission: 'order.read' }],
  },
  {
    label: 'Finance',
    items: [
      { to: '/finance/payments', label: 'Payments', permission: 'finance.read' },
      { to: '/finance/refunds', label: 'Refunds', permission: 'finance.refund' },
      { to: '/finance/payroll', label: 'Payroll', permission: 'finance.read' },
      { to: '/finance/ledger', label: 'Ledger', permission: 'finance.read' },
    ],
  },
  {
    label: 'Growth',
    items: [
      { to: '/growth/promotions', label: 'Promotions', permission: 'promotion.moderate' },
      { to: '/group-buys', label: 'Group Buys', permission: 'group_buy.moderate' },
      { to: '/growth/loyalty', label: 'Loyalty', permission: 'configuration.edit' },
      { to: '/chains', label: 'Enterprise Chains', permission: 'chain.read' },
      { to: '/vouchers', label: 'Vouchers', permission: 'voucher.verify' },
      { to: '/content', label: 'Content', permission: 'content.manage' },
      { to: '/content/editorial', label: 'Editorial', permission: 'content.manage' },
      { to: '/content/help', label: 'Help & Broadcast', permission: 'content.manage' },
    ],
  },
  {
    label: 'Support',
    items: [
      { to: '/support/inbox', label: 'Inbox', permission: 'support.manage' },
      { to: '/conversations', label: 'Conversations', permission: 'conversation.read' },
    ],
  },
  {
    label: 'Trust & Safety',
    items: [
      { to: '/trust/risk-cases', label: 'Risk Cases', permission: 'risk.investigate' },
      { to: '/reviews', label: 'Reviews', permission: 'review.moderate' },
    ],
  },
  {
    label: 'Compliance',
    items: [{ to: '/compliance', label: 'Compliance', permission: 'audit.read' }],
  },
  {
    label: 'Analytics',
    items: [
      { to: '/analytics', label: 'Analytics', permission: 'analytics.read' },
      { to: '/exports', label: 'Data Exports', permission: 'export.request' },
      { to: '/exports/scheduled', label: 'Scheduled Reports', permission: 'export.approve' },
    ],
  },
  {
    label: 'Configuration',
    items: [
      { to: '/configuration/general-settings', label: 'General Settings', permission: 'configuration.edit' },
      { to: '/configuration/regions', label: 'Regions', permission: 'configuration.edit' },
      { to: '/configuration/geofences', label: 'Geofences', permission: 'configuration.edit' },
      { to: '/catalogue', label: 'Service Catalogue', permission: 'configuration.edit' },
      { to: '/configuration/feature-flags', label: 'Feature Flags', permission: 'feature.edit' },
      { to: '/configuration/sla', label: 'SLA Rules', permission: 'configuration.edit' },
      { to: '/configuration/commissions', label: 'Commissions', permission: 'configuration.edit' },
      { to: '/configuration/quality-scores', label: 'Quality Scores', permission: 'configuration.edit' },
      { to: '/configuration/gateways', label: 'Payment Gateways', permission: 'configuration.edit' },
      { to: '/configuration/center', label: 'Config Center', permission: 'configuration.edit' },
      { to: '/webhooks', label: 'Webhooks', permission: 'webhook.read' },
      { to: '/configuration/integrations', label: 'Integration Health', permission: 'configuration.edit' },
    ],
  },
  {
    label: 'IAM',
    items: [
      { to: '/iam/admin-users', label: 'Admin Users', permission: 'iam.manage' },
      { to: '/iam/teams', label: 'Teams', permission: 'iam.manage' },
      { to: '/iam/policies', label: 'Policies', permission: 'iam.manage' },
      { to: '/iam/sessions', label: 'My Sessions', permission: null },
      { to: '/auth/password-reset', label: 'Password Reset', permission: null },
    ],
  },
  {
    label: 'Audit',
    items: [
      { to: '/audit/logs', label: 'Audit Logs', permission: 'audit.read' },
      { to: '/audit/approvals', label: 'Two-Person Approvals', permission: 'approval.decide' },
    ],
  },
]

export function Shell() {
  const session = useSession()
  const navigate = useNavigate()
  const searchRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  const filteredNavGroups = useMemo(
    () =>
      NAV_GROUPS.map((group) => ({
        ...group,
        items: group.items.filter((item) => !item.permission || can(session, item.permission)),
      })).filter((group) => group.items.length > 0),
    [session],
  )

  const paletteItems = useMemo<PaletteItem[]>(() => {
    const navItems: PaletteItem[] = filteredNavGroups.flatMap((group) =>
      group.items.map((item) => ({ id: `nav:${item.to}`, label: item.label, group: group.label, to: item.to })),
    )
    const quickActions: PaletteItem[] = [
      { id: 'quick:search', label: 'Global search', group: 'Quick actions', to: '/search' },
      { id: 'quick:approval', label: 'New approval request', group: 'Quick actions', to: '/audit/approvals' },
      { id: 'quick:report', label: 'New report', group: 'Quick actions', to: '/exports' },
      { id: 'quick:city', label: 'New city', group: 'Quick actions', to: '/configuration/regions' },
    ]
    return [...navItems, ...quickActions]
  }, [filteredNavGroups])

  useEffect(() => {
    if (!session) return
    const timer = setInterval(() => {
      getSession()
      if (refreshInFlight) return
      const current = getSession()
      if (!current?.tokenIssuedAt) return
      if (Date.now() - current.tokenIssuedAt > REFRESH_AFTER_MS) {
        refreshInFlight = true
        void refreshAccessToken().finally(() => {
          refreshInFlight = false
        })
      }
    }, 30_000)
    return () => clearInterval(timer)
  }, [session])

  useEffect(() => {
    if (!session) return
    const timer = setInterval(() => setNow(Date.now()), 5_000)
    return () => clearInterval(timer)
  }, [session])

  useEffect(() => {
    if (!session) return
    loadStaffRoles().catch(() => undefined)
    loadPermissionCatalog().catch(() => undefined)
    loadLimits().catch(() => undefined)
  }, [session])

  const remainingMs = session ? session.expiresAt - now : 0
  const showExpiryWarning = session !== null && remainingMs > 0 && remainingMs <= 2 * 60 * 1000

  useEffect(() => {
    if (!session) return
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        e.stopPropagation()
        setPaletteOpen((open) => !open)
      } else if (e.key === '?' && !paletteOpen && !helpOpen) {
        e.preventDefault()
        setHelpOpen(true)
      } else if (e.key === 'Escape' && helpOpen) {
        setHelpOpen(false)
      } else if (e.key === '/' && !paletteOpen && !helpOpen) {
        const el = document.activeElement
        const tag = el?.tagName.toLowerCase()
        if (tag !== 'input' && tag !== 'textarea' && !(el instanceof HTMLElement && el.isContentEditable)) {
          e.preventDefault()
          searchRef.current?.focus()
        }
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [session, paletteOpen, helpOpen])

  function signOut() {
    void logout().catch(() => undefined)
    clearSession()
  }

  function submitSearch() {
    const q = query.trim()
    if (q) navigate(`/search?q=${encodeURIComponent(q)}`)
  }
  if (!session) {
    return <LoginPage />
  }
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">HUDumika Ops</div>
        <nav>
          {filteredNavGroups.map((group) => (
            <div key={group.label} className="nav-group">
              <div className="nav-group-label">{group.label}</div>
              {group.items.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
                >
                  {item.label}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
        <div className="sidebar-footer">
          <span className="muted small">HUDumika Ops · v0.1.0</span>
          <span className="muted small">Mock data</span>
        </div>
      </aside>
      <div className="main">
        <header className="topbar">
          <input
            ref={searchRef}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitSearch()
            }}
            placeholder="Ctrl+K — global search (ORD-, SHP-, CUS-…)"
            className="topbar-search"
            aria-label="Global search"
          />
          <div className="topbar-right">
            <span className="badge">{session.role}</span>
            {session.mfaVerified && <span className="muted small">MFA verified</span>}
            <span className="user">{session.displayName}</span>
            <button type="button" className="btn" onClick={signOut}>
              Sign out
            </button>
          </div>
        </header>
        {showExpiryWarning && (() => {
          const totalSeconds = Math.ceil(remainingMs / 1000)
          const mins = Math.floor(totalSeconds / 60)
          const secs = totalSeconds % 60
          return (
            <div className="notice" role="status">
              Session expires in {mins} min {secs} s — sign in again when it lapses.
            </div>
          )
        })()}
        <main className="content">
          <Outlet />
        </main>
      </div>
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        items={paletteItems}
        onNavigate={(item) => {
          setPaletteOpen(false)
          if (item.to) navigate(item.to)
          else item.action?.()
        }}
      />
      {helpOpen && (
        <div className="modal-backdrop" onClick={() => setHelpOpen(false)}>
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label="Keyboard shortcuts"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="modal-title">Keyboard shortcuts</h2>
            {[
              ['Ctrl+K / Cmd+K', 'command palette'],
              ['/', 'focus global search'],
              ['J / K', 'next / previous table row'],
              ['Enter', 'open selected row'],
              ['E', 'export table (when exportable)'],
              ['?', 'this help'],
            ].map(([key, description]) => (
              <div key={key} className="muted small" style={{ margin: '4px 0' }}>
                <kbd>{key}</kbd> — {description}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}