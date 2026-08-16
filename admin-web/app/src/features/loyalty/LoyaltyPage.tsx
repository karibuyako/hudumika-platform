import { useEffect, useState } from 'react'
import { adminListMerchants, type MerchantAdmin } from '@hudumika/contract'
import { EmptyState } from '../../components/EmptyState'
import { ErrorState } from '../../components/ErrorState'
import { LoadingSkeleton } from '../../components/LoadingSkeleton'
import { ReasonPrompt } from '../../components/ReasonPrompt'
import { parseApiError, type ApiErrorInfo } from '../../lib/api-error'
import { PENDING_ENDPOINT_CODE, pendingEndpointNotice } from '../../lib/pending-endpoints'
import { can } from '../../lib/permissions'
import { useSession } from '../../lib/session'

export function LoyaltyPage() {
  const [merchants, setMerchants] = useState<MerchantAdmin[] | null>(null)
  const [error, setError] = useState<ApiErrorInfo | null>(null)
  const [retryKey, setRetryKey] = useState(0)
  const [confirming, setConfirming] = useState(false)
  const [pending, setPending] = useState(false)

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

  return (
    <div className="page">
      <h1>Loyalty oversight</h1>

      <EmptyState
        title="No loyalty configuration in the contract yet"
        hint={`${merchants.length} merchants on file — the MerchantAdmin model exposes no loyalty fields (tiers or top-up rewards) in the contract.`}
      />

      <div className="state-card">
        <div className="state-title">Pending surface — loyalty config</div>
        <div className="state-message">{pendingEndpointNotice('loyalty_config')}</div>
        <p className="muted small">
          Loyalty tiers and top-up rewards (WORKFLOWS.md #12) would be configured here once the
          contract ships the surface. Nothing is editable through this console until then.
        </p>
        {canEdit && (
          <button
            type="button"
            className="btn"
            onClick={() => {
              setPending(false)
              setConfirming(true)
            }}
          >
            Oversee loyalty config
          </button>
        )}
      </div>

      {pending && (
        <div className="state-card">
          <div className="state-title">
            <span className="mono">{PENDING_ENDPOINT_CODE}</span>
          </div>
          <div className="state-message">{pendingEndpointNotice('loyalty_config')}</div>
          <p className="muted small">This action is documented for backend implementation — nothing was sent.</p>
        </div>
      )}

      <p className="muted small">Loyalty tiers and top-up rewards are reviewed for compliance (workflow 12).</p>

      {confirming && (
        <ReasonPrompt
          title="Oversee loyalty config"
          description="Reviews loyalty tiers and top-up rewards for compliance (workflow 12)."
          maxLength={1000}
          onSubmit={() => {
            setPending(true)
            setConfirming(false)
          }}
          onClose={() => setConfirming(false)}
        />
      )}
    </div>
  )
}
