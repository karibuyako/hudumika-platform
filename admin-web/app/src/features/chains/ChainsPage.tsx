import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import {
  adminChainOnboard,
  adminChainSuspend,
  adminListChains,
  type ChainAccountAdmin,
  type ChainAccountAdminTier,
} from '@hudumika/contract'
import { formatTZS } from '../../lib/money'
import { parseApiError, type ApiErrorInfo } from '../../lib/api-error'
import { DetailDrawer } from '../../components/DetailDrawer'
import { DataTable, type DataTableColumn } from '../../components/DataTable'
import { ErrorState } from '../../components/ErrorState'
import { FilterChips } from '../../components/FilterChips'
import { LoadingSkeleton } from '../../components/LoadingSkeleton'
import { ReasonPrompt } from '../../components/ReasonPrompt'
import { StatusPill } from '../../components/StatusPill'
import { Toast } from '../../components/FormBits'
import { can } from '../../lib/permissions'
import { useSession } from '../../lib/session'
import { useRefetchOnFocus } from '../../lib/use-refetch-on-focus'

type TierFilter = 'all' | ChainAccountAdminTier

const FILTERS: Array<{ key: TierFilter; label: string; match: (c: ChainAccountAdmin) => boolean }> = [
  { key: 'all', label: 'All', match: () => true },
  { key: 'standard', label: 'Standard', match: (c) => c.tier === 'standard' },
  { key: 'enterprise', label: 'Enterprise', match: (c) => c.tier === 'enterprise' },
]

const COLUMNS: DataTableColumn<ChainAccountAdmin>[] = [
  { key: 'name', header: 'Name', render: (c) => c.name, sortValue: (c) => c.name },
  { key: 'group', header: 'Group ID', render: (c) => c.merchantGroupId, className: 'mono' },
  { key: 'stores', header: 'Stores', render: (c) => c.storesCount, sortValue: (c) => c.storesCount },
  {
    key: 'tier',
    header: 'Tier',
    render: (c) => <StatusPill status={c.tier} tone={c.tier === 'enterprise' ? 'brand' : 'muted'} />,
  },
  { key: 'sla', header: 'SLA level', render: (c) => c.slaLevel ?? '—' },
  { key: 'manager', header: 'Account manager', render: (c) => c.accountManager ?? '—' },
  {
    key: 'volume',
    header: 'Monthly volume',
    render: (c) => (c.monthlyVolumeTZS == null ? '—' : formatTZS(c.monthlyVolumeTZS)),
    sortValue: (c) => c.monthlyVolumeTZS ?? null,
    className: 'mono',
  },
  {
    key: 'status',
    header: 'Status',
    render: (c) => (c.status ? <StatusPill status={c.status} tone={c.status === 'active' ? 'ok' : 'bad'} /> : '—'),
  },
]

