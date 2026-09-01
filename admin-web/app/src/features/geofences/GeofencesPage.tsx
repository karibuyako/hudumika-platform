import { useEffect, useState, type FormEvent } from 'react'
import { adminListGeofences, adminCreateGeofence, adminDeleteGeofence, type AdminGeofence } from '@hudumika/contract'
import { parseApiError } from '../../lib/api-error'
import { toLocal } from '../../lib/time'
import { can } from '../../lib/permissions'
import { useSession } from '../../lib/session'
import { ErrorState } from '../../components/ErrorState'
import { EmptyState } from '../../components/EmptyState'
import { Field, InlineError, Toast } from '../../components/FormBits'
import { LoadingSkeleton } from '../../components/LoadingSkeleton'
import { DetailDrawer } from '../../components/DetailDrawer'
import { DataTable, type DataTableColumn } from '../../components/DataTable'

const GEOFENCE_TYPES = ['hub_zone', 'delivery_zone', 'restricted_zone', 'surge_zone'] as const

const COLUMNS: DataTableColumn<AdminGeofence>[] = [
  { key: 'name', header: 'Name', render: (g) => <span className="mono-strong">{g.name}</span> },
  { key: 'type', header: 'Type', render: (g) => <span className="tag">{g.type}</span> },
  { key: 'active', header: 'Active', render: (g) => (g.active ? 'Yes' : 'No') },
  { key: 'created', header: 'Created', render: (g) => toLocal(g.createdAt), className: 'muted' },
]

export function GeofencesPage() {
  const [geofences, setGeofences] = useState<AdminGeofence[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [retryKey, setRetryKey] = useState(0)
  const [creating, setCreating] = useState(false)
  const [selected, setSelected] = useState<AdminGeofence | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const session = useSession()
  const allowed = can(session, 'configuration.manage')

  useEffect(() => {
    setError(null)
    adminListGeofences().then((res) => {
      if (res.status === 200) setGeofences(res.data)
      else setError(parseApiError(res, 'Failed to load geofences').message)
    })
  }, [retryKey])

  function handleCreate(e: FormEvent) {
    e.preventDefault()
    const form = e.target as HTMLFormElement
    const fd = new FormData(form)
    const name = (fd.get('name') as string ?? '').trim()
    const type = fd.get('type') as string
    const boundaryRaw = (fd.get('boundary') as string ?? '').trim()
    if (!name || !type) return
    let boundary: Record<string, unknown> = {}
    if (boundaryRaw) {
      try { boundary = JSON.parse(boundaryRaw) } catch { return }
    }
    setCreating(false)
    adminCreateGeofence({ name, type: type as any, boundary: boundary as any }).then((res) => {
      if (res.status === 201) { setToast('Geofence created'); setRetryKey((k) => k + 1) }
    })
  }

  if (error) return <ErrorState title="Failed to load geofences" message={error} onRetry={() => setRetryKey((k) => k + 1)} />
  if (!geofences) return <LoadingSkeleton kind="table" />

  return (
    <div className="page">
      <div className="page-title-row">
        <h1>Geofences</h1>
        <div className="page-actions">
          {toast && <Toast message={toast} />}
          {allowed && <button type="button" className="btn" onClick={() => setCreating(true)}>New geofence</button>}
        </div>
      </div>

      {geofences.length === 0 ? (
        <EmptyState title="No geofences" hint="Create a geofence to define zones for hubs, deliveries, restrictions, or surge pricing." />
      ) : (
        <DataTable rows={geofences} columns={COLUMNS} rowKey={(g) => g.id} onRowClick={setSelected} emptyTitle="No geofences" tableId="admin-geofences" ariaLabel="Admin geofences" />
      )}

      {selected && (
        <DetailDrawer title={selected.name} onClose={() => setSelected(null)}>
          <div className="meta-grid">
            <div className="meta-item"><span className="meta-label">ID</span><span className="meta-value mono">{selected.id}</span></div>
            <div className="meta-item"><span className="meta-label">Name</span><span className="meta-value">{selected.name}</span></div>
            <div className="meta-item"><span className="meta-label">Type</span><span className="meta-value"><span className="tag">{selected.type}</span></span></div>
            <div className="meta-item"><span className="meta-label">Active</span><span className="meta-value">{selected.active ? 'Yes' : 'No'}</span></div>
            <div className="meta-item"><span className="meta-label">Created</span><span className="meta-value">{toLocal(selected.createdAt)}</span></div>
          </div>
          {selected.boundary && (
            <div className="detail-section" style={{ marginTop: '1rem' }}>
              <h3>Boundary (GeoJSON)</h3>
              <pre className="mono small" style={{ whiteSpace: 'pre-wrap', maxHeight: 200, overflow: 'auto' }}>{JSON.stringify(selected.boundary, null, 2)}</pre>
            </div>
          )}
          {allowed && (
            <div className="form-actions" style={{ marginTop: '1rem' }}>
              <button
                type="button"
                className="btn btn-danger"
                disabled={busy}
                onClick={async () => {
                  if (!confirm(`Delete geofence ${selected.name}?`)) return
                  setBusy(true)
                  const res = await adminDeleteGeofence(selected.id)
                  setBusy(false)
                  if (res.status === 200) {
                    setToast(`Geofence ${selected.name} deleted`)
                    setSelected(null)
                    setRetryKey((k) => k + 1)
                  }
                }}
              >
                {busy ? 'Working…' : 'Delete'}
              </button>
            </div>
          )}
        </DetailDrawer>
      )}

      {creating && (
        <div className="modal-backdrop" onClick={() => setCreating(false)}>
          <form className="modal" role="dialog" aria-modal="true" aria-label="Create geofence" onClick={(e) => e.stopPropagation()} onSubmit={handleCreate}>
            <h3 className="modal-title">New geofence</h3>
            <Field label="Name" hint="Required"><input name="name" className="field" required maxLength={100} /></Field>
            <Field label="Type" hint="Required">
              <select name="type" className="field" required defaultValue="delivery_zone">
                {GEOFENCE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </Field>
            <Field label="Boundary (GeoJSON)">
              <textarea name="boundary" className="field mono" rows={6} placeholder='{"type":"Polygon","coordinates":[[...]]}' />
            </Field>
            <div className="modal-actions">
              <button type="button" className="btn btn-ghost" onClick={() => setCreating(false)}>Cancel</button>
              <button type="submit" className="btn">Create</button>
            </div>
          </form>
        </div>
      )}
    </div>
  )
}
