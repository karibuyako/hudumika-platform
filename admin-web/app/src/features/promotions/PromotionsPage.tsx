import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  adminListPromotions,
  adminPromotionDecision,
  AdminListPromotionsState,
  type AdminPromotionDecisionBody,
  type Promotion,
  type PromotionStatus,
} from '@hudumika/contract'
import { parseApiError } from '../../lib/api-error'
import { formatTZS } from '../../lib/money'
import { can } from '../../lib/permissions'
import { useSession } from '../../lib/session'
import { toLocal } from '../../lib/time'
import { DataTable, type DataTableColumn } from '../../components/DataTable'
import { DetailDrawer } from '../../components/DetailDrawer'
import { AuditTrailSection } from '../../components/AuditTrailSection'
import { ErrorState } from '../../components/ErrorState'
import { FilterChips } from '../../components/FilterChips'
import { Toast } from '../../components/FormBits'
import { LoadingSkeleton } from '../../components/LoadingSkeleton'
import { ReasonPrompt } from '../../components/ReasonPrompt'
import { StatusPill } from '../../components/StatusPill'
import { useRefetchOnFocus } from '../../lib/use-refetch-on-focus'

type StatusFilter = 'all' | (typeof AdminListPromotionsState)[keyof typeof AdminListPromotionsState]
type ActionKind = 'approve' | 'reject' | 'pause'

const STATUSES = Object.values(AdminListPromotionsState)

const FILTERS: Array<{ key: StatusFilter; label: string }> = [
  { key: 'all', label: 'All' },
  ...STATUSES.map((s) => ({ key: s as StatusFilter, label: s.replace(/_/g, ' ') })),
]

const DECISION: Record<ActionKind, AdminPromotionDecisionBody['decision']> = {
  approve: 'approved',
  reject: 'rejected',
  pause: 'paused',
}

function promoTone(status: PromotionStatus): 'ok' | 'bad' | 'warn' | 'muted' {
  if (status === 'live') return 'ok'
  if (status === 'rejected' || status === 'ended') return 'muted'
  if (status === 'pending_review') return 'warn'
  return 'bad'
}

function fmtRate(bps: number): string {
  return `${(bps / 100).toFixed(1).replace(/\.0$/, '')}%`
}

function benefit(p: Promotion): string {
  if (p.couponAmountTZS != null) return formatTZS(p.couponAmountTZS)
  if (p.discountRateBps != null) return fmtRate(p.discountRateBps)
  return '—'
}

function short(id: string) {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id
}

const COLUMNS: DataTableColumn<Promotion>[] = [
  {
    key: 'title',
    header: 'Title',
    render: (p) => (
      <>
        <div className="strong">{p.title}</div>
        <div className="muted small mono">{p.id}</div>
      </>
    ),
  },
  { key: 'merchant', header: 'Merchant', render: (p) => short(p.merchantId), className: 'mono' },
  { key: 'type', header: 'Type', render: (p) => <span className="tag">{p.type}</span> },
  { key: 'status', header: 'Status', render: (p) => <StatusPill status={p.status} tone={promoTone(p.status)} /> },
  { key: 'budget', header: 'Budget', render: (p) => formatTZS(p.budgetTZS), sortValue: (p) => p.budgetTZS ?? 0, align: 'right' },
  { key: 'benefit', header: 'Benefit', render: benefit },
  { key: 'redeems', header: 'Redeems', render: (p) => p.redeemCount ?? '—', align: 'right' },
  { key: 'schedule', header: 'Schedule', render: (p) => (
    <span className="muted small">
      {toLocal(p.startsAt)} – {toLocal(p.endsAt)}
    </span>
  ) },
]

