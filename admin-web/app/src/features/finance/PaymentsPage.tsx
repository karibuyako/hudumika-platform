import { useCallback, useEffect, useMemo, useState } from 'react'
import { adminListPayouts, type PayoutBatch } from '@hudumika/contract'
import { DataTable, type DataTableColumn } from '../../components/DataTable'
import { DetailDrawer } from '../../components/DetailDrawer'
import { ErrorState } from '../../components/ErrorState'
import { LoadingSkeleton } from '../../components/LoadingSkeleton'
import { ReasonPrompt } from '../../components/ReasonPrompt'
import { StatusPill } from '../../components/StatusPill'
import { parseApiError } from '../../lib/api-error'
import { formatTZS } from '../../lib/money'
import { PENDING_ENDPOINT_CODE, pendingEndpointNotice } from '../../lib/pending-endpoints'
import { can } from '../../lib/permissions'
import { useSession } from '../../lib/session'
import { useRefetchOnFocus } from '../../lib/use-refetch-on-focus'

type Bucket = 'all' | 'processing' | 'settled' | 'exception'

const BUCKETS: Array<{ key: Bucket; label: string; match: (p: PayoutBatch) => boolean }> = [
  { key: 'all', label: 'All', match: () => true },
  { key: 'processing', label: 'Processing', match: (p) => p.status === 'processing' },
  { key: 'settled', label: 'Settled', match: (p) => p.status === 'settled' },
  { key: 'exception', label: 'Exception', match: (p) => p.status === 'exception' },
]

function statusTone(status: string): 'ok' | 'bad' | 'warn' | 'muted' {
  if (status === 'settled') return 'ok'
  if (status === 'exception') return 'bad'
  if (status === 'processing') return 'warn'
  return 'muted'
}

const RECONCILABLE = ['processing', 'exception'] as const

const COLUMNS: DataTableColumn<PayoutBatch>[] = [
  { key: 'batch', header: 'Batch', render: (b) => b.id, className: 'mono' },
  { key: 'cycle', header: 'Cycle', render: (b) => b.cycle },
  { key: 'status', header: 'Status', render: (b) => <StatusPill status={b.status} tone={statusTone(b.status)} /> },
  { key: 'total', header: 'Total', render: (b) => formatTZS(b.totalTZS), sortValue: (b) => b.totalTZS, align: 'right' },
  { key: 'count', header: 'Count', render: (b) => b.count, sortValue: (b) => b.count, align: 'right' },
  { key: 'exceptions', header: 'Exceptions', render: (b) => (b.exceptions ? <span className="badge bad">{b.exceptions}</span> : '—'), align: 'right' },
]

export function PaymentsPage() {
  const [batches, setBatches] = useState<PayoutBatch[] | null>(null)
  const [bucket, setBucket] = useState<Bucket>('all')
  const [selected, setSelected] = useState<PayoutBatch | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [retryKey, setRetryKey] = useState(0)

  const load = useCallback(() => {
    setError(null)
    adminListPayouts().then((res) => {
      if (res.status === 200) setBatches(res.data)
      else setError(parseApiError(res, 'Failed to load payout batches').message)
    })
  }, [])

  useEffect(() => {
    load()
  }, [load, retryKey])

  useRefetchOnFocus(load)

  const counts = useMemo(() => {
    if (!batches) return new Map<Bucket, number>()
    const map = new Map<Bucket, number>()
    for (const b of BUCKETS) map.set(b.key, batches.filter(b.match).length)
    return map
  }, [batches])

  const visible = useMemo(
    () => (batches ?? []).filter(BUCKETS.find((b) => b.key === bucket)!.match),
    [batches, bucket],
  )

  if (error)
    return (
      <ErrorState
        title="Failed to load payout batches"
        message={error}
        onRetry={() => setRetryKey((k) => k + 1)}
      />
    )
  if (!batches) return <LoadingSkeleton kind="table" />

  return (
    <div className="page">
      <div className="page-title-row">
        <h1>Payout batches</h1>
      </div>

      <div className="filters">
        {BUCKETS.map((b) => (
          <button
            key={b.key}
            type="button"
            className={`chip${bucket === b.key ? ' active' : ''}`}
            aria-pressed={bucket === b.key}
            onClick={() => setBucket(b.key)}
          >
            {b.label} <span className="chip-count">{counts.get(b.key) ?? 0}</span>
          </button>
        ))}
      </div>

      <DataTable
        rows={visible}
        columns={COLUMNS}
        rowKey={(b) => b.id}
        onRowClick={setSelected}
        exportable
        exportFileName="payouts"
        tableId="payments"
        emptyTitle="No payout batches in this bucket"
        ariaLabel="Payout batches"
      />

      {selected && <PayoutDrawer batch={selected} onClose={() => setSelected(null)} />}
    </div>
  )
}

function PayoutDrawer({ batch, onClose }: { batch: PayoutBatch; onClose: () => void }) {
  const session = useSession()
  const allowed = can(session, 'finance.payout_adjust') && (RECONCILABLE as readonly string[]).includes(batch.status)
  const [confirm, setConfirm] = useState(false)
  const [pending, setPending] = useState(false)

  return (
    <DetailDrawer title={<span className="mono-strong">{batch.id}</span>} onClose={onClose}>
      <div className="meta-grid">
        <div className="meta-item">
          <span className="meta-label">ID</span>
          <span className="meta-value mono">{batch.id}</span>
        </div>
        <div className="meta-item">
          <span className="meta-label">Cycle</span>
          <span className="meta-value">{batch.cycle}</span>
        </div>
        <div className="meta-item">
          <span className="meta-label">Status</span>
          <span className="meta-value">
            <StatusPill status={batch.status} tone={statusTone(batch.status)} />
          </span>
        </div>
        <div className="meta-item">
          <span className="meta-label">Total</span>
          <span className="meta-value">{formatTZS(batch.totalTZS)}</span>
        </div>
        <div className="meta-item">
          <span className="meta-label">Payouts</span>
          <span className="meta-value">{batch.count}</span>
        </div>
      </div>

      <h3>Exceptions</h3>
      {batch.exceptions ? (
        <div className="queue-list">
          <div className="queue-item">
            <div className="queue-main">
              <div className="small strong">{batch.exceptions} payout exception(s)</div>
              <div className="muted small">
                {batch.exceptions} payout(s) in this batch need review before settlement.
              </div>
            </div>
            <div className="queue-actions">
              <span className="badge bad">{batch.exceptions}</span>
            </div>
          </div>
        </div>
      ) : (
        <p className="muted small">No exceptions in this batch.</p>
      )}

      {allowed && (
        <>
          <hr className="divider" />
          <div className="page-actions">
            <button
              type="button"
              className="btn"
              onClick={() => {
                setPending(false)
                setConfirm(true)
              }}
            >
              Reconcile
            </button>
          </div>
        </>
      )}

      {pending && (
        <div className="state-card">
          <div className="state-title">
            <span className="mono">{PENDING_ENDPOINT_CODE}</span>
          </div>
          <div className="state-message">{pendingEndpointNotice('payout_reconcile')}</div>
          <p className="muted small">This action is documented for backend implementation — nothing was sent.</p>
        </div>
      )}

      {confirm && (
        <ReasonPrompt
          title="Reconcile payout batch"
          description={`${batch.id} — current status: ${batch.status}.`}
          confirmLabel="Confirm"
          onSubmit={() => {
            setPending(true)
            setConfirm(false)
          }}
          onClose={() => setConfirm(false)}
        />
      )}
    </DetailDrawer>
  )
}
