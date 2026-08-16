import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  VerificationState,
  adminListRiders,
  type RiderAdmin,
  type RiderAdminDocumentsItemStatus,
} from '@hudumika/contract'
import { DetailDrawer } from '../../components/DetailDrawer'
import { AuditTrailSection } from '../../components/AuditTrailSection'
import { EmptyState } from '../../components/EmptyState'
import { ErrorState } from '../../components/ErrorState'
import { LoadingSkeleton } from '../../components/LoadingSkeleton'
import { ReasonPrompt } from '../../components/ReasonPrompt'
import { StatusPill } from '../../components/StatusPill'
import { parseApiError, type ApiErrorInfo } from '../../lib/api-error'
import { PENDING_ENDPOINT_CODE, pendingEndpointNotice } from '../../lib/pending-endpoints'
import { can } from '../../lib/permissions'
import { useSession } from '../../lib/session'
import { useRefetchOnFocus } from '../../lib/use-refetch-on-focus'

type Filter = 'all' | VerificationState

const FILTERS: Array<{ key: Filter; label: string; match: (r: RiderAdmin) => boolean }> = [
  { key: 'all', label: 'All', match: () => true },
  ...Object.values(VerificationState).map((v) => ({
    key: v as Filter,
    label: v.charAt(0).toUpperCase() + v.slice(1).replace(/_/g, ' '),
    match: (r: RiderAdmin) => r.verification === v,
  })),
]

const DOC_TONES: Record<RiderAdminDocumentsItemStatus, string> = {
  approved: 'ok',
  missing: 'muted',
  pending: 'warn',
  rejected: 'bad',
}

const VERIFIABLE: VerificationState[] = ['pending', 'changes_requested']

type VerificationDecision = 'approve' | 'request_changes'

