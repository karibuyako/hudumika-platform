import { useEffect, useState, type FormEvent } from 'react'
import { adminListPolicies, adminCreatePolicy, type AdminPolicy } from '@hudumika/contract'
import { parseApiError } from '../../lib/api-error'
import { toLocal } from '../../lib/time'
import { ErrorState } from '../../components/ErrorState'
import { EmptyState } from '../../components/EmptyState'
import { Field, InlineError, Toast } from '../../components/FormBits'
import { LoadingSkeleton } from '../../components/LoadingSkeleton'
import { StatusPill } from '../../components/StatusPill'
import { can } from '../../lib/permissions'
import { useSession } from '../../lib/session'
import { DataTable, type DataTableColumn } from '../../components/DataTable'

const COLUMNS: DataTableColumn<AdminPolicy>[] = [
  { key: 'name', header: 'Name', render: (p) => <span className="mono-strong">{p.name}</span> },
  { key: 'type', header: 'Type', render: (p) => <StatusPill status={p.type} tone={p.type === 'allow' ? 'ok' : 'bad'} /> },
  { key: 'resource', header: 'Resource', render: (p) => p.resource, className: 'mono small' },
  { key: 'action', header: 'Action', render: (p) => p.action, className: 'mono small' },
  { key: 'created', header: 'Created', render: (p) => toLocal(p.createdAt), className: 'muted' },
]

export function PoliciesPage() {
  const [policies, setPolicies] = useState<AdminPolicy[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [retryKey, setRetryKey] = useState(0)
  const [creating, setCreating] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const session = useSession()
  const allowed = can(session, 'iam.manage')

  useEffect(() => {
    setError(null)
    adminListPolicies().then((res) => {
      if (res.status === 200) setPolicies(res.data)
      else setError(parseApiError(res, 'Failed to load policies').message)
    })
  }, [retryKey])

  function handleCreate(e: FormEvent) {
    e.preventDefault()
    const form = e.target as HTMLFormElement
    const fd = new FormData(form)
    const body = {
      name: (fd.get('name') as string ?? '').trim(),
      resource: (fd.get('resource') as string ?? '').trim(),
      action: (fd.get('action') as string ?? '').trim(),
      effect: fd.get('effect') as string,
      reason: (fd.get('reason') as string ?? '').trim() || undefined,
    }
    if (!body.name || !body.resource || !body.action) return
    setCreating(false)
    adminCreatePolicy(body as never).then((res) => {
      if (res.status === 201) { setToast('Policy created'); setRetryKey((k) => k + 1) }
    })
  }

  if (error) return <ErrorState title="Failed to load policies" message={error} onRetry={() => setRetryKey((k) => k + 1)} />
  if (!policies) return <LoadingSkeleton kind="table" />

  return (
    <div className="page">
      <div className="page-title-row">
        <h1>ABAC Policies</h1>
        <div className="page-actions">
          {toast && <Toast message={toast} />}
          {allowed && <button type="button" className="btn" onClick={() => setCreating(true)}>New policy</button>}
        </div>
      </div>

      {policies.length === 0 ? (
        <EmptyState title="No policies" hint="Create an ABAC policy to define access rules." />
      ) : (
        <DataTable rows={policies} columns={COLUMNS} rowKey={(p) => p.id} emptyTitle="No policies" tableId="admin-policies" ariaLabel="Admin policies" />
      )}

      {creating && (
        <div className="modal-backdrop" onClick={() => setCreating(false)}>
          <form className="modal" role="dialog" aria-modal="true" aria-label="Create policy" onClick={(e) => e.stopPropagation()} onSubmit={handleCreate}>
            <h3 className="modal-title">New ABAC policy</h3>
            <Field label="Name" hint="Required"><input name="name" className="field" required maxLength={100} /></Field>
            <Field label="Resource pattern" hint="e.g. order:*, shipment:region/dar"><input name="resource" className="field" required /></Field>
            <Field label="Action pattern" hint="e.g. refund.*, order.read"><input name="action" className="field" required /></Field>
            <Field label="Effect">
              <select name="effect" className="field">
                <option value="allow">Allow</option>
                <option value="deny">Deny</option>
              </select>
            </Field>
            <Field label="Reason"><textarea name="reason" className="field" rows={2} maxLength={1000} /></Field>
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
