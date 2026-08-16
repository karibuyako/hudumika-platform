import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import {
  adminCreateReport,
  adminListDataExports,
  type AdminCreateReportBody,
  type DataExportJob,
  type DataExportJobStatus,
} from '@hudumika/contract'
import { DetailDrawer } from '../../components/DetailDrawer'
import { DataTable, type DataTableColumn } from '../../components/DataTable'
import { ErrorState } from '../../components/ErrorState'
import { Field, InlineError, Toast } from '../../components/FormBits'
import { LoadingSkeleton } from '../../components/LoadingSkeleton'
import { ReasonPrompt } from '../../components/ReasonPrompt'
import { StatusPill } from '../../components/StatusPill'
import { parseApiError } from '../../lib/api-error'
import { PENDING_ENDPOINT_CODE, pendingEndpointNotice } from '../../lib/pending-endpoints'
import { can } from '../../lib/permissions'
import { useSession } from '../../lib/session'
import { toLocal } from '../../lib/time'
import { useRefetchOnFocus } from '../../lib/use-refetch-on-focus'

type Bucket = 'all' | DataExportJobStatus

const BUCKETS: Array<{ key: Bucket; label: string; match: (j: DataExportJob) => boolean }> = [
  { key: 'all', label: 'All', match: () => true },
  { key: 'queued', label: 'Queued', match: (j) => j.status === 'queued' },
  { key: 'processing', label: 'Processing', match: (j) => j.status === 'processing' },
  { key: 'ready', label: 'Ready', match: (j) => j.status === 'ready' },
  { key: 'failed', label: 'Failed', match: (j) => j.status === 'failed' },
]

function statusTone(status: DataExportJobStatus): 'ok' | 'bad' | 'info' | 'muted' {
  if (status === 'ready') return 'ok'
  if (status === 'failed') return 'bad'
  if (status === 'processing') return 'info'
  return 'muted'
}

const COLUMNS: DataTableColumn<DataExportJob>[] = [
  { key: 'job', header: 'Job', render: (j) => <span className="mono">{j.id}</span> },
  { key: 'scope', header: 'Scope', render: (j) => <span className="tag">{j.scope}</span> },
  { key: 'format', header: 'Format', render: (j) => <span className="tag muted">{j.format}</span> },
  { key: 'status', header: 'Status', render: (j) => <StatusPill status={j.status} tone={statusTone(j.status)} /> },
  { key: 'createdAt', header: 'Created', render: (j) => toLocal(j.createdAt), sortValue: (j) => j.createdAt, className: 'muted' },
  { key: 'completedAt', header: 'Completed', render: (j) => toLocal(j.completedAt), className: 'muted' },
  {
    key: 'download',
    header: 'Download',
    render: (j) =>
      j.status === 'ready' && j.downloadUrl ? (
        <a className="btn" href={j.downloadUrl} target="_blank" rel="noopener noreferrer">
          Download
        </a>
      ) : (
        '—'
      ),
  },
]

