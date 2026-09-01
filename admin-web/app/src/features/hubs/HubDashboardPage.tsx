import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { adminHubDashboard, type HubDashboard } from '@hudumika/contract'
import { EmptyState } from '../../components/EmptyState'
import { ErrorState } from '../../components/ErrorState'
import { LoadingSkeleton } from '../../components/LoadingSkeleton'
import { toLocal } from '../../lib/time'
import { useRefetchOnFocus } from '../../lib/use-refetch-on-focus'
import { useServerEvents } from '../../lib/use-server-events'

export function HubDashboardPage() {
  const [hubId, setHubId] = useState('')
  const [loaded, setLoaded] = useState<string | null>(null)

  return (
    <div className="page">
      <h1>Hub dashboard</h1>
      <p className="muted">Live load, sortation, capacity, and staffing for a single hub.</p>
      <form
        className="form-grid"
        onSubmit={(e) => {
          e.preventDefault()
          setLoaded(hubId.trim())
        }}
      >
        <label className="field-block">
          <span className="field-label">Hub ID</span>
          <input
            className="field"
            value={hubId}
            onChange={(e) => setHubId(e.target.value)}
            placeholder="hub_…"
            required
            aria-required="true"
          />
        </label>
        <div className="form-actions">
          <button type="submit" className="btn">
            Load dashboard
          </button>
        </div>
      </form>

      {loaded ? <HubDashboardSection hubId={loaded} /> : <p className="muted small">Enter a hub ID to load its dashboard.</p>}
    </div>
  )
}

export function HubDashboardSection({ hubId }: { hubId: string }) {
  const [dash, setDash] = useState<HubDashboard | null>(null)
  const [error, setError] = useState<number | null>(null)
  const [retryKey, setRetryKey] = useState(0)

  const loadDashboard = useCallback(() => {
    setDash(null)
    setError(null)
    adminHubDashboard(hubId).then((res) => {
      if (res.status === 200) setDash(res.data)
      else setError(res.status)
    })
  }, [hubId])

  useEffect(() => {
    loadDashboard()
  }, [loadDashboard, retryKey])

  useRefetchOnFocus(loadDashboard)
  useServerEvents({ enabled: !!dash, onEvent: () => loadDashboard() })

  if (error === 404) return <EmptyState title="Hub not found" />
  if (error)
    return (
      <ErrorState
        title="Failed to load hub dashboard"
        message={`Failed to load dashboard (${error})`}
        onRetry={() => setRetryKey((k) => k + 1)}
      />
    )
  if (!dash) return <LoadingSkeleton kind="stats" />

  const load = dash.load ?? {}
  const capacityPct = load.capacityPct
  const awaitingSort = load.awaitingSort ?? 0
  const exceptions = load.exceptions ?? 0

  return (
    <>
      <p className="muted small">Updated {toLocal(dash.updatedAt)}</p>
      <div className="cards">
        <div className="stat-card">
          <div className="stat-value">{load.incoming ?? '—'}</div>
          <div className="stat-label">Incoming</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{load.outgoing ?? '—'}</div>
          <div className="stat-label">Outgoing</div>
        </div>
        <div className={`stat-card${awaitingSort > 0 ? ' warn' : ''}`}>
          <div className="stat-value">{awaitingSort}</div>
          <div className="stat-label">Awaiting sort</div>
        </div>
        <div className={`stat-card${exceptions > 0 ? ' danger' : ''}`}>
          <div className="stat-value">{exceptions}</div>
          <div className="stat-label">Exceptions</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{capacityPct != null ? `${capacityPct}%` : '—'}</div>
          <div className="stat-label">Capacity</div>
          {capacityPct != null && (
            <>
              <div className="bar-track">
                <div
                  className={`bar-fill${capacityPct > 100 ? ' bad' : capacityPct > 80 ? ' warn' : ''}`}
                  style={{ width: `${Math.min(capacityPct, 100)}%` }}
                />
              </div>
              {capacityPct > 100 ? (
                <Link className="muted small" to="/operations/hubs">
                  Capacity warning — open hubs
                </Link>
              ) : capacityPct > 80 ? (
                <div className="muted small">Capacity near threshold — monitor hub load.</div>
              ) : null}
            </>
          )}
        </div>
      </div>

      <h3>Sortation queues</h3>
      {(dash.sortationQueues ?? []).length === 0 ? (
        <p className="muted small">No sortation queues at this hub.</p>
      ) : (
        <div className="queue-list">
          {(dash.sortationQueues ?? []).map((q) => (
            <div key={q.zone} className="queue-item">
              <div className="queue-main">
                <div className="small strong">{q.zone}</div>
              </div>
              <div className="queue-actions">
                <span className="badge">{q.count}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="meta-grid">
        <div className="meta-item">
          <span className="meta-label">Staff on duty</span>
          <span className="meta-value">{dash.staffOnDuty ?? '—'}</span>
        </div>
        <div className="meta-item">
          <span className="meta-label">Vehicles present</span>
          <span className="meta-value">{dash.vehiclesPresent ?? '—'}</span>
        </div>
      </div>

      {dash.performance && (
        <>
          <h3>Performance</h3>
          <div className="meta-grid">
            <div className="meta-item">
              <span className="meta-label">Inbound throughput</span>
              <span className="meta-value mono">{dash.performance.inboundThroughput ?? '—'} pkgs/hr</span>
            </div>
            <div className="meta-item">
              <span className="meta-label">Outbound throughput</span>
              <span className="meta-value mono">{dash.performance.outboundThroughput ?? '—'} pkgs/hr</span>
            </div>
            <div className="meta-item">
              <span className="meta-label">Sortation completion</span>
              <span className="meta-value mono">{dash.performance.sortationCompletionPct != null ? `${Math.round(dash.performance.sortationCompletionPct)}%` : '—'}</span>
            </div>
            <div className="meta-item">
              <span className="meta-label">Exception rate</span>
              <span className="meta-value mono">{dash.performance.exceptionRate != null ? `${dash.performance.exceptionRate.toFixed(1)}%` : '—'}</span>
            </div>
            <div className="meta-item">
              <span className="meta-label">Capacity trend</span>
              <span className="meta-value">{dash.performance.capacityTrend ?? '—'}</span>
            </div>
          </div>
        </>
      )}
    </>
  )
}
