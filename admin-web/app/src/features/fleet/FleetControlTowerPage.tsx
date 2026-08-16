import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import {
  adminFleetControlTower,
  type AdminFleetControlTowerFleetType,
  type AdminFleetControlTowerParams,
  type adminFleetControlTowerResponseError,
  type adminFleetControlTowerResponseSuccess,
  type FleetOverview,
  type FleetOverviewHubsItem,
} from '@hudumika/contract'
import { DetailDrawer } from '../../components/DetailDrawer'
import { EmptyState } from '../../components/EmptyState'
import { ErrorState } from '../../components/ErrorState'
import { LoadingSkeleton } from '../../components/LoadingSkeleton'
import { ReasonPrompt } from '../../components/ReasonPrompt'
import { StatCard } from '../../components/StatCard'
import { parseApiError, type ApiErrorInfo } from '../../lib/api-error'
import { PENDING_ENDPOINT_CODE, pendingEndpointNotice } from '../../lib/pending-endpoints'
import { can } from '../../lib/permissions'
import { useSession } from '../../lib/session'
import { snapshotLabel } from '../../lib/time'
import { useRefetchOnFocus } from '../../lib/use-refetch-on-focus'
import { useServerEvents } from '../../lib/use-server-events'

type FleetTypeFilter = 'all' | AdminFleetControlTowerFleetType

const FLEET_TYPES: AdminFleetControlTowerFleetType[] = ['captive', 'contracted', 'outsourced', 'hybrid']

function isSuccess(
  res: adminFleetControlTowerResponseSuccess | adminFleetControlTowerResponseError,
): res is adminFleetControlTowerResponseSuccess {
  return res.status === 200
}

