import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  adminCreateTwoPersonApproval,
  adminRefundDecision,
  listRefundRequests,
  type RefundRequest,
} from '@hudumika/contract'
import { DataTable, type DataTableColumn } from '../../components/DataTable'
import { DetailDrawer } from '../../components/DetailDrawer'
import { ErrorState } from '../../components/ErrorState'
import { LoadingSkeleton } from '../../components/LoadingSkeleton'
import { ReasonPrompt } from '../../components/ReasonPrompt'
import { StatusPill } from '../../components/StatusPill'
import { Toast } from '../../components/FormBits'
import { parseApiError } from '../../lib/api-error'
import { formatTZS } from '../../lib/money'
import { can } from '../../lib/permissions'
import { useSession } from '../../lib/session'
import { toLocal } from '../../lib/time'
import { useRefetchOnFocus } from '../../lib/use-refetch-on-focus'
import { getLimits } from '../../lib/limits'

type Bucket = 'all' | 'pending' | 'approved' | 'rejected'

const APPROVAL_THRESHOLD_TZS = getLimits().maxRefundAmountTzs

const BUCKETS: Array<{ key: Bucket; label: string; match: (r: RefundRequest) => boolean }> = [
  { key: 'all', label: 'All', match: () => true },
  { key: 'pending', label: 'Pending', match: (r) => r.status === 'pending' },
  { key: 'approved', label: 'Approved', match: (r) => r.status === 'approved' },
  { key: 'rejected', label: 'Rejected', match: (r) => r.status === 'rejected' },
]

function statusTone(status: string): 'ok' | 'bad' | 'warn' {
  if (status === 'approved') return 'ok'
  if (status === 'rejected') return 'bad'
  return 'warn'
}

interface PromptState {
  refund: RefundRequest
  decision: 'approve' | 'reject'
}

const COLUMNS: DataTableColumn<RefundRequest>[] = [
  { key: 'refund', header: 'Refund', render: (r) => r.id, className: 'mono' },
  { key: 'order', header: 'Order', render: (r) => r.orderId, className: 'mono' },
  { key: 'customer', header: 'Customer', render: (r) => r.customerName ?? '—' },
  { key: 'amount', header: 'Amount', render: (r) => formatTZS(r.amountTZS), sortValue: (r) => r.amountTZS, align: 'right' },
  { key: 'reason', header: 'Reason', render: (r) => r.reason, className: 'muted small' },
  { key: 'status', header: 'Status', render: (r) => <StatusPill status={r.status} tone={statusTone(r.status)} /> },
  { key: 'created', header: 'Created', render: (r) => toLocal(r.createdAt), sortValue: (r) => r.createdAt, className: 'muted' },
]

