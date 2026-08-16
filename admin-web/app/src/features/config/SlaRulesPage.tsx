import { useEffect, useState, type FormEvent } from 'react'
import {
  adminListSlaRules,
  adminPutSlaRules,
  AdminSlaRuleScope as ScopeConst,
  type AdminPutSlaRulesBody,
  type AdminSlaRule,
  type AdminSlaRuleScope,
} from '@hudumika/contract'
import { parseApiError } from '../../lib/api-error'
import { can } from '../../lib/permissions'
import { useSession } from '../../lib/session'
import { DetailDrawer } from '../../components/DetailDrawer'
import { EmptyState } from '../../components/EmptyState'
import { ErrorState } from '../../components/ErrorState'
import { Field, InlineError, Toast } from '../../components/FormBits'
import { LoadingSkeleton } from '../../components/LoadingSkeleton'
import { StatusPill } from '../../components/StatusPill'

const SCOPES = Object.values(ScopeConst)

interface SlaForm {
  scope: AdminSlaRuleScope
  responseMinutes: string
  resolutionMinutes: string
  alertBeforeMinutes: string
  active: boolean
}

function toSlaForm(rule: AdminSlaRule | null): SlaForm {
  return rule
    ? {
        scope: rule.scope,
        responseMinutes: String(rule.responseMinutes),
        resolutionMinutes: String(rule.resolutionMinutes),
        alertBeforeMinutes: rule.alertBeforeMinutes != null ? String(rule.alertBeforeMinutes) : '',
        active: rule.active ?? true,
      }
    : { scope: 'support_ticket', responseMinutes: '', resolutionMinutes: '', alertBeforeMinutes: '', active: true }
}

function sameSlaRule(a: AdminSlaRule, b: AdminSlaRule): boolean {
  if (a.id && b.id) return a.id === b.id
  return a.scope === b.scope
}

