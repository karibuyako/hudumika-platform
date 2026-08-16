import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  listRoutes,
  logisticsControlTower,
  type ControlTower,
  type ControlTowerCriticalExceptionsItemType,
  type logisticsControlTowerResponseError,
  type logisticsControlTowerResponseSuccess,
  type Route,
} from '@hudumika/contract'
import { EmptyState } from '../../components/EmptyState'
import { ErrorState } from '../../components/ErrorState'
import { LoadingSkeleton } from '../../components/LoadingSkeleton'
import { StatCard } from '../../components/StatCard'
import { StatusPill } from '../../components/StatusPill'
import { parseApiError, type ApiErrorInfo } from '../../lib/api-error'
import { snapshotLabel } from '../../lib/time'
import { useRefetchOnFocus } from '../../lib/use-refetch-on-focus'
import { useServerEvents } from '../../lib/use-server-events'

type Tower = ControlTower

function isSuccess(
  res: logisticsControlTowerResponseSuccess | logisticsControlTowerResponseError,
): res is logisticsControlTowerResponseSuccess {
  return res.status === 200
}

const EXCEPTION_TONES: Record<ControlTowerCriticalExceptionsItemType, 'warn' | 'bad'> = {
  wrong_hub_scan: 'warn',
  vehicle_delayed: 'warn',
  package_missing: 'bad',
  rider_no_show: 'bad',
  seal_broken: 'bad',
  reconciliation_failed: 'bad',
}

export function LogisticsTowerPage() {
  const [tower, setTower] = useState<Tower | null>(null)
  const [error, setError] = useState<ApiErrorInfo | null>(null)
  const [retryKey, setRetryKey] = useState(0)
  const [routes, setRoutes] = useState<Route[] | null>(null)
  const [routesError, setRoutesError] = useState(false)

  const load = useCallback(() => {
    setError(null)
    logisticsControlTower().then((res) => {
      if (isSuccess(res)) setTower(res.data)
      else setError(parseApiError(res, 'Logistics tower unavailable'))
    })
  }, [])

  useEffect(() => {
    load()
  }, [load, retryKey])

  useEffect(() => {
    let cancelled = false
    setRoutes(null)
    setRoutesError(false)
    listRoutes().then((res) => {
      if (cancelled) return
      if (res.status === 200) setRoutes(res.data)
      else setRoutesError(true)
    })
    return () => {
      cancelled = true
    }
  }, [retryKey])

  useRefetchOnFocus(load)
  useServerEvents({ enabled: !!tower, onEvent: () => load() })

  if (error) {
    return (
      <ErrorState
        title="Logistics tower unavailable"
        message={error.message}
        requestId={error.requestId}
        onRetry={() => setRetryKey((k) => k + 1)}
      />
    )
  }
  if (!tower) return <LoadingSkeleton kind="stats" />
  if (!tower.totals) {
    return (
      <EmptyState title="Logistics tower unavailable" hint="Totals could not be loaded for this snapshot." />
    )
  }

  const totals = tower.totals
  const tripsByHub = totals.tripsByHub ?? []
  const maxTrips = tripsByHub.reduce((max, hub) => Math.max(max, hub.trips), 0)
  const exceptions = tower.criticalExceptions ?? []

  return (
    <div className="page">
      <h1>Logistics Control Tower</h1>
      <p className="muted">{snapshotLabel(tower.generatedAt)}</p>

      <div className="kpi">
        <StatCard label="Active shipments" value={totals.activeShipments} />
        <StatCard label="Delayed" value={totals.delayed} tone="warn" />
        <StatCard label="Exceptions" value={totals.exceptions} tone="danger" />
        <StatCard label="At risk" value={totals.atRisk} tone="warn" />
        <StatCard label="Active trips" value={totals.activeTrips} />
      </div>

      <section>
        <h2>Trips by hub</h2>
        <p className="muted small">Corridor and map views ship in a later release.</p>
        {tripsByHub.length === 0 ? (
          <EmptyState title="No hub trips" hint="Trip distribution appears once trips are scheduled." />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Hub</th>
                  <th>Trips</th>
                  <th>Share</th>
                </tr>
              </thead>
              <tbody>
                {tripsByHub.map((hub) => (
                  <tr key={hub.hubName}>
                    <td className="strong">{hub.hubName}</td>
                    <td className="mono">{hub.trips}</td>
                    <td>
                      <div className="bar-track" style={{ width: 120 }}>
                        <div
                          className="bar-fill"
                          style={{ width: `${maxTrips > 0 ? Math.round((hub.trips / maxTrips) * 100) : 0}%` }}
                        />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <h2>Corridors</h2>
        <p className="muted small">Corridor map view ships with the backend map milestone.</p>
        {routes === null ? (
          <LoadingSkeleton kind="table" rows={3} />
        ) : routesError ? (
          <p className="muted small">Routes could not be loaded for this snapshot.</p>
        ) : routes.length === 0 ? (
          <EmptyState title="No routes" hint="Corridor routes appear once transport routes are configured." />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Route</th>
                  <th>Corridor</th>
                  <th>Est. hours</th>
                  <th>Departures</th>
                  <th>Vehicles</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {routes.map((route) => (
                  <tr key={route.id}>
                    <td className="strong">{route.name}</td>
                    <td className="mono">
                      {route.fromHubId} → {route.toHubId}
                    </td>
                    <td className="mono">{route.estimatedHours ?? '—'}</td>
                    <td className="mono">
                      {route.scheduledDepartures != null ? route.scheduledDepartures.length : '—'}
                    </td>
                    <td>
                      {(route.permittedVehicles ?? []).length === 0 ? (
                        <span className="muted">—</span>
                      ) : (
                        (route.permittedVehicles ?? []).map((v) => (
                          <span key={v} className="tag">
                            {v}
                          </span>
                        ))
                      )}
                    </td>
                    <td>
                      <StatusPill
                        status={route.active ? 'active' : 'inactive'}
                        tone={route.active ? 'ok' : 'muted'}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <h2>Critical exceptions</h2>
        <p className="muted small">
          Exceptions are machine-fed — never manually composed; each links to the shipment custody chain and
          runbook.
        </p>
        {exceptions.length === 0 ? (
          <EmptyState title="No critical exceptions" hint="Machine-fed exceptions appear here." />
        ) : (
          <div className="queue-list">
            {exceptions.map((ex) => (
              <Link className="queue-item" key={ex.shipmentId} to="/logistics/shipments">
                <div className="queue-main">
                  <div className="small">
                    <span className={`tag ${EXCEPTION_TONES[ex.type]}`}>{ex.type.replace(/_/g, ' ')}</span>
                  </div>
                  <div className="mono">{ex.shipmentId}</div>
                  <div className="muted small">{ex.detail ?? '—'}</div>
                </div>
                <div className="queue-actions">
                  <span className="muted small">Open shipment →</span>
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
