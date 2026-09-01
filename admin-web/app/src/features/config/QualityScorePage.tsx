import { useEffect, useState, type FormEvent } from 'react'
import { adminGetQualityScores, adminUpdateQualityScores, type AdminQualityScoreConfig } from '@hudumika/contract'
import { parseApiError } from '../../lib/api-error'
import { can } from '../../lib/permissions'
import { useSession } from '../../lib/session'
import { ErrorState } from '../../components/ErrorState'
import { Field, InlineError, Toast } from '../../components/FormBits'
import { LoadingSkeleton } from '../../components/LoadingSkeleton'
import { StatusPill } from '../../components/StatusPill'

interface WeightForm {
  deliveryTimeBps: string
  cancellationBps: string
  customerRatingBps: string
  completionBps: string
}

export function QualityScorePage() {
  const [config, setConfig] = useState<AdminQualityScoreConfig | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [retryKey, setRetryKey] = useState(0)
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [editError, setEditError] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const session = useSession()
  const allowed = can(session, 'configuration.edit')

  useEffect(() => {
    setError(null)
    adminGetQualityScores().then((res) => {
      if (res.status === 200) setConfig(res.data)
      else setError(parseApiError(res, 'Failed to load quality scores').message)
    })
  }, [retryKey])

  if (error) return <ErrorState title="Failed to load quality scores" message={error} onRetry={() => setRetryKey((k) => k + 1)} />
  if (!config) return <LoadingSkeleton kind="table" />

  const weights = config.weights ?? {}

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    const form = e.target as HTMLFormElement
    const fd = new FormData(form)
    setBusy(true)
    adminUpdateQualityScores({
      weights: {
        deliveryTimeBps: Number(fd.get('deliveryTimeBps') ?? 0),
        cancellationBps: Number(fd.get('cancellationBps') ?? 0),
        customerRatingBps: Number(fd.get('customerRatingBps') ?? 0),
        completionBps: Number(fd.get('completionBps') ?? 0),
      },
      minPassingScore: Number(fd.get('minPassingScore') ?? 0),
      enabled: config?.enabled ?? true,
    }).then((res) => {
      if (res.status === 200) { setConfig(res.data); setEditing(false); setToast('Quality scores updated') }
      else setEditError(parseApiError(res, 'Update failed').message)
      setBusy(false)
    })
  }

  function bpsToPct(bps: number | undefined): string {
    return bps != null ? `${(bps / 100).toFixed(1)}%` : '—'
  }

  return (
    <div className="page">
      <div className="page-title-row">
        <h1>Quality score configuration</h1>
        {toast && <div className="page-actions"><Toast message={toast} /></div>}
      </div>
      <p className="muted small">Configure provider quality scoring weights and thresholds.</p>

      <div className="state-card">
        <div className="state-title">Current configuration</div>
        <div className="meta-grid">
          <div className="meta-item">
            <span className="meta-label">Status</span>
            <span className="meta-value"><StatusPill status={config.enabled ? 'active' : 'inactive'} tone={config.enabled ? 'ok' : 'muted'} /></span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Min passing score</span>
            <span className="meta-value mono">{config.minPassingScore}</span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Delivery time</span>
            <span className="meta-value mono">{bpsToPct(weights.deliveryTimeBps)} ({weights.deliveryTimeBps ?? '—'} bps)</span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Cancellation</span>
            <span className="meta-value mono">{bpsToPct(weights.cancellationBps)} ({weights.cancellationBps ?? '—'} bps)</span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Customer rating</span>
            <span className="meta-value mono">{bpsToPct(weights.customerRatingBps)} ({weights.customerRatingBps ?? '—'} bps)</span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Completion</span>
            <span className="meta-value mono">{bpsToPct(weights.completionBps)} ({weights.completionBps ?? '—'} bps)</span>
          </div>
        </div>
        {allowed && (
          <div style={{ marginTop: 12 }}>
            <button type="button" className="btn" onClick={() => setEditing(true)}>Edit configuration</button>
          </div>
        )}
      </div>

      {editing && (
        <div className="modal-backdrop" onClick={() => setBusy(false)}>
          <form className="modal" role="dialog" aria-modal="true" aria-label="Edit quality scores" onClick={(e) => e.stopPropagation()} onSubmit={handleSubmit}>
            <h3 className="modal-title">Edit quality scores</h3>
            <Field label="Delivery time weight (bps)" hint="0–10000 basis points">
              <input type="number" name="deliveryTimeBps" className="field" defaultValue={weights.deliveryTimeBps ?? 0} min={0} max={10000} />
            </Field>
            <Field label="Cancellation weight (bps)" hint="0–10000 basis points">
              <input type="number" name="cancellationBps" className="field" defaultValue={weights.cancellationBps ?? 0} min={0} max={10000} />
            </Field>
            <Field label="Customer rating weight (bps)" hint="0–10000 basis points">
              <input type="number" name="customerRatingBps" className="field" defaultValue={weights.customerRatingBps ?? 0} min={0} max={10000} />
            </Field>
            <Field label="Completion weight (bps)" hint="0–10000 basis points">
              <input type="number" name="completionBps" className="field" defaultValue={weights.completionBps ?? 0} min={0} max={10000} />
            </Field>
            <Field label="Minimum passing score">
              <input type="number" name="minPassingScore" className="field" defaultValue={config.minPassingScore} min={0} max={1000} />
            </Field>
            {editError && <InlineError message={editError} />}
            <div className="modal-actions">
              <button type="button" className="btn btn-ghost" onClick={() => setEditing(false)} disabled={busy}>Cancel</button>
              <button type="submit" className="btn" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
            </div>
          </form>
        </div>
      )}
    </div>
  )
}
