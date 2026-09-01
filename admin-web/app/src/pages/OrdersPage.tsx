import { useEffect, useMemo, useState, type FormEvent } from 'react'
import {
  adminCancelOrder,
  adminDisputeDecision,
  adminListOrders,
  adminListRiders,
  adminAssignOrderToRider,
  type OrderDetail,
  type OrderStatus,
  type RiderAdmin,
} from '@hudumika/contract'
import { PriorityBadge } from '../components/PriorityBadge'
import { DataTable, type DataTableColumn } from '../components/DataTable'
import { ErrorState } from '../components/ErrorState'
import { LoadingSkeleton } from '../components/LoadingSkeleton'
import { ReasonPrompt } from '../components/ReasonPrompt'
import { Toast } from '../components/FormBits'
import { formatTZS } from '../lib/money'
import { can } from '../lib/permissions'
import { getLimits } from '../lib/limits'
import { useSession } from '../lib/session'
import { toLocal } from '../lib/time'
import { parseApiError, type ApiErrorInfo } from '../lib/api-error'

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
  const [error, setError] = useState<ApiErrorInfo | null>(null)
  const [retryKey, setRetryKey] = useState(0)
  const [toast, setToast] = useState<string | null>(null)

  useEffect(() => {
    setError(null)
    adminListOrders()
      .then((res) => {
        if (res.status === 200) setOrders(res.data)
        else setError(parseApiError(res, 'Failed to load orders'))
      })
      .catch(() => setError(parseApiError({ status: 0, data: undefined }, 'Failed to load orders')))
  }, [retryKey])

  async function handleCancel(orderId: string, reason: string): Promise<ApiErrorInfo | null> {
    const res = await adminCancelOrder(orderId, { reason })
    if (res.status === 200) {
      setOrders((prev) => (prev ?? []).map((o) => (o.id === orderId ? { ...o, status: 'cancelled' as OrderStatus } : o)))
      setSelected((prev) => (prev && prev.id === orderId ? { ...prev, status: 'cancelled' as OrderStatus } : prev))
      setToast('Order cancelled')
      return null
    }
    return parseApiError(res, 'Cancel failed')
  }

  const counts = useMemo(() => {
    if (!orders) return new Map<Bucket, number>()
    const map = new Map<Bucket, number>()
    for (const b of BUCKETS) map.set(b.key, orders.filter(b.match).length)
    return map
  }, [orders])

  const visible = useMemo(() => (orders ?? []).filter(BUCKETS.find((b) => b.key === bucket)!.match), [orders, bucket])

  if (error) return <ErrorState title="Failed to load orders" message={error.message} requestId={error.requestId} onRetry={() => setRetryKey((k) => k + 1)} />
  if (!orders) return <LoadingSkeleton />

  return (
    <div className="page">
      <div className="page-title-row">
        <h1>Orders</h1>
        {toast && (
          <div className="page-actions">
            <Toast message={toast} />
          </div>
        )}
      </div>
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

      {selected && <OrderDrawer order={selected} onClose={() => setSelected(null)} onCancel={handleCancel} />}
    </div>
  )
}