export function PromotionsPage() {
  const [all, setAll] = useState<Promotion[] | null>(null)
  const [rows, setRows] = useState<Promotion[]>([])
  const [filter, setFilter] = useState<StatusFilter>('all')
  const [selected, setSelected] = useState<Promotion | null>(null)
  const [prompt, setPrompt] = useState<ActionKind | null>(null)
  const [promptError, setPromptError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [retryKey, setRetryKey] = useState(0)

  const load = useCallback(() => {
    setError(null)
    const params = filter === 'all' ? undefined : { state: filter }
    adminListPromotions(params).then((res) => {
      if (res.status === 200) {
        setRows(res.data)
        if (params === undefined) setAll(res.data)
      } else {
        setError(`Failed to load promotions (${res.status})`)
      }
    })
  }, [filter])

  useEffect(() => {
    load()
  }, [load, retryKey])

  useRefetchOnFocus(load)

  const counts = useMemo(() => {
    const map: Partial<Record<StatusFilter, number>> = { all: all?.length ?? 0 }
    for (const s of STATUSES) map[s] = (all ?? []).filter((p) => p.status === s).length
    return map
  }, [all])

  const session = useSession()
  const allowed = can(session, 'promotion.moderate')

  async function decide(reason: string) {
    const target = selected
    const kind = prompt
    if (!target || !kind) return
    setBusy(true)
    setPromptError(null)
    const res = await adminPromotionDecision(target.id ?? '', {
      decision: DECISION[kind],
      reason,
    })
    if (res.status === 200) {
      setAll((prev) => (prev ?? []).map((p) => (p.id === res.data.id ? { ...p, ...res.data } : p)))
      setRows((prev) => prev.map((p) => (p.id === res.data.id ? { ...p, ...res.data } : p)))
      setSelected(null)
      setPrompt(null)
      setToast(
        kind === 'approve'
          ? `${target.title} approved`
          : kind === 'reject'
            ? `${target.title} rejected`
            : `${target.title} paused`,
      )
      setRetryKey((k) => k + 1)
    } else {
      setPromptError(parseApiError(res).message)
    }
    setBusy(false)
  }

  if (error) {
    return <ErrorState title="Failed to load promotions" message={error} onRetry={() => setRetryKey((k) => k + 1)} />
  }
  if (!all) return <LoadingSkeleton kind="table" rows={6} />

  return (
    <div className="page">
      <div className="page-title-row">
        <h1>Promotions</h1>
        {toast && (
          <div className="page-actions">
            <Toast message={toast} />
          </div>
        )}
      </div>

      <FilterChips options={FILTERS} value={filter} onChange={setFilter} counts={counts} ariaLabel="Promotion status filters" />

      <DataTable
        rows={rows}
        columns={COLUMNS}
        rowKey={(p) => p.id ?? p.merchantId}
        onRowClick={setSelected}
        exportable
        exportFileName="promotions"
        tableId="promotions"
        emptyTitle="No promotions found"
        emptyHint="New promotions appear here when merchants submit them."
        ariaLabel="Promotions"
      />

      {selected && (
        <PromotionDrawer
          promotion={selected}
          onClose={() => setSelected(null)}
          allowed={allowed}
          onAction={(kind) => {
            setToast(null)
            setPromptError(null)
            setPrompt(kind)
          }}
        />
      )}

      {prompt === 'approve' && (
        <ReasonPrompt
          title="Approve promotion"
          description="The promotion will be published and go live."
          maxLength={1000}
          busy={busy}
          error={promptError}
          onSubmit={(reason) => decide(reason)}
          onClose={() => setPrompt(null)}
        />
      )}

      {prompt === 'reject' && (
        <ReasonPrompt
          title="Reject promotion"
          description="The promotion will be rejected and can no longer be used."
          tone="danger"
          maxLength={1000}
          busy={busy}
          error={promptError}
          onSubmit={(reason) => decide(reason)}
          onClose={() => setPrompt(null)}
        />
      )}

      {prompt === 'pause' && (
        <ReasonPrompt
          title="Pause promotion"
          description="The promotion will be paused and stop running immediately."
          maxLength={1000}
          busy={busy}
          error={promptError}
          onSubmit={(reason) => decide(reason)}
          onClose={() => setPrompt(null)}
        />
      )}
    </div>
  )
}

function PromotionDrawer({
  promotion,
  onClose,
  onAction,
  allowed,
}: {
  promotion: Promotion
  onClose: () => void
  onAction: (kind: ActionKind) => void
  allowed: boolean
}) {
  const p = promotion
  const roi =
    p.attributedRevenueTZS != null && p.spendTZS != null && p.spendTZS > 0
      ? `${Math.round((p.attributedRevenueTZS / p.spendTZS) * 100)}%`
      : null
  return (
    <DetailDrawer title={p.title} onClose={onClose}>
      <div className="detail-section">
        <h3>Campaign</h3>
        <div className="meta-grid">
          <div className="meta-item">
            <span className="meta-label">ID</span>
            <span className="mono">{p.id ?? '—'}</span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Merchant</span>
            <span className="mono">{short(p.merchantId)}</span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Type</span>
            <span className="meta-value">
              <span className="tag">{p.type}</span>
            </span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Status</span>
            <span className="meta-value">
              <StatusPill status={p.status} tone={promoTone(p.status)} />
            </span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Description</span>
            <span className="meta-value">{p.description ?? '—'}</span>
          </div>
        </div>
      </div>

      <div className="detail-section">
        <h3>Money</h3>
        <div className="meta-grid">
          <div className="meta-item">
            <span className="meta-label">Budget</span>
            <span className="meta-value">{formatTZS(p.budgetTZS)}</span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Coupon amount</span>
            <span className="meta-value">{formatTZS(p.couponAmountTZS)}</span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Threshold</span>
            <span className="meta-value">{formatTZS(p.thresholdTZS)}</span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Spend</span>
            <span className="meta-value">{formatTZS(p.spendTZS)}</span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Attributed revenue</span>
            <span className="meta-value">{formatTZS(p.attributedRevenueTZS)}</span>
          </div>
          {roi && (
            <div className="meta-item">
              <span className="meta-label">ROI</span>
              <span className="meta-value">{roi}</span>
            </div>
          )}
        </div>
      </div>

      <div className="detail-section">
        <h3>Schedule</h3>
        <div className="meta-grid">
          <div className="meta-item">
            <span className="meta-label">Starts</span>
            <span className="meta-value">{toLocal(p.startsAt)}</span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Ends</span>
            <span className="meta-value">{toLocal(p.endsAt)}</span>
          </div>
        </div>
      </div>

      <div className="detail-section">
        <h3>Performance</h3>
        <div className="meta-grid">
          <div className="meta-item">
            <span className="meta-label">Redeems</span>
            <span className="meta-value">{p.redeemCount ?? '—'}</span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Impressions</span>
            <span className="meta-value">{p.impressions ?? '—'}</span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Clicks</span>
            <span className="meta-value">{p.clicks ?? '—'}</span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Attributed orders</span>
            <span className="meta-value">{p.attributedOrders ?? '—'}</span>
          </div>
        </div>
      </div>

      {p.rejectReason && (
        <div className="detail-section">
          <h3>Reject reason</h3>
          <p className="small">{p.rejectReason}</p>
        </div>
      )}

      {allowed && (p.status === 'pending_review' || p.status === 'live') && (
        <div className="form-actions">
          {p.status === 'pending_review' && (
            <button type="button" className="btn" onClick={() => onAction('approve')}>
              Approve
            </button>
          )}
          <button type="button" className="btn btn-danger" onClick={() => onAction('reject')}>
            Reject
          </button>
          {p.status === 'live' && (
            <button type="button" className="btn" onClick={() => onAction('pause')}>
              Pause
            </button>
          )}
        </div>
      )}

      <AuditTrailSection entityType="promotion" entityId={p.id ?? ''} label="Audit" />
    </DetailDrawer>
  )
}
