import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  adminListProviders,
  VerificationState,
  type ProviderAdmin,
  type ProviderAdminDocumentsItem,
} from '@hudumika/contract'
import { DetailDrawer } from '../../components/DetailDrawer'
import { AuditTrailSection } from '../../components/AuditTrailSection'
import { ErrorState } from '../../components/ErrorState'
import { FilterChips } from '../../components/FilterChips'
import { LoadingSkeleton } from '../../components/LoadingSkeleton'
import { ReasonPrompt } from '../../components/ReasonPrompt'
import { StatusPill } from '../../components/StatusPill'
import { DataTable, type DataTableColumn } from '../../components/DataTable'
import { parseApiError } from '../../lib/api-error'
import { formatTZS } from '../../lib/money'
import { PENDING_ENDPOINT_CODE, pendingEndpointNotice } from '../../lib/pending-endpoints'
import { can } from '../../lib/permissions'
import { useSession } from '../../lib/session'
import { useRefetchOnFocus } from '../../lib/use-refetch-on-focus'

/**
 * Row extension for fields the admin list may carry that the contract model
 * does not yet type (city, categories, isOpen) — rendered defensively.
 */
type ProviderRow = ProviderAdmin & { city?: string; categories?: string[]; isOpen?: boolean }

const FILTERS: Array<{ key: string; label: string }> = [
  { key: 'all', label: 'All' },
  ...Object.values(VerificationState).map((s) => ({ key: s, label: s.replace(/_/g, ' ') })),
]

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function verificationTone(state: string): 'ok' | 'bad' | 'warn' {
  if (state === 'approved') return 'ok'
  if (state === 'rejected' || state === 'suspended') return 'bad'
  return 'warn'
}

function documentTone(status: string): 'ok' | 'muted' | 'bad' | 'warn' {
  if (status === 'approved') return 'ok'
  if (status === 'missing') return 'muted'
  if (status === 'rejected') return 'bad'
  return 'warn'
}

const VERIFIABLE: VerificationState[] = ['pending', 'documents_review', 'changes_requested']

type VerificationDecision = 'approve' | 'request_changes'

const COLUMNS: DataTableColumn<ProviderRow>[] = [
  {
    key: 'name',
    header: 'Name',
    render: (p) => (
      <>
        {p.name}
        <br />
        <span className="muted mono">{p.id}</span>
      </>
    ),
  },
  { key: 'city', header: 'City', render: (p) => p.city ?? '—' },
  {
    key: 'verification',
    header: 'Verification',
    render: (p) => <StatusPill status={p.verification} tone={verificationTone(p.verification)} />,
  },
  {
    key: 'reliability',
    header: 'Reliability',
    render: (p) => (p.reliabilityScore != null ? `${p.reliabilityScore}/100` : '—'),
    sortValue: (p) => p.reliabilityScore,
    className: 'mono',
  },
  {
    key: 'areas',
    header: 'Service areas',
    render: (p) =>
      p.serviceAreas?.length ? (
        p.serviceAreas.map((a) => (
          <span key={a} className="tag">
            {a}
          </span>
        ))
      ) : (
        <span className="muted">—</span>
      ),
  },
  {
    key: 'categories',
    header: 'Categories',
    render: (p) =>
      p.categories?.length ? (
        p.categories.map((c) => (
          <span key={c} className="tag">
            {c}
          </span>
        ))
      ) : (
        <span className="muted">—</span>
      ),
  },
  {
    key: 'open',
    header: 'Open',
    render: (p) => <StatusPill status={p.isOpen ? 'open' : 'closed'} tone={p.isOpen ? 'ok' : 'muted'} />,
  },
]

export function ProvidersPage() {
  const [providers, setProviders] = useState<ProviderRow[] | null>(null)
  const [filter, setFilter] = useState<string>('all')
  const [selected, setSelected] = useState<ProviderRow | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [requestId, setRequestId] = useState<string | undefined>(undefined)
  const [retryKey, setRetryKey] = useState(0)

  const load = useCallback(() => {
    setError(null)
    adminListProviders().then((res) => {
      if (res.status === 200) {
        setProviders(res.data as ProviderRow[])
      } else {
        const info = parseApiError(res, 'Failed to load providers')
        setError(info.message)
        setRequestId(info.requestId)
      }
    })
  }, [])

  useEffect(() => {
    load()
  }, [load, retryKey])

  useRefetchOnFocus(load)

  const counts = useMemo(() => {
    if (!providers) return {}
    const map: Record<string, number> = { all: providers.length }
    for (const state of Object.values(VerificationState)) {
      map[state] = providers.filter((p) => p.verification === state).length
    }
    return map
  }, [providers])

  const visible = useMemo(
    () => (providers ?? []).filter((p) => filter === 'all' || p.verification === filter),
    [providers, filter],
  )

  if (error) {
    return (
      <ErrorState
        title="Failed to load providers"
        message={error}
        requestId={requestId}
        onRetry={() => setRetryKey((k) => k + 1)}
      />
    )
  }
  if (!providers) return <LoadingSkeleton kind="table" />

  return (
    <div className="page">
      <h1>Providers</h1>
      <FilterChips
        options={FILTERS}
        value={filter}
        onChange={setFilter}
        counts={counts}
        ariaLabel="Filter providers by verification state"
      />

      <DataTable
        rows={visible}
        columns={COLUMNS}
        rowKey={(p) => p.id}
        onRowClick={setSelected}
        emptyTitle={providers.length === 0 ? 'No providers found' : 'No providers match this filter'}
        emptyHint={providers.length === 0 ? 'Providers will appear here once they register.' : undefined}
        exportable
        exportFileName="providers"
        tableId="providers"
        ariaLabel="Providers"
      />

      {selected && <ProviderDrawer provider={selected} onClose={() => setSelected(null)} />}
    </div>
  )
}

