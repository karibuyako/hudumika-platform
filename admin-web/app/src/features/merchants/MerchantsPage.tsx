import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import {
  adminListMerchants,
  adminMerchantDecision,
  type MerchantAdmin,
  type VerificationState,
} from '@hudumika/contract'
import { parseApiError } from '../../lib/api-error'
import { useSession } from '../../lib/session'
import { can } from '../../lib/permissions'
import { DetailDrawer } from '../../components/DetailDrawer'
import { AuditTrailSection } from '../../components/AuditTrailSection'
import { ErrorState } from '../../components/ErrorState'
import { FilterChips } from '../../components/FilterChips'
import { LoadingSkeleton } from '../../components/LoadingSkeleton'
import { ReasonPrompt } from '../../components/ReasonPrompt'
import { StatusPill } from '../../components/StatusPill'
import { MaskedField } from '../../components/MaskedField'
import { Toast } from '../../components/FormBits'
import { DataTable, type DataTableColumn } from '../../components/DataTable'
import { useRefetchOnFocus } from '../../lib/use-refetch-on-focus'

const STATUSES: VerificationState[] = [
  'pending',
  'documents_review',
  'approved',
  'rejected',
  'suspended',
  'changes_requested',
]

type StatusFilter = 'all' | VerificationState
type ActionKind = 'approve' | 'reject' | 'request_changes'

const DECISION: Record<ActionKind, 'approved' | 'rejected' | 'changes_requested'> = {
  approve: 'approved',
  reject: 'rejected',
  request_changes: 'changes_requested',
}

const ACTIONABLE: VerificationState[] = ['pending', 'documents_review', 'changes_requested']

const FILTERS: Array<{ key: StatusFilter; label: string }> = [
  { key: 'all', label: 'All' },
  ...STATUSES.map((s) => ({ key: s as StatusFilter, label: s.replace(/_/g, ' ') })),
]

function verificationTone(status: VerificationState): 'ok' | 'bad' | 'warn' {
  if (status === 'approved') return 'ok'
  if (status === 'rejected' || status === 'suspended') return 'bad'
  return 'warn'
}

function docTone(status: string): string {
  if (status === 'approved') return ''
  if (status === 'missing') return 'muted'
  if (status === 'pending') return 'warn'
  return 'bad'
}

function fmtBps(bps: number | null | undefined): string {
  if (bps == null) return '—'
  return `${(bps / 100).toFixed(1)}% (${bps} bps)`
}

const COLUMNS: DataTableColumn<MerchantAdmin>[] = [
  {
    key: 'business',
    header: 'Business',
    render: (m) => (
      <>
        <div className="strong">{m.businessName}</div>
        <div className="muted small mono">{m.id}</div>
      </>
    ),
  },
  { key: 'city', header: 'City', render: (m) => m.city },
  {
    key: 'categories',
    header: 'Categories',
    render: (m) =>
      (m.categories ?? []).map((c) => (
        <span key={c} className="tag">
          {c}
        </span>
      )),
  },
  { key: 'rating', header: 'Rating', render: (m) => m.rating.toFixed(1), sortValue: (m) => m.rating, className: 'mono' },
  { key: 'reviews', header: 'Reviews', render: (m) => m.reviewCount },
  {
    key: 'verification',
    header: 'Verification',
    render: (m) => <StatusPill status={m.verification} tone={verificationTone(m.verification)} />,
  },
  {
    key: 'status',
    header: 'Status',
    render: (m) => (
      <span className={`pill pill-${m.isOpen ? 'ok' : 'muted'}`}>{m.isOpen ? 'Open' : 'Closed'}</span>
    ),
  },
]

