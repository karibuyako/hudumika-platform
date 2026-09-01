import { useEffect, useState, type FormEvent } from 'react'
import { adminListAdmins, adminCreateAdmin, adminUpdateAdmin, adminSuspendAdmin, type AdminStaffUser } from '@hudumika/contract'
import { parseApiError } from '../../lib/api-error'
import { toLocal } from '../../lib/time'
import { DetailDrawer } from '../../components/DetailDrawer'
import { ErrorState } from '../../components/ErrorState'
import { EmptyState } from '../../components/EmptyState'
import { Field, InlineError, Toast } from '../../components/FormBits'
import { LoadingSkeleton } from '../../components/LoadingSkeleton'
import { ReasonPrompt } from '../../components/ReasonPrompt'
import { StatusPill } from '../../components/StatusPill'
import { DataTable, type DataTableColumn } from '../../components/DataTable'
import { can } from '../../lib/permissions'
import { effectiveRoles } from '../../lib/roles'
import { useSession } from '../../lib/session'

const COLUMNS: DataTableColumn<AdminStaffUser>[] = [
  { key: 'name', header: 'Name', render: (u) => <span className="mono-strong">{u.displayName}</span> },
  { key: 'role', header: 'Role', render: (u) => <span className="tag">{u.role}</span> },
  { key: 'email', header: 'Email', render: (u) => u.email, className: 'muted' },
  { key: 'team', header: 'Team', render: (u) => u.teamName ?? '—' },
  { key: 'status', header: 'Status', render: (u) => <StatusPill status={u.status} tone={u.status === 'active' ? 'ok' : 'bad'} /> },
  { key: 'lastLogin', header: 'Last login', render: (u) => toLocal(u.lastLoginAt), className: 'muted' },
  { key: 'created', header: 'Created', render: (u) => toLocal(u.createdAt), className: 'muted' },
]

export function AdminUsersPage() {
  const [users, setUsers] = useState<AdminStaffUser[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [retryKey, setRetryKey] = useState(0)
  const [selected, setSelected] = useState<AdminStaffUser | null>(null)
  const [creating, setCreating] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const session = useSession()
  const allowed = can(session, 'iam.manage')

  useEffect(() => {
    setError(null)
    adminListAdmins().then((res) => {
      if (res.status === 200) setUsers(res.data)
      else setError(parseApiError(res, 'Failed to load admin users').message)
    })
  }, [retryKey])

  function handleCreate(e: FormEvent) {
    e.preventDefault()
    const form = e.target as HTMLFormElement
    const fd = new FormData(form)
    const body = {
      displayName: (fd.get('displayName') as string ?? '').trim(),
      role: fd.get('role') as string,
      email: (fd.get('email') as string ?? '').trim(),
      phone: (fd.get('phone') as string ?? '').trim() || undefined,
      teamId: (fd.get('teamId') as string ?? '').trim() || undefined,
    }
    if (!body.displayName || !body.role || !body.email) return
    setCreating(false)
    adminCreateAdmin(body as never).then((res) => {
      if (res.status === 201) {
        setToast('Admin user created')
        setRetryKey((k) => k + 1)
      }
    })
  }

  if (error) return <ErrorState title="Failed to load admin users" message={error} onRetry={() => setRetryKey((k) => k + 1)} />
  if (!users) return <LoadingSkeleton kind="table" />

  return (
    <div className="page">
      <div className="page-title-row">
        <h1>Admin users</h1>
        <div className="page-actions">
          {toast && <Toast message={toast} />}
          {allowed && <button type="button" className="btn" onClick={() => setCreating(true)}>New user</button>}
        </div>
      </div>

      {users.length === 0 ? (
        <EmptyState title="No admin users" />
      ) : (
        <DataTable rows={users} columns={COLUMNS} rowKey={(u) => u.id} onRowClick={setSelected} emptyTitle="No admin users" tableId="admin-users" ariaLabel="Admin users" />
      )}

      {selected && (
        <DetailDrawer title={selected.displayName} onClose={() => setSelected(null)}>
          <div className="meta-grid">
            <div className="meta-item"><span className="meta-label">ID</span><span className="meta-value mono">{selected.id}</span></div>
            <div className="meta-item"><span className="meta-label">Role</span><span className="meta-value">{selected.role}</span></div>
            <div className="meta-item"><span className="meta-label">Email</span><span className="meta-value">{selected.email}</span></div>
            <div className="meta-item"><span className="meta-label">Team</span><span className="meta-value">{selected.teamName ?? '—'}</span></div>
            <div className="meta-item"><span className="meta-label">Status</span><span className="meta-value"><StatusPill status={selected.status} tone={selected.status === 'active' ? 'ok' : 'bad'} /></span></div>
            <div className="meta-item"><span className="meta-label">Last login</span><span className="meta-value">{toLocal(selected.lastLoginAt)}</span></div>
          </div>
          {allowed && selected.status === 'active' && (
            <div className="form-actions" style={{ marginTop: '1rem' }}>
              <SuspendButton
                user={selected}
                onSuspended={() => {
                  setToast(`${selected.displayName} suspended`)
                  setSelected(null)
                  setRetryKey((k) => k + 1)
                }}
              />
            </div>
          )}
        </DetailDrawer>
      )}

      {creating && (
        <div className="modal-backdrop" onClick={() => setCreating(false)}>
          <form className="modal" role="dialog" aria-modal="true" aria-label="Create admin user" onClick={(e) => e.stopPropagation()} onSubmit={handleCreate}>
            <h3 className="modal-title">New admin user</h3>
            <Field label="Display name" hint="Required"><input name="displayName" className="field" required maxLength={100} /></Field>
            <Field label="Role" hint="Required">
              <select name="role" className="field" required>
                {effectiveRoles().map((role) => (
                  <option key={role.id} value={role.id}>
                    {role.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Email" hint="Required"><input name="email" type="email" className="field" required /></Field>
            <Field label="Phone"><input name="phone" className="field" /></Field>
            <Field label="Team ID" hint="Optional"><input name="teamId" className="field" /></Field>
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

function SuspendButton({ user, onSuspended }: { user: AdminStaffUser; onSuspended: () => void }) {
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<ReturnType<typeof parseApiError> | null>(null)

  async function handleSuspend(reason: string) {
    setBusy(true)
    setError(null)
    const res = await adminSuspendAdmin(user.id, { reason })
    setBusy(false)
    if (res.status === 200) {
      onSuspended()
    } else {
      setError(parseApiError(res, 'Suspend failed'))
    }
  }

  return (
    <>
      <button
        type="button"
        className="btn btn-danger"
        disabled={busy}
        onClick={() => {
          setError(null)
          setConfirming(true)
        }}
      >
        {busy ? 'Working…' : 'Suspend user'}
      </button>
      {confirming && (
        <ReasonPrompt
          title={`Suspend ${user.displayName}`}
          description="Provide a reason for suspending this admin user. This action will be logged."
          tone="danger"
          confirmLabel="Confirm"
          busy={busy}
          error={error}
          onSubmit={handleSuspend}
          onClose={() => {
            if (!busy) setConfirming(false)
          }}
        />
      )}
    </>
  )
}
