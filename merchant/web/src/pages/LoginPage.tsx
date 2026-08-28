import { useState } from 'react'
import { requestOtp, verifyOtp } from '@hudumika/contract'
import { parseApiError } from '../lib/api-error'
import { makeMockStaffProfile, SESSION_TTL_MS, setSession } from '../lib/session'

export function LoginPage() {
  const [phone, setPhone] = useState('')
  const [code, setCode] = useState('')
  const [requestId, setRequestId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [verifying, setVerifying] = useState(false)

  async function sendCode() {
    setError(null)
    const destination = phone.trim()
    if (!destination) {
      setError('Enter your merchant phone number to continue')
      return
    }
    setSending(true)
    try {
      const res = await requestOtp({ channel: 'phone', destination, purpose: 'login' })
      if (res.status === 200) {
        setRequestId(res.data.requestId)
      } else if (res.status === 429) {
        const info = parseApiError(res, 'Too many requests')
        setError(`Too many requests — retry shortly (request ${info.requestId ?? 'unknown'})`)
      } else {
        setError(parseApiError(res, 'Could not send the code').message)
      }
    } finally {
      setSending(false)
    }
  }

  async function verify() {
    setError(null)
    const trimmedCode = code.trim()
    if (!requestId || !trimmedCode) {
      setError('Enter the one-time code we sent')
      return
    }
    setVerifying(true)
    try {
      const res = await verifyOtp({ requestId, code: trimmedCode })
      if (res.status === 200) {
        const profile = makeMockStaffProfile(phone.trim())
        setSession({
          ...profile,
          userId: (res.data.user as { id?: string })?.id ?? phone.trim(),
          phone: phone.trim(),
          accessToken: res.data.accessToken,
          refreshToken: res.data.refreshToken,
          tokenIssuedAt: Date.now(),
          expiresAt: Date.now() + SESSION_TTL_MS,
        })
        setToast(`Signed in as ${profile.role}`)
      } else if (res.status === 401) {
        setError('Invalid or expired code')
      } else {
        setError(parseApiError(res, 'Could not verify the code').message)
      }
    } finally {
      setVerifying(false)
    }
  }

  return (
    <div className="page">
      <div className="state-card">
        <div className="state-title">Merchant sign-in</div>
        <div className="state-message">Merchant workspace — authorized sellers only.</div>
        {toast && <div className="notice" role="status">{toast}</div>}
        {error && <div className="inline-error">{error}</div>}
        {!requestId ? (
          <>
            <div className="field-block">
              <label className="field-label" htmlFor="merchant-phone">Phone</label>
              <input
                id="merchant-phone"
                className="field"
                type="tel"
                aria-label="Merchant phone"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="+255 700 000 010"
                maxLength={20}
              />
            </div>
            <button type="button" className="btn" onClick={sendCode} disabled={sending}>
              {sending ? 'Sending…' : 'Send code'}
            </button>
          </>
        ) : (
          <>
            <div className="field-block">
              <label className="field-label" htmlFor="merchant-code">One-time code</label>
              <input
                id="merchant-code"
                className="field"
                aria-label="One-time code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                maxLength={8}
                inputMode="numeric"
                autoComplete="one-time-code"
              />
            </div>
            <button type="button" className="btn" onClick={verify} disabled={verifying}>
              {verifying ? 'Verifying…' : 'Verify'}
            </button>
          </>
        )}
        <p className="muted small">Merchant access is protected by OTP; sessions expire after 20 minutes.</p>
      </div>
    </div>
  )
}
