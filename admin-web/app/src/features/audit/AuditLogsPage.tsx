import { useCallback, useEffect, useMemo, useState } from 'react'
import { adminListAuditLogs, type AdminListAuditLogsParams, type AuditLog } from '@hudumika/contract'
import { DataTable, type DataTableColumn } from '../../components/DataTable'
import { ErrorState } from '../../components/ErrorState'
import { LoadingSkeleton } from '../../components/LoadingSkeleton'
import { DetailDrawer } from '../../components/DetailDrawer'
import { FilterChips } from '../../components/FilterChips'
import { Toast } from '../../components/FormBits'
import { MaskedField } from '../../components/MaskedField'
import { toLocal } from '../../lib/time'
import { parseApiError } from '../../lib/api-error'
import { useSession } from '../../lib/session'
import { can } from '../../lib/permissions'
import { useRefetchOnFocus } from '../../lib/use-refetch-on-focus'

const DETAILS_TRUNCATE = 2000

const COLUMNS: DataTableColumn<AuditLog>[] = [
  { key: 'at', header: 'At', render: (l) => toLocal(l.at), sortValue: (l) => l.at, className: 'muted' },
  { key: 'action', header: 'Action', render: (l) => <span className="mono-strong">{l.action}</span> },
  { key: 'entityType', header: 'Entity type', render: (l) => <span className="tag">{l.entityType}</span> },
  { key: 'entityId', header: 'Entity ID', render: (l) => <span className="mono">{l.entityId}</span> },
  { key: 'actor', header: 'Actor', render: (l) => <span className="mono">{l.actorUserId}</span> },
  { key: 'role', header: 'Role', render: (l) => l.actorRole ?? '—', className: 'muted' },
  { key: 'ip', header: 'IP address', render: (l) => <span className="mono">{l.ipAddress ?? '—'}</span> },
  { key: 'requestId', header: 'Request ID', render: (l) => <span className="mono">{l.requestId ?? '—'}</span> },
]

const SENSITIVE_KEY = /phone|account|ip|email/i
const LOOKS_SENSITIVE = /^\+?[\d\s-]{7,}$/
const LOGIN_ACTION = /login|otp|mfa|sign|auth/i

type AuditFilters = {
  actorUserId: string
  entityType: string
  entityId: string
  from: string
  to: string
}

const EMPTY_FILTERS: AuditFilters = { actorUserId: '', entityType: '', entityId: '', from: '', to: '' }

function toParams(f: AuditFilters): AdminListAuditLogsParams {
  const params: AdminListAuditLogsParams = {}
  if (f.actorUserId.trim()) params.actorUserId = f.actorUserId.trim()
  if (f.entityType.trim()) params.entityType = f.entityType.trim()
  if (f.entityId.trim()) params.entityId = f.entityId.trim()
  if (f.from) params.from = new Date(`${f.from}T00:00:00`).toISOString()
  if (f.to) params.to = new Date(`${f.to}T23:59:59`).toISOString()
  return params
}