export function DataExportsPage() {
  const [jobs, setJobs] = useState<DataExportJob[] | null>(null)
  const [bucket, setBucket] = useState<Bucket>('all')
  const [selected, setSelected] = useState<DataExportJob | null>(null)
  const [modalOpen, setModalOpen] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [retryKey, setRetryKey] = useState(0)

  const load = useCallback(() => {
    setError(null)
    adminListDataExports().then((res) => {
      if (res.status === 200) setJobs(res.data)
      else setError(parseApiError(res, 'Failed to load data exports').message)
    })
  }, [])

  useEffect(() => {
    load()
  }, [load, retryKey])

  useRefetchOnFocus(load)

  const counts = useMemo(() => {
    if (!jobs) return new Map<Bucket, number>()
    const map = new Map<Bucket, number>()
    for (const b of BUCKETS) map.set(b.key, jobs.filter(b.match).length)
    return map
  }, [jobs])

  const visible = useMemo(
    () => (jobs ?? []).filter(BUCKETS.find((b) => b.key === bucket)!.match),
    [jobs, bucket],
  )

  if (error)
    return (
      <ErrorState
        title="Failed to load data exports"
        message={error}
        onRetry={() => setRetryKey((k) => k + 1)}
      />
    )
  if (!jobs) return <LoadingSkeleton kind="table" />

  return (
    <div className="page">
      <div className="page-title-row">
        <h1>Data exports</h1>
        <button className="btn" type="button" onClick={() => setModalOpen(true)}>
          New report
        </button>
      </div>

      {toast && <Toast message={toast} />}

      <div className="filters">
        {BUCKETS.map((b) => (
          <button
            key={b.key}
            type="button"
            className={`chip${bucket === b.key ? ' active' : ''}`}
            aria-pressed={bucket === b.key}
            onClick={() => setBucket(b.key)}
          >
            {b.label} <span className="chip-count">{counts.get(b.key) ?? 0}</span>
          </button>
        ))}
      </div>

      <DataTable
        rows={visible}
        columns={COLUMNS}
        rowKey={(j) => j.id}
        onRowClick={setSelected}
        tableId="exports"
        emptyTitle="No export jobs"
        ariaLabel="Data export jobs"
      />

      {selected && <ExportDrawer job={selected} onClose={() => setSelected(null)} />}
      {modalOpen && (
        <ReportModal
          onClose={() => setModalOpen(false)}
          onCreated={(name) => {
            setModalOpen(false)
            setToast(`Report ${name} queued`)
            setRetryKey((k) => k + 1)
          }}
        />
      )}
    </div>
  )
}

function ExportDrawer({ job, onClose }: { job: DataExportJob; onClose: () => void }) {
  const session = useSession()
  const canApprove = can(session, 'export.approve')
  const [prompt, setPrompt] = useState<'approve' | 'reject' | 'rerun' | null>(null)
  const [pending, setPending] = useState<'approve' | 'reject' | 'rerun' | null>(null)

  const awaitingDecision = job.status === 'queued' || job.status === 'processing'

  return (
    <DetailDrawer title="Export job" onClose={onClose}>
      <div className="meta-grid">
        <div className="meta-item">
          <span className="meta-label">Job ID</span>
          <span className="meta-value mono">{job.id}</span>
        </div>
        <div className="meta-item">
          <span className="meta-label">Scope</span>
          <span className="meta-value">
            <span className="tag">{job.scope}</span>
          </span>
        </div>
        <div className="meta-item">
          <span className="meta-label">Format</span>
          <span className="meta-value">
            <span className="tag muted">{job.format}</span>
          </span>
        </div>
        <div className="meta-item">
          <span className="meta-label">Status</span>
          <span className="meta-value">
            <StatusPill status={job.status} tone={statusTone(job.status)} />
          </span>
        </div>
        <div className="meta-item">
          <span className="meta-label">Created</span>
          <span className="meta-value">{toLocal(job.createdAt)}</span>
        </div>
        <div className="meta-item">
          <span className="meta-label">Completed</span>
          <span className="meta-value">{toLocal(job.completedAt)}</span>
        </div>
        <div className="meta-item">
          <span className="meta-label">Expires in</span>
          <span className="meta-value">{job.expiresInSeconds != null ? job.expiresInSeconds : '—'}</span>
        </div>
        <div className="meta-item">
          <span className="meta-label">Download URL</span>
          <span className="meta-value mono">{job.downloadUrl ? truncate(job.downloadUrl, 48) : '—'}</span>
        </div>
      </div>

      {canApprove && (awaitingDecision || job.status === 'failed') && (
        <div className="detail-section">
          <h3>Approval</h3>
          <div className="form-actions">
            {awaitingDecision && (
              <>
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    setPending(null)
                    setPrompt('approve')
                  }}
                >
                  Approve
                </button>
                <button
                  type="button"
                  className="btn btn-danger"
                  onClick={() => {
                    setPending(null)
                    setPrompt('reject')
                  }}
                >
                  Reject
                </button>
              </>
            )}
            {job.status === 'failed' && (
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setPending(null)
                  setPrompt('rerun')
                }}
              >
                Re-run
              </button>
            )}
          </div>
        </div>
      )}

      {pending && (
        <div className="state-card">
          <div className="state-title">
            <span className="mono">{PENDING_ENDPOINT_CODE}</span>
          </div>
          <div className="state-message">
            {pendingEndpointNotice(pending === 'rerun' ? 'export_rerun' : 'export_approve')}
          </div>
          <p className="muted small">This action is documented for backend implementation — nothing was sent.</p>
        </div>
      )}

      <p className="muted small">
        Exports are permissioned and audited (export.*); every download is logged. Approvals are
        audited (export.*).
      </p>

      {prompt === 'approve' && (
        <ReasonPrompt
          title="Approve export"
          description={`${job.id} — releases the queued data export for delivery.`}
          onSubmit={() => {
            setPending('approve')
            setPrompt(null)
          }}
          onClose={() => setPrompt(null)}
        />
      )}
      {prompt === 'reject' && (
        <ReasonPrompt
          title="Reject export"
          description={`${job.id} — cancels the queued data export and notifies the requester.`}
          tone="danger"
          onSubmit={() => {
            setPending('reject')
            setPrompt(null)
          }}
          onClose={() => setPrompt(null)}
        />
      )}
      {prompt === 'rerun' && (
        <ReasonPrompt
          title="Re-run export"
          description={`${job.id} — retries the failed data export job.`}
          onSubmit={() => {
            setPending('rerun')
            setPrompt(null)
          }}
          onClose={() => setPrompt(null)}
        />
      )}
    </DetailDrawer>
  )
}

