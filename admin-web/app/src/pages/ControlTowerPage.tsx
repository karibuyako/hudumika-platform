import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  adminOperationsControlTower,
  type OperationsControlTower,
  type adminOperationsControlTowerResponseError,
  type adminOperationsControlTowerResponseSuccess,
} from '@hudumika/contract'
import { snapshotLabel } from '../lib/time'
import { parseApiError, type ApiErrorInfo } from '../lib/api-error'
import { useRefetchOnFocus } from '../lib/use-refetch-on-focus'
import { useServerEvents } from '../lib/use-server-events'
import { ErrorState } from '../components/ErrorState'
import { LoadingSkeleton } from '../components/LoadingSkeleton'

type Tower = OperationsControlTower

const CRITICAL_ACTION_LINKS = [
  { to: '/operations/exceptions', label: 'Shipment exceptions', key: 'shipmentExceptions' },
  { to: '/services/providers', label: 'Provider incidents', key: 'providerIncidents' },
  { to: '/finance/payments', label: 'Payment failures', key: 'paymentFailures' },
  { to: '/trust/risk-cases', label: 'Fraud cases', key: 'fraudCases' },
  { to: '/configuration/sla', label: 'SLA breaches', key: 'slaBreaches' },
  { to: '/operations/hubs', label: 'Hub capacity warnings', key: 'hubCapacityWarnings' },
] as const

function isSuccess(
  res: adminOperationsControlTowerResponseSuccess | adminOperationsControlTowerResponseError,
): res is adminOperationsControlTowerResponseSuccess {
  return res.status === 200
}

export function ControlTowerPage() {
  const [tower, setTower] = useState<Tower | null>(null)
  const [error, setError] = useState<ApiErrorInfo | null>(null)
  const [retryKey, setRetryKey] = useState(0)

  const load = useCallback(() => {
    setError(null)
    adminOperationsControlTower().then((res) => {
      if (isSuccess(res)) setTower(res.data)
      else setError(parseApiError(res, 'Control tower unavailable'))
    })
  }, [])

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

  const totals = tower.totals ?? {}

  return (
    <div className="page">
      <h1>Operations Control Tower</h1>
      <p className="muted">{snapshotLabel(tower.generatedAt)}</p>

      <AlertBanner criticalActions={tower.criticalActions} delayedShipments={totals.delayedShipments} />

      <div className="cards">
        <StatCard label="Orders today" value={totals.ordersToday} />
        <StatCard label="Active deliveries" value={totals.activeDeliveries} />
        <StatCard label="Active service jobs" value={totals.activeServiceJobs} />
        <StatCard label="Providers online" value={totals.providersOnline} />
        <StatCard label="Riders online" value={totals.ridersOnline} />
        <StatCard label="Open incidents" value={totals.openIncidents} />
        <StatCard label="Delayed shipments" value={totals.delayedShipments} />
        <StatCard label="Pending disputes" value={totals.pendingDisputes} />
      </div>

      <div className="cards">
        <NetworkCard
          title="Delivery network"
          normal={tower.networkHealth.deliveryNetwork?.normalPct}
          delayed={tower.networkHealth.deliveryNetwork?.delayedPct}
          critical={tower.networkHealth.deliveryNetwork?.criticalPct}
        />
        <NetworkCard
          title="Service network"
          normal={tower.networkHealth.serviceNetwork?.normalPct}
          delayed={tower.networkHealth.serviceNetwork?.capacityIssuePct}
          critical={tower.networkHealth.serviceNetwork?.criticalPct}
        />
      </div>

      <h2>Critical actions required</h2>
      <div className="queue-list">
        {CRITICAL_ACTION_LINKS.map(({ to, label, key }) => (
          <CriticalActionRow
            key={key}
            to={to}
            label={label}
            count={tower.criticalActions[key]}
          />
        ))}
      </div>
    </div>
  )
}

function AlertBanner({
  criticalActions,
  delayedShipments,
}: {
  criticalActions: OperationsControlTower['criticalActions']
  delayedShipments?: number
}) {
  const items: Array<{ key: string; text: string; to: string }> = []
  for (const { to, label, key } of CRITICAL_ACTION_LINKS) {
    const count = criticalActions[key]
    if (count && count > 0) items.push({ key, text: `${count} ${label.toLowerCase()} open`, to })
  }
  if (delayedShipments && delayedShipments > 0) {
    items.push({ key: 'delayedShipments', text: `${delayedShipments} orders delayed`, to: '/operations/exceptions' })
  }
  if (items.length === 0) return null
  return (
    <div className="notice" role="alert">
      {items.map((item, i) => (
        <span key={item.key}>
          {i > 0 && ' · '}
          {item.text}{' '}
          <Link to={item.to} className="strong">
            Open
          </Link>
        </span>
      ))}
    </div>
  )
}

function CriticalActionRow({ to, label, count }: { to: string; label: string; count?: number }) {
  const zero = (count ?? 0) === 0
  return (
    <Link className={`queue-item${zero ? ' muted' : ''}`} to={to}>
      <div className="queue-main">
        <div className="small">
          <span className="mono strong">{count ?? 0}</span> <span>{label}</span>
        </div>
      </div>
      <div className="queue-actions">
        <span className="muted small">Open queue →</span>
      </div>
    </Link>
  )
}

function StatCard({ label, value, danger }: { label: string; value?: number; danger?: boolean }) {
  return (
    <div className={`stat-card${danger ? ' danger' : ''}`}>
      <div className="stat-value">{value ?? '—'}</div>
      <div className="stat-label">{label}</div>
    </div>
  )
}

function NetworkCard({
  title,
  normal,
  delayed,
  critical,
}: {
  title: string
  normal?: number
  delayed?: number
  critical?: number
}) {
  return (
    <div className="stat-card">
      <div className="stat-label">{title}</div>
      <div className="network-row"><span className="dot ok" />Normal {normal != null ? `${pct(normal)}` : '—'}</div>
      <div className="network-row"><span className="dot warn" />Delayed {delayed != null ? `${pct(delayed)}` : '—'}</div>
      <div className="network-row"><span className="dot bad" />Critical {critical != null ? `${pct(critical)}` : '—'}</div>
    </div>
  )
}

function pct(v: number) {
  return `${Math.round(v * 100)}%`
}