export function RidersPage() {
  const [riders, setRiders] = useState<RiderAdmin[] | null>(null)
  const [filter, setFilter] = useState<Filter>('all')
  const [selected, setSelected] = useState<RiderAdmin | null>(null)
  const [error, setError] = useState<ApiErrorInfo | null>(null)
  const [retryKey, setRetryKey] = useState(0)

  const load = useCallback(() => {
    setError(null)
    adminListRiders().then((res) => {
      if (res.status === 200) setRiders(res.data)
      else setError(parseApiError(res, 'Failed to load riders'))
    })
  }, [])

  useEffect(() => {
    load()
  }, [load, retryKey])

  useRefetchOnFocus(load)

  const counts = useMemo(() => {
    if (!riders) return new Map<Filter, number>()
    const map = new Map<Filter, number>()
    for (const f of FILTERS) map.set(f.key, riders.filter(f.match).length)
    return map
  }, [riders])

  const visible = useMemo(
    () => (riders ?? []).filter(FILTERS.find((f) => f.key === filter)!.match),
    [riders, filter],
  )

  if (error) {
    return (
      <ErrorState
        title="Failed to load riders"
        message={error.message}
        requestId={error.requestId}
        onRetry={() => setRetryKey((k) => k + 1)}
      />
    )
  }
  if (!riders) return <LoadingSkeleton kind="table" />
  if (riders.length === 0) {
    return (
      <div className="page">
        <h1>Riders</h1>
        <EmptyState title="No riders found" hint="Riders appear here once they begin onboarding." />
      </div>
    )
  }

  return (
    <div className="page">
      <h1>Riders</h1>
      <div className="filters">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            className={`chip${filter === f.key ? ' active' : ''}`}
            onClick={() => setFilter(f.key)}
          >
            {f.label} <span className="chip-count">{counts.get(f.key) ?? 0}</span>
          </button>
        ))}
      </div>

      <table className="table">
        <thead>
          <tr>
            <th>Name</th>
            <th>City</th>
            <th>Vehicle</th>
            <th>License plate</th>
            <th>Make / Year</th>
            <th>Verification</th>
            <th>Reliability</th>
          </tr>
        </thead>
        <tbody>
          {visible.length === 0 && (
            <tr>
              <td colSpan={7} className="muted">
                <EmptyState title="No riders match this filter" />
              </td>
            </tr>
          )}
          {visible.map((rider) => (
            <tr key={rider.id} className="row-click" onClick={() => setSelected(rider)}>
              <td>{rider.name}</td>
              <td>{rider.city}</td>
              <td>{rider.vehicle}</td>
              <td className="mono">{rider.licensePlate ?? '—'}</td>
              <td>{vehicleSpec(rider)}</td>
              <td>
                <StatusPill status={rider.verification} tone={verificationTone(rider.verification)} />
              </td>
              <td className="mono">{rider.reliabilityScore ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {selected && <RiderDrawer rider={selected} onClose={() => setSelected(null)} />}
    </div>
  )
}

function RiderDrawer({ rider, onClose }: { rider: RiderAdmin; onClose: () => void }) {
  const session = useSession()
  const allowed = can(session, 'rider.verify')
  const [decision, setDecision] = useState<VerificationDecision | null>(null)
  const [pending, setPending] = useState<VerificationDecision | null>(null)

  return (
    <>
    <DetailDrawer title={rider.name} onClose={onClose}>
      <div className="meta-grid">
        <div className="meta-item">
          <span className="meta-label">ID</span>
          <span className="meta-value mono">{rider.id}</span>
        </div>
        <div className="meta-item">
          <span className="meta-label">Name</span>
          <span className="meta-value">{rider.name}</span>
        </div>
        <div className="meta-item">
          <span className="meta-label">City</span>
          <span className="meta-value">{rider.city}</span>
        </div>
        <div className="meta-item">
          <span className="meta-label">Vehicle</span>
          <span className="meta-value">{rider.vehicle}</span>
        </div>
        <div className="meta-item">
          <span className="meta-label">License plate</span>
          <span className="meta-value mono">{rider.licensePlate ?? '—'}</span>
        </div>
        <div className="meta-item">
          <span className="meta-label">Make / Year</span>
          <span className="meta-value">{vehicleSpec(rider)}</span>
        </div>
        <div className="meta-item">
          <span className="meta-label">Verification</span>
          <span className="meta-value">
            <StatusPill status={rider.verification} tone={verificationTone(rider.verification)} />
          </span>
        </div>
        <div className="meta-item">
          <span className="meta-label">Documents</span>
          <span className="meta-value">
            {rider.documents.length === 0 ? (
              <span className="muted small">None on file</span>
            ) : (
              rider.documents.map((d, i) => (
                <span key={d.type}>
                  {i > 0 ? ' ' : null}
                  <span className={docTagClass(d.status)}>{d.type}</span>
                </span>
              ))
            )}
          </span>
        </div>
        <div className="meta-item">
          <span className="meta-label">Reliability score</span>
          <span className="meta-value mono">{rider.reliabilityScore ?? '—'}</span>
        </div>
      </div>

      {VERIFIABLE.includes(rider.verification) && allowed && (
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
          <div className="state-message">{pendingEndpointNotice('rider_approve')}</div>
          <p className="muted small">This action is documented for backend implementation — nothing was sent.</p>
        </div>
      )}

      <p className="muted small">Rider verification decisions are audited (rider.*) and notify the rider.</p>

      <AuditTrailSection entityType="rider" entityId={rider.id} label="Audit" />
    </DetailDrawer>

      {decision && (
        <ReasonPrompt
          title={decision === 'approve' ? 'Approve rider' : 'Request rider changes'}
          description={`${rider.name} (${rider.id}) — current verification: ${rider.verification}.`}
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

function vehicleSpec(rider: RiderAdmin): string {
  if (rider.vehicleMake == null && rider.vehicleYear == null) return '—'
  if (rider.vehicleMake == null) return String(rider.vehicleYear)
  if (rider.vehicleYear == null) return rider.vehicleMake
  return `${rider.vehicleMake} · ${rider.vehicleYear}`
}

function verificationTone(verification: VerificationState): 'ok' | 'bad' | 'warn' {
  if (verification === 'approved') return 'ok'
  if (verification === 'rejected' || verification === 'suspended') return 'bad'
  return 'warn'
}

function docTagClass(status: RiderAdminDocumentsItemStatus): string {
  const tone = DOC_TONES[status] ?? 'muted'
  return tone === 'ok' ? 'tag' : `tag ${tone}`
}
