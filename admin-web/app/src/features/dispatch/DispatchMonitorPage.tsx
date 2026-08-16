import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  adminEscalateShipment,
  adminListOrders,
  adminListRiders,
  listShipments,
  type OrderDetail,
  type OrderStatus,
  type RiderAdmin,
  type Shipment,
  type ShipmentStatus,
} from '@hudumika/contract'
import { PriorityBadge } from '../../components/PriorityBadge'
import { EmptyState } from '../../components/EmptyState'
import { ErrorState } from '../../components/ErrorState'
import { Toast } from '../../components/FormBits'
import { LoadingSkeleton } from '../../components/LoadingSkeleton'
import { ReasonPrompt } from '../../components/ReasonPrompt'
import { StatCard } from '../../components/StatCard'
import { StatusPill } from '../../components/StatusPill'
import { parseApiError } from '../../lib/api-error'
import { formatTZS } from '../../lib/money'
import { can } from '../../lib/permissions'
import { useSession } from '../../lib/session'
import { toLocal } from '../../lib/time'

const DISPATCHABLE: OrderStatus[] = ['paid', 'merchant_accepted', 'preparing']

const STUCK_MINUTES = 30
const TIMEOUT_MINUTES = 10
const SHIPMENT_STUCK_MINUTES = 60

const STUCK_SHIPMENT_STATUSES: ShipmentStatus[] = ['planned', 'picked_up', 'at_hub']

const OPEN_SHIPMENT_STATUSES: ShipmentStatus[] = [
  'planned',
  'picked_up',
  'at_hub',
  'in_transit',
  'out_for_delivery',
  'exception',
]

function minutesSince(iso: string | null | undefined): number {
  if (!iso) return 0
  const ms = Date.now() - new Date(iso).getTime()
  return Math.max(0, Math.floor(ms / 60000))
}

function short(id: string) {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id
}

