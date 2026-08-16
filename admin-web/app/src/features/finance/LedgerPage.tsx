import { useEffect, useRef, useState, type FormEvent } from 'react'
import { adminAdjustWallet, adminCreateTwoPersonApproval, type Wallet } from '@hudumika/contract'
import { InlineError, Toast } from '../../components/FormBits'
import { parseApiError } from '../../lib/api-error'
import { formatTZS } from '../../lib/money'
import { can } from '../../lib/permissions'
import { useSession } from '../../lib/session'

const APPROVAL_THRESHOLD_TZS = 1000000

interface ApprovalPrompt {
  userId: string
  deltaTZS: number
}

export function LedgerPage() {
  const [userId, setUserId] = useState('')
  const [delta, setDelta] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<Wallet | null>(null)
  const [approval, setApproval] = useState<ApprovalPrompt | null>(null)
  const [approvalError, setApprovalError] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  const session = useSession()
  const allowed = can(session, 'finance.payout_adjust')

  const isLarge = Math.abs(Number(delta)) >= APPROVAL_THRESHOLD_TZS

  function submitApproval(reasonText: string) {
    if (!approval) return
    setBusy(true)
    setApprovalError(null)
    adminCreateTwoPersonApproval({
      actionType: 'modify_ledger',
      targetType: 'wallet',
      targetId: approval.userId,
      reason: reasonText,
      payload: { deltaTZS: approval.deltaTZS },
    }).then((res) => {
      if (res.status === 201) {
        setToast('Approval request created — pending a second admin')
        setApproval(null)
        setUserId('')
        setDelta('')
        setReason('')
      } else {
        setApprovalError(parseApiError(res, 'Could not create approval request').message)
      }
      setBusy(false)
    })
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const uid = userId.trim()
    const deltaTZS = Number(delta)
    if (!uid || delta === '' || !Number.isFinite(deltaTZS) || !Number.isInteger(deltaTZS)) return
    if (Math.abs(deltaTZS) >= APPROVAL_THRESHOLD_TZS) {
      setApprovalError(null)
      setApproval({ userId: uid, deltaTZS })
      return
    }
    const r = reason.trim()
    if (!r) return
    setBusy(true)
    setError(null)
    setResult(null)
    adminAdjustWallet(uid, { deltaTZS, reason: r }).then((res) => {
      if (res.status === 200) {
        setResult(res.data)
        setUserId('')
        setDelta('')
        setReason('')
      } else {
        setError(parseApiError(res, 'Adjustment failed').message)
      }
      setBusy(false)
    })
  }

  return (
    <div className="page">
      <div className="page-title-row">
        <h1>Ledger adjustment</h1>
      </div>

      <p className="muted small">
        Manual wallet adjustment for a single user. Delta is signed: positive credits the wallet,
        negative debits it. Ledger adjustments are audited (ledger.*) and flagged for two-person
        approval at thresholds.
      </p>

      {toast && <Toast message={toast} />}

      {result && (
        <Toast
          message={`Adjusted. Withdrawable ${formatTZS(result.withdrawableTZS)} · pending ${formatTZS(
            result.pendingTZS,
          )} · total ${formatTZS(result.totalTZS)}`}
        />
      )}

      {allowed ? (
        <form className="modal" onSubmit={handleSubmit}>
          <h3 className="modal-title">Adjust wallet</h3>
          <div className="form-grid">
            <label className="field-block">
              <span className="field-label">User ID</span>
              <input
                className="field"
                value={userId}
                onChange={(e) => setUserId(e.target.value)}
                placeholder="usr_…"
                required
                aria-required="true"
              />
            </label>
            <label className="field-block">
              <span className="field-label">Delta (TZS)</span>
              <input
                className="field"
                type="number"
                step={1}
                value={delta}
                onChange={(e) => setDelta(e.target.value)}
                placeholder="-5000 or 15000"
                required
                aria-required="true"
              />
              <span className="field-hint">Signed integer amount to credit (+) or debit (−).</span>
            </label>
            <label className="field-block">
              <span className="field-label">Reason</span>
              <textarea
                className="field"
                rows={3}
                maxLength={500}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Explain why this action is taken (audited)"
                required
                aria-required="true"
              />
            </label>
          </div>
          {error && <InlineError message={error} />}
          <div className="modal-actions">
            <button type="submit" className="btn" disabled={busy}>
              {busy ? 'Working…' : isLarge ? 'Initiate approval' : 'Adjust wallet'}
            </button>
          </div>
        </form>
      ) : (
        <div className="state-card">
          <p className="muted small">Wallet adjustments require the finance.payout_adjust permission</p>
        </div>
      )}

      {approval && (
        <LedgerApprovalModal
          userId={approval.userId}
          deltaTZS={approval.deltaTZS}
          busy={busy}
          error={approvalError}
          onSubmit={submitApproval}
          onClose={() => {
            if (!busy) setApproval(null)
          }}
        />
      )}
    </div>
  )
}

function LedgerApprovalModal({
  userId,
  deltaTZS,
  busy,
  error,
  onSubmit,
  onClose,
}: {
  userId: string
  deltaTZS: number
  busy: boolean
  error: string | null
  onSubmit: (reason: string) => void
  onClose: () => void
}) {
  const reasonRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    reasonRef.current?.focus()
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    const reason = reasonRef.current?.value.trim() ?? ''
    if (!reason) return
    onSubmit(reason)
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="Initiate ledger approval"
        onClick={(e) => e.stopPropagation()}
        onSubmit={handleSubmit}
      >
        <h3 className="modal-title">Initiate approval</h3>
        <p className="muted small">
          Adjustments of {formatTZS(APPROVAL_THRESHOLD_TZS)} or more require two-person approval (modify_ledger).
        </p>
        <label className="field-block">
          <span className="field-label">Delta</span>
          <input className="field mono" value={formatTZS(deltaTZS)} readOnly aria-readonly="true" />
          <span className="field-hint">Wallet {userId} — signed credit (+) or debit (−).</span>
        </label>
        <label className="field-label" htmlFor="approval-reason">
          Reason
        </label>
        <textarea
          ref={reasonRef}
          id="approval-reason"
          className="field"
          rows={3}
          maxLength={1000}
          required
          placeholder="Explain why this action is taken (audited)"
        />
        {error && (
          <div className="inline-error" role="alert">
            {error}
          </div>
        )}
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn" disabled={busy}>
            {busy ? 'Working…' : 'Request approval'}
          </button>
        </div>
      </form>
    </div>
  )
}
