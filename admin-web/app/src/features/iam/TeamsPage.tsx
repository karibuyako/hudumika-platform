import { useEffect, useState, type FormEvent } from 'react'
import { adminListTeams, adminCreateTeam, adminUpdateTeam, adminDeleteTeam, type AdminTeam } from '@hudumika/contract'
import { parseApiError } from '../../lib/api-error'
import { toLocal } from '../../lib/time'
import { ErrorState } from '../../components/ErrorState'
import { EmptyState } from '../../components/EmptyState'
import { Field, InlineError, Toast } from '../../components/FormBits'
import { LoadingSkeleton } from '../../components/LoadingSkeleton'
import { DetailDrawer } from '../../components/DetailDrawer'
import { can } from '../../lib/permissions'
import { useSession } from '../../lib/session'
import { DataTable, type DataTableColumn } from '../../components/DataTable'

const COLUMNS: DataTableColumn<AdminTeam>[] = [
  { key: 'name', header: 'Name', render: (t) => <span className="mono-strong">{t.name}</span> },
  { key: 'description', header: 'Description', render: (t) => t.description ?? '—', className: 'muted' },
  { key: 'members', header: 'Members', render: (t) => t.memberCount ?? 0, sortValue: (t) => t.memberCount ?? 0 },
  { key: 'created', header: 'Created', render: (t) => toLocal(t.createdAt), className: 'muted' },
]

export function TeamsPage() {
  const [teams, setTeams] = useState<AdminTeam[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [retryKey, setRetryKey] = useState(0)
  const [creating, setCreating] = useState(false)
  const [selected, setSelected] = useState<AdminTeam | null>(null)
  const [editing, setEditing] = useState<AdminTeam | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const session = useSession()
  const allowed = can(session, 'iam.manage')

  useEffect(() => {
    setError(null)
    adminListTeams().then((res) => {
      if (res.status === 200) setTeams(res.data)
      else setError(parseApiError(res, 'Failed to load teams').message)
    })
  }, [retryKey])

  function handleCreate(e: FormEvent) {
    e.preventDefault()
    const form = e.target as HTMLFormElement
    const fd = new FormData(form)
    const name = (fd.get('name') as string ?? '').trim()
    const desc = (fd.get('description') as string ?? '').trim()
    if (!name) return
    setCreating(false)
    adminCreateTeam({ name, description: desc || undefined }).then((res) => {
      if (res.status === 201) { setToast('Team created'); setRetryKey((k) => k + 1) }
    })
  }

  if (error) return <ErrorState title="Failed to load teams" message={error} onRetry={() => setRetryKey((k) => k + 1)} />
  if (!teams) return <LoadingSkeleton kind="table" />

  return (
    <div className="page">
      <div className="page-title-row">
        <h1>Teams</h1>
        <div className="page-actions">
          {toast && <Toast message={toast} />}
          {allowed && <button type="button" className="btn" onClick={() => setCreating(true)}>New team</button>}
        </div>
      </div>

      {teams.length === 0 ? (
        <EmptyState title="No teams" hint="Create a team to group admin users." />
      ) : (
        <DataTable rows={teams} columns={COLUMNS} rowKey={(t) => t.id} onRowClick={setSelected} emptyTitle="No teams" tableId="admin-teams" ariaLabel="Admin teams" />
      )}

      {selected && (
        <DetailDrawer title={selected.name} onClose={() => setSelected(null)}>
          <div className="meta-grid">
            <div className="meta-item"><span className="meta-label">ID</span><span className="meta-value mono">{selected.id}</span></div>
            <div className="meta-item"><span className="meta-label">Name</span><span className="meta-value">{selected.name}</span></div>
            <div className="meta-item"><span className="meta-label">Description</span><span className="meta-value">{selected.description ?? '—'}</span></div>
            <div className="meta-item"><span className="meta-label">Members</span><span className="meta-value">{selected.memberCount ?? 0}</span></div>
          </div>
          {allowed && (
            <div className="form-actions" style={{ marginTop: '1rem' }}>
              <button type="button" className="btn" onClick={() => { setEditing(selected); setSelected(null) }}>Edit</button>
              <button
                type="button"
                className="btn btn-danger"
                disabled={busy}
                onClick={async () => {
                  if (!confirm(`Delete team ${selected.name}?`)) return
                  setBusy(true)
                  const res = await adminDeleteTeam(selected.id)
                  setBusy(false)
                  if (res.status === 200) {
                    setToast(`Team ${selected.name} deleted`)
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

      {editing && (
        <div className="modal-backdrop" onClick={() => !busy && setEditing(null)}>
          <form className="modal" role="dialog" aria-modal="true" aria-label="Edit team" onClick={(e) => e.stopPropagation()} onSubmit={async (e) => {
            e.preventDefault()
            const fd = new FormData(e.currentTarget as HTMLFormElement)
            const name = (fd.get('name') as string ?? '').trim()
            if (!name) return
            setBusy(true)
            const res = await adminUpdateTeam(editing.id, { name, description: (fd.get('description') as string ?? '').trim() || undefined })
            setBusy(false)
            if (res.status === 200) {
              setToast('Team updated')
              setEditing(null)
              setRetryKey((k) => k + 1)
            }
          }}>
            <h3 className="modal-title">Edit team</h3>
            <Field label="Name" hint="Required"><input name="name" className="field" required maxLength={100} defaultValue={editing.name} /></Field>
            <Field label="Description"><textarea name="description" className="field" rows={2} maxLength={500} defaultValue={editing.description ?? ''} /></Field>
            <div className="modal-actions">
              <button type="button" className="btn btn-ghost" onClick={() => setEditing(null)} disabled={busy}>Cancel</button>
              <button type="submit" className="btn" disabled={busy}>{busy ? 'Working…' : 'Save'}</button>
            </div>
          </form>
        </div>
      )}

      {creating && (
        <div className="modal-backdrop" onClick={() => setCreating(false)}>
          <form className="modal" role="dialog" aria-modal="true" aria-label="Create team" onClick={(e) => e.stopPropagation()} onSubmit={handleCreate}>
            <h3 className="modal-title">New team</h3>
            <Field label="Name" hint="Required"><input name="name" className="field" required maxLength={100} /></Field>
            <Field label="Description"><textarea name="description" className="field" rows={2} maxLength={500} /></Field>
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
