import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  adminGroupBuyDecision,
  adminListGroupBuys,
  GroupBuyStatus,
  type AdminGroupBuyDecisionBody,
  type GroupBuyDeal,
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

type StatusFilter = 'all' | GroupBuyStatus
type ActionKind = 'approve' | 'reject' | 'delist'

const STATUSES = Object.values(GroupBuyStatus)

const FILTERS: Array<{ key: StatusFilter; label: string }> = [
  { key: 'all', label: 'All' },
  ...STATUSES.map((s) => ({ key: s as StatusFilter, label: s.replace(/_/g, ' ') })),
]

const DECISION: Record<ActionKind, AdminGroupBuyDecisionBody['decision']> = {
  approve: 'approved',
  reject: 'rejected',
  delist: 'delisted',
}

const PROMPT: Record<ActionKind, { title: string; description: string }> = {
  approve: {
    title: 'Approve group buy deal',
    description: 'The deal will be approved and go live.',
  },
  reject: {
    title: 'Reject group buy deal',
    description: 'The deal will be rejected and can no longer be used.',
  },
  delist: {
    title: 'Delist group buy deal',
    description: 'The deal will be delisted and removed from the live selection.',
  },
}

function dealTone(status: GroupBuyStatus): 'ok' | 'bad' | 'warn' | 'muted' {
  if (status === 'live' || status === 'extended') return 'ok'
  if (status === 'pending_review') return 'warn'
  return 'muted'
}

function short(id: string) {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id
}

const COLUMNS: DataTableColumn<GroupBuyDeal>[] = [
  {
    key: 'title',
    header: 'Title',
    render: (d) => (
      <>
        <div className="strong">{d.title}</div>
        <div className="muted small mono">{d.id}</div>
      </>
    ),
  },
  { key: 'merchant', header: 'Merchant', render: (d) => short(d.merchantId), className: 'mono' },
  {
    key: 'price',
    header: 'Price',
    render: (d) => (
      <>
        {formatTZS(d.priceTZS)} from <span className="muted">{formatTZS(d.originalPriceTZS)}</span>
      </>
    ),
    sortValue: (d) => d.priceTZS,
    align: 'right',
  },
  { key: 'sold', header: 'Sold / Qty', render: (d) => <>{d.soldCount ?? '—'} / {d.quantity}</>, align: 'right' },
  { key: 'status', header: 'Status', render: (d) => <StatusPill status={d.status} tone={dealTone(d.status)} /> },
  {
    key: 'schedule',
    header: 'Schedule',
    render: (d) => (
      <span className="muted small">
        {toLocal(d.salesStartAt)} – {toLocal(d.salesEndAt)}
      </span>
    ),
  },
]

