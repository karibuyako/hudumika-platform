import { useEffect, useState } from 'react'
import { adminListMerchants, adminUpdateLoyaltyConfig, type MerchantAdmin, type AdminLoyaltyConfigBody } from '@hudumika/contract'
import { EmptyState } from '../../components/EmptyState'
import { ErrorState } from '../../components/ErrorState'
import { LoadingSkeleton } from '../../components/LoadingSkeleton'
import { ReasonPrompt } from '../../components/ReasonPrompt'
import { Toast } from '../../components/FormBits'
import { parseApiError, type ApiErrorInfo } from '../../lib/api-error'
import { can } from '../../lib/permissions'
import { useSession } from '../../lib/session'

const DEFAULT_TIERS = [
  { name: 'Bronze', discountBps: 500, thresholdTZS: 100000, perks: [] },
  { name: 'Silver', discountBps: 1000, thresholdTZS: 500000, perks: ['priority support'] },
  { name: 'Gold', discountBps: 2000, thresholdTZS: 1000000, perks: ['priority support', 'free delivery'] },
]

const DEFAULT_TOP_UP_REWARDS = [{ thresholdTZS: 100000, bonusTZS: 5000 }]

export function LoyaltyPage() {
  const [merchants, setMerchants] = useState<MerchantAdmin[] | null>(null)
  const [tiers, setTiers] = useState<Array<{ name: string; discountBps: number; thresholdTZS: number; perks: string[] }>>(DEFAULT_TIERS)
  const [topUpRewards, setTopUpRewards] = useState<Array<{ thresholdTZS: number; bonusTZS: number }>>(DEFAULT_TOP_UP_REWARDS)
  const [error, setError] = useState<ApiErrorInfo | null>(null)
  const [retryKey, setRetryKey] = useState(0)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [promptError, setPromptError] = useState<ApiErrorInfo | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  const session = useSession()
  const canEdit = can(session, 'configuration.edit')

  useEffect(() => {
    setError(null)
    adminListMerchants().then((res) => {
      if (res.status === 200) setMerchants(res.data)
      else setError(parseApiError(res, 'Failed to load merchants'))
    })
  }, [retryKey])

  if (error) {
    return (
      <ErrorState
        title="Failed to load merchants"
        message={error.message}
        requestId={error.requestId}
        onRetry={() => setRetryKey((k) => k + 1)}
      />
    )
  }
  if (!merchants) return <LoadingSkeleton kind="table" />

  async function handleConfirm(reason: string) {
    setBusy(true)
    setPromptError(null)
    const res = await adminUpdateLoyaltyConfig({
      tiers,
      topUpRewards,
      reason,
    })
    setBusy(false)
    if (res.status === 200) {
      setToast('Loyalty config updated')
      setConfirming(false)
    } else {
      setPromptError(parseApiError(res, 'Update failed'))
    }
  }

  return (
    <div className="page">
      <div className="page-title-row">
        <h1>Loyalty oversight</h1>
        {toast && (
          <div className="page-actions">
            <Toast message={toast} />
          </div>
        )}
      </div>

      <EmptyState
        title="Loyalty configuration"
        hint={`${merchants.length} merchants on file — review tiers and top-up rewards for compliance. The current config is audited (loyalty.*).`}
      />

      <div className="state-card">
        <div className="state-title">Loyalty tiers & top-up rewards</div>
        <p className="muted small">
          Default tiers (Bronze/Silver/Gold) and a top-up reward will be applied when you confirm. Edit
          the contract model for custom tiers; this console applies the reviewed config.
        </p>
        {canEdit && (
          <button
            type="button"
            className="btn"
            onClick={() => {
              setPromptError(null)
              setConfirming(true)
            }}
          >
            Oversee loyalty config
          </button>
        )}
      </div>

      <p className="muted small">Loyalty tiers and top-up rewards are reviewed for compliance (workflow 12).</p>

      {confirming && (
        <ReasonPrompt
          title="Oversee loyalty config"
          description="Reviews loyalty tiers and top-up rewards for compliance (workflow 12)."
          maxLength={1000}
          busy={busy}
          error={promptError}
          onSubmit={handleConfirm}
          onClose={() => {
            if (!busy) setConfirming(false)
          }}
        />
      )}
    </div>
  )
}
