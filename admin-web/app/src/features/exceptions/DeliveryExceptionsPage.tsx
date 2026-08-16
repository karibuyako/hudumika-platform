import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import {
  DeliveryExceptionKind,
  DeliveryExceptionStatus,
  listDeliveryExceptions,
  updateDeliveryException,
  type DeliveryException,
  type DeliveryExceptionKind as Kind,
  type DeliveryExceptionStatus as Status,
} from '@hudumika/contract'
import { DataTable, type DataTableColumn } from '../../components/DataTable'
import { DetailDrawer } from '../../components/DetailDrawer'
import { ErrorState } from '../../components/ErrorState'
import { FilterChips } from '../../components/FilterChips'
import { Toast } from '../../components/FormBits'
import { LoadingSkeleton } from '../../components/LoadingSkeleton'
import { StatusPill } from '../../components/StatusPill'
import { parseApiError } from '../../lib/api-error'
import { toLocal } from '../../lib/time'

type KindFilter = 'all' | Kind
type StatusFilter = 'all' | Status

const STATUSES: Status[] = Object.values(DeliveryExceptionStatus)

function statusTone(status: Status): 'ok' | 'bad' | 'info' | 'warn' {
  if (status === 'resolved') return 'ok'
  if (status === 'escalated') return 'bad'
  if (status === 'resolving') return 'info'
  return 'warn'
}

const COLUMNS: DataTableColumn<DeliveryException>[] = [
  { key: 'id', header: 'ID', render: (e) => e.id, className: 'mono' },
  { key: 'kind', header: 'Kind', render: (e) => <span className="tag">{e.kind.replace(/_/g, ' ')}</span> },
  {
    key: 'status',
    header: 'Status',
    render: (e) => <StatusPill status={e.status} tone={statusTone(e.status)} />,
    sortValue: (e) => e.status,
  },
  { key: 'reference', header: 'Reference', render: (e) => e.shipmentId ?? e.orderId ?? '—', className: 'mono' },
  { key: 'replanned', header: 'Replanned', render: (e) => (e.autoReplanned ? <span className="badge">replanned</span> : '—') },
  { key: 'created', header: 'Created', render: (e) => toLocal(e.createdAt), sortValue: (e) => e.createdAt, className: 'muted' },
]

