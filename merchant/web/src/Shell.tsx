import { useEffect, useState } from 'react'
import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import { logout } from '@hudumika/contract'
import { LoginPage } from './pages/LoginPage'
import { clearSession, getSession, refreshAccessToken, useSession } from './lib/session'

const REFRESH_AFTER_MS = 10 * 60 * 1000

let refreshInFlight = false

const NAV_GROUPS: Array<{ label: string; items: Array<{ to: string; label: string }> }> = [
  { label: 'Overview', items: [{ to: '/', label: 'Overview' }] },
  {
    label: 'Commerce',
    items: [
      { to: '/orders', label: 'Orders' },
      { to: '/catalogue', label: 'Catalogue' },
      { to: '/availability', label: 'Availability' },
    ],
  },
  { label: 'Customers', items: [{ to: '/customers', label: 'Customers' }] },
  { label: 'Marketing', items: [{ to: '/promotions', label: 'Promotions' }] },
  { label: 'Finance', items: [{ to: '/earnings', label: 'Earnings' }] },
  { label: 'Support', items: [{ to: '/support', label: 'Support' }] },
]

export function Shell() {
  const session = useSession()
  const navigate = useNavigate()
  const [now, setNow] = useState(() => Date.now())

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

  function signOut() {
    void logout().catch(() => undefined)
    clearSession()
    navigate('/')
  }

  if (!session) {
    return <LoginPage />
  }

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">HUDumika Merchant</div>
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
          <span className="muted small">HUDumika Merchant · v0.1.0</span>
          <span className="muted small">Mock data</span>
        </div>
      </aside>
      <div className="main">
        <header className="topbar">
          <div className="topbar-search" style={{ display: 'flex', alignItems: 'center', color: 'var(--color-ink-300)', fontSize: 12 }}>
            Merchant workspace
          </div>
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
            Session expires in {Math.floor(remainingMs / 60_000)} min {Math.ceil((remainingMs % 60_000) / 1000)} s — sign in again when it lapses.
          </div>
        )}
        <main className="content">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