export function ChainsPage() {
  const [chains, setChains] = useState<ChainAccountAdmin[] | null>(null)
  const [filter, setFilter] = useState<TierFilter>('all')
  const [selected, setSelected] = useState<ChainAccountAdmin | null>(null)
  const [error, setError] = useState<ApiErrorInfo | null>(null)
  const [retryKey, setRetryKey] = useState(0)
  const [toast, setToast] = useState<string | null>(null)

  const load = useCallback(() => {
    setError(null)
    adminListChains()
      .then((res) => {
        if (res.status === 200) setChains(res.data)
        else setError(parseApiError(res, 'Failed to load chains'))
      })
      .catch(() => setError(parseApiError({ status: 0, data: undefined }, 'Failed to load chains')))
  }, [])

  useEffect(() => {
    load()
  }, [load, retryKey])

  useRefetchOnFocus(load)

  const counts = useMemo(() => {
    const map: Partial<Record<TierFilter, number>> = { all: chains?.length ?? 0, standard: 0, enterprise: 0 }
    for (const c of chains ?? []) map[c.tier] = (map[c.tier] ?? 0) + 1
    return map
  }, [chains])

  const visible = useMemo(
    () => (chains ?? []).filter(FILTERS.find((f) => f.key === filter)!.match),
    [chains, filter],
  )

  if (error) {
    return (
      <ErrorState
        title="Failed to load chains"
        message={error.message}
        requestId={error.requestId}
        onRetry={() => setRetryKey((k) => k + 1)}
      />
    )
  }
  if (!chains) return <LoadingSkeleton kind="table" />

  async function handleOnboard(merchantGroupId: string, tier: ChainAccountAdminTier, reason: string): Promise<ApiErrorInfo | null> {
    const res = await adminChainOnboard(merchantGroupId, { tier, reason })
    if (res.status === 200) {
      setChains((prev) => (prev ?? []).map((c) => (c.merchantGroupId === merchantGroupId ? { ...c, tier, status: 'active' as never } : c)))
      setSelected((prev) => (prev && prev.merchantGroupId === merchantGroupId ? { ...prev, tier, status: 'active' as never } : prev))
      setToast('Chain onboarded')
      return null
    }
    return parseApiError(res, 'Onboard failed')
  }

  async function handleSuspend(merchantGroupId: string, reason: string): Promise<ApiErrorInfo | null> {
    const res = await adminChainSuspend(merchantGroupId, { reason })
    if (res.status === 200) {
      setChains((prev) => (prev ?? []).map((c) => (c.merchantGroupId === merchantGroupId ? { ...c, status: 'suspended' as never } : c)))
      setSelected((prev) => (prev && prev.merchantGroupId === merchantGroupId ? { ...prev, status: 'suspended' as never } : prev))
      setToast('Chain suspended')
      return null
    }
    return parseApiError(res, 'Suspend failed')
  }

  return (
    <div className="page">
      <div className="page-title-row">
        <h1>Enterprise chains</h1>
        {toast && (
          <div className="page-actions">
            <Toast message={toast} />
          </div>
        )}
      </div>
      <FilterChips
        options={FILTERS.map(({ key, label }) => ({ key, label }))}
        value={filter}
        onChange={setFilter}
        counts={counts}
        ariaLabel="Chain tier filters"
      />

      <DataTable
        rows={visible}
        columns={COLUMNS}
        rowKey={(c) => c.merchantGroupId}
        onRowClick={setSelected}
        exportable
        exportFileName="chains"
        tableId="chains"
        emptyTitle={chains.length === 0 ? 'No chains found' : 'No chains match this filter'}
        emptyHint="Enterprise chain accounts appear here once onboarded."
        ariaLabel="Enterprise chains"
      />

      {selected && <ChainDrawer chain={selected} onClose={() => setSelected(null)} onOnboard={handleOnboard} onSuspend={handleSuspend} />}
    </div>
  )
}

