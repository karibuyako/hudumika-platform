import { useState, type FormEvent } from 'react'
import { adminResetPassword } from '@hudumika/contract'
import { parseApiError } from '../../lib/api-error'
import { Field, InlineError, Toast } from '../../components/FormBits'
import { can } from '../../lib/permissions'
import { useSession } from '../../lib/session'

export function PasswordResetPage() {
  const [userId, setUserId] = useState('')
  const [method, setMethod] = useState<'sms' | 'email'>('sms')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{ status: string; resetId: string } | null>(null)
  const session = useSession()
  const allowed = can(session, 'user.manage') || can(session, 'iam.manage')

  if (!allowed) {
    return (
      <div className="page">
        <h1>Password reset</h1>
        <div className="state-card">
          <div className="state-title">Access denied</div>
          <div className="state-message">You do not have permission to reset passwords.</div>
        </div>
      </div>
    )
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (!userId.trim()) return
    setBusy(true)
    setError(null)
    setResult(null)
    const res = await adminResetPassword({ userId: userId.trim(), method })
    setBusy(false)
    if (res.status === 200) {
      setResult({ status: res.data.status, resetId: res.data.resetId })
    } else {
      const err = parseApiError(res, 'Password reset failed')
      setError(err.message)
    }
  }

  return (
    <div className="page">
      <h1>Password reset</h1>
      <p className="muted small">Send a password reset code to a user via SMS or email. The user receives a one-time code to set a new password.</p>

      <div className="state-card">
        <form onSubmit={handleSubmit}>
          <Field label="User ID" hint="The user's account ID (UUID)">
            <input className="field" value={userId} onChange={(e) => setUserId(e.target.value)} placeholder="usr_..." required />
          </Field>
          <Field label="Reset method">
            <select className="field" value={method} onChange={(e) => setMethod(e.target.value as 'sms' | 'email')}>
              <option value="sms">SMS</option>
              <option value="email">Email</option>
            </select>
          </Field>
          {error && <InlineError message={error} />}
          <div className="modal-actions">
            <button type="submit" className="btn" disabled={busy || !userId.trim()}>
              {busy ? 'Sending…' : 'Send reset code'}
            </button>
          </div>
        </form>

        {result && (
          <div className="notice" role="status" style={{ marginTop: 12 }}>
            Reset code {result.status === 'sent' ? 'sent' : 'failed'} to user {userId}.
            {result.resetId && <> Reset ID: <span className="mono">{result.resetId}</span></>}
          </div>
        )}
      </div>
    </div>
  )
}
