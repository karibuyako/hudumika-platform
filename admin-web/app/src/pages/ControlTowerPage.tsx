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
import { useSession } from '../lib/session'
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

// Role-based widget configuration: which dashboard widgets each role can see.
const ROLE_WIDGETS: Record<string, string[]> = {
  'platform-owner': ['orders', 'revenue', 'riders', 'merchants', 'disputes', 'system-health', 'audit-recent'],
  'platform-administrator': ['orders', 'revenue', 'riders', 'merchants', 'disputes', 'system-health'],
  'operations-manager': ['orders', 'dispatch', 'riders', 'fleet', 'exceptions'],
  'dispatch-manager': ['orders', 'dispatch', 'riders', 'fleet'],
  'finance': ['revenue', 'payouts', 'reconciliation', 'cod'],
  'customer-support': ['orders', 'tickets', 'conversations', 'disputes'],
  'compliance': ['verifications', 'risk-cases', 'audit-recent', 'handoffs'],
  'risk-and-fraud': ['orders', 'risk-cases', 'disputes', 'riders'],
  'trust-and-safety': ['riders', 'providers', 'safety-events', 'conversations'],
  'merchant-operations': ['merchants', 'orders', 'finance'],
  'provider-operations': ['providers', 'orders'],
  'rider-operations': ['riders', 'fleet', 'cod'],
  'analytics': ['orders', 'revenue', 'analytics'],
  'marketing': ['promotions', 'group-buys', 'vouchers'],
  'content-manager': ['content', 'banners', 'promotions'],
  'technical-ops': ['system-health', 'webhooks', 'audit-recent'],
  'security-administrator': ['audit-recent', 'sessions', 'iam'],
  'read-only-auditor': ['audit-recent'],
}

function isSuccess(
  res: adminOperationsControlTowerResponseSuccess | adminOperationsControlTowerResponseError,
): res is adminOperationsControlTowerResponseSuccess {
  return res.status === 200
}

export function ControlTowerPage() {
  const [tower, setTower] = useState<Tower | null>(null)
  const [error, setError] = useState<ApiErrorInfo | null>(null)
  const [retryKey, setRetryKey] = useState(0)
  const session = useSession()

  const load = useCallback(() => {
    setError(null)
    setTower(null)
    adminOperationsControlTower()
      .then((res) => {
        if (isSuccess(res)) setTower(res.data)
        else setError(parseApiError(res, 'Control tower unavailable'))
      })
      .catch(() => setError(parseApiError({ status: 0, data: undefined }, 'Control tower unavailable')))
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

  // Determine which widgets the current role may see
  const userRole = session?.role ?? 'platform-owner'
  const allowedWidgets = ROLE_WIDGETS[userRole] ?? ROLE_WIDGETS['platform-owner']

  return (
    <div className="page">
      <h1>Operations Control Tower</h1>
      <p className="muted">{snapshotLabel(tower.generatedAt)}</p>

      {allowedWidgets.includes('orders') && (
        <AlertBanner criticalActions={tower.criticalActions} delayedShipments={totals.delayedShipments} />
      )}

      <div className="cards">
        {allowedWidgets.includes('orders') && <StatCard label="Orders today" value={totals.ordersToday} />}
        {allowedWidgets.includes('dispatch') && <StatCard label="Active deliveries" value={totals.activeDeliveries} />}
        {allowedWidgets.includes('orders') && <StatCard label="Active service jobs" value={totals.activeServiceJobs} />}
        {allowedWidgets.includes('providers') && <StatCard label="Providers online" value={totals.providersOnline} />}
        {allowedWidgets.includes('riders') && <StatCard label="Riders online" value={totals.ridersOnline} />}
        {allowedWidgets.includes('system-health') && <StatCard label="Open incidents" value={totals.openIncidents} />}
        {allowedWidgets.includes('dispatch') && <StatCard label="Delayed shipments" value={totals.delayedShipments} />}
        {allowedWidgets.includes('disputes') && <StatCard label="Pending disputes" value={totals.pendingDisputes} />}
      </div>

      <div className="cards">
        {allowedWidgets.includes('system-health') && (
          <NetworkCard
            title="Delivery network"
            normal={tower.networkHealth.deliveryNetwork?.normalPct}
            delayed={tower.networkHealth.deliveryNetwork?.delayedPct}
            critical={tower.networkHealth.deliveryNetwork?.criticalPct}
          />
        )}
        {allowedWidgets.includes('system-health') && (
          <NetworkCard
            title="Service network"
            normal={tower.networkHealth.serviceNetwork?.normalPct}
            delayed={tower.networkHealth.serviceNetwork?.capacityIssuePct}
            critical={tower.networkHealth.serviceNetwork?.criticalPct}
          />
        )}
      </div>

      {allowedWidgets.includes('exceptions') && (
        <>
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
        </>
      )}
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