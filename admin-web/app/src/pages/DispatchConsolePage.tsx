import { useEffect, useMemo, useState } from 'react'
import {
  adminListOrders,
  adminListRiders,
  adminAssignOrderToRider,
  type OrderDetail,
  type RiderAdmin,
  type OrderStatus,
} from '@hudumika/contract'
import { formatTZS } from '../lib/money'
import { toLocal } from '../lib/time'
import { useSession } from '../lib/session'
import { can } from '../lib/permissions'
import { parseApiError } from '../lib/api-error'
import { ErrorState } from '../components/ErrorState'
import { LoadingSkeleton } from '../components/LoadingSkeleton'
import { PriorityBadge } from '../components/PriorityBadge'
import { ReasonPrompt } from '../components/ReasonPrompt'
import { DataTable, type DataTableColumn } from '../components/DataTable'

const DISPATCHABLE: OrderStatus[] = ['paid', 'merchant_accepted', 'preparing']
const REASSIGNABLE: OrderStatus[] = ['paid', 'merchant_accepted', 'preparing', 'rider_assigned']

type BulkOutcome =
  | { order: OrderDetail; ok: true; rider: string }
  | { order: OrderDetail; ok: false; code: string; message: string }

export function DispatchConsolePage() {
  const session = useSession()
  const canAssign = can(session, 'dispatch.assign')
  const canReassign = can(session, 'dispatch.reassign')
  const canDispatch = canAssign || canReassign
  const [orders, setOrders] = useState<OrderDetail[] | null>(null)
  const [riders, setRiders] = useState<RiderAdmin[] | null>(null)
  const [filter, setFilter] = useState<'all' | 'express' | 'vip'>('all')
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<OrderDetail | null>(null)
  const [assigning, setAssigning] = useState<string | null>(null)
  const [selectedOrders, setSelectedOrders] = useState<Set<string>>(new Set())
  const [bulk, setBulk] = useState<{ orders: OrderDetail[]; reason: string } | null>(null)
  const [bulkRunning, setBulkRunning] = useState(false)
  const [bulkResults, setBulkResults] = useState<BulkOutcome[] | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [prompt, setPrompt] = useState<{ order: OrderDetail; rider: RiderAdmin } | null>(null)
  const [promptBusy, setPromptBusy] = useState(false)
  const [promptError, setPromptError] = useState<string | null>(null)
  const [reassignedIds, setReassignedIds] = useState<string[]>([])
  const [retryKey, setRetryKey] = useState(0)

  useEffect(() => {
    setError(null)
    let cancelled = false
    Promise.all([adminListOrders(), adminListRiders()])
      .then(([ordersRes, ridersRes]) => {
        if (cancelled) return
        if (ordersRes.status !== 200 || ridersRes.status !== 200) {
          const err = ordersRes.status !== 200 ? parseApiError(ordersRes as { status: number; data?: unknown }, 'Failed to load dispatch console') : parseApiError(ridersRes as { status: number; data?: unknown }, 'Failed to load dispatch console')
          setError(`${err.code}: ${err.message}`)
          return
        }
        setOrders(ordersRes.data)
        setRiders(ridersRes.data)
      })
      .catch(() => {
        if (!cancelled) setError('Failed to load dispatch console')
      })
    return () => {
      cancelled = true
    }
  }, [retryKey])

  const queue = useMemo(() => {
    if (!orders) return []
    return orders
      .filter((o) => DISPATCHABLE.includes(o.status) && !o.riderId)
      .filter((o) => filter === 'all' || o.priority === filter)
      .filter((o) => {
        if (!query) return true
        const q = query.toLowerCase()
        return o.no?.toLowerCase().includes(q) || o.id.toLowerCase().includes(q)
      })
  }, [orders, filter, query])

  const reassignQueue = useMemo(() => {
    if (!orders) return []
    return orders
      .filter((o) => REASSIGNABLE.includes(o.status) && o.riderId && !reassignedIds.includes(o.id))
      .filter((o) => filter === 'all' || o.priority === filter)
      .filter((o) => {
        if (!query) return true
        const q = query.toLowerCase()
        return o.no?.toLowerCase().includes(q) || o.id.toLowerCase().includes(q)
      })
  }, [orders, filter, query, reassignedIds])

  const availableRiders = useMemo(
    () => (riders ?? []).filter((r) => r.verification === 'approved'),
    [riders],
  )

  function toggleSelected(id: string) {
    if (bulkRunning) return
    setSelectedOrders((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleSelectAll(checked: boolean) {
    if (bulkRunning) return
    setSelectedOrders(checked ? new Set(queue.map((o) => o.id)) : new Set())
  }

  function clearSelection() {
    setBulk(null)
    setSelectedOrders(new Set())
  }

  function startBulk() {
    if (bulk) return
    const orders = queue.filter((o) => selectedOrders.has(o.id))
    if (orders.length === 0) return
    setSelected(null)
    setBulk({ orders, reason: '' })
  }

  async function runBulk(rider: RiderAdmin) {
    if (!bulk?.reason || bulkRunning) return
    const orders = bulk.orders
    setBulkRunning(true)
    setNotice(null)
    setBulkResults([])
    const outcomes: BulkOutcome[] = []
    for (const order of orders) {
      const res = await adminAssignOrderToRider(order.id, {
        riderId: rider.id,
        reason: bulk.reason,
      })
      if (res.status === 200) {
        setOrders((prev) => (prev ?? []).map((o) => (o.id === order.id ? { ...o, ...res.data } : o)))
        outcomes.push({ order, ok: true, rider: rider.name })
      } else {
        const err = parseApiError(res)
        outcomes.push({ order, ok: false, code: err.code, message: err.message })
      }
      setBulkResults([...outcomes])
    }
    setBulkRunning(false)
    setBulk(null)
    setSelectedOrders(new Set())
    setNotice(`Bulk assignment complete — ${outcomes.filter((o) => o.ok).length} assigned`)
  }

  async function assign(order: OrderDetail, rider: RiderAdmin, reason: string) {
    setPromptBusy(true)
    setPromptError(null)
    setAssigning(rider.id)
    setNotice(null)
    const res = await adminAssignOrderToRider(order.id, {
      riderId: rider.id,
      reason,
    })
    if (res.status === 200) {
      setOrders((prev) => (prev ?? []).map((o) => (o.id === order.id ? { ...o, ...res.data } : o)))
      setSelected(null)
      setPrompt(null)
      setNotice(`Order ${order.no ?? short(order.id)} assigned to ${rider.name}`)
    } else {
      const err = parseApiError(res as { status: number; data?: unknown })
      setPromptError(`Assignment failed (${err.code}: ${err.message})`)
    }
    setAssigning(null)
    setPromptBusy(false)
  }

  async function reassign(order: OrderDetail, rider: RiderAdmin, reason: string) {
    setPromptBusy(true)
    setPromptError(null)
    setAssigning(rider.id)
    setNotice(null)
    const res = await adminAssignOrderToRider(order.id, {
      riderId: rider.id,
      reason,
    })
    if (res.status === 200) {
      setOrders((prev) => (prev ?? []).map((o) => (o.id === order.id ? { ...o, ...res.data } : o)))
      setReassignedIds((prev) => (prev.includes(order.id) ? prev : [...prev, order.id]))
      setSelected(null)
      setPrompt(null)
      setNotice(`Order ${order.no ?? short(order.id)} reassigned to ${rider.name}`)
    } else {
      const err = parseApiError(res as { status: number; data?: unknown })
      setPromptError(`Reassignment failed (${err.code}: ${err.message})`)
    }
    setAssigning(null)
    setPromptBusy(false)
  }

  if (error) {
    return (
      <ErrorState
        title="Dispatch console unavailable"
        message={error}
        onRetry={() => setRetryKey((k) => k + 1)}
      />
    )
  }
  if (!orders || !riders) return <LoadingSkeleton kind="table" rows={6} />

  const allSelected = queue.length > 0 && queue.every((o) => selectedOrders.has(o.id))

  const selectAllCheckbox = (
    <input
      type="checkbox"
      aria-label="Select all dispatchable"
      checked={allSelected}
      disabled={bulkRunning}
      onChange={(e) => toggleSelectAll(e.target.checked)}
    />
  )

  const assignColumns: DataTableColumn<OrderDetail>[] = [
    {
      key: 'select',
      header: canAssign ? (selectAllCheckbox as unknown as string) : '',
      render: (o) =>
        canAssign ? (
          <input
            type="checkbox"
            aria-label={`Select order ${o.no ?? short(o.id)}`}
            checked={selectedOrders.has(o.id)}
            disabled={bulkRunning}
            onChange={() => toggleSelected(o.id)}
          />
        ) : null,
    },
    {
      key: 'order',
      header: 'Order',
      render: (o) => (
        <>
          <div className="strong">{o.no ?? short(o.id)}</div>
          <div className="muted small">{o.fulfillmentType ?? 'local'}</div>
        </>
      ),
    },
    { key: 'priority', header: 'Priority', render: (o) => <PriorityBadge priority={o.priority} /> },
    { key: 'source', header: 'Source', render: (o) => o.source ?? 'app' },
    {
      key: 'total',
      header: 'Total',
      render: (o) => formatTZS(o.totals?.totalTZS),
      sortValue: (o) => o.totals?.totalTZS ?? 0,
      align: 'right',
    },
    { key: 'created', header: 'Created', render: (o) => toLocal(o.createdAt), sortValue: (o) => o.createdAt, className: 'muted' },
    {
      key: 'action',
      header: '',
      render: (o) =>
        canAssign ? (
          <button
            className="btn"
            onClick={() => {
              setBulk(null)
              setSelected(selected?.id === o.id ? null : o)
            }}
          >
            {selected?.id === o.id ? 'Close' : 'Assign'}
          </button>
        ) : null,
    },
  ]

  const reassignColumns: DataTableColumn<OrderDetail>[] = [
    ...assignColumns.slice(1, 6),
    { key: 'rider', header: 'Rider', render: (o) => riders.find((r) => r.id === o.riderId)?.name ?? o.riderId, className: 'muted' },
    {
      key: 'action',
      header: '',
      render: (o) =>
        canReassign ? (
          <button className="btn" onClick={() => setSelected(selected?.id === o.id ? null : o)}>
            {selected?.id === o.id ? 'Close' : 'Reassign'}
          </button>
        ) : null,
    },
  ]

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Dispatch Console</h1>
          <p className="muted">
            {queue.length} orders awaiting assignment · {reassignQueue.length} awaiting reassignment ·{' '}
            {availableRiders.length} approved riders online
          </p>
        </div>
        <div className="filters">
          {(['all', 'express', 'vip'] as const).map((f) => (
            <button
              key={f}
              className={`chip${filter === f ? ' active' : ''}`}
              onClick={() => setFilter(f)}
            >
              {f}
            </button>
          ))}
          <input
            className="topbar-search"
            style={{ width: 180 }}
            placeholder="Search order…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      </div>

      {notice && <div className="notice">{notice}</div>}

      <div className="dispatch-grid">
        <section>
          <h2>Assignment queue</h2>
          {canAssign && selectedOrders.size > 0 && (
            <div className="toolbar">
              <button className="btn" disabled={bulkRunning || Boolean(bulk)} onClick={startBulk}>
                {bulkRunning ? 'Assigning…' : `Assign ${selectedOrders.size} selected`}
              </button>
              <button className="btn btn-ghost" disabled={bulkRunning} onClick={clearSelection}>
                Clear selection
              </button>
            </div>
          )}
          <DataTable
            rows={queue}
            columns={assignColumns}
            rowKey={(o) => o.id}
            selectedRowKey={selected?.id ?? null}
            emptyTitle="No orders awaiting dispatch"
            ariaLabel="Assignment queue"
          />
        </section>

        <aside className="riders-panel">
          <h2>Available riders</h2>
          {!canDispatch && <div className="muted small">You don't have dispatch permissions</div>}
          {canDispatch && bulk?.reason && (
            <div className="rider-picker-hint muted small">
              Assigning{' '}
              <span className="strong">
                {bulk.orders.length} selected {bulk.orders.length === 1 ? 'order' : 'orders'}
              </span>{' '}
              to a rider
            </div>
          )}
          {canDispatch && selected && (
            <div className="rider-picker-hint muted small">
              Selecting a rider assigns <span className="strong">{selected.no ?? short(selected.id)}</span>
            </div>
          )}
          {canDispatch && (
            <div className="rider-list">
              {availableRiders.map((rider) => (
                <button
                  key={rider.id}
                  className={`rider-card${selected || bulk?.reason ? '' : ' disabled'}`}
                  disabled={(!selected && !bulk?.reason) || bulkRunning}
                  onClick={() => {
                    if (bulk?.reason) {
                      runBulk(rider)
                      return
                    }
                    if (!selected) return
                    setPromptError(null)
                    setPrompt({ order: selected, rider })
                  }}
                >
                  <div className="rider-line">
                    <span className="strong">{rider.name}</span>
                    <span className="rider-score">{rider.reliabilityScore ?? '—'}</span>
                  </div>
                  <div className="muted small">
                    {rider.vehicle}
                    {rider.licensePlate ? ` · ${rider.licensePlate}` : ''} · {rider.city}
                  </div>
                  <div className="muted small">
                    {rider.vehicleMake ?? ''} {rider.vehicleYear ?? ''}
                  </div>
                  {assigning === rider.id && <div className="muted small">Assigning…</div>}
                </button>
              ))}
              {availableRiders.length === 0 && <div className="muted">No approved riders</div>}
            </div>
          )}
        </aside>
      </div>

      {bulkResults && (
        <section className="queue">
          <h2>Bulk assignment report</h2>
          <div className="queue-list">
            {bulkResults.map((r) => (
              <div className="queue-item" key={r.order.id}>
                <div className="queue-main">
                  <div className="mono-strong">{r.order.no ?? short(r.order.id)}</div>
                  {r.ok ? (
                    <div className="muted small">assigned to {r.rider}</div>
                  ) : (
                    <div className="muted small">{r.message}</div>
                  )}
                </div>
                <div className="queue-actions">
                  {r.ok ? (
                    <span className="pill pill-ok">assigned</span>
                  ) : (
                    <span className="pill pill-bad">failed: {r.code}</span>
                  )}
                </div>
              </div>
            ))}
          </div>
          <div className="muted small">
            {bulkResults.filter((r) => r.ok).length} assigned · {bulkResults.filter((r) => !r.ok).length} failed
          </div>
          <button className="btn btn-ghost" onClick={() => setBulkResults(null)}>
            Close
          </button>
        </section>
      )}

      <section className="queue">
        <h2>Reassignment queue</h2>
        <DataTable
          rows={reassignQueue}
          columns={reassignColumns}
          rowKey={(o) => o.id}
          selectedRowKey={selected?.id ?? null}
          emptyTitle="No orders awaiting reassignment"
          ariaLabel="Reassignment queue"
        />
      </section>

      {prompt && (
        <ReasonPrompt
          title="Assign order"
          maxLength={500}
          busy={promptBusy}
          error={promptError}
          onSubmit={(reason) =>
            prompt.order.riderId
              ? reassign(prompt.order, prompt.rider, reason)
              : assign(prompt.order, prompt.rider, reason)
          }
          onClose={() => {
            if (!promptBusy) setPrompt(null)
          }}
        />
      )}

      {bulk && !bulk.reason && (
        <ReasonPrompt
          title="Bulk assignment"
          maxLength={500}
          onSubmit={(reason) => setBulk({ ...bulk, reason })}
          onClose={() => setBulk(null)}
        />
      )}
    </div>
  )
}

function short(id: string) {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id
}