function ProviderDrawer({ provider, onClose }: { provider: ProviderRow; onClose: () => void }) {
  const p = provider
  const session = useSession()
  const allowed = can(session, 'provider.verify')
  const [decision, setDecision] = useState<VerificationDecision | null>(null)
  const [pending, setPending] = useState<VerificationDecision | null>(null)

  return (
    <>
    <DetailDrawer title={p.name} onClose={onClose} wide>
      <div className="meta-grid">
        <div className="meta-item">
          <span className="meta-label">ID</span>
          <span className="meta-value mono">{p.id}</span>
        </div>
        <div className="meta-item">
          <span className="meta-label">Name</span>
          <span className="meta-value">{p.name}</span>
        </div>
        {p.bio && (
          <div className="meta-item">
            <span className="meta-label">Bio</span>
            <span className="meta-value">{p.bio}</span>
          </div>
        )}
        {p.availability?.length ? (
          <div className="meta-item">
            <span className="meta-label">Availability</span>
            <span className="meta-value small">
              {p.availability.map((a) => `${DAY_NAMES[a.dayOfWeek] ?? a.dayOfWeek} ${a.startTime}–${a.endTime}`).join(', ')}
            </span>
          </div>
        ) : (
          <div className="meta-item">
            <span className="meta-label">Availability</span>
            <span className="meta-value muted">—</span>
          </div>
        )}
        <div className="meta-item">
          <span className="meta-label">City</span>
          <span className="meta-value">{p.city ?? '—'}</span>
        </div>
        <div className="meta-item">
          <span className="meta-label">Service areas</span>
          <span className="meta-value">
            {p.serviceAreas?.length ? p.serviceAreas.map((a) => (
              <span key={a} className="tag">
                {a}
              </span>
            )) : <span className="muted">—</span>}
          </span>
        </div>
        <div className="meta-item">
          <span className="meta-label">Categories</span>
          <span className="meta-value">
            {p.categories?.length ? p.categories.map((c) => (
              <span key={c} className="tag">
                {c}
              </span>
            )) : <span className="muted">—</span>}
          </span>
        </div>
        <div className="meta-item">
          <span className="meta-label">Trade</span>
          <span className="meta-value">{p.trade}</span>
        </div>
      </div>

      <hr className="divider" />
      <div className="meta-grid">
        <div className="meta-item">
          <span className="meta-label">Verification</span>
          <span className="meta-value">
            <StatusPill status={p.verification} tone={verificationTone(p.verification)} />
          </span>
        </div>
        <div className="meta-item">
          <span className="meta-label">Documents</span>
          <span className="meta-value">
            {p.documents.length === 0 ? (
              <span className="muted">—</span>
            ) : (
              p.documents.map((d: ProviderAdminDocumentsItem) => (
                <span key={d.type} className={`tag${documentTone(d.status) === 'ok' ? '' : ` ${documentTone(d.status)}`}`}>
                  {d.type} · {d.status}
                </span>
              ))
            )}
          </span>
        </div>
      </div>

      <hr className="divider" />
      <div className="meta-grid">
        <div className="meta-item">
          <span className="meta-label">Payout cycle</span>
          <span className="meta-value">{p.payoutCycleDays} days</span>
        </div>
        <div className="meta-item">
          <span className="meta-label">Reliability</span>
          <span className="meta-value mono">{p.reliabilityScore}/100</span>
        </div>
        <div className="meta-item">
          <span className="meta-label">Base rate</span>
          <span className="meta-value mono">{formatTZS(p.baseRateTZS)}</span>
        </div>
      </div>

      {VERIFIABLE.includes(p.verification) && allowed && (
        <>
          <hr className="divider" />
          <h3>Verification decision</h3>
          <div className="page-actions">
            <button
              type="button"
              className="btn"
              onClick={() => {
                setPending(null)
                setDecision('approve')
              }}
            >
              Approve
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => {
                setPending(null)
                setDecision('request_changes')
              }}
            >
              Request changes
            </button>
          </div>
        </>
      )}

      {pending && (
        <div className="state-card">
          <div className="state-title">
            <span className="mono">{PENDING_ENDPOINT_CODE}</span>
          </div>
          <div className="state-message">{pendingEndpointNotice('provider_approve')}</div>
          <p className="muted small">This action is documented for backend implementation — nothing was sent.</p>
        </div>
      )}

      <p className="muted small">Provider verification decisions are audited (provider.*) and notify the provider.</p>

      <AuditTrailSection entityType="provider" entityId={p.id} label="Audit" />
    </DetailDrawer>

      {decision && (
        <ReasonPrompt
          title={decision === 'approve' ? 'Approve provider' : 'Request provider changes'}
          description={`${p.name} (${p.id}) — current verification: ${p.verification}.`}
          confirmLabel="Confirm"
          onSubmit={() => {
            setPending(decision)
            setDecision(null)
          }}
          onClose={() => setDecision(null)}
        />
      )}
    </>
  )
}
