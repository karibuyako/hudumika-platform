import { useEffect, useMemo, useState } from 'react'

type BookingStatus = 'upcoming' | 'active' | 'history'
type Booking = {
  id: string
  service: string
  customer: string
  startAt: number
  endAt: number
  status: BookingStatus
  address: string
  amount: string
}

function addMinutes(base: number, minutes: number) {
  return base + minutes * 60 * 1000
}

function formatCountdown(targetMs: number, nowMs: number): string {
  const diff = Math.max(0, targetMs - nowMs)
  const totalSeconds = Math.floor(diff / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const mins = Math.floor((totalSeconds % 3600) / 60)
  const secs = totalSeconds % 60
  if (hours > 0) return `${hours}h ${mins}m ${secs}s`
  if (mins > 0) return `${mins}m ${secs}s`
  return `${secs}s`
}

export function BookingsPage() {
  const [tab, setTab] = useState<BookingStatus>('upcoming')
  const [now, setNow] = useState(() => Date.now())

  const bookings = useMemo<Booking[]>(() => {
    const base = Date.now()
    return [
      {
        id: 'BK-10482',
        service: 'House cleaning — Standard',
        customer: 'Asha K.',
        startAt: addMinutes(base, 42),
        endAt: addMinutes(base, 162),
        status: 'upcoming',
        address: 'Msasani, Dar es Salaam',
        amount: 'TZS 35,000',
      },
      {
        id: 'BK-10473',
        service: 'AC Service',
        customer: 'John M.',
        startAt: addMinutes(base, 180),
        endAt: addMinutes(base, 300),
        status: 'upcoming',
        address: 'Mikocheni, Dar es Salaam',
        amount: 'TZS 55,000',
      },
      {
        id: 'BK-10465',
        service: 'Plumbing — Repair',
        customer: 'Rehema S.',
        startAt: addMinutes(base, -15),
        endAt: addMinutes(base, 75),
        status: 'active',
        address: 'Kariakoo, Dar es Salaam',
        amount: 'TZS 40,000',
      },
      {
        id: 'BK-10440',
        service: 'House cleaning — Deep',
        customer: 'David O.',
        startAt: addMinutes(base, -1440),
        endAt: addMinutes(base, -1200),
        status: 'history',
        address: 'Upanga, Dar es Salaam',
        amount: 'TZS 65,000',
      },
      {
        id: 'BK-10421',
        service: 'House cleaning — Standard',
        customer: 'Zainab H.',
        startAt: addMinutes(base, -2880),
        endAt: addMinutes(base, -2760),
        status: 'history',
        address: 'Oyster Bay, Dar es Salaam',
        amount: 'TZS 35,000',
      },
    ]
  }, [])

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  const filtered = bookings.filter((b) => b.status === tab)

  return (
    <div className="page">
      <div className="page-title-row">
        <div>
          <h1>Bookings</h1>
          <p className="muted">Manage upcoming, active and past bookings. Countdown shows time to start for upcoming.</p>
        </div>
      </div>

      <div className="segmented" role="tablist" aria-label="Bookings filter">
        {(['upcoming', 'active', 'history'] as const).map((key) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            className={tab === key ? 'active' : ''}
            onClick={() => setTab(key)}
          >
            {key === 'upcoming' ? 'Upcoming' : key === 'active' ? 'Active' : 'History'} ({bookings.filter((b) => b.status === key).length})
          </button>
        ))}
      </div>

      <div className="table-wrap" style={{ marginTop: 14 }}>
        <table className="table">
          <thead>
            <tr>
              <th>Booking</th>
              <th>Service</th>
              <th>Customer</th>
              <th>When</th>
              <th>Countdown</th>
              <th>Amount</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((b) => {
              const target = b.status === 'upcoming' ? b.startAt : b.status === 'active' ? b.endAt : null
              const label = b.status === 'upcoming' ? 'Starts in' : b.status === 'active' ? 'Ends in' : '—'
              return (
                <tr key={b.id}>
                  <td>
                    <div className="mono-strong">{b.id}</div>
                    <div className="muted small">{b.address}</div>
                  </td>
                  <td>{b.service}</td>
                  <td>{b.customer}</td>
                  <td className="mono small">
                    {new Date(b.startAt).toLocaleString()} — {new Date(b.endAt).toLocaleTimeString()}
                  </td>
                  <td className="mono-strong">
                    {target ? (
                      <span title={new Date(target).toISOString()}>
                        {label} {formatCountdown(target, now)}
                      </span>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="mono">{b.amount}</td>
                  <td>
                    {b.status === 'upcoming' && <span className="pill pill-warn">Upcoming</span>}
                    {b.status === 'active' && <span className="pill pill-info">Active</span>}
                    {b.status === 'history' && <span className="pill pill-muted">Completed</span>}
                  </td>
                </tr>
              )
            })}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={7} className="empty-cell muted small">
                  No {tab} bookings
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {tab === 'upcoming' && (
        <p className="muted small" style={{ marginTop: 8 }}>
          Countdown updates every second. Prepare to travel when less than 30 minutes remains.
        </p>
      )}
    </div>
  )
}
