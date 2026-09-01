import { useCallback, useEffect, useMemo, useState } from 'react'
import { adminListPayouts, adminPayoutReconcile, listPaymentHistory, refundPayment, type PayoutBatch, type ListPaymentHistory200Item } from '@hudumika/contract'
import { DataTable, type DataTableColumn } from '../../components/DataTable'
import { DetailDrawer } from '../../components/DetailDrawer'
import { ErrorState } from '../../components/ErrorState'
import { LoadingSkeleton } from '../../components/LoadingSkeleton'
import { ReasonPrompt } from '../../components/ReasonPrompt'
import { StatusPill } from '../../components/StatusPill'
import { Toast } from '../../components/FormBits'
import { parseApiError, type ApiErrorInfo } from '../../lib/api-error'
import { formatTZS } from '../../lib/money'
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

function intentStatusTone(s: string): 'ok' | 'bad' | 'warn' | 'muted' {
  if (s === 'paid') return 'ok'
  if (s === 'failed' || s === 'refunded' || s === 'reversed') return 'bad'
  if (s === 'pending' || s === 'created') return 'warn'
  return 'muted'
}

const INTENT_COLUMNS: DataTableColumn<ListPaymentHistory200Item>[] = [
  { key: 'id', header: 'Intent', render: (i) => i.id, className: 'mono' },
  { key: 'method', header: 'Method', render: (i) => i.method },
  { key: 'amount', header: 'Amount', render: (i) => formatTZS(i.amountTZS), sortValue: (i) => i.amountTZS, align: 'right' },
  { key: 'status', header: 'Status', render: (i) => <StatusPill status={i.status} tone={intentStatusTone(i.status)} /> },
  { key: 'ref', header: 'Reference', render: (i) => i.reference ?? '—', className: 'mono' },
  { key: 'created', header: 'Created', render: (i) => new Date(i.createdAt).toLocaleString() },
]

export function PaymentsPage() {
  const [batches, setBatches] = useState<PayoutBatch[] | null>(null)
  const [intents, setIntents] = useState<ListPaymentHistory200Item[] | null>(null)
  const [bucket, setBucket] = useState<Bucket>('all')
  const [tab, setTab] = useState<'payouts' | 'intents'>('payouts')
  const [selected, setSelected] = useState<PayoutBatch | null>(null)
  const [selectedIntent, setSelectedIntent] = useState<ListPaymentHistory200Item | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [retryKey, setRetryKey] = useState(0)
  const [toast, setToast] = useState<string | null>(null)

  const load = useCallback(() => {
    setError(null)
    if (tab === 'payouts') {
      adminListPayouts()
        .then((res) => {
          if (res.status === 200) setBatches(res.data)
          else setError(parseApiError(res, 'Failed to load payout batches').message)
        })
        .catch(() => setError(parseApiError({ status: 0, data: undefined }, 'Failed to load payout batches').message))
    } else {
      listPaymentHistory({ limit: 100 })
        .then((res) => {
          if (res.status === 200) setIntents(res.data)
          else setError(parseApiError(res, 'Failed to load payment history').message)
        })
        .catch(() => setError(parseApiError({ status: 0, data: undefined }, 'Failed to load payment history').message))
    }
  }, [tab])

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

  async function handleReconcile(batchId: string, outcome: 'paid' | 'failed' | 'exception', note?: string): Promise<ApiErrorInfo | null> {
    const res = await adminPayoutReconcile(batchId, { outcome, note } as never)
    if (res.status === 200) {
      const nextStatus = outcome === 'paid' ? 'settled' : 'exception'
      setBatches((prev) => (prev ?? []).map((b) => (b.id === batchId ? { ...b, status: nextStatus as PayoutBatch['status'] } : b)))
      setSelected((prev) => (prev && prev.id === batchId ? { ...prev, status: nextStatus as PayoutBatch['status'] } : prev))
      setToast(`Payout ${outcome}`)
      return null
    }
    return parseApiError(res, 'Reconcile failed')
  }

  if (error)
    return (
      <ErrorState
        title="Failed to load payment data"
        message={error}
        onRetry={() => setRetryKey((k) => k + 1)}
      />
    )

  return (
    <div className="page">
      <div className="page-title-row">
        <h1>Payments</h1>
        {toast && (
          <div className="page-actions">
            <Toast message={toast} />
          </div>
        )}
      </div>

      <div className="filters">
        <button type="button" className={`chip${tab === 'payouts' ? ' active' : ''}`} onClick={() => setTab('payouts')}>Payout Batches</button>
        <button type="button" className={`chip${tab === 'intents' ? ' active' : ''}`} onClick={() => setTab('intents')}>Payment History</button>
      </div>

      {tab === 'payouts' ? (
        <>
          {!batches ? <LoadingSkeleton kind="table" /> : (
            <>
              <div className="filters">
                {BUCKETS.map((b) => (
                  <button key={b.key} type="button" className={`chip${bucket === b.key ? ' active' : ''}`} aria-pressed={bucket === b.key} onClick={() => setBucket(b.key)}>
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
            </>
          )}
        </>
      ) : (
        <>
          {!intents ? <LoadingSkeleton kind="table" /> : (
            <DataTable
              rows={intents}
              columns={INTENT_COLUMNS}
              rowKey={(i) => i.id}
              onRowClick={setSelectedIntent}
              exportable
              exportFileName="payment-history"
              tableId="payment-intents"
              emptyTitle="No payment history"
              ariaLabel="Payment history"
            />
          )}
        </>
      )}

      {selected && <PayoutDrawer batch={selected} onClose={() => setSelected(null)} onReconcile={handleReconcile} />}
      {selectedIntent && <IntentDrawer intent={selectedIntent} onClose={() => setSelectedIntent(null)} />}
    </div>
  )
}

function PayoutDrawer({
  batch,
  onClose,
  onReconcile,
}: {
  batch: PayoutBatch
  onClose: () => void
  onReconcile: (batchId: string, outcome: 'paid' | 'failed' | 'exception', note?: string) => Promise<ApiErrorInfo | null>
}) {
  const session = useSession()
  const allowed = can(session, 'finance.payout_adjust') && (RECONCILABLE as readonly string[]).includes(batch.status)
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [reconcileError, setReconcileError] = useState<ApiErrorInfo | null>(null)
  const [outcome, setOutcome] = useState<'paid' | 'failed' | 'exception'>('paid')

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
                setReconcileError(null)
                setConfirm(true)
              }}
            >
              Reconcile
            </button>
          </div>
        </>
      )}

      {confirm && (
        <div className="modal-backdrop" onClick={() => !busy && setConfirm(false)}>
          <form
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label="Reconcile payout batch"
            onClick={(e) => e.stopPropagation()}
            onSubmit={async (e) => {
              e.preventDefault()
              const form = e.currentTarget as HTMLFormElement
              const data = new FormData(form)
              const note = (data.get('reason') as string)?.trim() ?? ''
              if (outcome === 'exception' && !note) {
                setReconcileError(parseApiError({ status: 422, data: { code: 'ADMIN_REASON_REQUIRED', message: 'note is required when outcome is exception' } }, 'Reconcile failed') as ApiErrorInfo)
                return
              }
              setBusy(true)
              setReconcileError(null)
              const err = await onReconcile(batch.id, outcome, note || undefined)
              setBusy(false)
              if (err) setReconcileError(err)
              else setConfirm(false)
            }}
          >
            <h3 className="modal-title">Reconcile payout batch</h3>
            <p className="muted small">{batch.id} — current status: {batch.status}.</p>
            <label className="field-label" htmlFor="payout-outcome">
              Outcome
            </label>
            <select
              id="payout-outcome"
              className="field"
              value={outcome}
              onChange={(e) => setOutcome(e.target.value as never)}
            >
              <option value="paid">paid — batch settled</option>
              <option value="failed">failed — batch failed</option>
              <option value="exception">exception — needs variance note</option>
            </select>
            <label className="field-label" htmlFor="reconcile-reason">
              Reason / note {outcome === 'exception' ? '(required)' : '(optional)'}
            </label>
            <textarea
              id="reconcile-reason"
              name="reason"
              className="field"
              rows={3}
              maxLength={1000}
              placeholder="Explain why this outcome (audited)"
            />
            {reconcileError && (
              <div className="inline-error" role="alert">
                <div>{reconcileError.message}</div>
                <div className="muted small">
                  {reconcileError.code}
                  {reconcileError.requestId ? ` · request ${reconcileError.requestId}` : ''}
                </div>
              </div>
            )}
            <div className="modal-actions">
              <button type="button" className="btn btn-ghost" onClick={() => setConfirm(false)} disabled={busy}>
                Cancel
              </button>
              <button type="submit" className="btn" disabled={busy}>
                {busy ? 'Working…' : 'Confirm'}
              </button>
            </div>
          </form>
        </div>
      )}
    </DetailDrawer>
  )
}

