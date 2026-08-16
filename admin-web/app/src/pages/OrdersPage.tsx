import { useEffect, useMemo, useState } from 'react'
import { adminListOrders, type OrderDetail, type OrderStatus } from '@hudumika/contract'
import { PriorityBadge } from '../components/PriorityBadge'
import { DataTable, type DataTableColumn } from '../components/DataTable'
import { ErrorState } from '../components/ErrorState'
import { LoadingSkeleton } from '../components/LoadingSkeleton'
import { ReasonPrompt } from '../components/ReasonPrompt'
import { formatTZS } from '../lib/money'
import { PENDING_ENDPOINT_CODE, pendingEndpointNotice } from '../lib/pending-endpoints'
import { can } from '../lib/permissions'
import { useSession } from '../lib/session'
import { toLocal } from '../lib/time'

type Bucket = 'all' | 'needs_rider' | 'active' | 'completed' | 'failed' | 'cancelled' | 'dine_in'

const CANCELLABLE: OrderStatus[] = ['paid', 'merchant_accepted', 'preparing', 'rider_assigned', 'picked_up']

const COLUMNS: DataTableColumn<OrderDetail>[] = [
  { key: 'no', header: 'Number', render: (o) => o.no ?? short(o.id), sortValue: (o) => o.no ?? o.id },
  { key: 'status', header: 'Status', render: (o) => <StatusBadge status={o.status} /> },
  { key: 'priority', header: 'Priority', render: (o) => <PriorityBadge priority={o.priority} /> },
  { key: 'merchant', header: 'Merchant', render: (o) => short(o.merchantId) },
  { key: 'rider', header: 'Rider', render: (o) => (o.riderId ? short(o.riderId) : '—') },
  { key: 'total', header: 'Total', render: (o) => formatTZS(o.totals?.totalTZS), sortValue: (o) => o.totals?.totalTZS ?? 0, align: 'right' },
  { key: 'created', header: 'Created', render: (o) => toLocal(o.createdAt), className: 'muted' },
]

const BUCKETS: Array<{ key: Bucket; label: string; match: (o: OrderDetail) => boolean }> = [
  { key: 'all', label: 'All', match: () => true },
  {
    key: 'needs_rider',
    label: 'Needs rider',
    match: (o) => !o.riderId && ['paid', 'merchant_accepted', 'preparing'].includes(o.status),
  },
  {
    key: 'active',
    label: 'Active',
    match: (o) =>
      ['paid', 'merchant_accepted', 'preparing', 'rider_assigned', 'rider_arrived_pickup', 'picked_up', 'delivering', 'rider_arrived_dropoff', 'rescheduled'].includes(o.status),
  },
  { key: 'completed', label: 'Completed', match: (o) => ['delivered', 'completed'].includes(o.status) },
  {
    key: 'failed',
    label: 'Failed',
    match: (o) => ['failed_delivery', 'timed_out', 'returning', 'failed', 'disputed', 'refunded'].includes(o.status),
  },
  { key: 'cancelled', label: 'Cancelled', match: (o) => o.status === 'cancelled' },
  {
    key: 'dine_in',
    label: 'Dine-in',
    match: (o) => (o.fulfillmentType as string | undefined) === 'dine_in',
  },
]

export function OrdersPage() {
  const [orders, setOrders] = useState<OrderDetail[] | null>(null)
  const [bucket, setBucket] = useState<Bucket>('all')
  const [selected, setSelected] = useState<OrderDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [retryKey, setRetryKey] = useState(0)

  useEffect(() => {
    setError(null)
    adminListOrders().then((res) => {
      if (res.status === 200) setOrders(res.data)
      else setError(`Failed to load orders (${res.status})`)
    })
  }, [retryKey])

  const counts = useMemo(() => {
    if (!orders) return new Map<Bucket, number>()
    const map = new Map<Bucket, number>()
    for (const b of BUCKETS) map.set(b.key, orders.filter(b.match).length)
    return map
  }, [orders])

  const visible = useMemo(() => (orders ?? []).filter(BUCKETS.find((b) => b.key === bucket)!.match), [orders, bucket])

  if (error) return <ErrorState title="Failed to load orders" message={error} onRetry={() => setRetryKey((k) => k + 1)} />
  if (!orders) return <LoadingSkeleton />

  return (
    <div className="page">
      <h1>Orders</h1>
      <div className="filters">
        {BUCKETS.map((b) => (
          <button
            key={b.key}
            className={`chip${bucket === b.key ? ' active' : ''}`}
            onClick={() => setBucket(b.key)}
          >
            {b.label} <span className="chip-count">{counts.get(b.key) ?? 0}</span>
          </button>
        ))}
      </div>

      <DataTable
        rows={visible}
        columns={COLUMNS}
        rowKey={(o) => o.id}
        onRowClick={setSelected}
        exportable
        exportFileName="orders"
        emptyTitle="No orders in this bucket"
        ariaLabel="Orders"
      />

      {selected && <OrderDrawer order={selected} onClose={() => setSelected(null)} />}
    </div>
  )
}