export function AuditLogsPage() {
  const session = useSession()
  const canExport = can(session, 'export.request')
  const [rows, setRows] = useState<AuditLog[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [requestId, setRequestId] = useState<string | undefined>(undefined)
  const [retryKey, setRetryKey] = useState(0)
  const [filters, setFilters] = useState<AuditFilters>(EMPTY_FILTERS)
  const [applied, setApplied] = useState<AuditFilters>(EMPTY_FILTERS)
  const [selected, setSelected] = useState<AuditLog | null>(null)
  const [loginFilter, setLoginFilter] = useState<'all' | 'login'>('all')
  const [toast, setToast] = useState<string | null>(null)

  const load = useCallback(() => {
    setError(null)
    setRequestId(undefined)
    adminListAuditLogs(toParams(applied)).then((res) => {
      if (res.status === 200) setRows(res.data)
      else {
        const err = parseApiError(res, 'Failed to load audit logs')
        setError(err.message)
        setRequestId(err.requestId)
      }
    })
  }, [applied])

  useEffect(() => {
    load()
  }, [load, retryKey])

  useRefetchOnFocus(load)

  useEffect(() => {
    function onExport() {
      setToast('Audit export downloaded — logged')
    }
    window.addEventListener('hudumika.export', onExport)
    return () => window.removeEventListener('hudumika.export', onExport)
  }, [])

  const loginCount = useMemo(() => (rows ?? []).filter((r) => LOGIN_ACTION.test(r.action)).length, [rows])
  const visibleRows = loginFilter === 'login' ? (rows ?? []).filter((r) => LOGIN_ACTION.test(r.action)) : rows

  if (error) {
    return (
      <ErrorState
        title="Failed to load audit logs"
        message={error}
        requestId={requestId}
        onRetry={() => setRetryKey((k) => k + 1)}
      />
    )
  }
  if (!rows) return <LoadingSkeleton kind="table" />

  const hasFilters = Object.values(applied).some((v) => v.trim())

  return (
    <div className="page">
      <h1>Audit logs</h1>
      <p className="muted small">Sensitive entries require the compliance role; every query is itself audited.</p>

      <form
        className="toolbar"
        onSubmit={(e) => {
          e.preventDefault()
          setApplied({ ...filters })
        }}
      >
        <input
          className="topbar-search"
          value={filters.actorUserId}
          onChange={(e) => setFilters((f) => ({ ...f, actorUserId: e.target.value }))}
          placeholder="Actor user ID"
          aria-label="Filter by actor user ID"
        />
        <input
          className="topbar-search"
          value={filters.entityType}
          onChange={(e) => setFilters((f) => ({ ...f, entityType: e.target.value }))}
          placeholder="Entity type"
          aria-label="Filter by entity type"
        />
        <input
          className="topbar-search"
          value={filters.entityId}
          onChange={(e) => setFilters((f) => ({ ...f, entityId: e.target.value }))}
          placeholder="Entity ID"
          aria-label="Filter by entity ID"
        />
        <label className="field-label">
          From
          <input
            type="date"
            className="field"
            value={filters.from}
            onChange={(e) => setFilters((f) => ({ ...f, from: e.target.value }))}
            aria-label="Filter by from date"
          />
        </label>
        <label className="field-label">
          To
          <input
            type="date"
            className="field"
            value={filters.to}
            onChange={(e) => setFilters((f) => ({ ...f, to: e.target.value }))}
            aria-label="Filter by to date"
          />
        </label>
        {hasFilters && (
          <button
            className="btn"
            type="button"
            onClick={() => {
              setFilters(EMPTY_FILTERS)
              setApplied(EMPTY_FILTERS)
            }}
          >
            Clear filters
          </button>
        )}
      </form>

      {toast && <Toast message={toast} />}

      <FilterChips
        options={[
          { key: 'all', label: 'All' },
          { key: 'login', label: 'Login activity' },
        ]}
        value={loginFilter}
        onChange={setLoginFilter}
        counts={{ all: rows.length, login: loginCount }}
        ariaLabel="Audit entry presets"
      />

      <DataTable
        rows={visibleRows ?? []}
        columns={COLUMNS}
        rowKey={(l) => l.id}
        onRowClick={setSelected}
        exportable={canExport}
        exportFileName="audit-logs"
        tableId="audit"
        emptyTitle="No audit entries"
        ariaLabel="Audit logs"
      />

      {selected && <AuditLogDrawer entry={selected} onClose={() => setSelected(null)} />}
    </div>
  )
}

type DetailsLine = {
  text: string
  comma?: boolean
  sensitive?: { value: string; label: string }
}

function buildDetailsLines(value: unknown, depth: number, key: string | null, out: DetailsLine[]): void {
  const pad = '  '.repeat(depth)
  const prefix = key != null ? `${JSON.stringify(key)}: ` : ''
  if (value === null) {
    out.push({ text: `${pad}${prefix}null` })
    return
  }
  if (typeof value === 'string') {
    if (SENSITIVE_KEY.test(key ?? '') || LOOKS_SENSITIVE.test(value)) {
      out.push({ text: `${pad}${prefix}`, sensitive: { value, label: `details.${key ?? 'value'}` } })
    } else {
      out.push({ text: `${pad}${prefix}${JSON.stringify(value)}` })
    }
    return
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    out.push({ text: `${pad}${prefix}${String(value)}` })
    return
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      out.push({ text: `${pad}${prefix}[]` })
      return
    }
    out.push({ text: `${pad}${prefix}[` })
    value.forEach((item, i) => {
      buildDetailsLines(item, depth + 1, null, out)
      out[out.length - 1] = { ...out[out.length - 1], comma: i < value.length - 1 }
    })
    out.push({ text: `${pad}]` })
    return
  }
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length === 0) {
    out.push({ text: `${pad}${prefix}{}` })
    return
  }
  out.push({ text: `${pad}${prefix}{` })
  entries.forEach(([k, v], i) => {
    buildDetailsLines(v, depth + 1, k, out)
    out[out.length - 1] = { ...out[out.length - 1], comma: i < entries.length - 1 }
  })
  out.push({ text: `${pad}}` })
}

