import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AdminListRiskCasesSeverity,
  AdminListRiskCasesStatus,
  adminListRiskCases,
  adminReviewRiskCase,
  type AdminReviewRiskCaseBodyAction,
  type RiskCase,
  type RiskCaseRelated,
} from '@hudumika/contract'
import { parseApiError } from '../../lib/api-error'
import { toLocal } from '../../lib/time'
import { useSession } from '../../lib/session'
import { can } from '../../lib/permissions'
import { DetailDrawer } from '../../components/DetailDrawer'
import { AuditTrailSection } from '../../components/AuditTrailSection'
import { DataTable, type DataTableColumn } from '../../components/DataTable'
import { ErrorState } from '../../components/ErrorState'
import { FilterChips } from '../../components/FilterChips'
import { Toast } from '../../components/FormBits'
import { LoadingSkeleton } from '../../components/LoadingSkeleton'
import { ReasonPrompt } from '../../components/ReasonPrompt'
import { StatusPill } from '../../components/StatusPill'
import { useRefetchOnFocus } from '../../lib/use-refetch-on-focus'

type StatusFilter = 'all' | (typeof AdminListRiskCasesStatus)[keyof typeof AdminListRiskCasesStatus]
type SeverityFilter = 'all' | (typeof AdminListRiskCasesSeverity)[keyof typeof AdminListRiskCasesSeverity]
type ActionKind = AdminReviewRiskCaseBodyAction

const STATUSES = Object.values(AdminListRiskCasesStatus)
const SEVERITIES = Object.values(AdminListRiskCasesSeverity)

const STATUS_FILTERS: Array<{ key: StatusFilter; label: string }> = [
  { key: 'all', label: 'All' },
  ...STATUSES.map((s) => ({ key: s as StatusFilter, label: s.replace(/_/g, ' ') })),
]

const SEVERITY_FILTERS: Array<{ key: SeverityFilter; label: string }> = [
  { key: 'all', label: 'All' },
  ...SEVERITIES.map((s) => ({ key: s as SeverityFilter, label: s.replace(/_/g, ' ') })),
]

const ACTIONABLE = ['open', 'investigating']

const SEVERITY_ORDER: Record<RiskCase['severity'], number> = { low: 1, medium: 2, high: 3, critical: 4 }

const COLUMNS: DataTableColumn<RiskCase>[] = [
  { key: 'id', header: 'ID', render: (c) => short(c.id), className: 'mono' },
  {
    key: 'severity',
    header: 'Severity',
    render: (c) => <StatusPill status={c.severity} tone={severityTone(c.severity)} />,
    sortValue: (c) => SEVERITY_ORDER[c.severity],
  },
  { key: 'status', header: 'Status', render: (c) => <StatusPill status={c.status} tone={statusTone(c.status)} /> },
  {
    key: 'signals',
    header: 'Signals',
    render: (c) => (
      <>
        {c.signals.slice(0, 3).map((s) => (
          <span key={s} className="tag">
            {s}
          </span>
        ))}
        {c.signals.length > 3 && <span className="muted small">+{c.signals.length - 3}</span>}
      </>
    ),
  },
  { key: 'related', header: 'Related', render: (c) => relatedSummary(c), className: 'muted small' },
  { key: 'createdAt', header: 'Created', render: (c) => toLocal(c.createdAt), sortValue: (c) => c.createdAt, className: 'muted' },
]

const PROMPT: Record<ActionKind, { description: string; danger: boolean }> = {
  dismiss: { description: 'The case will be closed with no action taken.', danger: false },
  block_user: { description: 'The related customer account will be blocked.', danger: true },
  block_provider: { description: 'The related provider account will be blocked.', danger: true },
  escalate: { description: 'The case will be escalated for senior review.', danger: false },
  hold: { description: 'The case will be held pending further signals.', danger: false },
}

const TOAST: Record<ActionKind, string> = {
  dismiss: 'dismissed',
  block_user: 'user blocked',
  block_provider: 'provider blocked',
  escalate: 'escalated',
  hold: 'held',
}

function severityTone(severity: RiskCase['severity']): 'bad' | 'warn' | 'info' | 'muted' {
  if (severity === 'critical') return 'bad'
  if (severity === 'high') return 'warn'
  if (severity === 'medium') return 'info'
  return 'muted'
}

function statusTone(status: RiskCase['status']): 'ok' | 'bad' | 'warn' | 'info' {
  if (status === 'open') return 'warn'
  if (status === 'investigating') return 'info'
  if (status === 'resolved') return 'ok'
  return 'bad'
}

function short(id: string) {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id
}

function relatedSummary(c: RiskCase): string {
  const r = c.related
  if (!r) return '—'
  const parts: string[] = []
  if (r.customerUserId) parts.push(short(r.customerUserId))
  if (r.providerId) parts.push(short(r.providerId))
  if (r.riderId) parts.push(short(r.riderId))
  if (r.orderIds?.length) parts.push(`${r.orderIds.length} orders`)
  return parts.length > 0 ? parts.join(', ') : '—'
}

