import { useMemo } from 'react'

export function DashboardPage() {
  const stats = useMemo(
    () => [
      { label: 'Upcoming bookings', value: '12', sub: 'Next 7 days' },
      { label: 'Active now', value: '3', sub: 'In progress' },
      { label: 'Today earnings', value: 'TZS 284,000', sub: '+12% vs yesterday' },
      { label: 'Avg rating', value: '4.8', sub: '312 reviews' },
    ],
    [],
  )

  return (
    <div className="page">
      <div className="page-title-row">
        <div>
          <h1>Dashboard</h1>
          <p className="muted">Overview of your provider activity.</p>
        </div>
      </div>

      <div className="cards">
        {stats.map((s) => (
          <div key={s.label} className="stat-card">
            <div className="stat-value">{s.value}</div>
            <div className="stat-label">{s.label}</div>
            <div className="stat-sub">{s.sub}</div>
          </div>
        ))}
      </div>

      <h2>Today&apos;s highlights</h2>
      <div className="queue-list">
        <div className="queue-item">
          <div className="queue-main">
            <strong>Next booking in 42 minutes</strong>
            <span className="muted small">BK-10482 — House cleaning — 11:30 AM · Msasani</span>
          </div>
          <span className="pill pill-warn">Upcoming</span>
        </div>
        <div className="queue-item">
          <div className="queue-main">
            <strong>Payout settled</strong>
            <span className="muted small">TZS 120,000 credited · Booking BK-10471</span>
          </div>
          <span className="pill pill-ok">Settled</span>
        </div>
      </div>
    </div>
  )
}