function ChainDrawer({
  chain,
  onClose,
  onOnboard,
  onSuspend,
}: {
  chain: ChainAccountAdmin
  onClose: () => void
  onOnboard: (merchantGroupId: string, tier: ChainAccountAdminTier, reason: string) => Promise<ApiErrorInfo | null>
  onSuspend: (merchantGroupId: string, reason: string) => Promise<ApiErrorInfo | null>
}) {
  const session = useSession()
  const canManage = can(session, 'chain.suspend')
  const [prompt, setPrompt] = useState<'onboard' | 'suspend' | null>(null)
  const [suspendBusy, setSuspendBusy] = useState(false)
  const [suspendError, setSuspendError] = useState<ApiErrorInfo | null>(null)

  return (
    <DetailDrawer title={chain.name} onClose={onClose}>
      <div className="detail-section">
        <h3>Account</h3>
        <div className="meta-grid">
          <div className="meta-item">
            <span className="meta-label">Group ID</span>
            <span className="meta-value mono">{chain.merchantGroupId}</span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Name</span>
            <span className="meta-value">{chain.name}</span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Tier</span>
            <span className="meta-value">
              <StatusPill status={chain.tier} tone={chain.tier === 'enterprise' ? 'brand' : 'muted'} />
            </span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Stores</span>
            <span className="meta-value">{chain.storesCount}</span>
          </div>
        </div>
      </div>

      <div className="detail-section">
        <h3>SLA</h3>
        <div className="meta-grid">
          <div className="meta-item">
            <span className="meta-label">SLA level</span>
            <span className="meta-value">{chain.slaLevel ?? '—'}</span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Account manager</span>
            <span className="meta-value">{chain.accountManager ?? '—'}</span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Monthly volume</span>
            <span className="meta-value mono">
              {chain.monthlyVolumeTZS == null ? '—' : formatTZS(chain.monthlyVolumeTZS)}
            </span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Status</span>
            <span className="meta-value">
              {chain.status ? (
                <StatusPill status={chain.status} tone={chain.status === 'active' ? 'ok' : 'bad'} />
              ) : (
                '—'
              )}
            </span>
          </div>
        </div>
      </div>

      {canManage && (
        <>
          <hr className="divider" />
          <div className="detail-section">
            <h3>Chain lifecycle</h3>
            <div className="form-actions">
              {chain.status !== 'active' && (
                <button
                  type="button"
                  className="btn"
                  onClick={() => setPrompt('onboard')}
                >
                  Onboard
                </button>
              )}
              {chain.status === 'active' && (
                <button
                  type="button"
                  className="btn btn-danger"
                  onClick={() => setPrompt('suspend')}
                >
                  Suspend
                </button>
              )}
            </div>
          </div>
        </>
      )}

      <p className="muted small">
        Onboarding and suspension follow the enterprise chain workflow (WORKFLOWS.md #14); suspension
        of a major chain requires two-person approval.
      </p>

      {prompt === 'onboard' && (
        <OnboardPrompt
          chain={chain}
          onClose={() => setPrompt(null)}
          onSubmit={async (tier, reason) => {
            const err = await onOnboard(chain.merchantGroupId, tier, reason)
            if (!err) setPrompt(null)
            return err
          }}
        />
      )}
      {prompt === 'suspend' && (
        <ReasonPrompt
          title="Suspend chain"
          description={`${chain.name} (${chain.merchantGroupId}) — suspends the chain account. Major chains require two-person approval.`}
          tone="danger"
          busy={suspendBusy}
          error={suspendError}
          onSubmit={async (reason) => {
            setSuspendBusy(true)
            setSuspendError(null)
            const err = await onSuspend(chain.merchantGroupId, reason)
            setSuspendBusy(false)
            if (err) setSuspendError(err)
            else setPrompt(null)
          }}
          onClose={() => {
            if (!suspendBusy) setPrompt(null)
          }}
        />
      )}
    </DetailDrawer>
  )
}

const TIERS: ChainAccountAdminTier[] = ['standard', 'enterprise']

/** Onboard — reason plus tier choice (standard/enterprise). */
function OnboardPrompt({
  chain,
  onSubmit,
  onClose,
}: {
  chain: ChainAccountAdmin
  onSubmit: (tier: ChainAccountAdminTier, reason: string) => Promise<ApiErrorInfo | null>
  onClose: () => void
}) {
  const [tier, setTier] = useState<ChainAccountAdminTier>('standard')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<ApiErrorInfo | null>(null)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (!reason.trim()) return
    setBusy(true)
    setError(null)
    const err = await onSubmit(tier, reason.trim())
    setBusy(false)
    if (err) setError(err)
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="Onboard chain"
        onClick={(e) => e.stopPropagation()}
        onSubmit={handleSubmit}
      >
        <h3 className="modal-title">Onboard chain</h3>
        <p className="muted small">
          Activates {chain.name} ({chain.merchantGroupId}) as an enterprise chain account.
        </p>
        <label className="field-label" htmlFor="onboard-reason">
          Reason
        </label>
        <textarea
          id="onboard-reason"
          className="field"
          rows={3}
          maxLength={500}
          required
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Explain why this action is taken (audited)"
        />
        <label className="field-block">
          <span className="field-label">Tier</span>
          <select className="field" value={tier} onChange={(e) => setTier(e.target.value as ChainAccountAdminTier)}>
            {TIERS.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        {error && (
          <div className="inline-error" role="alert">
            <div>{error.message}</div>
            <div className="muted small">
              {error.code}
              {error.requestId ? ` · request ${error.requestId}` : ''}
            </div>
          </div>
        )}
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn" disabled={busy}>
            {busy ? 'Working…' : 'Confirm'}
          </button>
        </div>
      </form>
    </div>
  )
}