export function RiskCasesPage() {
  const [all, setAll] = useState<RiskCase[] | null>(null)
  const [rows, setRows] = useState<RiskCase[]>([])
  const [status, setStatus] = useState<StatusFilter>('all')
  const [severity, setSeverity] = useState<SeverityFilter>('all')
  const [selected, setSelected] = useState<RiskCase | null>(null)
  const [prompt, setPrompt] = useState<ActionKind | null>(null)
  const [promptError, setPromptError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [retryKey, setRetryKey] = useState(0)

  const session = useSession()
  const canInvestigate = can(session, 'risk.investigate')
  const canBlock = can(session, 'risk.block')

  const load = useCallback(() => {
    setError(null)
    const params =
      status === 'all' && severity === 'all'
        ? undefined
        : {
            status: status === 'all' ? undefined : status,
            severity: severity === 'all' ? undefined : severity,
          }
    adminListRiskCases(params).then((res) => {
      if (res.status === 200) {
        setRows(res.data)
        if (params === undefined) setAll(res.data)
      } else {
        setError(`Failed to load risk cases (${res.status})`)
      }
    })
  }, [status, severity])

  useEffect(() => {
    load()
  }, [load, retryKey])

  useRefetchOnFocus(load)

  const counts = useMemo(() => {
    const statusCounts: Partial<Record<StatusFilter, number>> = { all: all?.length ?? 0 }
    const severityCounts: Partial<Record<SeverityFilter, number>> = { all: all?.length ?? 0 }
    for (const s of STATUSES) statusCounts[s] = (all ?? []).filter((c) => c.status === s).length
    for (const s of SEVERITIES) severityCounts[s] = (all ?? []).filter((c) => c.severity === s).length
    return { status: statusCounts, severity: severityCounts }
  }, [all])

  const matrix = useMemo(() => {
    const cellCounts = new Map<string, number>()
    for (const c of all ?? []) {
      const key = `${c.severity}|${c.status}`
      cellCounts.set(key, (cellCounts.get(key) ?? 0) + 1)
    }
    return SEVERITIES.map((sev) => {
      const cells = STATUSES.map((st) => ({ status: st, count: cellCounts.get(`${sev}|${st}`) ?? 0 }))
      const total = cells.reduce((n, cell) => n + cell.count, 0)
      return { severity: sev, cells, total }
    })
  }, [all])

  function focusMatrix(sev: SeverityFilter, st: StatusFilter) {
    if (status === st && severity === sev) {
      setStatus('all')
      setSeverity('all')
    } else {
      setSeverity(sev)
      setStatus(st)
    }
  }

  async function decide(reason: string) {
    const target = selected
    const kind = prompt
    if (!target || !kind) return
    setBusy(true)
    setPromptError(null)
    const res = await adminReviewRiskCase(target.id, { action: kind, reason })
    if (res.status === 200) {
      setAll((prev) => (prev ?? []).map((c) => (c.id === res.data.id ? { ...c, ...res.data } : c)))
      setRows((prev) => prev.map((c) => (c.id === res.data.id ? { ...c, ...res.data } : c)))
      setSelected(null)
      setPrompt(null)
      setToast(`Case ${short(target.id)} ${TOAST[kind]}`)
      setRetryKey((k) => k + 1)
    } else {
      setPromptError(parseApiError(res).message)
    }
    setBusy(false)
  }

  if (error) {
    return <ErrorState title="Failed to load risk cases" message={error} onRetry={() => setRetryKey((k) => k + 1)} />
  }
  if (!all) return <LoadingSkeleton kind="table" rows={6} />

  return (
    <div className="page">
      <div className="page-title-row">
        <h1>Risk Cases</h1>
        {toast && (
          <div className="page-actions">
            <Toast message={toast} />
          </div>
        )}
      </div>

      <FilterChips
        options={STATUS_FILTERS}
        value={status}
        onChange={setStatus}
        counts={counts.status}
        ariaLabel="Risk status filters"
      />
      <FilterChips
        options={SEVERITY_FILTERS}
        value={severity}
        onChange={setSeverity}
        counts={counts.severity}
        ariaLabel="Risk severity filters"
      />

      <div className="table-wrap">
        <table className="table" aria-label="Risk cases by severity and status">
          <thead>
            <tr>
              <th>Severity</th>
              {STATUSES.map((s) => (
                <th key={s}>{s.replace(/_/g, ' ')}</th>
              ))}
              <th>Total</th>
            </tr>
          </thead>
          <tbody>
            {matrix.map((row) => (
              <tr key={row.severity}>
                <td>{row.severity}</td>
                {row.cells.map((cell) => (
                  <td key={cell.status}>
                    <button
                      type="button"
                      className={`tag${row.severity === 'critical' && cell.status === 'open' ? ' bad' : ''}${
                        row.severity === 'high' && cell.status === 'open' ? ' warn' : ''
                      }`}
                      aria-label={`${row.severity} ${cell.status} cases`}
                      onClick={() => focusMatrix(row.severity, cell.status)}
                    >
                      {cell.count}
                    </button>
                  </td>
                ))}
                <td aria-label={`${row.severity} total cases`}>{row.total}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <DataTable
        rows={rows}
        columns={COLUMNS}
        rowKey={(c) => c.id}
        onRowClick={setSelected}
        exportable
        exportFileName="risk-cases"
        tableId="risk"
        emptyTitle="No risk cases"
        emptyHint="Flagged activity appears here for review."
        ariaLabel="Risk cases"
      />

      {selected && (
        <RiskCaseDrawer
          riskCase={selected}
          canInvestigate={canInvestigate}
          canBlock={canBlock}
          onClose={() => setSelected(null)}
          onAction={(kind) => {
            setToast(null)
            setPromptError(null)
            setPrompt(kind)
          }}
        />
      )}

      {prompt && (
        <ReasonPrompt
          title={prompt.replace(/_/g, ' ')}
          description={PROMPT[prompt].description}
          tone={PROMPT[prompt].danger ? 'danger' : 'default'}
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

function RiskCaseDrawer({
  riskCase,
  canInvestigate,
  canBlock,
  onClose,
  onAction,
}: {
  riskCase: RiskCase
  canInvestigate: boolean
  canBlock: boolean
  onClose: () => void
  onAction: (kind: ActionKind) => void
}) {
  const r: RiskCaseRelated = riskCase.related ?? {}
  return (
    <DetailDrawer title={`Case ${short(riskCase.id)}`} onClose={onClose}>
      <div className="detail-section">
        <h3>Case</h3>
        <div className="meta-grid">
          <div className="meta-item">
            <span className="meta-label">ID</span>
            <span className="meta-value mono">{riskCase.id}</span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Severity</span>
            <span className="meta-value">
              <StatusPill status={riskCase.severity} tone={severityTone(riskCase.severity)} />
            </span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Status</span>
            <span className="meta-value">
              <StatusPill status={riskCase.status} tone={statusTone(riskCase.status)} />
            </span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Created by</span>
            <span className="meta-value mono">{riskCase.createdBy ?? '—'}</span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Created</span>
            <span className="meta-value">{toLocal(riskCase.createdAt)}</span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Decided action</span>
            <span className="meta-value">{riskCase.decidedAction ? riskCase.decidedAction.replace(/_/g, ' ') : '—'}</span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Reason</span>
            <span className="meta-value">{riskCase.reason ?? '—'}</span>
          </div>
        </div>
      </div>

      <div className="detail-section">
        <h3>Related</h3>
        <div className="meta-grid">
          <div className="meta-item">
            <span className="meta-label">Customer user</span>
            <span className="meta-value mono">{r.customerUserId ?? '—'}</span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Provider</span>
            <span className="meta-value mono">{r.providerId ?? '—'}</span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Rider</span>
            <span className="meta-value mono">{r.riderId ?? '—'}</span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Orders</span>
            <span className="meta-value">
              {!r.orderIds || r.orderIds.length === 0 ? (
                <span className="muted small">—</span>
              ) : (
                r.orderIds.map((id) => (
                  <span key={id} className="tag">
                    {id}
                  </span>
                ))
              )}
            </span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Devices</span>
            <span className="meta-value">
              {!r.deviceIds || r.deviceIds.length === 0 ? (
                <span className="muted small">—</span>
              ) : (
                r.deviceIds.map((id) => (
                  <span key={id} className="tag">
                    {id}
                  </span>
                ))
              )}
            </span>
          </div>
          <div className="meta-item">
            <span className="meta-label">IP history</span>
            <span className="meta-value">
              {!r.ipHistory || r.ipHistory.length === 0 ? (
                <span className="muted small">—</span>
              ) : (
                r.ipHistory.map((ip) => (
                  <span key={ip} className="tag">
                    {ip}
                  </span>
                ))
              )}
            </span>
          </div>
        </div>
      </div>

      <div className="detail-section">
        <h3>Signals</h3>
        <div>
          {riskCase.signals.length === 0 ? (
            <span className="muted small">—</span>
          ) : (
            riskCase.signals.map((s) => (
              <span key={s} className="tag">
                {s}
              </span>
            ))
          )}
        </div>
      </div>

      {canInvestigate && (
        <p className="muted small">Blocks require the risk.block permission; decisions are audited (risk_case.*).</p>
      )}

      {canInvestigate ? (
        ACTIONABLE.includes(riskCase.status) && (
          <div className="form-actions">
            <button type="button" className="btn" onClick={() => onAction('dismiss')}>
              Dismiss
            </button>
            {canBlock && (
              <button type="button" className="btn btn-danger" onClick={() => onAction('block_user')}>
                Block user
              </button>
            )}
            {canBlock && (
              <button type="button" className="btn btn-danger" onClick={() => onAction('block_provider')}>
                Block provider
              </button>
            )}
            <button type="button" className="btn" onClick={() => onAction('escalate')}>
              Escalate
            </button>
            <button type="button" className="btn" onClick={() => onAction('hold')}>
              Hold
            </button>
          </div>
        )
      ) : (
        <p className="muted small">Case review requires risk.investigate</p>
      )}

      <AuditTrailSection entityType="risk_case" entityId={riskCase.id} label="Audit" />
    </DetailDrawer>
  )
}