export function SlaRulesPage() {
  const [rules, setRules] = useState<AdminSlaRule[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [retryKey, setRetryKey] = useState(0)

  const [selected, setSelected] = useState<AdminSlaRule | null>(null)
  const [editing, setEditing] = useState<AdminSlaRule | null>(null)
  const [editError, setEditError] = useState<string | null>(null)
  const [editBusy, setEditBusy] = useState(false)
  const [toast, setToast] = useState<string | null>(null)

  const session = useSession()
  const allowed = can(session, 'configuration.edit')

  useEffect(() => {
    setError(null)
    adminListSlaRules().then((res) => {
      if (res.status === 200) setRules(res.data)
      else setError(parseApiError(res, 'Failed to load SLA rules').message)
    })
  }, [retryKey])

  function submitEdit(form: SlaForm) {
    if (!editing || !rules) return
    const responseMinutes = Number(form.responseMinutes)
    const resolutionMinutes = Number(form.resolutionMinutes)
    if (form.responseMinutes.trim() === '' || form.resolutionMinutes.trim() === '') return
    if (Number.isNaN(responseMinutes) || Number.isNaN(resolutionMinutes)) return
    const alertBefore = form.alertBeforeMinutes.trim() === '' ? undefined : Number(form.alertBeforeMinutes)
    if (alertBefore !== undefined && Number.isNaN(alertBefore)) return

    setEditBusy(true)
    setEditError(null)
    const updated: AdminSlaRule = {
      ...(editing.id ? { id: editing.id } : {}),
      scope: form.scope,
      responseMinutes,
      resolutionMinutes,
      ...(alertBefore !== undefined ? { alertBeforeMinutes: alertBefore } : {}),
      active: form.active,
    }
    const payload: AdminPutSlaRulesBody = { rules: rules.map((r) => (sameSlaRule(r, editing) ? updated : r)) }
    adminPutSlaRules(payload).then((res) => {
      if (res.status === 200) {
        setToast('SLA rules saved')
        setEditing(null)
        setSelected(null)
        setRetryKey((k) => k + 1)
      } else {
        setEditError(parseApiError(res, 'Could not save SLA rules').message)
      }
      setEditBusy(false)
    })
  }

  if (error) {
    return <ErrorState title="Failed to load SLA rules" message={error} onRetry={() => setRetryKey((k) => k + 1)} />
  }
  if (!rules) return <LoadingSkeleton kind="table" />

  return (
    <div className="page">
      <div className="page-title-row">
        <h1>SLA rules</h1>
        {toast && (
          <div className="page-actions">
            <Toast message={toast} />
          </div>
        )}
      </div>

      <p className="muted small">SLA rules are audited (configuration.*); breaches surface in the control tower.</p>

      {rules.length === 0 ? (
        <EmptyState title="No SLA rules" />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Scope</th>
                <th>Response (min)</th>
                <th>Resolution (min)</th>
                <th>Alert before (min)</th>
                <th>Active</th>
              </tr>
            </thead>
            <tbody>
              {rules.map((rule) => (
                <tr key={rule.id ?? rule.scope} className="row-click" onClick={() => setSelected(rule)}>
                  <td>
                    <span className="tag">{rule.scope}</span>
                  </td>
                  <td className="mono">{rule.responseMinutes != null ? rule.responseMinutes : '—'}</td>
                  <td className="mono">{rule.resolutionMinutes != null ? rule.resolutionMinutes : '—'}</td>
                  <td className="mono">{rule.alertBeforeMinutes ?? '—'}</td>
                  <td>
                    <StatusPill status={rule.active ? 'active' : 'inactive'} tone={rule.active ? 'ok' : 'muted'} label={rule.active ? 'Active' : 'Inactive'} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selected && (
        <SlaDrawer
          rule={selected}
          canEdit={allowed}
          onEdit={() => {
            setToast(null)
            setEditError(null)
            setEditing(selected)
          }}
          onClose={() => setSelected(null)}
        />
      )}

      {editing && (
        <SlaModal
          initial={editing}
          busy={editBusy}
          error={editError}
          onSubmit={submitEdit}
          onClose={() => {
            if (!editBusy) setEditing(null)
          }}
        />
      )}
    </div>
  )
}

function SlaDrawer({
  rule,
  canEdit,
  onEdit,
  onClose,
}: {
  rule: AdminSlaRule
  canEdit: boolean
  onEdit: () => void
  onClose: () => void
}) {
  return (
    <DetailDrawer title={rule.scope} onClose={onClose}>
      <div className="detail-section">
        <div className="meta-grid">
          <div className="meta-item">
            <span className="meta-label">Scope</span>
            <span className="meta-value">
              <span className="tag">{rule.scope}</span>
            </span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Response minutes</span>
            <span className="meta-value mono">{rule.responseMinutes != null ? rule.responseMinutes : '—'}</span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Resolution minutes</span>
            <span className="meta-value mono">{rule.resolutionMinutes != null ? rule.resolutionMinutes : '—'}</span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Alert before minutes</span>
            <span className="meta-value mono">{rule.alertBeforeMinutes ?? '—'}</span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Active</span>
            <span className="meta-value">
              <StatusPill status={rule.active ? 'active' : 'inactive'} tone={rule.active ? 'ok' : 'muted'} label={rule.active ? 'Active' : 'Inactive'} />
            </span>
          </div>
        </div>
      </div>

      {canEdit && (
        <div className="detail-section">
          <button type="button" className="btn" onClick={onEdit}>
            Edit rule
          </button>
        </div>
      )}
    </DetailDrawer>
  )
}

function SlaModal({
  initial,
  busy,
  error,
  onSubmit,
  onClose,
}: {
  initial: AdminSlaRule
  busy: boolean
  error: string | null
  onSubmit: (form: SlaForm) => void
  onClose: () => void
}) {
  const [form, setForm] = useState<SlaForm>(() => toSlaForm(initial))

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
        aria-label="Edit SLA rule"
        onClick={(e) => e.stopPropagation()}
        onSubmit={handleSubmit}
      >
        <h3 className="modal-title">Edit SLA rule</h3>
        <div className="form-grid">
          <Field label="Scope">
            <select className="field" value={form.scope} disabled>
              {SCOPES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Response minutes">
            <input
              type="number"
              min={1}
              className="field"
              value={form.responseMinutes}
              onChange={(e) => setForm({ ...form, responseMinutes: e.target.value })}
              required
            />
          </Field>
          <Field label="Resolution minutes">
            <input
              type="number"
              min={1}
              className="field"
              value={form.resolutionMinutes}
              onChange={(e) => setForm({ ...form, resolutionMinutes: e.target.value })}
              required
            />
          </Field>
          <Field label="Alert before minutes">
            <input
              type="number"
              min={1}
              className="field"
              value={form.alertBeforeMinutes}
              onChange={(e) => setForm({ ...form, alertBeforeMinutes: e.target.value })}
            />
          </Field>
          <Field label="Active">
            <select
              className="field"
              value={form.active ? 'yes' : 'no'}
              onChange={(e) => setForm({ ...form, active: e.target.value === 'yes' })}
            >
              <option value="yes">Yes</option>
              <option value="no">No</option>
            </select>
          </Field>
        </div>
        {error && <InlineError message={error} />}
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn" disabled={busy}>
            {busy ? 'Working…' : 'Save changes'}
          </button>
        </div>
      </form>
    </div>
  )
}
