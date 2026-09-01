import { useEffect, useState, type FormEvent } from 'react'
import { adminListPayroll, adminRunPayroll, type AdminPayrollBatch } from '@hudumika/contract'
import { parseApiError } from '../../lib/api-error'
import { formatTZS } from '../../lib/money'
import { toLocal } from '../../lib/time'
import { ErrorState } from '../../components/ErrorState'
import { EmptyState } from '../../components/EmptyState'
import { Field, InlineError, Toast } from '../../components/FormBits'
import { LoadingSkeleton } from '../../components/LoadingSkeleton'
import { StatusPill } from '../../components/StatusPill'
import { DataTable, type DataTableColumn } from '../../components/DataTable'
import { can } from '../../lib/permissions'
import { useSession } from '../../lib/session'

function statusTone(s: string): 'ok' | 'bad' | 'info' | 'muted' {
  if (s === 'completed') return 'ok'
  if (s === 'failed') return 'bad'
  if (s === 'processing') return 'info'
  return 'muted'
}

const COLUMNS: DataTableColumn<AdminPayrollBatch>[] = [
  { key: 'id', header: 'Batch', render: (b) => <span className="mono-strong">{b.id}</span> },
  { key: 'period', header: 'Period', render: (b) => `${b.periodStart} → ${b.periodEnd}` },
  { key: 'total', header: 'Total', render: (b) => formatTZS(b.totalTZS), sortValue: (b) => b.totalTZS, align: 'right' },
  { key: 'count', header: 'Count', render: (b) => b.count, sortValue: (b) => b.count },
  { key: 'status', header: 'Status', render: (b) => <StatusPill status={b.status} tone={statusTone(b.status)} /> },
  { key: 'dry', header: 'Dry run', render: (b) => b.dryRun ? 'Yes' : 'No' },
  { key: 'created', header: 'Created', render: (b) => toLocal(b.createdAt), className: 'muted' },
]

export function PayrollPage() {
  const [batches, setBatches] = useState<AdminPayrollBatch[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [retryKey, setRetryKey] = useState(0)
  const [creating, setCreating] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const session = useSession()
  const allowed = can(session, 'finance.payout_adjust')

  useEffect(() => {
    setError(null)
    adminListPayroll().then((res) => {
      if (res.status === 200) setBatches(res.data)
      else setError(parseApiError(res, 'Failed to load payroll batches').message)
    })
  }, [retryKey])

  function handleCreate(e: FormEvent) {
    e.preventDefault()
    const form = e.target as HTMLFormElement
    const fd = new FormData(form)
    const body = {
      periodStart: fd.get('periodStart') as string,
      periodEnd: fd.get('periodEnd') as string,
      role: (fd.get('role') as string ?? '').trim() || undefined,
      dryRun: fd.get('dryRun') === 'true',
    }
    if (!body.periodStart || !body.periodEnd) return
    setCreating(false)
    adminRunPayroll(body as never).then((res) => {
      if (res.status === 201) { setToast('Payroll batch created'); setRetryKey((k) => k + 1) }
    })
  }

  if (error) return <ErrorState title="Failed to load payroll batches" message={error} onRetry={() => setRetryKey((k) => k + 1)} />
  if (!batches) return <LoadingSkeleton kind="table" />

  return (
    <div className="page">
      <div className="page-title-row">
        <h1>Payroll</h1>
        <div className="page-actions">
          {toast && <Toast message={toast} />}
          {allowed && <button type="button" className="btn" onClick={() => setCreating(true)}>New batch</button>}
        </div>
      </div>

      {batches.length === 0 ? (
        <EmptyState title="No payroll batches" hint="Run a payroll batch to get started." />
      ) : (
        <DataTable rows={batches} columns={COLUMNS} rowKey={(b) => b.id} emptyTitle="No payroll batches" exportable exportFileName="payroll" tableId="payroll" ariaLabel="Payroll batches" />
      )}

      {creating && (
        <div className="modal-backdrop" onClick={() => setCreating(false)}>
          <form className="modal" role="dialog" aria-modal="true" aria-label="Run payroll" onClick={(e) => e.stopPropagation()} onSubmit={handleCreate}>
            <h3 className="modal-title">Run payroll batch</h3>
            <Field label="Period start" hint="Required"><input name="periodStart" type="date" className="field" required /></Field>
            <Field label="Period end" hint="Required"><input name="periodEnd" type="date" className="field" required /></Field>
            <Field label="Role filter" hint="Optional — filter by rider role"><input name="role" className="field" placeholder="e.g. rider" /></Field>
            <Field label="Dry run">
              <select name="dryRun" className="field">
                <option value="false">No — process payroll</option>
                <option value="true">Yes — preview only</option>
              </select>
            </Field>
            <div className="modal-actions">
              <button type="button" className="btn btn-ghost" onClick={() => setCreating(false)}>Cancel</button>
              <button type="submit" className="btn">Run batch</button>
            </div>
          </form>
        </div>
      )}
    </div>
  )
}
