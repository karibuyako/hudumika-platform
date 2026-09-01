import { useEffect, useState, type FormEvent } from 'react'
import { adminListScheduledReports, adminCreateScheduledReport, type AdminScheduledReport } from '@hudumika/contract'
import { parseApiError } from '../../lib/api-error'
import { toLocal } from '../../lib/time'
import { ErrorState } from '../../components/ErrorState'
import { EmptyState } from '../../components/EmptyState'
import { Field, InlineError, Toast } from '../../components/FormBits'
import { LoadingSkeleton } from '../../components/LoadingSkeleton'
import { StatusPill } from '../../components/StatusPill'
import { DataTable, type DataTableColumn } from '../../components/DataTable'

function statusTone(status: string): 'ok' | 'bad' | 'muted' {
  if (status === 'completed') return 'ok'
  if (status === 'failed') return 'bad'
  return 'muted'
}

const COLUMNS: DataTableColumn<AdminScheduledReport>[] = [
  { key: 'name', header: 'Name', render: (r) => <span className="mono-strong">{r.name}</span> },
  { key: 'metrics', header: 'Metrics', render: (r) => (r.metrics ?? []).map((m) => <span key={m} className="tag">{m}</span>) },
  { key: 'schedule', header: 'Schedule', render: (r) => <span className="tag">{r.schedule}</span> },
  { key: 'format', header: 'Format', render: (r) => <span className="tag muted">{r.format}</span> },
  { key: 'status', header: 'Status', render: (r) => <StatusPill status={r.status} tone={statusTone(r.status)} /> },
  { key: 'nextRun', header: 'Next run', render: (r) => toLocal(r.nextRunAt), className: 'muted' },
  { key: 'created', header: 'Created', render: (r) => toLocal(r.createdAt), className: 'muted' },
]

export function ScheduledReportsPage() {
  const [reports, setReports] = useState<AdminScheduledReport[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [retryKey, setRetryKey] = useState(0)
  const [creating, setCreating] = useState(false)
  const [busy, setBusy] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  useEffect(() => {
    setError(null)
    adminListScheduledReports().then((res) => {
      if (res.status === 200) setReports(res.data)
      else setError(parseApiError(res, 'Failed to load scheduled reports').message)
    })
  }, [retryKey])

  function handleCreate(e: FormEvent) {
    e.preventDefault()
    const form = e.target as HTMLFormElement
    const fd = new FormData(form)
    const name = (fd.get('name') as string)?.trim() ?? ''
    const metrics = (fd.get('metrics') as string ?? '').split(',').map((m) => m.trim()).filter(Boolean)
    const schedule = fd.get('schedule') as string
    const format = fd.get('format') as string
    if (!name || metrics.length === 0) return
    setBusy(true)
    setCreateError(null)
    adminCreateScheduledReport({ name, metrics, schedule: schedule as never, format: format as never }).then((res) => {
      if (res.status === 201) {
        setCreating(false)
        setToast('Report created')
        setRetryKey((k) => k + 1)
      } else {
        setCreateError(parseApiError(res, 'Create failed').message)
      }
      setBusy(false)
    })
  }

  if (error) return <ErrorState title="Failed to load scheduled reports" message={error} onRetry={() => setRetryKey((k) => k + 1)} />
  if (!reports) return <LoadingSkeleton kind="table" />

  return (
    <div className="page">
      <div className="page-title-row">
        <h1>Scheduled reports</h1>
        <div className="page-actions">
          {toast && <Toast message={toast} />}
          <button type="button" className="btn" onClick={() => setCreating(true)}>New report</button>
        </div>
      </div>

      {reports.length === 0 ? (
        <EmptyState title="No scheduled reports" hint="Create a report to get started." />
      ) : (
        <DataTable rows={reports} columns={COLUMNS} rowKey={(r) => r.id} emptyTitle="No scheduled reports" exportable exportFileName="scheduled-reports" tableId="scheduled-reports" ariaLabel="Scheduled reports" />
      )}

      {creating && (
        <div className="modal-backdrop" onClick={() => !busy && setCreating(false)}>
          <form className="modal" role="dialog" aria-modal="true" aria-label="New scheduled report" onClick={(e) => e.stopPropagation()} onSubmit={handleCreate}>
            <h3 className="modal-title">New scheduled report</h3>
            <Field label="Name"><input name="name" className="field" required maxLength={160} /></Field>
            <Field label="Metrics" hint="Comma-separated metric keys"><input name="metrics" className="field" required placeholder="orders, revenueTZS" /></Field>
            <Field label="Schedule">
              <select name="schedule" className="field">
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
                <option value="monthly">Monthly</option>
              </select>
            </Field>
            <Field label="Format">
              <select name="format" className="field">
                <option value="csv">CSV</option>
                <option value="xlsx">Excel</option>
                <option value="pdf">PDF</option>
                <option value="json">JSON</option>
              </select>
            </Field>
            {createError && <InlineError message={createError} />}
            <div className="modal-actions">
              <button type="button" className="btn btn-ghost" onClick={() => setCreating(false)} disabled={busy}>Cancel</button>
              <button type="submit" className="btn" disabled={busy}>{busy ? 'Creating…' : 'Create'}</button>
            </div>
          </form>
        </div>
      )}
    </div>
  )
}