export function MerchantsPage() {
  const session = useSession()
  const canApprove = can(session, 'merchant.approve')
  const [merchants, setMerchants] = useState<MerchantAdmin[] | null>(null)
  const [status, setStatus] = useState<StatusFilter>('all')
  const [selected, setSelected] = useState<MerchantAdmin | null>(null)
  const [prompt, setPrompt] = useState<ActionKind | null>(null)
  const [promptError, setPromptError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [retryKey, setRetryKey] = useState(0)

  const load = useCallback(() => {
    setError(null)
    const params = status === 'all' ? undefined : { status }
    adminListMerchants(params).then((res) => {
      if (res.status === 200) setMerchants(res.data)
      else setError(`Failed to load merchants (${res.status})`)
    })
  }, [status])

  useEffect(() => {
    load()
  }, [load, retryKey])

  useRefetchOnFocus(load)

  const counts = useMemo(() => {
    const map: Partial<Record<StatusFilter, number>> = { all: merchants?.length ?? 0 }
    for (const s of STATUSES) map[s] = (merchants ?? []).filter((m) => m.verification === s).length
    return map
  }, [merchants])

  async function decide(reason: string, commissionRateBps?: number) {
    const target = selected
    const kind = prompt
    if (!target || !kind) return
    setBusy(true)
    setPromptError(null)
    const res = await adminMerchantDecision(target.id, {
      decision: DECISION[kind],
      reason,
      ...(commissionRateBps !== undefined ? { commissionRateBps } : {}),
    })
    if (res.status === 200) {
      setMerchants((prev) => (prev ?? []).map((m) => (m.id === res.data.id ? { ...m, ...res.data } : m)))
      setSelected(null)
      setPrompt(null)
      setToast(
        kind === 'approve'
          ? `${target.businessName} approved`
          : kind === 'reject'
            ? `${target.businessName} rejected`
            : `Changes requested for ${target.businessName}`,
      )
      setRetryKey((k) => k + 1)
    } else {
      setPromptError(parseApiError(res).message)
    }
    setBusy(false)
  }

  if (error) {
    return <ErrorState title="Failed to load merchants" message={error} onRetry={() => setRetryKey((k) => k + 1)} />
  }
  if (!merchants) return <LoadingSkeleton kind="table" rows={6} />

  return (
    <div className="page">
      <div className="page-title-row">
        <h1>Merchants</h1>
        {toast && (
          <div className="page-actions">
            <Toast message={toast} />
          </div>
        )}
      </div>

      <FilterChips options={FILTERS} value={status} onChange={setStatus} counts={counts} ariaLabel="Merchant status filters" />

      <DataTable
        rows={merchants}
        columns={COLUMNS}
        rowKey={(m) => m.id}
        onRowClick={setSelected}
        emptyTitle="No merchants found"
        emptyHint="New merchants appear here when they apply."
        exportable
        exportFileName="merchants"
        tableId="merchants"
        ariaLabel="Merchants"
      />

      {selected && (
        <MerchantDrawer
          merchant={selected}
          canApprove={canApprove}
          onClose={() => setSelected(null)}
          onAction={(kind) => {
            setToast(null)
            setPromptError(null)
            setPrompt(kind)
          }}
        />
      )}

      {prompt === 'reject' && (
        <ReasonPrompt
          title="Reject merchant"
          description="The merchant will be marked rejected and cannot trade."
          tone="danger"
          confirmLabel="Confirm"
          busy={busy}
          error={promptError}
          onSubmit={(reason) => decide(reason)}
          onClose={() => setPrompt(null)}
        />
      )}

      {prompt === 'request_changes' && (
        <ReasonPrompt
          title="Request changes"
          description="The merchant will be asked to resubmit their documents."
          busy={busy}
          error={promptError}
          onSubmit={(reason) => decide(reason)}
          onClose={() => setPrompt(null)}
        />
      )}

      {prompt === 'approve' && (
        <ApprovePrompt
          busy={busy}
          error={promptError}
          onSubmit={(reason, commissionRateBps) => decide(reason, commissionRateBps)}
          onClose={() => setPrompt(null)}
        />
      )}
    </div>
  )
}

function MerchantDrawer({
  merchant,
  canApprove,
  onClose,
  onAction,
}: {
  merchant: MerchantAdmin
  canApprove: boolean
  onClose: () => void
  onAction: (kind: ActionKind) => void
}) {
  const commercial = merchant.commercial ?? {}
  return (
    <DetailDrawer title={merchant.businessName} onClose={onClose}>
      <div className="detail-section">
        <h3>Business</h3>
        <div className="meta-grid">
          <div className="meta-item">
            <span className="meta-label">ID</span>
            <span className="mono">{merchant.id}</span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Business name</span>
            <span className="meta-value">{merchant.businessName}</span>
          </div>
          <div className="meta-item">
            <span className="meta-label">City</span>
            <span className="meta-value">{merchant.city}</span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Service areas</span>
            <span className="meta-value">{(merchant.serviceAreas ?? []).join(', ') || '—'}</span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Categories</span>
            <span className="meta-value">
              {(merchant.categories ?? []).map((c) => (
                <span key={c} className="tag">
                  {c}
                </span>
              ))}
            </span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Rating</span>
            <span className="mono">{merchant.rating.toFixed(1)}</span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Reviews</span>
            <span className="meta-value">{merchant.reviewCount}</span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Status</span>
            <span className="meta-value">
              <span className={`pill pill-${merchant.isOpen ? 'ok' : 'muted'}`}>
                {merchant.isOpen ? 'Open' : 'Closed'}
              </span>
            </span>
          </div>
        </div>
      </div>

      <div className="detail-section">
        <h3>Verification</h3>
        <div className="meta-grid">
          <div className="meta-item">
            <span className="meta-label">State</span>
            <span className="meta-value">
              <StatusPill status={merchant.verification} tone={verificationTone(merchant.verification)} />
            </span>
          </div>
        </div>
        <div className="meta-label">Documents</div>
        <div>
          {(merchant.documents ?? []).map((doc) => (
            <span key={doc.type} className={`tag ${docTone(doc.status)}`}>
              {doc.type} · {doc.status}
            </span>
          ))}
          {(merchant.documents ?? []).length === 0 && <span className="muted small">No documents on file</span>}
        </div>
      </div>

      <div className="detail-section">
        <h3>Commercial</h3>
        <div className="meta-grid">
          <div className="meta-item">
            <span className="meta-label">Commission rate</span>
            <span className="mono">{fmtBps(commercial.commissionRateBps)}</span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Payout cycle</span>
            <span className="meta-value">
              {commercial.payoutCycleDays != null ? `${commercial.payoutCycleDays} days` : '—'}
            </span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Payout account</span>
            <span className="meta-value">
              <MaskedField value={commercial.payoutAccount} permission="audit.unmask" label="Payout account" />
            </span>
          </div>
        </div>
      </div>

      {ACTIONABLE.includes(merchant.verification) && canApprove && (
        <div className="form-actions">
          <button type="button" className="btn" onClick={() => onAction('approve')}>
            Approve
          </button>
          <button type="button" className="btn" onClick={() => onAction('request_changes')}>
            Request changes
          </button>
          <button type="button" className="btn btn-danger" onClick={() => onAction('reject')}>
            Reject
          </button>
        </div>
      )}

      <AuditTrailSection entityType="merchant" entityId={merchant.id} label="Audit" />
    </DetailDrawer>
  )
}

/** Approve flow — ReasonPrompt-style modal plus an optional commission override. */
function ApprovePrompt({
  busy,
  error,
  onSubmit,
  onClose,
}: {
  busy: boolean
  error: string | null
  onSubmit: (reason: string, commissionRateBps?: number) => void
  onClose: () => void
}) {
  const reasonRef = useRef<HTMLTextAreaElement>(null)
  const [bps, setBps] = useState('')

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
    const parsed = bps ? Math.round(Number(bps)) : undefined
    onSubmit(reason, parsed != null && Number.isFinite(parsed) ? Math.max(0, parsed) : undefined)
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="Approve merchant"
        onClick={(e) => e.stopPropagation()}
        onSubmit={handleSubmit}
      >
        <h3 className="modal-title">Approve merchant</h3>
        <p className="muted small">Approval publishes the merchant to the marketplace.</p>
        <label className="field-label" htmlFor="approve-reason">
          Reason
        </label>
        <textarea
          ref={reasonRef}
          id="approve-reason"
          className="field"
          rows={3}
          maxLength={500}
          required
          placeholder="Explain why this action is taken (audited)"
        />
        <div className="form-grid">
          <label className="field-block">
            <span className="field-label">Commission rate (bps)</span>
            <input
              type="number"
              className="field"
              min={0}
              step={1}
              value={bps}
              onChange={(e) => setBps(e.target.value)}
              placeholder="Optional, e.g. 250"
            />
          </label>
        </div>
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