export function RefundsPage() {
  const [refunds, setRefunds] = useState<RefundRequest[] | null>(null)
  const [bucket, setBucket] = useState<Bucket>('all')
  const [selected, setSelected] = useState<RefundRequest | null>(null)
  const [prompt, setPrompt] = useState<PromptState | null>(null)
  const [promptError, setPromptError] = useState<string | null>(null)
  const [approvalPrompt, setApprovalPrompt] = useState<RefundRequest | null>(null)
  const [approvalError, setApprovalError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [retryKey, setRetryKey] = useState(0)

  const load = useCallback(() => {
    setError(null)
    listRefundRequests().then((res) => {
      if (res.status === 200) setRefunds(res.data)
      else setError(parseApiError(res, 'Failed to load refund requests').message)
    })
  }, [])

  useEffect(() => {
    load()
  }, [load, retryKey])

  useRefetchOnFocus(load)

  const counts = useMemo(() => {
    if (!refunds) return new Map<Bucket, number>()
    const map = new Map<Bucket, number>()
    for (const b of BUCKETS) map.set(b.key, refunds.filter(b.match).length)
    return map
  }, [refunds])

  const visible = useMemo(
    () => (refunds ?? []).filter(BUCKETS.find((b) => b.key === bucket)!.match),
    [refunds, bucket],
  )

  const session = useSession()
  const allowed = can(session, 'refund.approve')

  function submitApproval(reason: string) {
    if (!approvalPrompt) return
    setBusy(true)
    setApprovalError(null)
    adminCreateTwoPersonApproval({
      actionType: 'large_refund',
      targetType: 'refund',
      targetId: approvalPrompt.id,
      reason,
      payload: { decision: 'approve', amountTZS: approvalPrompt.amountTZS },
    }).then((res) => {
      if (res.status === 201) {
        setToast('Approval request created — pending a second admin')
        setApprovalPrompt(null)
        setSelected(null)
      } else {
        setApprovalError(parseApiError(res, 'Could not create approval request').message)
        setBusy(false)
      }
    })
  }

  if (error)
    return (
      <ErrorState
        title="Failed to load refund requests"
        message={error}
        onRetry={() => setRetryKey((k) => k + 1)}
      />
    )
  if (!refunds) return <LoadingSkeleton kind="table" />

  function submitDecision(reason: string) {
    if (!prompt) return
    setBusy(true)
    setPromptError(null)
    const body =
      prompt.decision === 'approve'
        ? { decision: prompt.decision as 'approve', reason, amountTZS: prompt.refund.amountTZS }
        : { decision: prompt.decision as 'reject', reason }
    adminRefundDecision(prompt.refund.id, body).then((res) => {
      if (res.status === 200) {
        setToast(
          prompt.decision === 'approve'
            ? `Refund ${prompt.refund.id} approved for ${formatTZS(prompt.refund.amountTZS)}`
            : `Refund ${prompt.refund.id} rejected`,
        )
        setPrompt(null)
        setSelected(null)
        setRetryKey((k) => k + 1)
      } else {
        setPromptError(parseApiError(res, 'Could not update refund').message)
        setBusy(false)
      }
    })
  }

  return (
    <div className="page">
      <div className="page-title-row">
        <h1>Refund requests</h1>
      </div>

      {toast && <Toast message={toast} />}

      <div className="filters">
        {BUCKETS.map((b) => (
          <button
            key={b.key}
            type="button"
            className={`chip${bucket === b.key ? ' active' : ''}`}
            aria-pressed={bucket === b.key}
            onClick={() => {
              setBucket(b.key)
              setToast(null)
            }}
          >
            {b.label} <span className="chip-count">{counts.get(b.key) ?? 0}</span>
          </button>
        ))}
      </div>

      <DataTable
        rows={visible}
        columns={COLUMNS}
        rowKey={(r) => r.id}
        onRowClick={setSelected}
        exportable
        exportFileName="refunds"
        tableId="refunds"
        emptyTitle="No refund requests in this bucket"
        ariaLabel="Refund requests"
      />

      {selected && (
        <DetailDrawer title={<span className="mono-strong">{selected.id}</span>} onClose={() => setSelected(null)}>
          <div className="meta-grid">
            <div className="meta-item">
              <span className="meta-label">ID</span>
              <span className="meta-value mono">{selected.id}</span>
            </div>
            <div className="meta-item">
              <span className="meta-label">Order</span>
              <span className="meta-value mono">{selected.orderId}</span>
            </div>
            <div className="meta-item">
              <span className="meta-label">Customer</span>
              <span className="meta-value">{selected.customerName ?? '—'}</span>
            </div>
            <div className="meta-item">
              <span className="meta-label">Amount</span>
              <span className="meta-value">{formatTZS(selected.amountTZS)}</span>
            </div>
            <div className="meta-item">
              <span className="meta-label">Status</span>
              <span className="meta-value">
                <StatusPill status={selected.status} tone={statusTone(selected.status)} />
              </span>
            </div>
            <div className="meta-item">
              <span className="meta-label">Created</span>
              <span className="meta-value">{toLocal(selected.createdAt)}</span>
            </div>
            <div className="meta-item">
              <span className="meta-label">Reason</span>
              <span className="meta-value">{selected.reason}</span>
            </div>
            {selected.decisionReason && (
              <div className="meta-item">
                <span className="meta-label">Decision reason</span>
                <span className="meta-value">{selected.decisionReason}</span>
              </div>
            )}
          </div>

          {selected.status === 'pending' && allowed && (
            <>
              <h3>Decision</h3>
              {selected.amountTZS >= APPROVAL_THRESHOLD_TZS && (
                <p className="muted small">
                  Refunds above {formatTZS(APPROVAL_THRESHOLD_TZS)} require two-person approval (large_refund).
                </p>
              )}
              <div className="page-actions">
                {selected.amountTZS >= APPROVAL_THRESHOLD_TZS ? (
                  <button
                    className="btn"
                    type="button"
                    onClick={() => {
                      setToast(null)
                      setApprovalError(null)
                      setApprovalPrompt(selected)
                    }}
                  >
                    Initiate approval
                  </button>
                ) : (
                  <button
                    className="btn"
                    type="button"
                    onClick={() => {
                      setToast(null)
                      setPrompt({ refund: selected, decision: 'approve' })
                    }}
                  >
                    Approve
                  </button>
                )}
                <button
                  className="btn btn-danger"
                  type="button"
                  onClick={() => {
                    setToast(null)
                    setPrompt({ refund: selected, decision: 'reject' })
                  }}
                >
                  Reject
                </button>
              </div>
            </>
          )}
        </DetailDrawer>
      )}

      {prompt && (
        <ReasonPrompt
          title={prompt.decision === 'approve' ? 'Approve refund' : 'Reject refund'}
          description={`Refund ${prompt.refund.id} for ${formatTZS(prompt.refund.amountTZS)} on order ${prompt.refund.orderId}.`}
          tone={prompt.decision === 'reject' ? 'danger' : 'default'}
          busy={busy}
          error={promptError}
          onSubmit={submitDecision}
          onClose={() => {
            if (!busy) setPrompt(null)
          }}
        />
      )}

      {approvalPrompt && (
        <ReasonPrompt
          title="Initiate approval"
          description={`Refund ${approvalPrompt.id} for ${formatTZS(approvalPrompt.amountTZS)} on order ${approvalPrompt.orderId} exceeds the two-person approval threshold (large_refund).`}
          maxLength={1000}
          confirmLabel="Request approval"
          busy={busy}
          error={approvalError}
          onSubmit={submitApproval}
          onClose={() => {
            if (!busy) setApprovalPrompt(null)
          }}
        />
      )}
    </div>
  )
}
