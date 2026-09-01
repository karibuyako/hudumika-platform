import { useEffect, useState, type FormEvent } from 'react'
import { adminGetSettings, adminUpdateSettings, type AdminSettings } from '@hudumika/contract'
import { parseApiError } from '../../lib/api-error'
import { can } from '../../lib/permissions'
import { useSession } from '../../lib/session'
import { ErrorState } from '../../components/ErrorState'
import { Field, InlineError, Toast } from '../../components/FormBits'
import { LoadingSkeleton } from '../../components/LoadingSkeleton'

export function GeneralSettingsPage() {
  const [settings, setSettings] = useState<AdminSettings | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [retryKey, setRetryKey] = useState(0)
  const [toast, setToast] = useState<string | null>(null)
  const session = useSession()
  const allowed = can(session, 'configuration.edit')

  useEffect(() => {
    setError(null)
    adminGetSettings().then((res) => {
      if (res.status === 200) setSettings(res.data)
      else setError(parseApiError(res, 'Failed to load settings').message)
    })
  }, [retryKey])

  if (error) return <ErrorState title="Failed to load settings" message={error} onRetry={() => setRetryKey((k) => k + 1)} />
  if (!settings) return <LoadingSkeleton kind="table" />

  return (
    <div className="page">
      <div className="page-title-row">
        <h1>General settings</h1>
        {toast && <div className="page-actions"><Toast message={toast} /></div>}
      </div>
      <p className="muted small">Platform-wide settings for general, booking, notification, and order configuration.</p>

      <SettingsSection title="General" settings={settings} group="general" allowed={allowed} onSaved={() => { setToast('Settings saved'); setRetryKey((k) => k + 1) }} />
      <SettingsSection title="Booking" settings={settings} group="booking" allowed={allowed} onSaved={() => { setToast('Settings saved'); setRetryKey((k) => k + 1) }} />
      <SettingsSection title="Notifications" settings={settings} group="notification" allowed={allowed} onSaved={() => { setToast('Settings saved'); setRetryKey((k) => k + 1) }} />
      <SettingsSection title="Orders" settings={settings} group="order" allowed={allowed} onSaved={() => { setToast('Settings saved'); setRetryKey((k) => k + 1) }} />
    </div>
  )
}

function SettingsSection({
  title,
  settings,
  group,
  allowed,
  onSaved,
}: {
  title: string
  settings: AdminSettings
  group: 'general' | 'booking' | 'notification' | 'order'
  allowed: boolean
  onSaved: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [values, setValues] = useState<Record<string, string>>(() => {
    const section = settings[group] as Record<string, unknown> | undefined
    if (!section) return {}
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(section)) {
      if (typeof v === 'boolean') out[k] = v ? 'true' : 'false'
      else out[k] = v != null ? String(v) : ''
    }
    return out
  })

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const patch: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(values)) {
      if (v === 'true') patch[k] = true
      else if (v === 'false') patch[k] = false
      else if (/^\d+$/.test(v)) patch[k] = Number(v)
      else patch[k] = v
    }
    adminUpdateSettings({ [group]: patch } as never).then((res) => {
      if (res.status === 200) { setEditing(false); onSaved() }
      else setError(parseApiError(res, 'Update failed').message)
      setBusy(false)
    })
  }

  return (
    <div className="state-card">
      <div className="state-title">{title}</div>
      {editing ? (
        <form onSubmit={handleSubmit}>
          {Object.entries(values).map(([k, v]) => (
            <Field key={k} label={k.replace(/([A-Z])/g, ' $1')}>
              {typeof values[k] === 'string' && (values[k] === 'true' || values[k] === 'false') ? (
                <select className="field" value={values[k]} onChange={(e) => setValues({ ...values, [k]: e.target.value })}>
                  <option value="true">Enabled</option>
                  <option value="false">Disabled</option>
                </select>
              ) : (
                <input className="field" value={values[k]} onChange={(e) => setValues({ ...values, [k]: e.target.value })} />
              )}
            </Field>
          ))}
          {error && <InlineError message={error} />}
          <div className="modal-actions">
            <button type="button" className="btn btn-ghost" onClick={() => setEditing(false)} disabled={busy}>Cancel</button>
            <button type="submit" className="btn" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
          </div>
        </form>
      ) : (
        <div className="meta-grid">
          {Object.entries(settings[group] as Record<string, unknown> ?? {}).map(([k, v]) => (
            <div key={k} className="meta-item">
              <span className="meta-label">{k.replace(/([A-Z])/g, ' $1')}</span>
              <span className="meta-value">{String(v ?? '—')}</span>
            </div>
          ))}
          {allowed && <button type="button" className="btn" onClick={() => setEditing(true)} style={{ marginTop: 12 }}>Edit</button>}
        </div>
      )}
    </div>
  )
}
