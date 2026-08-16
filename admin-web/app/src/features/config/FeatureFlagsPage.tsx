import { useEffect, useState, type FormEvent } from 'react'
import { adminListFeatures, adminUpdateFeature, type AdminFeatureFlag, type AdminFeatureFlagTargeting } from '@hudumika/contract'
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

interface TargetingForm {
  countries: string
  regions: string
  cities: string
  segments: string
  userPct: string
}

interface FeatureForm {
  enabled: boolean
  rolloutPct: string
  betaOnly: boolean
  targeting: TargetingForm
}

const EMPTY_TARGETING: TargetingForm = { countries: '', regions: '', cities: '', segments: '', userPct: '' }

function toFeatureForm(flag: AdminFeatureFlag | null): FeatureForm {
  const t = flag?.targeting
  return flag
    ? {
        enabled: flag.enabled,
        rolloutPct: flag.rolloutPct != null ? String(flag.rolloutPct) : '',
        betaOnly: flag.betaOnly ?? false,
        targeting: {
          countries: t?.countries?.length ? t.countries.join(', ') : '',
          regions: t?.regions?.length ? t.regions.join(', ') : '',
          cities: t?.cities?.length ? t.cities.join(', ') : '',
          segments: t?.segments?.length ? t.segments.join(', ') : '',
          userPct: t?.userPct != null ? String(t.userPct * 100) : '',
        },
      }
    : { enabled: true, rolloutPct: '', betaOnly: false, targeting: EMPTY_TARGETING }
}

function splitList(value: string): string[] | undefined {
  const parts = value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
  return parts.length > 0 ? parts : undefined
}

function buildTargeting(form: TargetingForm): AdminFeatureFlagTargeting | undefined {
  const countries = splitList(form.countries)
  const regions = splitList(form.regions)
  const cities = splitList(form.cities)
  const segments = splitList(form.segments)
  const rawPct = form.userPct.trim() === '' ? undefined : Number(form.userPct)
  const userPct = rawPct !== undefined && Number.isFinite(rawPct) ? rawPct / 100 : undefined
  if (!countries && !regions && !cities && !segments && userPct === undefined) return undefined
  return {
    ...(countries ? { countries } : {}),
    ...(regions ? { regions } : {}),
    ...(cities ? { cities } : {}),
    ...(segments ? { segments } : {}),
    ...(userPct !== undefined ? { userPct } : {}),
  }
}

