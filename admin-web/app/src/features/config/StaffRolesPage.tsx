import { useEffect, useState, type FormEvent } from 'react'
import { adminCreateTwoPersonApproval, adminListStaffRoles, type AdminRoleDefinition } from '@hudumika/contract'
import { parseApiError } from '../../lib/api-error'
import { can, loadPermissionCatalog } from '../../lib/permissions'
import { useSession } from '../../lib/session'
import { toLocal } from '../../lib/time'
import { loadStaffRoles } from '../../lib/roles'
import { DetailDrawer } from '../../components/DetailDrawer'
import { EmptyState } from '../../components/EmptyState'
import { ErrorState } from '../../components/ErrorState'
import { Field, InlineError, Toast } from '../../components/FormBits'
import { LoadingSkeleton } from '../../components/LoadingSkeleton'

interface RoleForm {
  name: string
  description: string
  permissions: string
  reason: string
}

export function StaffRolesPage() {
  const [roles, setRoles] = useState<AdminRoleDefinition[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [retryKey, setRetryKey] = useState(0)

  const [selected, setSelected] = useState<AdminRoleDefinition | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [createBusy, setCreateBusy] = useState(false)
  const [toast, setToast] = useState<string | null>(null)

  const session = useSession()
  const allowed = can(session, 'iam.manage')

  useEffect(() => {
    setError(null)
    adminListStaffRoles().then((res) => {
      if (res.status === 200) {
        setRoles(res.data)
        loadStaffRoles().catch(() => undefined)
        loadPermissionCatalog().catch(() => undefined)
      } else {
        setError(parseApiError(res, 'Failed to load staff roles').message)
      }
    })
  }, [retryKey])

  function submitCreate(form: RoleForm) {
    const perms = form.permissions
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean)
    if (!form.name.trim() || perms.length === 0 || !form.reason.trim()) return
    setCreateBusy(true)
    setCreateError(null)
    const name = form.name.trim()
    adminCreateTwoPersonApproval({
      actionType: 'change_iam_policy',
      targetType: 'staff-role',
      targetId: name,
      reason: form.reason.trim(),
      payload: {
        name,
        ...(form.description.trim() ? { description: form.description.trim() } : {}),
        permissions: perms,
      },
    }).then((res) => {
      if (res.status === 201) {
        setToast('Role creation approval requested — pending a second admin')
        setCreateOpen(false)
        setRetryKey((k) => k + 1)
      } else {
        setCreateError(parseApiError(res, 'Could not request role creation').message)
      }
      setCreateBusy(false)
    })
  }

  if (error) {
    return <ErrorState title="Failed to load staff roles" message={error} onRetry={() => setRetryKey((k) => k + 1)} />
  }
  if (!roles) return <LoadingSkeleton kind="table" />

  return (
    <div className="page">
      <div className="page-title-row">
        <h1>Staff roles</h1>
        <div className="page-actions">
          {toast && <Toast message={toast} />}
          {allowed && (
            <button
              type="button"
              className="btn"
              onClick={() => {
                setToast(null)
                setCreateError(null)
                setCreateOpen(true)
              }}
            >
              New role
            </button>
          )}
        </div>
      </div>

      <p className="muted small">Role changes are IAM actions (iam.manage); change_iam_policy requires two-person approval.</p>

      {roles.length === 0 ? (
        <EmptyState title="No staff roles" />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Description</th>
                <th>Permissions</th>
                <th>System</th>
              </tr>
            </thead>
            <tbody>
              {roles.map((role) => {
                const perms = role.permissions ?? []
                return (
                  <tr key={role.id ?? role.name} className="row-click" onClick={() => setSelected(role)}>
                    <td>
                      <span className="mono-strong">{role.name}</span>
                    </td>
                    <td className="muted">{role.description ?? '—'}</td>
                    <td>
                      <span className="muted">{perms.length}</span>{' '}
                      {perms.slice(0, 3).map((p) => (
                        <span key={p} className="tag mono">
                          {p}
                        </span>
                      ))}
                      {perms.length > 3 && <span className="muted">+{perms.length - 3}</span>}
                    </td>
                    <td>{role.system ? <span className="badge">system</span> : '—'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {selected && <RoleDrawer role={selected} onClose={() => setSelected(null)} />}

      {createOpen && (
        <RoleModal
          busy={createBusy}
          error={createError}
          onSubmit={submitCreate}
          onClose={() => {
            if (!createBusy) setCreateOpen(false)
          }}
        />
      )}
    </div>
  )
}

function RoleDrawer({ role, onClose }: { role: AdminRoleDefinition; onClose: () => void }) {
  const perms = role.permissions ?? []
  return (
    <DetailDrawer title={role.name} onClose={onClose}>
      <div className="detail-section">
        <div className="meta-grid">
          <div className="meta-item">
            <span className="meta-label">Name</span>
            <span className="meta-value mono-strong">{role.name}</span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Description</span>
            <span className="meta-value">{role.description ?? '—'}</span>
          </div>
          <div className="meta-item">
            <span className="meta-label">System</span>
            <span className="meta-value">{role.system ? <span className="badge">system</span> : '—'}</span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Created</span>
            <span className="meta-value">{toLocal(role.createdAt)}</span>
          </div>
        </div>
      </div>

      <div className="detail-section">
        <h3>Permissions</h3>
        {perms.length === 0 && <p className="muted small">No permissions</p>}
        {perms.map((p) => (
          <span key={p} className="tag mono">
            {p}
          </span>
        ))}
      </div>
    </DetailDrawer>
  )
}

function RoleModal({
  busy,
  error,
  onSubmit,
  onClose,
}: {
  busy: boolean
  error: string | null
  onSubmit: (form: RoleForm) => void
  onClose: () => void
}) {
  const [form, setForm] = useState<RoleForm>({ name: '', description: '', permissions: '', reason: '' })

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    onSubmit(form)
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="New role"
        onClick={(e) => e.stopPropagation()}
        onSubmit={handleSubmit}
      >
        <h3 className="modal-title">New role</h3>
        <div className="form-grid">
          <Field label="Name">
            <input
              className="field"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              required
              maxLength={80}
              placeholder="e.g. support_manager"
            />
          </Field>
          <Field label="Description">
            <input
              className="field"
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              maxLength={300}
            />
          </Field>
          <Field label="Permissions" hint="Comma-separated, e.g. orders.read, orders.manage">
            <input
              className="field mono"
              value={form.permissions}
              onChange={(e) => setForm({ ...form, permissions: e.target.value })}
              required
              placeholder="orders.read, orders.manage"
            />
          </Field>
          <Field label="Reason" hint="Required — audited and shown to the approving admin">
            <textarea
              className="field"
              rows={3}
              maxLength={1000}
              value={form.reason}
              onChange={(e) => setForm({ ...form, reason: e.target.value })}
              required
              aria-required="true"
              placeholder="Explain why this role is needed (audited)"
            />
          </Field>
        </div>
        <p className="muted small">IAM policy changes require two-person approval (change_iam_policy).</p>
        {error && <InlineError message={error} />}
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn" disabled={busy}>
            {busy ? 'Working…' : 'Create role'}
          </button>
        </div>
      </form>
    </div>
  )
}