function IntentDrawer({
  intent,
  onClose,
}: {
  intent: ListPaymentHistory200Item
  onClose: () => void
}) {
  const session = useSession()
  const canRefund = can(session, 'finance.payout_adjust') && intent.status === 'paid'
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function handleRefund(reason: string) {
    setBusy(true)
    setError(null)
    const res = await refundPayment(intent.id, { amount: intent.amountTZS, reason })
    setBusy(false)
    if (res.status === 200) {
      setToast('Refund processed')
      onClose()
    } else {
      setError(parseApiError(res, 'Refund failed').message)
    }
  }

  return (
    <DetailDrawer title={<span className="mono-strong">{intent.id}</span>} onClose={onClose}>
      {toast && <Toast message={toast} />}
      <div className="meta-grid">
        <div className="meta-item">
          <span className="meta-label">ID</span>
          <span className="meta-value mono">{intent.id}</span>
        </div>
        <div className="meta-item">
          <span className="meta-label">Status</span>
          <span className="meta-value"><StatusPill status={intent.status} tone={intentStatusTone(intent.status)} /></span>
        </div>
        <div className="meta-item">
          <span className="meta-label">Method</span>
          <span className="meta-value">{intent.method}</span>
        </div>
        <div className="meta-item">
          <span className="meta-label">Amount</span>
          <span className="meta-value">{formatTZS(intent.amountTZS)}</span>
        </div>
        <div className="meta-item">
          <span className="meta-label">Reference</span>
          <span className="meta-value mono">{intent.reference ?? '—'}</span>
        </div>
        <div className="meta-item">
          <span className="meta-label">Created</span>
          <span className="meta-value">{new Date(intent.createdAt).toLocaleString()}</span>
        </div>
      </div>

      {canRefund && (
        <ReasonPrompt
          title="Refund payment"
          description={`Refund ${formatTZS(intent.amountTZS)} for intent ${intent.id}.`}
          tone="danger"
          busy={busy}
          error={error}
          onSubmit={handleRefund}
          onClose={() => { if (!busy) onClose() }}
        />
      )}
    </DetailDrawer>
  )
}
