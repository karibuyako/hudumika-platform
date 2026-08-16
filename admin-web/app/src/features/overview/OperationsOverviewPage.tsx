import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { adminOverview, type AdminOverview, type GetServerEvents200EventsItem } from '@hudumika/contract'
import { ErrorState } from '../../components/ErrorState'
import { LoadingSkeleton } from '../../components/LoadingSkeleton'
import { EmptyState } from '../../components/EmptyState'
import { StatCard } from '../../components/StatCard'
import { formatTZS } from '../../lib/money'
import { parseApiError } from '../../lib/api-error'
import { toLocal } from '../../lib/time'
import { useRefetchOnFocus } from '../../lib/use-refetch-on-focus'
import { useServerEvents } from '../../lib/use-server-events'

const LIVE_ACTIVITY_LIMIT = 10

export function OperationsOverviewPage() {
  const [overview, setOverview] = useState<AdminOverview | null>(null)
  const [error, setError] = useState<{ title: string; message: string } | null>(null)
  const [retryKey, setRetryKey] = useState(0)
  const [liveEvents, setLiveEvents] = useState<Array<Pick<GetServerEvents200EventsItem, 'type' | 'at'>>>([])

  const load = useCallback(() => {
    setError(null)
    adminOverview().then((res) => {
      if (res.status === 200) setOverview(res.data)
      else {
        const info = parseApiError(res, 'Overview unavailable')
        setError({ title: 'Overview unavailable', message: `${info.code} — ${info.message}` })
      }
    })
  }, [])

  useEffect(() => {
    load()
  }, [load, retryKey])

  useRefetchOnFocus(load)
  useServerEvents({
    enabled: !!overview,
    onEvent: (events) => {
      load()
      if (events.length > 0) {
        setLiveEvents((prev) => [...events.map((e) => ({ type: e.type, at: e.at })), ...prev].slice(0, LIVE_ACTIVITY_LIMIT))
      }
    },
  })

  if (error) {
    return <ErrorState title={error.title} message={error.message} onRetry={() => setRetryKey((k) => k + 1)} />
  }
  if (!overview) return <LoadingSkeleton kind="stats" rows={4} />

  const m = overview.metrics
  const hasMetrics = m && Object.values(m).some((v) => v !== undefined)

  return (
    <div className="page">
      <div className="page-title-row">
        <div>
          <h1>Operations Overview</h1>
          <p className="muted">Live operating metrics — what is happening right now.</p>
        </div>
      </div>

      {!hasMetrics && (
        <EmptyState title="No live metrics" hint="The overview endpoint returned no metrics for this session." />
      )}

      {hasMetrics && (
        <div className="kpi">
          <StatCard label="Active orders" value={m.activeOrders ?? '—'} />
          <StatCard label="Active bookings" value={m.activeBookings ?? '—'} />
          <StatCard label="Pending approvals" value={m.pendingApprovals ?? '—'} tone={m.pendingApprovals ? 'warn' : 'default'} />
          <StatCard label="Open tickets" value={m.openTickets ?? '—'} />
          <StatCard label="Pending payouts" value={formatTZS(m.pendingPayoutsTZS)} tone={m.pendingPayoutsTZS ? 'warn' : 'default'} />
          <StatCard label="Exceptions" value={m.exceptions ?? '—'} tone={m.exceptions ? 'danger' : 'default'} />
        </div>
      )}

      <h2>Intervention queues</h2>
      {overview.queue.length === 0 ? (
        <EmptyState title="No open queues" hint="Every intervention queue is clear." />
      ) : (
        <div className="queue-list">
          {overview.queue.map((q, i) => (
            <div key={`${q.name}-${i}`} className="queue-item">
              <div className="queue-main">
                <span className="strong small">{q.name ?? 'Queue'}</span>
              </div>
              <div className="queue-actions">
                <span className="mono-strong">{q.count ?? 0}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      <h2>Quick actions</h2>
      <div className="toolbar">
        <Link className="btn" to="/commerce/merchants">
          Approve verifications
        </Link>
        <Link className="btn" to="/finance/payments">
          Reconcile payouts
        </Link>
        <Link className="btn" to="/audit/approvals">
          Open two-person queue
        </Link>
        <Link className="btn" to="/exports">
          New report
        </Link>
      </div>

      {liveEvents.length > 0 && (
        <section>
          <h2>Live activity</h2>
          <p className="muted small">Feed follows the /events stream</p>
          <div className="queue-list">
            {liveEvents.map((e, i) => (
              <div key={`${i}-${e.type}`} className="queue-item">
                <div className="queue-main">
                  <span className="small strong">{e.type.replace(/_/g, ' ')}</span>
                </div>
                <div className="queue-actions">
                  <span className="muted small">{toLocal(e.at)}</span>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}