function OrderDrawer({ order, onClose }: { order: OrderDetail; onClose: () => void }) {
  const t = order.totals
  const session = useSession()
  const allowed = can(session, 'order.cancel') && CANCELLABLE.includes(order.status)
  const [confirmCancel, setConfirmCancel] = useState(false)
  const [pending, setPending] = useState(false)

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <div className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <h2>{order.no ?? short(order.id)}</h2>
          <button className="btn" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="drawer-grid">
          <div>
            <h3>Status</h3>
            <div className="status-pipeline">
              {PIPELINE.map((s) => (
                <span
                  key={s}
                  className={`pipeline-step${order.status === s ? ' current' : pipelineDone(order, s) ? ' done' : ''}`}
                  title={s}
                />
              ))}
            </div>
            <p className="muted small">{order.status}</p>

            <h3>Items</h3>
            {(order.items ?? []).length === 0 && <p className="muted small">No line items</p>}
            <table className="table table-sm">
              <tbody>
                {(order.items ?? []).map((item, i) => (
                  <tr key={i}>
                    <td>{item.name}</td>
                    <td>×{item.quantity}</td>
                    <td>{formatTZS(item.unitPriceTZS)}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            <h3>Events</h3>
            <div className="timeline">
              {[...(order.events ?? [])]
                .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
                .map((ev, i) => (
                  <div key={i} className="timeline-item">
                    <div className="timeline-dot" />
                    <div>
                      <div className="small strong">{ev.status}</div>
                      <div className="muted small">
                        {toLocal(ev.at)} · {ev.by}
                      </div>
                      {ev.note && <div className="muted small">{ev.note}</div>}
                    </div>
                  </div>
                ))}
            </div>
          </div>
          <div>
            <h3>Delivery</h3>
            {order.deliveryAddress && (
              <p className="small">
                {order.deliveryAddress.label}
                <br />
                <span className="muted">{order.deliveryAddress.lines}</span>
                {order.deliveryAddress.landmark && (
                  <>
                    <br />
                    <span className="muted">{order.deliveryAddress.landmark}</span>
                  </>
                )}
                <br />
                <span className="muted">{order.deliveryAddress.contactPhone}</span>
              </p>
            )}

            <h3>Money (TZS)</h3>
            <table className="table table-sm">
              <tbody>
                {t && (
                  <>
                    <tr><td>Subtotal</td><td>{formatTZS(t.subtotalTZS)}</td></tr>
                    <tr><td>Delivery fee</td><td>{formatTZS(t.deliveryFeeTZS)}</td></tr>
                    <tr><td>Platform fee</td><td>{formatTZS(t.platformFeeTZS)}</td></tr>
                    <tr><td>Tax</td><td>{formatTZS(t.taxTZS)}</td></tr>
                    <tr><td>Discount</td><td>{t.discountTZS ? `−${formatTZS(t.discountTZS)}` : formatTZS(t.discountTZS)}</td></tr>
                    <tr className="row-total"><td>Total</td><td>{formatTZS(t.totalTZS)}</td></tr>
                  </>
                )}
              </tbody>
            </table>

            <h3>Assignment</h3>
            <p className="small">
              Rider: <span className="muted">{order.riderId ? short(order.riderId) : 'unassigned'}</span>
              <br />
              Merchant: <span className="muted">{short(order.merchantId)}</span>
              <br />
              Source: <span className="muted">{order.source ?? 'app'}</span>
              <br />
              Strategy: <span className="muted">{order.dispatchStrategy ?? '—'}</span>
            </p>
          </div>
        </div>

        {allowed && (
          <>
            <hr className="divider" />
            <div className="page-actions">
              <button
                type="button"
                className="btn btn-danger"
                onClick={() => {
                  setPending(false)
                  setConfirmCancel(true)
                }}
              >
                Cancel order
              </button>
            </div>
          </>
        )}

        {pending && (
          <div className="state-card">
            <div className="state-title">
              <span className="mono">{PENDING_ENDPOINT_CODE}</span>
            </div>
            <div className="state-message">{pendingEndpointNotice('order_cancel')}</div>
            <p className="muted small">This action is documented for backend implementation — nothing was sent.</p>
          </div>
        )}
      </div>

      {confirmCancel && (
        <ReasonPrompt
          title="Cancel order"
          description={`${order.no ?? order.id} — current status: ${order.status}.`}
          tone="danger"
          confirmLabel="Confirm"
          onSubmit={() => {
            setPending(true)
            setConfirmCancel(false)
          }}
          onClose={() => setConfirmCancel(false)}
        />
      )}
    </div>
  )
}

const PIPELINE: OrderStatus[] = [
  'paid',
  'merchant_accepted',
  'preparing',
  'rider_assigned',
  'picked_up',
  'delivering',
  'delivered',
  'completed',
]

function pipelineDone(order: OrderDetail, step: OrderStatus) {
  return PIPELINE.indexOf(order.status) > PIPELINE.indexOf(step)
}

export function StatusBadge({ status }: { status: OrderStatus }) {
  const cls =
    ['delivered', 'completed'].includes(status)
      ? 'ok'
      : ['failed_delivery', 'timed_out', 'failed', 'disputed', 'returning', 'refunded', 'cancelled'].includes(status)
        ? 'bad'
        : ''
  return <span className={`badge ${cls}`}>{status}</span>
}

function short(id: string) {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id
}