function OrderDrawer({
  order,
  onClose,
  onCancel,
}: {
  order: OrderDetail
  onClose: () => void
  onCancel: (orderId: string, reason: string) => Promise<ApiErrorInfo | null>
}) {
  const t = order.totals
  const session = useSession()
  const allowed = can(session, 'order.cancel') && CANCELLABLE.includes(order.status)
  const [confirmCancel, setConfirmCancel] = useState(false)
  const [busy, setBusy] = useState(false)
  const [cancelError, setCancelError] = useState<ApiErrorInfo | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  // Assign rider state
  const [riders, setRiders] = useState<RiderAdmin[]>([])
  const [assignRiderId, setAssignRiderId] = useState('')
  const [assigning, setAssigning] = useState(false)
  const [assignError, setAssignError] = useState<ApiErrorInfo | null>(null)
  const [assignPrompt, setAssignPrompt] = useState(false)
  const canAssign = can(session, 'dispatch.assign')
  const needsRider = !order.riderId && ['paid', 'merchant_accepted', 'preparing'].includes(order.status)

  useEffect(() => {
    if (!canAssign || !needsRider) return
    adminListRiders().then((res) => {
      if (res.status === 200) setRiders(res.data.filter((r) => r.verification === 'approved'))
    })
  }, [canAssign, needsRider])

  async function handleAssign(riderId: string, reason: string) {
    setBusy(true)
    setAssignError(null)
    const res = await adminAssignOrderToRider(order.id, { riderId, reason })
    setBusy(false)
    if (res.status === 200) {
      setToast(`Order assigned to ${riderId}`)
      onClose()
    } else {
      setAssignError(parseApiError(res, 'Assignment failed'))
    }
  }
  const canDispute = can(session, 'dispute.resolve') || can(session, 'order.cancel')
  const [disputePrompt, setDisputePrompt] = useState(false)
  const [disputeDecision, setDisputeDecision] = useState<'refund' | 'payout' | 'reject'>('refund')
  const [disputeAmount, setDisputeAmount] = useState('')
  const [disputeReason, setDisputeReason] = useState('')
  const [disputeBusy, setDisputeBusy] = useState(false)
  const [disputeError, setDisputeError] = useState<ApiErrorInfo | null>(null)

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

            {canAssign && needsRider && riders.length > 0 && (
              <div className="detail-section">
                <h3>Assign rider</h3>
                <label className="field-label" htmlFor="assign-rider-select">Select a rider</label>
                <select
                  id="assign-rider-select"
                  className="field"
                  value={assignRiderId}
                  onChange={(e) => setAssignRiderId(e.target.value)}
                >
                  <option value="">Choose rider…</option>
                  {riders.map((r) => (
                    <option key={r.id} value={r.id}>{r.name} · {r.city} · {r.vehicle}</option>
                  ))}
                </select>
                {assignError && (
                  <div className="inline-error" role="alert">
                    <div>{assignError.message}</div>
                    <div className="muted small">{assignError.code}{assignError.requestId ? ` · request ${assignError.requestId}` : ''}</div>
                  </div>
                )}
                <div className="form-actions">
                  <button
                    type="button"
                    className="btn"
                    disabled={!assignRiderId || busy}
                    onClick={() => {
                      setAssignError(null)
                      setAssignPrompt(true)
                    }}
                  >
                    {busy ? 'Assigning…' : 'Assign rider'}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        {order.status === 'disputed' && canDispute && (
          <div className="detail-section">
            <h3>Dispute resolution</h3>
            <button
              type="button"
              className="btn btn-danger"
              onClick={() => {
                setDisputeError(null)
                setDisputePrompt(true)
              }}
            >
              Resolve dispute
            </button>
            <p className="muted small">Refund/payout above {formatTZS(getLimits().twoPersonThresholdTzs)} requires two-person approval.</p>
          </div>
        )}

        {allowed && (
          <>
            <hr className="divider" />
            <div className="page-actions">
              <button
                type="button"
                className="btn btn-danger"
                onClick={() => {
                  setCancelError(null)
                  setConfirmCancel(true)
                }}
              >
                Cancel order
              </button>
            </div>
          </>
        )}
      </div>

      {confirmCancel && (
        <ReasonPrompt
          title="Cancel order"
          description={`${order.no ?? order.id} — current status: ${order.status}.`}
          tone="danger"
          confirmLabel="Confirm"
          busy={busy}
          error={cancelError}
          onSubmit={async (reason) => {
            setBusy(true)
            setCancelError(null)
            const err = await onCancel(order.id, reason)
            setBusy(false)
            if (err) {
              setCancelError(err)
            } else {
              setConfirmCancel(false)
              onClose()
            }
          }}
          onClose={() => {
            if (!busy) setConfirmCancel(false)
          }}
        />
      )}

      {assignPrompt && (
        <ReasonPrompt
          title="Assign rider"
          description={`${order.no ?? order.id} — assigning rider ${assignRiderId}.`}
          confirmLabel="Confirm"
          busy={busy}
          error={assignError}
          onSubmit={async (reason) => {
            await handleAssign(assignRiderId, reason)
            if (!assignError) setAssignPrompt(false)
          }}
          onClose={() => {
            if (!busy) setAssignPrompt(false)
          }}
        />
      )}

      {disputePrompt && (
        <div className="modal-backdrop" onClick={() => !disputeBusy && setDisputePrompt(false)}>
          <form
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label="Resolve dispute"
            onClick={(e) => e.stopPropagation()}
            onSubmit={async (e: FormEvent) => {
              e.preventDefault()
              if (!disputeReason.trim()) {
                setDisputeError({ code: 'ADMIN_REASON_REQUIRED', message: 'reason is required', retriable: false } as ApiErrorInfo)
                return
              }
              const amount = disputeAmount ? Number(disputeAmount) : undefined
              if ((disputeDecision === 'refund' || disputeDecision === 'payout') && !amount) {
                setDisputeError({ code: 'VALIDATION_FAILED', message: 'amountTZS is required for refund or payout', retriable: false } as ApiErrorInfo)
                return
              }
              setDisputeBusy(true)
              setDisputeError(null)
              const res = await adminDisputeDecision(order.id, {
                decision: disputeDecision,
                amountTZS: amount,
                reason: disputeReason.trim(),
              } as never)
              setDisputeBusy(false)
              if (res.status === 200) {
                setDisputePrompt(false)
                setDisputeReason('')
                setDisputeAmount('')
                onClose()
              } else {
                setDisputeError(parseApiError(res, 'Dispute decision failed'))
              }
            }}
          >
            <h3 className="modal-title">Resolve dispute</h3>
            <p className="muted small">
              {order.no ?? order.id} — current status: {order.status}. Refund/payout above {formatTZS(getLimits().twoPersonThresholdTzs)} requires two-person
              approval.
            </p>
            <label className="field-label" htmlFor="dispute-decision">
              Decision
            </label>
            <select
              id="dispute-decision"
              className="field"
              value={disputeDecision}
              onChange={(e) => setDisputeDecision(e.target.value as 'refund' | 'payout' | 'reject')}
            >
              <option value="refund">refund</option>
              <option value="payout">payout</option>
              <option value="reject">reject</option>
            </select>
            {(disputeDecision === 'refund' || disputeDecision === 'payout') && (
              <>
                <label className="field-label" htmlFor="dispute-amount">
                  Amount TZS
                </label>
                <input
                  id="dispute-amount"
                  type="number"
                  className="field"
                  value={disputeAmount}
                  onChange={(e) => setDisputeAmount(e.target.value)}
                  placeholder="Amount in TZS (integer)"
                  min={0}
                />
              </>
            )}
            <label className="field-label" htmlFor="dispute-reason">
              Reason
            </label>
            <textarea
              id="dispute-reason"
              className="field"
              rows={3}
              maxLength={500}
              required
              value={disputeReason}
              onChange={(e) => setDisputeReason(e.target.value)}
              placeholder="Explain why this action is taken (audited)"
            />
            {disputeError && (
              <div className="inline-error" role="alert">
                <div>{disputeError.message}</div>
                <div className="muted small">
                  {disputeError.code}
                  {disputeError.requestId ? ` · request ${disputeError.requestId}` : ''}
                </div>
              </div>
            )}
            <div className="modal-actions">
              <button type="button" className="btn btn-ghost" onClick={() => setDisputePrompt(false)} disabled={disputeBusy}>
                Cancel
              </button>
              <button type="submit" className="btn btn-danger" disabled={disputeBusy}>
                {disputeBusy ? 'Working…' : 'Confirm'}
              </button>
            </div>
          </form>
        </div>
      )}

      {toast && (
        <Toast message={toast} onClose={() => setToast(null)} />
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
