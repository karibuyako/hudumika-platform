import { useEffect, useState, type FormEvent } from 'react'
import {
  adminCreateTwoPersonApproval,
  adminListCommissionRules,
  AdminCommissionRuleScopeType as ScopeTypeConst,
  type AdminCommissionRule,
  type AdminCommissionRuleScopeType,
} from '@hudumika/contract'
import { parseApiError } from '../../lib/api-error'
import { can } from '../../lib/permissions'
import { useSession } from '../../lib/session'
import { toLocal } from '../../lib/time'
import { DetailDrawer } from '../../components/DetailDrawer'
import { EmptyState } from '../../components/EmptyState'
import { ErrorState } from '../../components/ErrorState'
import { Field, InlineError, Toast } from '../../components/FormBits'
import { LoadingSkeleton } from '../../components/LoadingSkeleton'
import { StatusPill } from '../../components/StatusPill'

const SCOPE_TYPES = Object.values(ScopeTypeConst)

interface CommissionForm {
  scopeType: AdminCommissionRuleScopeType
  scopeId: string
  rateBps: string
  active: boolean
  reason: string
}

function toCommissionForm(rule: AdminCommissionRule | null): CommissionForm {
  return rule
    ? {
        scopeType: rule.scopeType,
        scopeId: rule.scopeId ?? '',
        rateBps: String(rule.rateBps),
        active: rule.active ?? true,
        reason: '',
      }
    : { scopeType: 'category', scopeId: '', rateBps: '', active: true, reason: '' }
}

function sameCommissionRule(a: AdminCommissionRule, b: AdminCommissionRule): boolean {
  if (a.id && b.id) return a.id === b.id
  return a.scopeType === b.scopeType && (a.scopeId ?? null) === (b.scopeId ?? null)
}

function rateLabel(rule: AdminCommissionRule): string {
  return `${rule.rateBps} bps (${rule.rateBps / 100}%)`
}

