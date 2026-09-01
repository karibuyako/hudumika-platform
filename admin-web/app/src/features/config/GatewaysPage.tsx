import { useEffect, useState, type FormEvent } from 'react'
import { adminGetGateways, adminUpdateGateway, type AdminGatewayConfig } from '@hudumika/contract'
import { parseApiError } from '../../lib/api-error'
import { can } from '../../lib/permissions'
import { useSession } from '../../lib/session'
import { toLocal } from '../../lib/time'
import { DetailDrawer } from '../../components/DetailDrawer'
import { ErrorState } from '../../components/ErrorState'
import { EmptyState } from '../../components/EmptyState'
import { Field, InlineError, Toast } from '../../components/FormBits'
import { LoadingSkeleton } from '../../components/LoadingSkeleton'
import { StatusPill } from '../../components/StatusPill'

export function GatewaysPage() {
  const [gateways, setGateways] = useState<AdminGatewayConfig[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [retryKey, setRetryKey] = useState(0)
  const [selected, setSelected] = useState<AdminGatewayConfig | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [editing, setEditing] = useState<AdminGatewayConfig | null>(null)
  const [busy, setBusy] = useState(false)
  const [editError, setEditError] = useState<string | null>(null)
  const session = useSession()
  const allowed = can(session, 'configuration.edit')

  useEffect(() => {
    setError(null)
    adminGetGateways().then((res) => {
      if (res.status === 200) setGateways(res.data)
      else setError(parseApiError(res, 'Failed to load gateways').message)
    })
  }, [retryKey])

  if (error) return <ErrorState title="Failed to load gateways" message={error} onRetry={() => setRetryKey((k) => k + 1)} />
  if (!gateways) return <LoadingSkeleton kind="table" />

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (!editing) return
    const form = e.currentTarget as HTMLFormElement
    const fd = new FormData(form)
    setBusy(true)
    adminUpdateGateway({
      id: editing.id,
      enabled: fd.get('enabled') === 'true',
    }).then((res) => {
      if (res.status === 200) {
        setGateways((prev) => (prev ?? []).map((g) => (g.id === editing.id ? res.data : g)))
        setEditing(null)
        setSelected(null)
        setToast('Gateway updated')
        setRetryKey((k) => k + 1)
      } else {
        setEditError(parseApiError(res, 'Update failed').message)
      }
      setBusy(false)
    })
  }

  return (
    <div className="page">
      <div className="page-title-row">
        <h1>Payment gateways</h1>
        {toast && <div className="page-actions"><Toast message={toast} /></div>}
      </div>
      <p className="muted small">Configure and monitor payment gateway integrations.</p>

      {gateways.length === 0 ? (
        <EmptyState title="No gateway configurations" hint="Add gateway configurations via the backend." />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr><th>Provider</th><th>Category</th><th>Enabled</th><th>Last tested</th><th>Actions</th></tr>
            </thead>
            <tbody>
              {gateways.map((gw) => (
                <tr key={gw.id} className="row-click" onClick={() => setSelected(gw)}>
                  <td className="mono-strong">{gw.provider}</td>
                  <td><span className="tag">{gw.category}</span></td>
                  <td><StatusPill status={gw.enabled ? 'active' : 'inactive'} tone={gw.enabled ? 'ok' : 'muted'} /></td>
                  <td className="muted">{toLocal(gw.lastTestedAt)}</td>
                  <td>
                    {allowed && <button type="button" className="btn btn-ghost" onClick={(e) => { e.stopPropagation(); setEditing(gw) }}>Edit</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selected && (
        <DetailDrawer title={selected.provider} onClose={() => setSelected(null)}>
          <div className="meta-grid">
            <div className="meta-item"><span className="meta-label">Provider</span><span className="meta-value mono">{selected.provider}</span></div>
            <div className="meta-item"><span className="meta-label">Category</span><span className="meta-value">{selected.category}</span></div>
            <div className="meta-item"><span className="meta-label">Enabled</span><span className="meta-value"><StatusPill status={selected.enabled ? 'active' : 'inactive'} tone={selected.enabled ? 'ok' : 'muted'} /></span></div>
            <div className="meta-item"><span className="meta-label">Last tested</span><span className="meta-value">{toLocal(selected.lastTestedAt)}</span></div>
            <div className="meta-item"><span className="meta-label">Config</span><span className="meta-value mono small">{JSON.stringify(selected.config)}</span></div>
          </div>
          {allowed && <div className="detail-section"><button type="button" className="btn" onClick={() => setEditing(selected)}>Edit gateway</button></div>}
        </DetailDrawer>
      )}

      {editing && (
        <div className="modal-backdrop" onClick={() => !busy && setEditing(null)}>
          <form className="modal" role="dialog" aria-modal="true" aria-label="Edit gateway" onClick={(e) => e.stopPropagation()} onSubmit={handleSubmit}>
            <h3 className="modal-title">Edit gateway</h3>
            <p className="muted small">{editing.provider} ({editing.category})</p>
            <Field label="Enabled">
              <select name="enabled" className="field" defaultValue={editing.enabled ? 'true' : 'false'}>
                <option value="true">Enabled</option>
                <option value="false">Disabled</option>
              </select>
            </Field>
            {editError && <InlineError message={editError} />}
            <div className="modal-actions">
              <button type="button" className="btn btn-ghost" onClick={() => setEditing(null)} disabled={busy}>Cancel</button>
              <button type="submit" className="btn" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
            </div>
          </form>
        </div>
      )}
    </div>
  )
}