export function GroupBuysPage() {
  const [all, setAll] = useState<GroupBuyDeal[] | null>(null)
  const [rows, setRows] = useState<GroupBuyDeal[]>([])
  const [filter, setFilter] = useState<StatusFilter>('all')
  const [selected, setSelected] = useState<GroupBuyDeal | null>(null)
  const [prompt, setPrompt] = useState<ActionKind | null>(null)
  const [promptError, setPromptError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [retryKey, setRetryKey] = useState(0)

  const load = useCallback(() => {
    setError(null)
    const params = filter === 'all' ? undefined : { state: filter }
    adminListGroupBuys(params).then((res) => {
      if (res.status === 200) {
        setRows(res.data)
        if (params === undefined) setAll(res.data)
      } else {
        setError(`Failed to load group buy deals (${res.status})`)
      }
    })
  }, [filter])

  useEffect(() => {
    load()
  }, [load, retryKey])

  useRefetchOnFocus(load)

  const counts = useMemo(() => {
    const map: Partial<Record<StatusFilter, number>> = { all: all?.length ?? 0 }
    for (const s of STATUSES) map[s] = (all ?? []).filter((d) => d.status === s).length
    return map
  }, [all])

  const session = useSession()
  const allowed = can(session, 'group_buy.moderate')

  async function decide(reason: string) {
    const target = selected
    const kind = prompt
    if (!target || !kind) return
    setBusy(true)
    setPromptError(null)
    const res = await adminGroupBuyDecision(target.id ?? '', { decision: DECISION[kind], reason })
    if (res.status === 200) {
      setAll((prev) => (prev ?? []).map((d) => (d.id === res.data.id ? { ...d, ...res.data } : d)))
      setRows((prev) => prev.map((d) => (d.id === res.data.id ? { ...d, ...res.data } : d)))
      setSelected(null)
      setPrompt(null)
      setToast(
        kind === 'approve'
          ? `${target.title} approved`
          : kind === 'reject'
            ? `${target.title} rejected`
            : `${target.title} delisted`,
      )
      setRetryKey((k) => k + 1)
    } else {
      setPromptError(parseApiError(res).message)
    }
    setBusy(false)
  }

  if (error) {
    return <ErrorState title="Failed to load group buy deals" message={error} onRetry={() => setRetryKey((k) => k + 1)} />
  }
  if (!all) return <LoadingSkeleton kind="table" rows={6} />

  return (
    <div className="page">
      <div className="page-title-row">
        <h1>Group Buys</h1>
        {toast && (
          <div className="page-actions">
            <Toast message={toast} />
          </div>
        )}
      </div>

      <FilterChips options={FILTERS} value={filter} onChange={setFilter} counts={counts} ariaLabel="Group buy status filters" />

      <DataTable
        rows={rows}
        columns={COLUMNS}
        rowKey={(d) => d.id ?? d.merchantId}
        onRowClick={setSelected}
        exportable
        exportFileName="group-buys"
        tableId="groupbuys"
        emptyTitle="No group buy deals found"
        emptyHint="New deals appear here when merchants submit them."
        ariaLabel="Group buys"
      />

      {selected && (
        <GroupBuyDrawer
          deal={selected}
          onClose={() => setSelected(null)}
          allowed={allowed}
          onAction={(kind) => {
            setToast(null)
            setPromptError(null)
            setPrompt(kind)
          }}
        />
      )}

      {prompt && (
        <ReasonPrompt
          title={PROMPT[prompt].title}
          description={PROMPT[prompt].description}
          tone={prompt === 'approve' ? 'default' : 'danger'}
          maxLength={1000}
          busy={busy}
          error={promptError}
          onSubmit={decide}
          onClose={() => setPrompt(null)}
        />
      )}
    </div>
  )
}

function GroupBuyDrawer({
  deal,
  onClose,
  onAction,
  allowed,
}: {
  deal: GroupBuyDeal
  onClose: () => void
  onAction: (kind: ActionKind) => void
  allowed: boolean
}) {
  const d = deal
  return (
    <DetailDrawer title={d.title} onClose={onClose}>
      <div className="detail-section">
        <h3>Deal</h3>
        <div className="meta-grid">
          <div className="meta-item">
            <span className="meta-label">Deal</span>
            <span className="meta-value mono">{d.id ?? '—'}</span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Title</span>
            <span className="meta-value">{d.title}</span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Merchant</span>
            <span className="meta-value mono">{short(d.merchantId)}</span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Description</span>
            <span className="meta-value">{d.description ?? '—'}</span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Image</span>
            <span className="meta-value mono small">{d.imageUrl ?? '—'}</span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Status</span>
            <span className="meta-value">
              <StatusPill status={d.status} tone={dealTone(d.status)} />
            </span>
          </div>
        </div>
      </div>

      <div className="detail-section">
        <h3>Pricing</h3>
        <div className="meta-grid">
          <div className="meta-item">
            <span className="meta-label">Price</span>
            <span className="meta-value">{formatTZS(d.priceTZS)}</span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Original price</span>
            <span className="meta-value">{formatTZS(d.originalPriceTZS)}</span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Quantity</span>
            <span className="meta-value">{d.quantity}</span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Sold</span>
            <span className="meta-value">{d.soldCount ?? '—'}</span>
          </div>
        </div>
      </div>

      <div className="detail-section">
        <h3>Schedule</h3>
        <div className="meta-grid">
          <div className="meta-item">
            <span className="meta-label">Sales start</span>
            <span className="meta-value">{toLocal(d.salesStartAt)}</span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Sales end</span>
            <span className="meta-value">{toLocal(d.salesEndAt)}</span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Validity days</span>
            <span className="meta-value">{d.validityDays ?? '—'}</span>
          </div>
        </div>
      </div>

      {d.rejectReason && (
        <div className="detail-section">
          <h3>Rejection reason</h3>
          <p className="small">{d.rejectReason}</p>
        </div>
      )}

      {allowed && (d.status === 'pending_review' || d.status === 'live') && (
        <div className="form-actions">
          {d.status === 'pending_review' && (
            <button type="button" className="btn" onClick={() => onAction('approve')}>
              Approve
            </button>
          )}
          {d.status === 'pending_review' && (
            <button type="button" className="btn btn-danger" onClick={() => onAction('reject')}>
              Reject
            </button>
          )}
          {d.status === 'live' && (
            <button type="button" className="btn btn-danger" onClick={() => onAction('delist')}>
              Delist
            </button>
          )}
        </div>
      )}

      <AuditTrailSection entityType="group_buy" entityId={d.id ?? ''} label="Audit" />
    </DetailDrawer>
  )
}
