import { useEffect, useState, type FormEvent } from 'react'
import { adminGetConfig, adminUpdateConfig, type AdminConfigDomain } from '@hudumika/contract'
import { parseApiError } from '../../lib/api-error'
import { toLocal } from '../../lib/time'
import { can } from '../../lib/permissions'
import { useSession } from '../../lib/session'
import { ErrorState } from '../../components/ErrorState'
import { Field, InlineError, Toast } from '../../components/FormBits'
import { LoadingSkeleton } from '../../components/LoadingSkeleton'

const DOMAINS = ['regions', 'cities', 'zones', 'fees', 'commissions', 'tax', 'cancellation', 'sla', 'matching', 'risk', 'notifications'] as const

export function ConfigCenterPage() {
  const [domain, setDomain] = useState<string>(DOMAINS[0])
  const [config, setConfig] = useState<AdminConfigDomain | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [editError, setEditError] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const session = useSession()
  const allowed = can(session, 'configuration.edit')

  function loadDomain(d: string) {
    setLoading(true)
    setError(null)
    setConfig(null)
    setEditing(false)
    setDomain(d)
    adminGetConfig(d).then((res) => {
      if (res.status === 200) setConfig(res.data)
      else setError(parseApiError(res, 'Failed to load config').message)
      setLoading(false)
    })
  }

  useEffect(() => { loadDomain(domain) }, [])

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    const form = e.currentTarget as HTMLFormElement
    const fd = new FormData(form)
    const raw = fd.get('config') as string
    let configObj: Record<string, unknown>
    try { configObj = JSON.parse(raw) } catch { setEditError('Invalid JSON'); return }
    const reason = (fd.get('reason') as string ?? '').trim()
    setBusy(true)
    setEditError(null)
    adminUpdateConfig(domain, { config: configObj, reason }).then((res) => {
      if (res.status === 200) { setConfig(res.data); setEditing(false); setToast(`${domain} config updated`) }
      else setEditError(parseApiError(res, 'Update failed').message)
      setBusy(false)
    })
  }

  return (
    <div className="page">
      <div className="page-title-row">
        <h1>Configuration center</h1>
        {toast && <div className="page-actions"><Toast message={toast} /></div>}
      </div>
      <p className="muted small">Manage platform configuration per domain. Every change is audited (configuration.*).</p>

      <div className="filters">
        {DOMAINS.map((d) => (
          <button key={d} type="button" className={`chip${d === domain ? ' active' : ''}`} onClick={() => loadDomain(d)}>
            {d}
          </button>
        ))}
      </div>

      {loading && <LoadingSkeleton kind="table" />}
      {error && <ErrorState title={`Failed to load ${domain}`} message={error} onRetry={() => loadDomain(domain)} />}

      {config && !loading && (
        <div className="state-card">
          <div className="state-title">{config.domain} configuration</div>
          <p className="muted small">Updated {toLocal(config.updatedAt)}</p>
          <pre className="mono small" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 400, overflow: 'auto' }}>
            {JSON.stringify(config.config, null, 2)}
          </pre>
          {allowed && !editing && <button type="button" className="btn" style={{ marginTop: 12 }} onClick={() => setEditing(true)}>Edit {config.domain}</button>}
        </div>
      )}

      {editing && config && (
        <div className="modal-backdrop" onClick={() => !busy && setEditing(false)}>
          <form className="modal" role="dialog" aria-modal="true" aria-label={`Edit ${domain} config`} onClick={(e) => e.stopPropagation()} onSubmit={handleSubmit}>
            <h3 className="modal-title">Edit {domain} config</h3>
            <Field label="Configuration JSON">
              <textarea name="config" className="field" rows={12} defaultValue={JSON.stringify(config.config, null, 2)} />
            </Field>
            <Field label="Reason" hint="Required for audit trail">
              <textarea name="reason" className="field" rows={2} maxLength={1000} required placeholder="Explain the change (audited)" />
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