export function CommissionRulesPage() {
  const [rules, setRules] = useState<AdminCommissionRule[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [retryKey, setRetryKey] = useState(0)

  const [selected, setSelected] = useState<AdminCommissionRule | null>(null)
  const [editing, setEditing] = useState<AdminCommissionRule | null>(null)
  const [editError, setEditError] = useState<string | null>(null)
  const [editBusy, setEditBusy] = useState(false)
  const [toast, setToast] = useState<string | null>(null)

  const session = useSession()
  const allowed = can(session, 'configuration.edit')

  useEffect(() => {
    setError(null)
    adminListCommissionRules().then((res) => {
      if (res.status === 200) setRules(res.data)
      else setError(parseApiError(res, 'Failed to load commission rules').message)
    })
  }, [retryKey])

  function submitEdit(form: CommissionForm) {
    if (!editing || !rules) return
    if (form.rateBps.trim() === '') return
    const rateBps = Number(form.rateBps)
    if (Number.isNaN(rateBps)) return
    if (!form.reason.trim()) return
    setEditBusy(true)
    setEditError(null)
    const updated: AdminCommissionRule = {
      ...(editing.id ? { id: editing.id } : {}),
      scopeType: form.scopeType,
      ...(form.scopeId.trim() ? { scopeId: form.scopeId.trim() } : {}),
      rateBps,
      active: form.active,
    }
    const updatedRules = rules.map((r) => (sameCommissionRule(r, editing) ? updated : r))
    adminCreateTwoPersonApproval({
      actionType: 'change_commission',
      targetType: 'commission-rule',
      targetId: editing.id ?? 'all',
      reason: form.reason.trim(),
      payload: { rules: updatedRules },
    }).then((res) => {
      if (res.status === 201) {
        setToast('Commission change approval requested — pending a second admin')
        setEditing(null)
        setSelected(null)
        setRetryKey((k) => k + 1)
      } else {
        setEditError(parseApiError(res, 'Could not request commission change').message)
      }
      setEditBusy(false)
    })
  }

  if (error) {
    return <ErrorState title="Failed to load commission rules" message={error} onRetry={() => setRetryKey((k) => k + 1)} />
  }
  if (!rules) return <LoadingSkeleton kind="table" />

  return (
    <div className="page">
      <div className="page-title-row">
        <h1>Commission rules</h1>
        {toast && (
          <div className="page-actions">
            <Toast message={toast} />
          </div>
        )}
      </div>

      <p className="muted small">Commission changes are audited (configuration.*); change_commission requires two-person approval.</p>

      {rules.length === 0 ? (
        <EmptyState title="No commission rules" />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Scope type</th>
                <th>Scope ID</th>
                <th>Rate</th>
                <th>Active</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {rules.map((rule) => (
                <tr key={rule.id ?? `${rule.scopeType}:${rule.scopeId ?? 'default'}`} className="row-click" onClick={() => setSelected(rule)}>
                  <td>
                    <span className="tag">{rule.scopeType}</span>
                  </td>
                  <td>
                    <span className="mono">{rule.scopeId ?? '—'}</span>
                  </td>
                  <td className="mono">{rateLabel(rule)}</td>
                  <td>
                    <StatusPill status={rule.active ? 'active' : 'inactive'} tone={rule.active ? 'ok' : 'muted'} label={rule.active ? 'Active' : 'Inactive'} />
                  </td>
                  <td className="muted">{toLocal(rule.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selected && (
        <CommissionDrawer
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
        <CommissionModal
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

function CommissionDrawer({
  rule,
  canEdit,
  onEdit,
  onClose,
}: {
  rule: AdminCommissionRule
  canEdit: boolean
  onEdit: () => void
  onClose: () => void
}) {
  return (
    <DetailDrawer title={`${rule.scopeType} ${rule.scopeId ?? 'default'}`} onClose={onClose}>
      <div className="detail-section">
        <div className="meta-grid">
          <div className="meta-item">
            <span className="meta-label">Scope type</span>
            <span className="meta-value">
              <span className="tag">{rule.scopeType}</span>
            </span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Scope ID</span>
            <span className="meta-value mono">{rule.scopeId ?? '—'}</span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Rate</span>
            <span className="meta-value mono">{rateLabel(rule)}</span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Active</span>
            <span className="meta-value">
              <StatusPill status={rule.active ? 'active' : 'inactive'} tone={rule.active ? 'ok' : 'muted'} label={rule.active ? 'Active' : 'Inactive'} />
            </span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Updated</span>
            <span className="meta-value">{toLocal(rule.updatedAt)}</span>
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

function CommissionModal({
  initial,
  busy,
  error,
  onSubmit,
  onClose,
}: {
  initial: AdminCommissionRule
  busy: boolean
  error: string | null
  onSubmit: (form: CommissionForm) => void
  onClose: () => void
}) {
  const [form, setForm] = useState<CommissionForm>(() => toCommissionForm(initial))

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
        aria-label="Edit commission rule"
        onClick={(e) => e.stopPropagation()}
        onSubmit={handleSubmit}
      >
        <h3 className="modal-title">Edit commission rule</h3>
        <div className="form-grid">
          <Field label="Scope type">
            <select className="field" value={form.scopeType} disabled>
              {SCOPE_TYPES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Scope ID">
            <input
              className="field mono"
              value={form.scopeId}
              onChange={(e) => setForm({ ...form, scopeId: e.target.value })}
              placeholder="Category/merchant/provider id"
            />
          </Field>
          <Field label="Rate (bps)" hint="Basis points; 100 bps = 1%">
            <input
              type="number"
              min={0}
              className="field"
              value={form.rateBps}
              onChange={(e) => setForm({ ...form, rateBps: e.target.value })}
              required
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
          <Field label="Reason" hint="Required — audited and shown to the approving admin">
            <textarea
              className="field"
              rows={3}
              maxLength={1000}
              value={form.reason}
              onChange={(e) => setForm({ ...form, reason: e.target.value })}
              required
              aria-required="true"
              placeholder="Explain why this change is needed (audited)"
            />
          </Field>
        </div>
        <p className="muted small">Commission changes require two-person approval (change_commission).</p>
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
