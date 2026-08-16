import { useEffect, useMemo, useRef, useState } from 'react'
import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import { logout } from '@hudumika/contract'
import { LoginPage } from './features/auth/LoginPage'
import { CommandPalette, type PaletteItem } from './components/CommandPalette'
import { clearSession, getSession, refreshAccessToken, useSession } from './lib/session'

const REFRESH_AFTER_MS = 10 * 60 * 1000

let refreshInFlight = false

const NAV_GROUPS: Array<{ label: string; items: Array<{ to: string; label: string }> }> = [
  { label: 'Overview', items: [{ to: '/', label: 'Control Tower' }, { to: '/operations/overview', label: 'Operations Overview' }, { to: '/admin/map', label: 'Map' }] },
  {
    label: 'Operations',
    items: [
      { to: '/operations/dispatch', label: 'Dispatch' },
      { to: '/operations/dispatch-monitor', label: 'Dispatch Monitor' },
      { to: '/operations/fleet-tower', label: 'Fleet Tower' },
      { to: '/operations/fleet', label: 'Fleet' },
      { to: '/operations/hubs', label: 'Hubs' },
      { to: '/operations/hubs/dashboard', label: 'Hub Dashboard' },
      { to: '/operations/consignments', label: 'Consignments' },
      { to: '/operations/exceptions', label: 'Exceptions' },
    ],
  },
  {
    label: 'Commerce',
    items: [
      { to: '/commerce/orders', label: 'Orders' },
      { to: '/bookings', label: 'Bookings' },
      { to: '/commerce/merchants', label: 'Merchants' },
    ],
  },
  {
    label: 'Services',
    items: [{ to: '/services/providers', label: 'Providers' }],
  },
  {
    label: 'Logistics',
    items: [
      { to: '/logistics/control-tower', label: 'Control Tower' },
      { to: '/logistics/reconciliation', label: 'Reconciliation' },
      { to: '/logistics/shipments', label: 'Shipments' },
      { to: '/logistics/riders', label: 'Riders' },
      { to: '/logistics/riders/cod', label: 'Rider COD' },
      { to: '/logistics/waybills', label: 'Waybills' },
      { to: '/logistics/warehouses', label: 'Warehouses' },
      { to: '/carriers', label: 'Carriers' },
      { to: '/facilities', label: 'Facilities' },
      { to: '/fleet-accounts', label: 'Fleet Accounts' },
    ],
  },
  {
    label: 'Customers',
    items: [{ to: '/customers', label: 'Customers' }],
  },
  {
    label: 'Finance',
    items: [
      { to: '/finance/payments', label: 'Payments' },
      { to: '/finance/refunds', label: 'Refunds' },
      { to: '/finance/ledger', label: 'Ledger' },
    ],
  },
  {
    label: 'Growth',
    items: [
      { to: '/growth/promotions', label: 'Promotions' },
      { to: '/group-buys', label: 'Group Buys' },
      { to: '/growth/loyalty', label: 'Loyalty' },
      { to: '/chains', label: 'Enterprise Chains' },
      { to: '/vouchers', label: 'Vouchers' },
      { to: '/content', label: 'Content' },
      { to: '/content/help', label: 'Help & Broadcast' },
    ],
  },
  {
    label: 'Support',
    items: [
      { to: '/support/inbox', label: 'Inbox' },
      { to: '/conversations', label: 'Conversations' },
    ],
  },
  {
    label: 'Trust & Safety',
    items: [
      { to: '/trust/risk-cases', label: 'Risk Cases' },
      { to: '/reviews', label: 'Reviews' },
    ],
  },
  {
    label: 'Compliance',
    items: [{ to: '/compliance', label: 'Compliance' }],
  },
  {
    label: 'Analytics',
    items: [
      { to: '/analytics', label: 'Analytics' },
      { to: '/exports', label: 'Data Exports' },
    ],
  },
  {
    label: 'Configuration',
    items: [
      { to: '/configuration/regions', label: 'Regions' },
      { to: '/catalogue', label: 'Service Catalogue' },
      { to: '/configuration/feature-flags', label: 'Feature Flags' },
      { to: '/configuration/sla', label: 'SLA Rules' },
      { to: '/configuration/commissions', label: 'Commissions' },
      { to: '/webhooks', label: 'Webhooks' },
      { to: '/configuration/integrations', label: 'Integration Health' },
    ],
  },
  {
    label: 'IAM',
    items: [
      { to: '/iam/users', label: 'Users' },
      { to: '/iam/sessions', label: 'My Sessions' },
    ],
  },
  {
    label: 'Audit',
    items: [
      { to: '/audit/logs', label: 'Audit Logs' },
      { to: '/audit/approvals', label: 'Two-Person Approvals' },
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

  const paletteItems = useMemo<PaletteItem[]>(() => {
    const navItems: PaletteItem[] = NAV_GROUPS.flatMap((group) =>
      group.items.map((item) => ({ id: `nav:${item.to}`, label: item.label, group: group.label, to: item.to })),
    )
    const quickActions: PaletteItem[] = [
      { id: 'quick:search', label: 'Global search', group: 'Quick actions', to: '/search' },
      { id: 'quick:approval', label: 'New approval request', group: 'Quick actions', to: '/audit/approvals' },
      { id: 'quick:report', label: 'New report', group: 'Quick actions', to: '/exports' },
      { id: 'quick:city', label: 'New city', group: 'Quick actions', to: '/configuration/regions' },
    ]
    return [...navItems, ...quickActions]
  }, [])

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
          {NAV_GROUPS.map((group) => (
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
        {showExpiryWarning && (
          <div className="notice" role="status">
            Session expires in {Math.floor(remainingMs / 60_000)} min{' '}
            {Math.ceil((remainingMs % 60_000) / 1000)} s — sign in again when it lapses.
          </div>
        )}
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