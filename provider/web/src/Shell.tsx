import { useEffect, useState } from 'react'
import { NavLink, Outlet } from 'react-router-dom'
import { LoginPage } from './features/auth/LoginPage'
import { clearSession, getSession, useSession } from './lib/session'

const NAV_GROUPS: Array<{ label: string; items: Array<{ to: string; label: string }> }> = [
  { label: 'Overview', items: [{ to: '/', label: 'Dashboard' }] },
  { label: 'Schedule', items: [{ to: '/availability', label: 'Availability' }] },
  { label: 'Business', items: [{ to: '/catalogue', label: 'Catalogue' }, { to: '/bookings', label: 'Bookings' }] },
  { label: 'Finance', items: [{ to: '/earnings', label: 'Earnings' }] },
  { label: 'Engagement', items: [{ to: '/notifications', label: 'Notifications' }, { to: '/reviews', label: 'Reviews' }] },
  { label: 'Help', items: [{ to: '/support', label: 'Support' }] },
]

export function Shell() {
  const session = useSession()
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!session) return
    const timer = window.setInterval(() => setNow(Date.now()), 5_000)
    return () => window.clearInterval(timer)
  }, [session])

  const remainingMs = session ? session.expiresAt - now : 0
  const showExpiryWarning = session !== null && remainingMs > 0 && remainingMs <= 2 * 60 * 1000

  function signOut() {
    clearSession()
  }

  // Keep session fresh on focus — expire check handled in getSession()
  useEffect(() => {
    const onFocus = () => getSession()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [])

  if (!session) {
    return <LoginPage />
  }

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">HUDumika Provider</div>
        <nav>
          {NAV_GROUPS.map((group) => (
            <div key={group.label} className="nav-group">
              <div className="nav-group-label">{group.label}</div>
              {group.items.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.to === '/'}
                  className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
                >
                  {item.label}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
        <div className="sidebar-footer">
          <span className="muted small">HUDumika Provider · v0.1.0</span>
          <span className="muted small">Mock data</span>
        </div>
      </aside>
      <div className="main">
        <header className="topbar">
          <div className="muted small" style={{ fontWeight: 600 }}>
            Provider portal
          </div>
          <div className="topbar-right">
            <span className="badge">{session.role}</span>
            <span className="user">{session.displayName}</span>
            <span className="muted small mono">{session.phone}</span>
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
