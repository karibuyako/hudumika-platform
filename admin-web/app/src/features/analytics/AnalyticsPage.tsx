import { useEffect, useState, type FormEvent } from 'react'
import {
  adminAnalytics,
  exportAnalyticsReport,
  type AdminAnalytics200,
  type AdminAnalyticsParams,
  type ExportAnalyticsReportBody,
  type ExportAnalyticsReportBodyReportType,
} from '@hudumika/contract'
import { EmptyState } from '../../components/EmptyState'
import { ErrorState } from '../../components/ErrorState'
import { InlineError, Toast } from '../../components/FormBits'
import { LoadingSkeleton } from '../../components/LoadingSkeleton'
import { parseApiError } from '../../lib/api-error'
import { formatTZS } from '../../lib/money'
import { can } from '../../lib/permissions'
import { useSession } from '../../lib/session'

type Scope = Parameters<typeof adminAnalytics>[0]

function exportReportType(scope: Scope): ExportAnalyticsReportBodyReportType {
  if (scope === 'revenue') return 'revenue'
  if (scope === 'orders') return 'orders'
  return 'revenue'
}

const SCOPES: Array<{ key: Scope; label: string }> = [
  { key: 'revenue', label: 'Revenue' },
  { key: 'orders', label: 'Orders' },
  { key: 'growth', label: 'Growth' },
  { key: 'retention', label: 'Retention' },
  { key: 'fleet', label: 'Fleet' },
  { key: 'operations', label: 'Operations' },
  { key: 'gmv', label: 'GMV' },
  { key: 'take_rate', label: 'Take rate' },
  { key: 'quality', label: 'Quality' },
]

const MAX_KEYS = 40

export function AnalyticsPage() {
  const session = useSession()
  const canExport = can(session, 'export.request')
  const [scope, setScope] = useState<Scope>('revenue')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [appliedFrom, setAppliedFrom] = useState('')
  const [appliedTo, setAppliedTo] = useState('')
  const [data, setData] = useState<AdminAnalytics200 | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [exportError, setExportError] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)
  const [retryKey, setRetryKey] = useState(0)

  useEffect(() => {
    setError(null)
    setData(null)
    const params: AdminAnalyticsParams = {}
    if (appliedFrom) params.from = new Date(`${appliedFrom}T00:00:00`).toISOString()
    if (appliedTo) params.to = new Date(`${appliedTo}T23:59:59`).toISOString()
    adminAnalytics(scope, params).then((res) => {
      if (res.status === 200) setData(res.data)
      else setError(parseApiError(res, 'Failed to load analytics').message)
    })
  }, [scope, appliedFrom, appliedTo, retryKey])

  async function handleExport() {
    setExporting(true)
    setExportError(null)
    const body: ExportAnalyticsReportBody = {
      reportType: exportReportType(scope),
      from: appliedFrom ? new Date(`${appliedFrom}T00:00:00`).toISOString() : '',
      to: appliedTo ? new Date(`${appliedTo}T23:59:59`).toISOString() : '',
    }
    const res = await exportAnalyticsReport(body)
    if (res.status === 200) {
      const anchor = document.createElement('a')
      anchor.href = res.data.downloadUrl
      anchor.target = '_blank'
      anchor.rel = 'noopener'
      anchor.click()
      setNotice('Report exported — logged')
    } else {
      setExportError(parseApiError(res, 'Failed to export report').message)
    }
    setExporting(false)
  }

  if (error)
    return (
      <ErrorState
        title="Failed to load analytics"
        message={error}
        onRetry={() => setRetryKey((k) => k + 1)}
      />
    )
  if (!data) return <LoadingSkeleton kind="stats" />

  const entries = Object.entries(data)

  return (
    <div className="page">
      <h1>Analytics</h1>

      <div className="segmented">
        {SCOPES.map((s) => (
          <button
            key={s.key}
            type="button"
            className={scope === s.key ? 'active' : ''}
            aria-pressed={scope === s.key}
            onClick={() => setScope(s.key)}
          >
            {s.label}
          </button>
        ))}
      </div>

      <form
        className="toolbar"
        onSubmit={(e: FormEvent) => {
          e.preventDefault()
          setAppliedFrom(from)
          setAppliedTo(to)
        }}
      >
        <label className="field-label">
          From
          <input
            type="date"
            className="field"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            aria-label="Analytics from date"
          />
        </label>
        <label className="field-label">
          To
          <input
            type="date"
            className="field"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            aria-label="Analytics to date"
          />
        </label>
        <button className="btn" type="submit">
          Apply
        </button>
        {canExport && (
          <button className="btn" type="button" onClick={handleExport} disabled={exporting}>
            {exporting ? 'Exporting…' : 'Export report'}
          </button>
        )}
      </form>

      {notice && <Toast message={notice} />}
      {exportError && <InlineError message={exportError} />}

      {entries.length === 0 ? (
        <EmptyState
          title="No analytics data for this scope and range"
          hint="The analytics endpoint returns opaque data; structured dashboards ship with the analytics milestone"
        />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Metric</th>
                <th>Value</th>
              </tr>
            </thead>
            <tbody>
              {entries.slice(0, MAX_KEYS).map(([key, value]) => (
                <tr key={key}>
                  <td>
                    <span className="mono">{key}</span>
                  </td>
                  <td>{renderValue(key, value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {entries.length > MAX_KEYS && (
            <p className="muted small">
              Analytics payload truncated — showing the first {MAX_KEYS} of {entries.length} keys.
            </p>
          )}
        </div>
      )}
    </div>
  )
}

function renderValue(key: string, value: unknown): string {
  if (/TZS|Tzs$/.test(key)) return formatTZS(Number(value))
  if (value === null || value === undefined) return '—'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}
