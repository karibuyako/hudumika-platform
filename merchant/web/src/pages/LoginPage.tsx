import { useState } from 'react'
import { Link } from 'react-router-dom'
import { getRequestOtpUrl, getVerifyOtpUrl } from '@hudumika/contract'
import { parseApiError } from '../lib/api-error'
import { makeMockStaffProfile, SESSION_TTL_MS, setSession } from '../lib/session'
import { withApiBase } from '../lib/api-base'
import { hasAgreed, setAgreed, t } from '../lib/i18n'
import { LocaleSwitch } from '../components/LocaleSwitch'

async function requestOtpLive(body: { channel: string; destination: string; purpose: string }) {
  const res = await fetch(withApiBase(getRequestOtpUrl()), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  const data = text ? JSON.parse(text) : {}
  return { data, status: res.status, headers: res.headers } as any
}

async function verifyOtpLive(body: { requestId: string; code: string }) {
  const res = await fetch(withApiBase(getVerifyOtpUrl()), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  const data = text ? JSON.parse(text) : {}
  return { data, status: res.status, headers: res.headers } as any
}

export function LoginPage() {
  const [phone, setPhone] = useState('')
  const [code, setCode] = useState('')
  const [requestId, setRequestId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [verifying, setVerifying] = useState(false)
  const [agreed, setAgreedState] = useState(() => hasAgreed())

  async function sendCode() {
    setError(null)
    if (!agreed) {
      setError(t('login.agreeRequired'))
      return
    }
    const destination = phone.trim()
    if (!destination || !/^\+255[67]\d{8}$/.test(destination.replace(/\s/g, ''))) {
      setError(t('login.errPhone'))
      return
    }
    setSending(true)
    try {
      const res = await requestOtpLive({ channel: 'phone', destination, purpose: 'login' })
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
      const res = await verifyOtpLive({ requestId, code: trimmedCode })
      if (res.status === 200) {
        // Production: use real user from verify response; fallback to mock registry only in dev mock mode
        const realUser = (res.data.user ?? res.data.me) as any
        const isMockMode = !import.meta.env.PROD && import.meta.env.VITE_USE_MOCKS !== 'false'
        const profile = realUser?.id ? {
          userId: realUser.id,
          phone: realUser.phone ?? phone.trim(),
          displayName: realUser.fullName ?? realUser.displayName ?? phone.trim(),
          role: realUser.activeRole ?? realUser.role ?? (realUser.roles?.[0]?.role ?? 'merchant'),
          permissions: realUser.permissions ?? ['*'],
          mfaVerified: !!realUser.mfaVerified,
          expiresAt: Date.now() + SESSION_TTL_MS,
          accessToken: res.data.accessToken,
          refreshToken: res.data.refreshToken,
          tokenIssuedAt: Date.now(),
        } as any : makeMockStaffProfile(phone.trim())
        setSession({
          ...profile,
          userId: realUser?.id ?? (res.data.user as { id?: string })?.id ?? phone.trim(),
          phone: realUser?.phone ?? phone.trim(),
          accessToken: res.data.accessToken,
          refreshToken: res.data.refreshToken,
          tokenIssuedAt: Date.now(),
          expiresAt: Date.now() + SESSION_TTL_MS,
        } as any)
        setToast(`Signed in as ${profile.role}`)
        if (!isMockMode && !realUser) {
          // In production, verify must return user — treat as error if missing
          console.warn('verify-otp: production response missing user')
        }
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
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
        <LocaleSwitch />
      </div>
      <div className="state-card">
        <div className="state-title">{t('login.title')}</div>
        <div className="state-message">{t('login.sub')}</div>
        {toast && <div className="notice" role="status">{toast}</div>}
        {error && <div className="inline-error" role="alert">{error}</div>}
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '12px 0', cursor: 'pointer' }}>
          <input type="checkbox" checked={agreed} onChange={(e) => { const v = e.target.checked; setAgreedState(v); if (v) setAgreed(); }} aria-label={t('login.agree')} />
          <span className="muted small">
            {t('login.agree')} <Link to="/agreement">{t('login.terms')}</Link> & <Link to="/agreement">{t('login.privacy')}</Link>
          </span>
        </label>
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
              {sending ? t('login.sending') : t('login.send')}
            </button>
            <div style={{ marginTop: 8 }}>
              <Link to="/forgot" className="muted small">{t('login.forgot')}</Link>
            </div>
          </>
        ) : (
          <>
            <div className="field-block">
              <label className="field-label" htmlFor="merchant-code">{t('login.code')}</label>
              <input
                id="merchant-code"
                className="field"
                aria-label={t('login.code')}
                value={code}
                onChange={(e) => setCode(e.target.value)}
                maxLength={8}
                inputMode="numeric"
                autoComplete="one-time-code"
              />
            </div>
            <button type="button" className="btn" onClick={verify} disabled={verifying}>
              {verifying ? t('login.verifying') : t('login.verify')}
            </button>
            <div style={{ marginTop: 8 }}>
              <Link to="/forgot" className="muted small">{t('login.forgot')}</Link>
            </div>
          </>
        )}
        <p className="muted small">Merchant access is protected by OTP; sessions expire after 20 minutes.</p>
      </div>
    </div>
  )
}
