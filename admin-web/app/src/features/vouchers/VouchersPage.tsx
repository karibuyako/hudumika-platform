import { useState } from 'react'
import { adminVerifyVoucher, type Voucher } from '@hudumika/contract'
import { parseApiError } from '../../lib/api-error'
import { formatTZS } from '../../lib/money'
import { toLocal } from '../../lib/time'
import { useSession } from '../../lib/session'
import { can } from '../../lib/permissions'
import { InlineError } from '../../components/FormBits'
import { StatusPill } from '../../components/StatusPill'

type HistoryEntry = { code: string; status: Voucher['status']; at: string }

function voucherTone(status: Voucher['status']): 'ok' | 'bad' | 'warn' | 'muted' {
  if (status === 'unused') return 'ok'
  if (status === 'expired') return 'warn'
  if (status === 'refunded' || status === 'void') return 'bad'
  return 'muted'
}

function verifyError(code: string | undefined, fallback: string): string {
  if (code === 'VOUCHER_INVALID_CODE') return 'Code not found'
  if (code === 'VOUCHER_ALREADY_USED') return 'Already redeemed'
  if (code === 'VOUCHER_EXPIRED') return 'Expired'
  return fallback
}

export function VouchersPage() {
  const [code, setCode] = useState('')
  const [result, setResult] = useState<Voucher | null>(null)
  const [history, setHistory] = useState<HistoryEntry[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const session = useSession()
  const allowed = can(session, 'voucher.verify')

  async function verify(e: React.FormEvent) {
    e.preventDefault()
    const voucherCode = code.trim()
    if (!voucherCode) return
    setBusy(true)
    setError(null)
    const res = await adminVerifyVoucher({ voucherCode })
    if (res.status === 200) {
      setResult(res.data)
      setHistory((prev) => [{ code: res.data.code, status: res.data.status, at: new Date().toISOString() }, ...prev])
      setCode('')
    } else {
      const info = parseApiError(res)
      setResult(null)
      setError(verifyError(info.code, info.message))
    }
    setBusy(false)
  }

  function clear() {
    setResult(null)
    setError(null)
  }

  return (
    <div className="page">
      <div className="page-title-row">
        <h1>Voucher Verification</h1>
      </div>

      <div className="state-card">
        <div className="state-title">Verify a voucher</div>
        <div className="state-message">Verify a voucher code during a dispute or support interaction.</div>
      </div>

      {allowed ? (
        <form className="form-grid" onSubmit={verify}>
          <label className="field-label" htmlFor="voucher-code">
            Voucher code
          </label>
          <input
            id="voucher-code"
            className="field"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="Voucher code"
            required
            autoFocus
          />
          <div className="toolbar">
            <button type="submit" className="btn" disabled={busy || !code.trim()}>
              {busy ? 'Verifying…' : 'Verify'}
            </button>
            <button type="button" className="btn btn-ghost" onClick={clear} disabled={busy || !result}>
              Clear
            </button>
          </div>
        </form>
      ) : (
        <p className="muted small">Voucher verification requires voucher.verify</p>
      )}

      {error && <InlineError message={error} />}

      {result && (
        <div className="state-card">
          <div className="state-title">Verification result</div>
          <div className="meta-grid">
            <div className="meta-item">
              <span className="meta-label">Code</span>
              <span className="meta-value mono">{result.code}</span>
            </div>
            <div className="meta-item">
              <span className="meta-label">Group buy</span>
              <span className="meta-value mono">{result.groupBuyId}</span>
            </div>
            <div className="meta-item">
              <span className="meta-label">Title</span>
              <span className="meta-value">{result.title ?? '—'}</span>
            </div>
            <div className="meta-item">
              <span className="meta-label">Price</span>
              <span className="meta-value">{formatTZS(result.priceTZS)}</span>
            </div>
            <div className="meta-item">
              <span className="meta-label">Status</span>
              <span className="meta-value">
                <StatusPill status={result.status} tone={voucherTone(result.status)} />
              </span>
            </div>
            <div className="meta-item">
              <span className="meta-label">Purchased</span>
              <span className="meta-value">{toLocal(result.purchasedAt)}</span>
            </div>
            <div className="meta-item">
              <span className="meta-label">Redeemed</span>
              <span className="meta-value">{toLocal(result.redeemedAt)}</span>
            </div>
            <div className="meta-item">
              <span className="meta-label">Expires</span>
              <span className="meta-value">{toLocal(result.expiresAt)}</span>
            </div>
            <div className="meta-item">
              <span className="meta-label">Redeemed by merchant</span>
              <span className="meta-value">{result.redeemedByMerchantId ? <span className="mono">{result.redeemedByMerchantId}</span> : '—'}</span>
            </div>
          </div>
        </div>
      )}

      <h3>Session history</h3>
      {history.length === 0 ? (
        <p className="muted small">No verifications this session.</p>
      ) : (
        <div className="queue-list">
          {history.map((h, i) => (
            <div key={i} className="queue-item">
              <div className="queue-main">
                <div className="small strong mono">{h.code}</div>
                <div className="muted small">{toLocal(h.at)}</div>
              </div>
              <div className="queue-actions">
                <StatusPill status={h.status} tone={voucherTone(h.status)} />
              </div>
            </div>
          ))}
        </div>
      )}
      <p className="muted small">Verification history is append-only and audited (voucher.*).</p>
    </div>
  )
}