export function FeatureFlagsPage() {
  const [flags, setFlags] = useState<AdminFeatureFlag[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [retryKey, setRetryKey] = useState(0)

  const [selected, setSelected] = useState<AdminFeatureFlag | null>(null)
  const [editing, setEditing] = useState<AdminFeatureFlag | null>(null)
  const [editError, setEditError] = useState<string | null>(null)
  const [editBusy, setEditBusy] = useState(false)
  const [toast, setToast] = useState<string | null>(null)

  const session = useSession()
  const allowed = can(session, 'configuration.edit')

  useEffect(() => {
    setError(null)
    adminListFeatures().then((res) => {
      if (res.status === 200) setFlags(res.data)
      else setError(parseApiError(res, 'Failed to load feature flags').message)
    })
  }, [retryKey])

  function submitEdit(form: FeatureForm) {
    if (!editing) return
    const pct = form.rolloutPct.trim() === '' ? undefined : Number(form.rolloutPct)
    if (pct !== undefined && Number.isNaN(pct)) return
    const targeting = buildTargeting(form.targeting)
    setEditBusy(true)
    setEditError(null)
    const payload: AdminFeatureFlag = {
      key: editing.key,
      enabled: form.enabled,
      ...(pct !== undefined ? { rolloutPct: pct } : {}),
      betaOnly: form.betaOnly,
      ...(targeting ? { targeting } : {}),
    }
    adminUpdateFeature(payload).then((res) => {
      if (res.status === 200) {
        setToast('Feature updated')
        setEditing(null)
        setSelected(null)
        setRetryKey((k) => k + 1)
      } else {
        setEditError(parseApiError(res, 'Could not update feature').message)
      }
      setEditBusy(false)
    })
  }

  if (error) {
    return <ErrorState title="Failed to load feature flags" message={error} onRetry={() => setRetryKey((k) => k + 1)} />
  }
  if (!flags) return <LoadingSkeleton kind="table" />

  return (
    <div className="page">
      <div className="page-title-row">
        <h1>Feature flags</h1>
        {toast && (
          <div className="page-actions">
            <Toast message={toast} />
          </div>
        )}
      </div>

      {flags.length === 0 ? (
        <EmptyState title="No feature flags" />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Key</th>
                <th>Enabled</th>
                <th>Rollout</th>
                <th>Beta</th>
                <th>Updated by</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {flags.map((flag) => (
                <tr key={flag.key} className="row-click" onClick={() => setSelected(flag)}>
                  <td>
                    <span className="mono-strong">{flag.key}</span>
                  </td>
                  <td>
                    <StatusPill status={flag.enabled ? 'active' : 'inactive'} tone={flag.enabled ? 'ok' : 'muted'} label={flag.enabled ? 'Enabled' : 'Disabled'} />
                  </td>
                  <td>{flag.rolloutPct != null ? `${flag.rolloutPct}%` : '—'}</td>
                  <td>{flag.betaOnly ? <span className="badge">beta</span> : '—'}</td>
                  <td className="muted">{flag.updatedBy ?? '—'}</td>
                  <td className="muted">{toLocal(flag.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selected && (
        <FeatureDrawer
          flag={selected}
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
        <FeatureModal
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

function FeatureDrawer({
  flag,
  canEdit,
  onEdit,
  onClose,
}: {
  flag: AdminFeatureFlag
  canEdit: boolean
  onEdit: () => void
  onClose: () => void
}) {
  return (
    <DetailDrawer title={flag.key} onClose={onClose}>
      <div className="detail-section">
        <div className="meta-grid">
          <div className="meta-item">
            <span className="meta-label">Key</span>
            <span className="meta-value mono-strong">{flag.key}</span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Enabled</span>
            <span className="meta-value">
              <StatusPill status={flag.enabled ? 'active' : 'inactive'} tone={flag.enabled ? 'ok' : 'muted'} label={flag.enabled ? 'Enabled' : 'Disabled'} />
            </span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Rollout</span>
            <span className="meta-value">{flag.rolloutPct != null ? `${flag.rolloutPct}%` : '—'}</span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Beta only</span>
            <span className="meta-value">{flag.betaOnly ? <span className="badge">beta</span> : '—'}</span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Updated by</span>
            <span className="meta-value">{flag.updatedBy ?? '—'}</span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Updated</span>
            <span className="meta-value">{toLocal(flag.updatedAt)}</span>
          </div>
        </div>
      </div>

      <div className="detail-section">
        <h3>Targeting</h3>
        {flag.targeting ? (
          <pre className="mono small" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
            {JSON.stringify(flag.targeting, null, 2)}
          </pre>
        ) : (
          <p className="muted small">No targeting constraints</p>
        )}
      </div>

      {canEdit && (
        <div className="detail-section">
          <button type="button" className="btn" onClick={onEdit}>
            Edit feature
          </button>
        </div>
      )}
    </DetailDrawer>
  )
}

function FeatureModal({
  initial,
  busy,
  error,
  onSubmit,
  onClose,
}: {
  initial: AdminFeatureFlag
  busy: boolean
  error: string | null
  onSubmit: (form: FeatureForm) => void
  onClose: () => void
}) {
  const [form, setForm] = useState<FeatureForm>(() => toFeatureForm(initial))

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
        aria-label={`Edit ${initial.key}`}
        onClick={(e) => e.stopPropagation()}
        onSubmit={handleSubmit}
      >
        <h3 className="modal-title">Edit feature</h3>
        <div className="form-grid">
          <Field label="Key">
            <input className="field mono" value={initial.key} readOnly />
          </Field>
          <Field label="Enabled">
            <select
              className="field"
              value={form.enabled ? 'enabled' : 'disabled'}
              onChange={(e) => setForm({ ...form, enabled: e.target.value === 'enabled' })}
            >
              <option value="enabled">Enabled</option>
              <option value="disabled">Disabled</option>
            </select>
          </Field>
          <Field label="Rollout %" hint="0 to 1">
            <input
              type="number"
              min={0}
              max={1}
              step={0.05}
              className="field"
              value={form.rolloutPct}
              onChange={(e) => setForm({ ...form, rolloutPct: e.target.value })}
            />
          </Field>
          <Field label="Beta only">
            <select
              className="field"
              value={form.betaOnly ? 'yes' : 'no'}
              onChange={(e) => setForm({ ...form, betaOnly: e.target.value === 'yes' })}
            >
              <option value="no">No</option>
              <option value="yes">Yes</option>
            </select>
          </Field>
          <Field label="Target countries" hint="Comma-separated">
            <input
              className="field"
              value={form.targeting.countries}
              onChange={(e) =>
                setForm({ ...form, targeting: { ...form.targeting, countries: e.target.value } })
              }
            />
          </Field>
          <Field label="Target regions" hint="Comma-separated">
            <input
              className="field"
              value={form.targeting.regions}
              onChange={(e) =>
                setForm({ ...form, targeting: { ...form.targeting, regions: e.target.value } })
              }
            />
          </Field>
          <Field label="Target cities" hint="Comma-separated">
            <input
              className="field"
              value={form.targeting.cities}
              onChange={(e) =>
                setForm({ ...form, targeting: { ...form.targeting, cities: e.target.value } })
              }
            />
          </Field>
          <Field label="Target segments" hint="Comma-separated">
            <input
              className="field"
              value={form.targeting.segments}
              onChange={(e) =>
                setForm({ ...form, targeting: { ...form.targeting, segments: e.target.value } })
              }
            />
          </Field>
          <Field label="Target user %" hint="0 to 100">
            <input
              type="number"
              min={0}
              max={100}
              step={1}
              className="field"
              value={form.targeting.userPct}
              onChange={(e) =>
                setForm({ ...form, targeting: { ...form.targeting, userPct: e.target.value } })
              }
            />
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