export function FleetControlTowerPage() {
  const [tower, setTower] = useState<FleetOverview | null>(null)
  const [error, setError] = useState<ApiErrorInfo | null>(null)
  const [retryKey, setRetryKey] = useState(0)
  const [hubId, setHubId] = useState('all')
  const [fleetType, setFleetType] = useState<FleetTypeFilter>('all')
  const [selected, setSelected] = useState<FleetOverviewHubsItem | null>(null)
  const requestIdRef = useRef(0)

  const load = useCallback(() => {
    const requestId = ++requestIdRef.current
    setError(null)
    setTower(null)
    const params: AdminFleetControlTowerParams = {}
    if (hubId !== 'all') params.hubId = hubId
    if (fleetType !== 'all') params.fleetType = fleetType
    adminFleetControlTower(params).then((res) => {
      if (requestId !== requestIdRef.current) return
      if (isSuccess(res)) setTower(res.data)
      else setError(parseApiError(res, 'Control tower unavailable'))
    })
  }, [hubId, fleetType])

  useEffect(() => {
    load()
  }, [load, retryKey])

  useRefetchOnFocus(load)
  useServerEvents({ enabled: !!tower, onEvent: () => load() })

  if (error) {
    return (
      <ErrorState
        title="Control tower unavailable"
        message={error.message}
        requestId={error.requestId}
        onRetry={() => setRetryKey((k) => k + 1)}
      />
    )
  }
  if (!tower) return <LoadingSkeleton kind="stats" />
  if (!tower.totals) {
    return (
      <EmptyState
        title="Fleet tower unavailable"
        hint="The fleet overview response is missing totals data."
        action={{ label: 'Retry', onClick: () => setRetryKey((k) => k + 1) }}
      />
    )
  }

  const totals = tower.totals
  const anomalies = totals.anomalies ?? 0
  const openSos = totals.openSos ?? 0
  const safetyActive = openSos > 0 || anomalies > 0

  return (
    <div className="page">
      <div className="page-title-row">
        <h1>Fleet Control Tower</h1>
      </div>
      <p className="muted">{snapshotLabel(tower.generatedAt)}</p>

      <div className="toolbar">
        <label className="field-label">
          Hub
          <select
            className="field"
            value={hubId}
            onChange={(e) => setHubId(e.target.value)}
            aria-label="Filter by hub"
          >
            <option value="all">All hubs</option>
            {tower.hubs.map((h) => (
              <option key={h.hubId} value={h.hubId}>
                {h.hubId}
              </option>
            ))}
          </select>
        </label>
        <label className="field-label">
          Fleet type
          <select
            className="field"
            value={fleetType}
            onChange={(e) => setFleetType(e.target.value as FleetTypeFilter)}
            aria-label="Filter by fleet type"
          >
            <option value="all">All</option>
            {FLEET_TYPES.map((ft) => (
              <option key={ft} value={ft}>
                {ft}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="kpi">
        <StatCard label="Active riders" value={totals.activeRiders ?? '—'} />
        <StatCard label="Online riders" value={totals.onlineRiders ?? '—'} />
        <StatCard label="Active orders" value={totals.activeOrders ?? '—'} />
        <StatCard label="In transit" value={totals.inTransit ?? '—'} />
        <StatCard label="Anomalies" value={totals.anomalies ?? '—'} tone={anomalies > 0 ? 'danger' : 'warn'} />
        <StatCard label="Open SOS" value={totals.openSos ?? '—'} tone="danger" />
      </div>

      <h2>By fleet type</h2>
      {!tower.byFleetType || tower.byFleetType.length === 0 ? (
        <EmptyState title="No fleet type breakdown" />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Fleet type</th>
                <th>Count</th>
              </tr>
            </thead>
            <tbody>
              {tower.byFleetType.map((row) => (
                <tr key={row.fleetType}>
                  <td>
                    <span className="tag">{row.fleetType}</span>
                  </td>
                  <td className="mono">{row.count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2>Hubs</h2>
      {tower.hubs.length === 0 ? (
        <EmptyState title="No hubs" />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Hub</th>
                <th>Region</th>
                <th>Active riders</th>
                <th>Active orders</th>
                <th>Anomalies</th>
                <th>Riders</th>
              </tr>
            </thead>
            <tbody>
              {tower.hubs.map((h) => (
                <tr key={h.hubId} className="row-click" onClick={() => setSelected(h)}>
                  <td className="strong">{h.name}</td>
                  <td>{h.region}</td>
                  <td className="mono">{h.activeRiders ?? '—'}</td>
                  <td className="mono">{h.activeOrders ?? '—'}</td>
                  <td className="mono">
                    {h.anomalies != null && h.anomalies > 0 ? (
                      <span className="tag bad">{h.anomalies}</span>
                    ) : (
                      h.anomalies ?? '—'
                    )}
                  </td>
                  <td>
                    <Link to="/logistics/riders" onClick={(e) => e.stopPropagation()}>
                      Riders
                    </Link>
                    <div className="muted small">query by hub on the riders page</div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {safetyActive ? (
        <SafetyActionsPanel />
      ) : (
        <p className="muted small">No open safety events.</p>
      )}

      <p className="muted small">
        Open SOS and anomaly flags carry safety context (crash/fatigue); forced-rest riders are blocked from new
        offers (REST_ENFORCED).
      </p>

      {selected && <HubDrawer hub={selected} onClose={() => setSelected(null)} />}
    </div>
  )
}

type SafetyPrompt = 'crash' | 'rest_enforce' | 'rest_relieve'

function SafetyActionsPanel() {
  const session = useSession()
  const canRespond = can(session, 'safety.respond')
  const [prompt, setPrompt] = useState<SafetyPrompt | null>(null)
  const [pending, setPending] = useState<SafetyPrompt | null>(null)

  if (!canRespond) return null

  return (
    <div className="state-card">
      <div className="state-title">Safety actions</div>
      <div className="state-message">
        Crash and fatigue responses for open safety events (crash/fatigue); forced-rest riders are
        blocked from new offers.
      </div>
      <div className="form-actions">
        <button
          type="button"
          className="btn btn-danger"
          onClick={() => {
            setPending(null)
            setPrompt('crash')
          }}
        >
          Respond to crash
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => {
            setPending(null)
            setPrompt('rest_enforce')
          }}
        >
          Enforce rest
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => {
            setPending(null)
            setPrompt('rest_relieve')
          }}
        >
          Relieve rest
        </button>
      </div>

      {pending && (
        <div className="state-card">
          <div className="state-title">
            <span className="mono">{PENDING_ENDPOINT_CODE}</span>
          </div>
          <div className="state-message">{pendingEndpointNotice(pending === 'crash' ? 'crash_respond' : 'rest_override')}</div>
          <p className="muted small">This action is documented for backend implementation — nothing was sent.</p>
        </div>
      )}

      {prompt === 'crash' && (
        <CrashPrompt
          onClose={() => setPrompt(null)}
          onSubmit={() => {
            setPending('crash')
            setPrompt(null)
          }}
        />
      )}
      {prompt === 'rest_enforce' && (
        <ReasonPrompt
          title="Enforce rest"
          description="Places the affected rider on mandatory rest — they are blocked from new offers (REST_ENFORCED)."
          onSubmit={() => {
            setPending('rest_enforce')
            setPrompt(null)
          }}
          onClose={() => setPrompt(null)}
        />
      )}
      {prompt === 'rest_relieve' && (
        <ReasonPrompt
          title="Relieve rest"
          description="Clears the mandatory-rest hold on the affected rider."
          onSubmit={() => {
            setPending('rest_relieve')
            setPrompt(null)
          }}
          onClose={() => setPrompt(null)}
        />
      )}
    </div>
  )
}

/** Crash response — reason plus a safe/unsafe outcome. */
function CrashPrompt({ onSubmit, onClose }: { onSubmit: (outcome: 'safe' | 'unsafe') => void; onClose: () => void }) {
  const [outcome, setOutcome] = useState<'safe' | 'unsafe'>('safe')

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    onSubmit(outcome)
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="Respond to crash"
        onClick={(e) => e.stopPropagation()}
        onSubmit={handleSubmit}
      >
        <h3 className="modal-title">Respond to crash</h3>
        <p className="muted small">Records the outcome of an open crash alert (safety.crash).</p>
        <label className="field-label" htmlFor="crash-reason">
          Reason
        </label>
        <textarea
          id="crash-reason"
          className="field"
          rows={3}
          maxLength={500}
          required
          placeholder="Explain why this action is taken (audited)"
        />
        <label className="field-block">
          <span className="field-label">Outcome</span>
          <select className="field" value={outcome} onChange={(e) => setOutcome(e.target.value as 'safe' | 'unsafe')}>
            <option value="safe">safe</option>
            <option value="unsafe">unsafe</option>
          </select>
        </label>
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-danger">
            Confirm
          </button>
        </div>
      </form>
    </div>
  )
}

function HubDrawer({ hub, onClose }: { hub: FleetOverviewHubsItem; onClose: () => void }) {
  return (
    <DetailDrawer title={hub.name} onClose={onClose}>
      <div className="meta-grid">
        <div className="meta-item">
          <span className="meta-label">Hub ID</span>
          <span className="meta-value mono">{hub.hubId}</span>
        </div>
        <div className="meta-item">
          <span className="meta-label">Name</span>
          <span className="meta-value">{hub.name}</span>
        </div>
        <div className="meta-item">
          <span className="meta-label">Region</span>
          <span className="meta-value">{hub.region}</span>
        </div>
        <div className="meta-item">
          <span className="meta-label">Active riders</span>
          <span className="meta-value mono">{hub.activeRiders ?? '—'}</span>
        </div>
        <div className="meta-item">
          <span className="meta-label">Active orders</span>
          <span className="meta-value mono">{hub.activeOrders ?? '—'}</span>
        </div>
        <div className="meta-item">
          <span className="meta-label">Anomalies</span>
          <span className="meta-value mono">{hub.anomalies ?? '—'}</span>
        </div>
      </div>
      <Link className="btn" to="/operations/hubs">
        Open hub
      </Link>
    </DetailDrawer>
  )
}