export function DeliveryExceptionsPage() {
  const [exceptions, setExceptions] = useState<DeliveryException[] | null>(null)
  const [kindFilter, setKindFilter] = useState<KindFilter>('all')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [selected, setSelected] = useState<DeliveryException | null>(null)
  const [promptOpen, setPromptOpen] = useState(false)
  const [promptError, setPromptError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [retryKey, setRetryKey] = useState(0)

  useEffect(() => {
    setError(null)
    listDeliveryExceptions().then((res) => {
      if (res.status === 200) setExceptions(res.data)
      else setError(`Failed to load delivery exceptions (${res.status})`)
    })
  }, [retryKey])

  const kindOptions = useMemo(() => {
    const present = new Set((exceptions ?? []).map((e) => e.kind))
    const kinds = Object.values(DeliveryExceptionKind).filter((k) => present.has(k))
    return [
      { key: 'all' as KindFilter, label: 'All' },
      ...kinds.map((k) => ({ key: k, label: k.replace(/_/g, ' ') })),
    ]
  }, [exceptions])

  const kindCounts = useMemo(() => {
    const map: Partial<Record<KindFilter, number>> = { all: exceptions?.length ?? 0 }
    for (const e of exceptions ?? []) map[e.kind] = (map[e.kind] ?? 0) + 1
    return map
  }, [exceptions])

  const statusCounts = useMemo(() => {
    const map: Partial<Record<StatusFilter, number>> = { all: exceptions?.length ?? 0 }
    for (const e of exceptions ?? []) map[e.status] = (map[e.status] ?? 0) + 1
    return map
  }, [exceptions])

  const visible = useMemo(
    () =>
      (exceptions ?? []).filter(
        (e) => (kindFilter === 'all' || e.kind === kindFilter) && (statusFilter === 'all' || e.status === statusFilter),
      ),
    [exceptions, kindFilter, statusFilter],
  )

  async function resolve(reason: string, outcome?: string) {
    const target = selected
    if (!target || (target.status !== 'open' && target.status !== 'resolving')) return
    setBusy(true)
    setPromptError(null)
    const next: 'resolving' | 'resolved' = target.status === 'open' ? 'resolving' : 'resolved'
    const res = await updateDeliveryException(target.id, { status: next, outcome: outcome || null })
    if (res.status === 200) {
      setToast(`Exception ${target.id} ${next === 'resolving' ? 'marked resolving' : 'resolved'}`)
      setSelected(null)
      setPromptOpen(false)
      setRetryKey((k) => k + 1)
    } else {
      setPromptError(parseApiError(res).message)
    }
    setBusy(false)
  }

  if (error) {
    return (
      <ErrorState
        title="Failed to load delivery exceptions"
        message={error}
        onRetry={() => setRetryKey((k) => k + 1)}
      />
    )
  }
  if (!exceptions) return <LoadingSkeleton kind="table" rows={4} />

  return (
    <div className="page">
      <div className="page-title-row">
        <h1>Delivery exceptions</h1>
        {toast && (
          <div className="page-actions">
            <Toast message={toast} />
          </div>
        )}
      </div>

      <FilterChips
        options={kindOptions}
        value={kindFilter}
        onChange={setKindFilter}
        counts={kindCounts}
        ariaLabel="Exception kind filters"
      />
      <FilterChips
        options={[
          { key: 'all' as StatusFilter, label: 'All' },
          ...STATUSES.map((s) => ({ key: s as StatusFilter, label: s.replace(/_/g, ' ') })),
        ]}
        value={statusFilter}
        onChange={setStatusFilter}
        counts={statusCounts}
        ariaLabel="Exception status filters"
      />

      <DataTable
        rows={visible}
        columns={COLUMNS}
        rowKey={(e) => e.id}
        onRowClick={setSelected}
        exportable
        exportFileName="delivery-exceptions"
        emptyTitle={exceptions.length === 0 ? 'No delivery exceptions' : 'No exceptions match these filters'}
        emptyHint={exceptions.length === 0 ? 'Machine-fed anomalies will appear here as they are reported.' : undefined}
        ariaLabel="Delivery exceptions"
      />

      {selected && (
        <ExceptionDrawer
          exception={selected}
          onClose={() => setSelected(null)}
          onResolve={() => {
            setToast(null)
            setPromptError(null)
            setPromptOpen(true)
          }}
        />
      )}

      {promptOpen && selected && (selected.status === 'open' || selected.status === 'resolving') && (
        <ResolvePrompt
          title={selected.status === 'open' ? 'Mark exception resolving' : 'Resolve exception'}
          busy={busy}
          error={promptError}
          onSubmit={(reason, outcome) => resolve(reason, outcome)}
          onClose={() => {
            setPromptOpen(false)
            setPromptError(null)
          }}
        />
      )}
    </div>
  )
}

function ExceptionDrawer({
  exception,
  onClose,
  onResolve,
}: {
  exception: DeliveryException
  onClose: () => void
  onResolve: () => void
}) {
  const e = exception
  return (
    <DetailDrawer title={<span className="mono-strong">{e.id}</span>} onClose={onClose}>
      <div className="meta-grid">
        <div className="meta-item">
          <span className="meta-label">ID</span>
          <span className="meta-value mono">{e.id}</span>
        </div>
        <div className="meta-item">
          <span className="meta-label">Kind</span>
          <span className="meta-value">
            <span className="tag">{e.kind.replace(/_/g, ' ')}</span>
          </span>
        </div>
        <div className="meta-item">
          <span className="meta-label">Status</span>
          <span className="meta-value">
            <StatusPill status={e.status} tone={statusTone(e.status)} />
          </span>
        </div>
        <div className="meta-item">
          <span className="meta-label">Shipment</span>
          <span className="meta-value mono">{e.shipmentId ?? '—'}</span>
        </div>
        <div className="meta-item">
          <span className="meta-label">Order</span>
          <span className="meta-value mono">{e.orderId ?? '—'}</span>
        </div>
        <div className="meta-item">
          <span className="meta-label">Trip</span>
          <span className="meta-value mono">{e.tripId ?? '—'}</span>
        </div>
        <div className="meta-item">
          <span className="meta-label">Description</span>
          <span className="meta-value">{e.description ?? '—'}</span>
        </div>
        <div className="meta-item">
          <span className="meta-label">Reported by</span>
          <span className="meta-value mono">{e.reportedBy ?? '—'}</span>
        </div>
        <div className="meta-item">
          <span className="meta-label">Outcome</span>
          <span className="meta-value">{e.outcome ?? '—'}</span>
        </div>
        <div className="meta-item">
          <span className="meta-label">Auto replanned</span>
          <span className="meta-value">{e.autoReplanned ? <span className="badge">replanned</span> : '—'}</span>
        </div>
        <div className="meta-item">
          <span className="meta-label">Created</span>
          <span className="meta-value">{toLocal(e.createdAt)}</span>
        </div>
        <div className="meta-item">
          <span className="meta-label">Resolved</span>
          <span className="meta-value">{toLocal(e.resolvedAt)}</span>
        </div>
      </div>

      {(e.status === 'open' || e.status === 'resolving') && (
        <div className="detail-section">
          <h3>Actions</h3>
          <div className="form-actions">
            <button type="button" className="btn" onClick={onResolve}>
              {e.status === 'open' ? 'Mark resolving' : 'Resolve'}
            </button>
          </div>
        </div>
      )}

      <p className="muted small">
        Anomalies are machine-fed; resolutions are audited (exception.*). Escalation is reserved for security
        incidents.
      </p>
    </DetailDrawer>
  )
}

/** Resolve — required reason plus an optional outcome note. */
function ResolvePrompt({
  title,
  busy,
  error,
  onSubmit,
  onClose,
}: {
  title: string
  busy: boolean
  error: string | null
  onSubmit: (reason: string, outcome?: string) => void
  onClose: () => void
}) {
  const reasonRef = useRef<HTMLTextAreaElement>(null)
  const [outcome, setOutcome] = useState('')

  useEffect(() => {
    reasonRef.current?.focus()
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    const reason = reasonRef.current?.value.trim() ?? ''
    if (!reason) return
    onSubmit(reason, outcome.trim() || undefined)
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        onSubmit={handleSubmit}
      >
        <h3 className="modal-title">{title}</h3>
        <p className="muted small">Resolutions are audited against the original anomaly.</p>
        <label className="field-label" htmlFor="resolve-reason">
          Reason
        </label>
        <textarea
          ref={reasonRef}
          id="resolve-reason"
          className="field"
          rows={3}
          maxLength={500}
          required
          placeholder="Explain why this action is taken (audited)"
        />
        <label className="field-block">
          <span className="field-label">Outcome</span>
          <textarea
            className="field"
            rows={2}
            maxLength={1000}
            value={outcome}
            onChange={(e) => setOutcome(e.target.value)}
            placeholder="Optional — what resolved the anomaly"
          />
        </label>
        {error && (
          <div className="inline-error" role="alert">
            {error}
          </div>
        )}
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn" disabled={busy}>
            {busy ? 'Working…' : 'Confirm'}
          </button>
        </div>
      </form>
    </div>
  )
}