export function DispatchMonitorPage() {
  const [orders, setOrders] = useState<OrderDetail[] | null>(null)
  const [riders, setRiders] = useState<RiderAdmin[] | null>(null)
  const [shipments, setShipments] = useState<Shipment[] | null>(null)
  const [promptShipment, setPromptShipment] = useState<Shipment | null>(null)
  const [promptError, setPromptError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [retryKey, setRetryKey] = useState(0)

  const session = useSession()
  const canEscalate = can(session, 'shipment.reassign')

  useEffect(() => {
    setError(null)
    let cancelled = false
    Promise.all([adminListOrders(), adminListRiders(), listShipments()]).then(
      ([ordersRes, ridersRes, shipmentsRes]) => {
        if (cancelled) return
        if (ordersRes.status !== 200 || ridersRes.status !== 200 || shipmentsRes.status !== 200) {
          setError('Failed to load dispatch monitor')
          return
        }
        setOrders(ordersRes.data)
        setRiders(ridersRes.data)
        setShipments(shipmentsRes.data)
      },
    )
    return () => {
      cancelled = true
    }
  }, [retryKey])

  const approvedRiders = useMemo(
    () => (riders ?? []).filter((r) => r.verification === 'approved'),
    [riders],
  )

  const poolByCity = useMemo(() => {
    const counts = new Map<string, number>()
    for (const r of approvedRiders) counts.set(r.city, (counts.get(r.city) ?? 0) + 1)
    return [...counts.entries()]
      .map(([city, count]) => ({ city, count }))
      .sort((a, b) => b.count - a.count)
  }, [approvedRiders])

  const maxPool = poolByCity[0]?.count ?? 0

  const stuckOrders = useMemo(() => {
    if (!orders) return []
    return orders
      .filter((o) => DISPATCHABLE.includes(o.status) && minutesSince(o.createdAt) > STUCK_MINUTES)
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
  }, [orders])

  const timeoutOrders = useMemo(() => {
    if (!orders) return []
    return orders
      .filter(
        (o) =>
          ['paid', 'merchant_accepted'].includes(o.status) &&
          !o.riderId &&
          minutesSince(o.createdAt) > TIMEOUT_MINUTES,
      )
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
  }, [orders])

  const openShipments = useMemo(
    () => (shipments ?? []).filter((s) => OPEN_SHIPMENT_STATUSES.includes(s.status)).length,
    [shipments],
  )

  const stuckShipments = useMemo(() => {
    if (!shipments) return []
    return shipments
      .filter(
        (s) =>
          STUCK_SHIPMENT_STATUSES.includes(s.status) && minutesSince(s.createdAt) > SHIPMENT_STUCK_MINUTES,
      )
      .sort((a, b) => minutesSince(a.createdAt) - minutesSince(b.createdAt))
  }, [shipments])

  async function escalate(reason: string) {
    const target = promptShipment
    if (!target) return
    setBusy(true)
    setPromptError(null)
    const res = await adminEscalateShipment(target.id, { reason })
    if (res.status === 200) {
      setShipments((prev) => (prev ?? []).map((sh) => (sh.id === res.data.id ? res.data : sh)))
      setPromptShipment(null)
      setToast(`Shipment ${target.shipmentNumber} escalated`)
      setRetryKey((k) => k + 1)
    } else {
      setPromptError(parseApiError(res).message)
    }
    setBusy(false)
  }

  if (error) {
    return (
      <ErrorState
        title="Dispatch monitor unavailable"
        message={error}
        onRetry={() => setRetryKey((k) => k + 1)}
      />
    )
  }
  if (!orders || !riders || !shipments) return <LoadingSkeleton kind="table" rows={6} />

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Dispatch Monitor</h1>
          <p className="muted">
            {stuckOrders.length} stuck orders · {timeoutOrders.length} acceptance timeouts ·{' '}
            {stuckShipments.length} stuck shipments
          </p>
        </div>
      </div>

      {toast && <Toast message={toast} />}

      <div className="kpi">
        <StatCard label="Stuck orders" value={stuckOrders.length} tone="danger" />
        <StatCard label="Acceptance timeouts" value={timeoutOrders.length} tone="warn" />
        <StatCard label="Open shipments" value={openShipments} />
        <StatCard label="Rider pool cities" value={poolByCity.length} />
        <StatCard label="Online riders" value={approvedRiders.length} />
      </div>

      <section>
        <h2>Stuck orders</h2>
        {stuckOrders.length === 0 ? (
          <EmptyState title="No stuck orders" hint="Orders in dispatchable statuses over 30 minutes appear here." />
        ) : (
          <div className="queue-list">
            {stuckOrders.map((order) => {
              const age = minutesSince(order.createdAt)
              return (
                <div key={order.id} className="queue-item">
                  <div className="queue-main">
                    <div className="mono-strong">{order.no ?? short(order.id)}</div>
                    <div className="small">
                      <StatusPill status={order.status} tone="info" />
                      <PriorityBadge priority={order.priority} />
                    </div>
                    <div className="muted small">
                      Rider {order.riderId ? short(order.riderId) : '—'} · {formatTZS(order.totals?.totalTZS)}
                    </div>
                  </div>
                  <div className="queue-actions">
                    <div>
                      <div className="small strong">{age} min</div>
                      <div className="muted small">{toLocal(order.createdAt)}</div>
                    </div>
                    <Link className="btn" to="/operations/dispatch">
                      Open in console
                    </Link>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </section>

      <section>
        <h2>Acceptance timeouts</h2>
        {timeoutOrders.length === 0 ? (
          <EmptyState
            title="No acceptance timeouts"
            hint="Paid orders without a rider for over 10 minutes appear here."
          />
        ) : (
          <div className="queue-list">
            {timeoutOrders.map((order) => {
              const age = minutesSince(order.createdAt)
              return (
                <div key={order.id} className="queue-item">
                  <div className="queue-main">
                    <div className="mono-strong">{order.no ?? short(order.id)}</div>
                    <div className="muted small">
                      Merchant {short(order.merchantId)} · {formatTZS(order.totals?.totalTZS)}
                    </div>
                  </div>
                  <div className="queue-actions">
                    <div>
                      <div className="small strong">{age} min</div>
                      <div className="muted small">{toLocal(order.createdAt)}</div>
                    </div>
                    <Link className="btn" to="/operations/dispatch">
                      Open in console
                    </Link>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </section>

      <section>
        <h2>Rider pool depth</h2>
        <p className="muted small">Shallow pools flag dispatch risk.</p>
        {poolByCity.length === 0 ? (
          <EmptyState title="No approved riders" hint="Rider pools appear once riders are approved." />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>City</th>
                  <th>Riders</th>
                  <th>Depth</th>
                </tr>
              </thead>
              <tbody>
                {poolByCity.map((pool) => (
                  <tr key={pool.city}>
                    <td className="strong">{pool.city}</td>
                    <td>{pool.count}</td>
                    <td>
                      <div className="bar-track" style={{ width: 120 }}>
                        <div
                          className="bar-fill"
                          style={{ width: `${maxPool > 0 ? Math.round((pool.count / maxPool) * 100) : 0}%` }}
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
        <h2>Stuck shipments</h2>
        <p className="muted small">Planned, picked up, or at hub for over 60 minutes.</p>
        {stuckShipments.length === 0 ? (
          <EmptyState title="No stuck shipments" hint="Escalation candidates appear here." />
        ) : (
          <div className="queue-list">
            {stuckShipments.map((shipment) => {
              const age = minutesSince(shipment.createdAt)
              return (
                <div key={shipment.id} className="queue-item">
                  <div className="queue-main">
                    <div className="mono-strong">{shipment.shipmentNumber}</div>
                    <div className="small">
                      <StatusPill status={shipment.status} tone="warn" />
                    </div>
                  </div>
                  <div className="queue-actions">
                    <div>
                      <div className="small strong">{age} min</div>
                      <div className="muted small">{toLocal(shipment.createdAt)}</div>
                    </div>
                    {canEscalate && (
                      <button
                        className="btn btn-danger"
                        onClick={() => {
                          setToast(null)
                          setPromptError(null)
                          setPromptShipment(shipment)
                        }}
                      >
                        Escalate
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </section>

      {promptShipment && (
        <ReasonPrompt
          title={`Escalate ${promptShipment.shipmentNumber}`}
          description="Raises the shipment to security — reserved for serious incidents."
          tone="danger"
          maxLength={500}
          busy={busy}
          error={promptError}
          onSubmit={escalate}
          onClose={() => setPromptShipment(null)}
        />
      )}
    </div>
  )
}