function AuditLogDrawer({ entry, onClose }: { entry: AuditLog; onClose: () => void }) {
  const allLines: DetailsLine[] = []
  if (entry.details != null && typeof entry.details === 'object') {
    buildDetailsLines(entry.details, 0, null, allLines)
  }
  let detailsLines: DetailsLine[] = allLines
  let truncated = false
  if (allLines.length > 0) {
    let total = 0
    const visible: DetailsLine[] = []
    for (const line of allLines) {
      const len = line.text.length + (line.sensitive?.value.length ?? 0)
      if (total + len > DETAILS_TRUNCATE) {
        truncated = true
        break
      }
      total += len
      visible.push(line)
    }
    detailsLines = visible
  }
  return (
    <DetailDrawer title="Audit entry" onClose={onClose} wide>
      <div className="meta-grid">
        <div className="meta-item">
          <span className="meta-label">Entry ID</span>
          <span className="meta-value mono">{entry.id}</span>
        </div>
        <div className="meta-item">
          <span className="meta-label">At</span>
          <span className="meta-value">{toLocal(entry.at)}</span>
        </div>
        <div className="meta-item">
          <span className="meta-label">Action</span>
          <span className="meta-value mono-strong">{entry.action}</span>
        </div>
        <div className="meta-item">
          <span className="meta-label">Entity</span>
          <span className="meta-value">
            {entry.entityType} <span className="mono">{entry.entityId}</span>
          </span>
        </div>
        <div className="meta-item">
          <span className="meta-label">Actor user ID</span>
          <span className="meta-value mono">{entry.actorUserId}</span>
        </div>
        <div className="meta-item">
          <span className="meta-label">Actor role</span>
          <span className="meta-value">{entry.actorRole ?? '—'}</span>
        </div>
        <div className="meta-item">
          <span className="meta-label">IP address</span>
          <span className="meta-value">
            <MaskedField value={entry.ipAddress} permission="audit.unmask" label="IP address" />
          </span>
        </div>
        <div className="meta-item">
          <span className="meta-label">Request ID</span>
          <span className="meta-value mono">{entry.requestId ?? '—'}</span>
        </div>
      </div>

      {entry.details && (
        <div className="detail-section">
          <h3>Details</h3>
          <pre className="mono small" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
            {detailsLines.map((line, i) => (
              <span key={i}>
                {line.text}
                {line.sensitive && (
                  <MaskedField
                    value={line.sensitive.value}
                    permission="audit.unmask"
                    label={line.sensitive.label}
                  />
                )}
                {line.comma ? ',' : ''}
                {'\n'}
              </span>
            ))}
          </pre>
          {truncated && <p className="muted small">Details truncated — full payload available via the API.</p>}
        </div>
      )}

      <p className="muted small">Audit trail is immutable.</p>
    </DetailDrawer>
  )
}