const FORMATS: AdminCreateReportBody['format'][] = ['csv', 'xlsx', 'pdf', 'json']
const SCHEDULES: NonNullable<AdminCreateReportBody['schedule']>[] = ['none', 'daily', 'weekly', 'monthly']

function ReportModal({ onClose, onCreated }: { onClose: () => void; onCreated: (name: string) => void }) {
  const [name, setName] = useState('')
  const [metrics, setMetrics] = useState('')
  const [format, setFormat] = useState<AdminCreateReportBody['format']>('csv')
  const [schedule, setSchedule] = useState<NonNullable<AdminCreateReportBody['schedule']>>('none')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    if (!name.trim()) {
      setError('Name is required')
      return
    }
    const metricList = metrics
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    if (metricList.length === 0) {
      setError('Metrics are required')
      return
    }
    const body: AdminCreateReportBody = {
      name: name.trim(),
      metrics: metricList,
      format,
      schedule,
    }
    setBusy(true)
    adminCreateReport(body).then((res) => {
      if (res.status === 202) onCreated(body.name)
      else setError(parseApiError(res, 'Failed to queue report').message)
      setBusy(false)
    })
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="New report"
        onClick={(e) => e.stopPropagation()}
        onSubmit={handleSubmit}
      >
        <h3 className="modal-title">New report</h3>
        <div className="form-grid">
          <Field label="Name">
            <input
              className="field"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={160}
            />
          </Field>
          <Field label="Metrics" hint="Comma-separated metric keys">
            <input
              className="field"
              value={metrics}
              onChange={(e) => setMetrics(e.target.value)}
              required
              placeholder="orders, revenueTZS"
            />
          </Field>
          <Field label="Format">
            <select
              className="field"
              value={format}
              onChange={(e) => setFormat(e.target.value as AdminCreateReportBody['format'])}
            >
              {FORMATS.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Schedule">
            <select
              className="field"
              value={schedule}
              onChange={(e) => setSchedule(e.target.value as NonNullable<AdminCreateReportBody['schedule']>)}
            >
              {SCHEDULES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </Field>
        </div>
        {error && <InlineError message={error} />}
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn" disabled={busy}>
            {busy ? 'Queuing…' : 'Queue report'}
          </button>
        </div>
      </form>
    </div>
  )
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value
}
