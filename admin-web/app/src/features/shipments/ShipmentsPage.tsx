import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import {
  ShipmentStatus,
  adminCreateTwoPersonApproval,
  adminEscalateShipment,
  adminFreezeShipment,
  adminReassignShipment,
  getShipmentCustody,
  listShipments,
  type CustodyEntry,
  type Shipment,
  type ShipmentStatus as Status,
} from '@hudumika/contract'
import { DetailDrawer } from '../../components/DetailDrawer'
import { AuditTrailSection } from '../../components/AuditTrailSection'
import { EmptyState } from '../../components/EmptyState'
import { ErrorState } from '../../components/ErrorState'
import { FilterChips } from '../../components/FilterChips'
import { Toast } from '../../components/FormBits'
import { LoadingSkeleton } from '../../components/LoadingSkeleton'
import { ReasonPrompt } from '../../components/ReasonPrompt'
import { StatusPill } from '../../components/StatusPill'
import { parseApiError, type ApiErrorInfo } from '../../lib/api-error'
import { formatTZS } from '../../lib/money'
import { PENDING_ENDPOINT_CODE, pendingEndpointNotice } from '../../lib/pending-endpoints'
import { can } from '../../lib/permissions'
import { useSession } from '../../lib/session'
import { toLocal } from '../../lib/time'
import { useRefetchOnFocus } from '../../lib/use-refetch-on-focus'

type Bucket = 'all' | Status

const STATUSES: Status[] = Object.values(ShipmentStatus)

const BUCKETS: Bucket[] = ['all', ...STATUSES]

function toneFor(status: Status): 'ok' | 'bad' | 'info' | 'muted' | 'brand' {
  if (status === 'delivered') return 'ok'
  if (status === 'exception' || status === 'frozen') return 'bad'
  if (status === 'in_transit') return 'info'
  if (status === 'planned') return 'muted'
  return 'brand'
}

function truncate(text: string, max = 40) {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

type ActionKind = 'freeze' | 'unfreeze' | 'reassign' | 'escalate' | 'anomaly_dismiss' | 'anomaly_freeze'

function actionErrorText(info: ApiErrorInfo): string {
  if (info.code === 'SHIPMENT_NOT_REASSIGNABLE')
    return 'Shipment cannot be reassigned in its current state (SHIPMENT_NOT_REASSIGNABLE)'
  if (info.code === 'SHIPMENT_NOT_ESCALATABLE')
    return 'Shipment cannot be escalated in its current state (SHIPMENT_NOT_ESCALATABLE)'
  return info.message
}

export function ShipmentsPage() {
  const [shipments, setShipments] = useState<Shipment[] | null>(null)
  const [bucket, setBucket] = useState<Bucket>('all')
  const [selected, setSelected] = useState<Shipment | null>(null)
  const [prompt, setPrompt] = useState<ActionKind | null>(null)
  const [promptError, setPromptError] = useState<ApiErrorInfo | null>(null)
  const [busy, setBusy] = useState(false)
  const [anomalyPending, setAnomalyPending] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [retryKey, setRetryKey] = useState(0)

  const session = useSession()
  const canHold = can(session, 'shipment.hold')
  const canReassign = can(session, 'shipment.reassign')
  const canResolveAnomaly = can(session, 'anomaly.resolve')

  const load = useCallback(() => {
    setError(null)
    listShipments().then((res) => {
      if (res.status === 200) setShipments(res.data)
      else setError(`Failed to load shipments (${res.status})`)
    })
  }, [])

  useEffect(() => {
    load()
  }, [load, retryKey])

  useRefetchOnFocus(load)

  const counts = useMemo(() => {
    const map: Partial<Record<Bucket, number>> = { all: shipments?.length ?? 0 }
    for (const s of shipments ?? []) map[s.status] = (map[s.status] ?? 0) + 1
    return map
  }, [shipments])

  const visible = useMemo(
    () => (shipments ?? []).filter((r) => bucket === 'all' || r.status === bucket),
    [shipments, bucket],
  )

  async function runAction(reason: string, extra?: { resumePlan?: string; riderId?: string }) {
    const target = selected
    const kind = prompt
    if (!target || !kind) return
    setBusy(true)
    setPromptError(null)
    if (kind === 'anomaly_dismiss' || kind === 'anomaly_freeze') {
      setPrompt(null)
      setAnomalyPending(true)
      setBusy(false)
      return
    }
    if (kind === 'unfreeze') {
      const res = await adminCreateTwoPersonApproval({
        actionType: 'release_hold',
        targetType: 'shipment',
        targetId: target.id,
        reason,
        payload: { resumePlan: extra?.resumePlan ?? null },
      })
      if (res.status === 201) {
        setToast('Unfreeze approval requested — pending a second admin')
        setSelected(null)
        setPrompt(null)
      } else {
        const info = parseApiError(res)
        setPromptError({ ...info, message: actionErrorText(info) })
      }
      setBusy(false)
      return
    }
    let res
    if (kind === 'freeze') res = await adminFreezeShipment(target.id, { reason })
    else if (kind === 'reassign')
      res = await adminReassignShipment(target.id, { reason, riderId: extra?.riderId || null })
    else res = await adminEscalateShipment(target.id, { reason })
    if (res.status === 200) {
      setToast(`${target.shipmentNumber} ${kind === 'freeze' ? 'frozen' : kind === 'reassign' ? 'reassigned' : 'escalated'}`)
      setSelected(null)
      setPrompt(null)
      setRetryKey((k) => k + 1)
    } else {
      const info = parseApiError(res)
      setPromptError({ ...info, message: actionErrorText(info) })
    }
    setBusy(false)
  }

  if (error) {
    return (
      <ErrorState
        title="Failed to load shipments"
        message={error}
        onRetry={() => setRetryKey((k) => k + 1)}
      />
    )
  }
  if (!shipments) return <LoadingSkeleton kind="table" rows={4} />
  if (shipments.length === 0)
    return (
      <div className="page">
        <div className="page-title-row">
          <h1>Shipments</h1>
        </div>
        <EmptyState title="No shipments" hint="Shipments appear here once orders create physical logistics units." />
      </div>
    )

  return (
    <div className="page">
      <div className="page-title-row">
        <h1>Shipments</h1>
        {toast && (
          <div className="page-actions">
            <Toast message={toast} />
          </div>
        )}
      </div>

      <FilterChips
        options={BUCKETS.map((b) => ({ key: b, label: b === 'all' ? 'All' : b.replace(/_/g, ' ') }))}
        value={bucket}
        onChange={setBucket}
        counts={counts}
        ariaLabel="Shipment status filters"
      />

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Shipment</th>
              <th>Order</th>
              <th>Status</th>
              <th>Container</th>
              <th>Declared value</th>
              <th>Frozen reason</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 && (
              <tr>
                <td colSpan={7} className="muted">
                  <EmptyState title="No shipments in this bucket" />
                </td>
              </tr>
            )}
            {visible.map((s) => (
              <tr key={s.id} className="row-click" onClick={() => setSelected(s)}>
                <td className="mono">{s.shipmentNumber}</td>
                <td className="mono">{s.orderId}</td>
                <td>
                  <StatusPill status={s.status} tone={toneFor(s.status)} />
                </td>
                <td>{s.containerId ?? '—'}</td>
                <td>{formatTZS(s.declaredValueTZS)}</td>
                <td className="muted small">{s.frozenReason ? truncate(s.frozenReason) : '—'}</td>
                <td className="muted">{toLocal(s.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {selected && (
        <ShipmentDrawer
          shipment={selected}
          canHold={canHold}
          canReassign={canReassign}
          canResolveAnomaly={canResolveAnomaly}
          anomalyPending={anomalyPending}
          onClose={() => setSelected(null)}
          onAction={(kind) => {
            setToast(null)
            setPromptError(null)
            setAnomalyPending(false)
            setPrompt(kind)
          }}
        />
      )}

      {prompt === 'freeze' && (
        <ReasonPrompt
          title="Freeze shipment"
          description="Stops all movement and holds custody for investigation."
          tone="danger"
          busy={busy}
          error={promptError}
          onSubmit={(reason) => runAction(reason)}
          onClose={() => setPrompt(null)}
        />
      )}
      {prompt === 'unfreeze' && (
        <UnfreezePrompt
          busy={busy}
          error={promptError}
          onSubmit={(reason, resumePlan) => runAction(reason, { resumePlan })}
          onClose={() => setPrompt(null)}
        />
      )}
      {prompt === 'reassign' && (
        <ReassignPrompt
          busy={busy}
          error={promptError}
          onSubmit={(reason, riderId) => runAction(reason, { riderId })}
          onClose={() => setPrompt(null)}
        />
      )}
      {prompt === 'escalate' && (
        <ReasonPrompt
          title="Escalate shipment"
          description="Raises the shipment to security — reserved for serious incidents."
          tone="danger"
          busy={busy}
          error={promptError}
          onSubmit={(reason) => runAction(reason)}
          onClose={() => setPrompt(null)}
        />
      )}
      {prompt === 'anomaly_dismiss' && (
        <ReasonPrompt
          title="Dismiss anomaly"
          description="Marks the machine-fed anomaly as reviewed and dismisses it without action."
          busy={busy}
          error={promptError}
          onSubmit={(reason) => runAction(reason)}
          onClose={() => setPrompt(null)}
        />
      )}
      {prompt === 'anomaly_freeze' && (
        <ReasonPrompt
          title="Freeze with evidence"
          description="Holds the shipment with the evidence collected from the anomaly feed."
          tone="danger"
          busy={busy}
          error={promptError}
          onSubmit={(reason) => runAction(reason)}
          onClose={() => setPrompt(null)}
        />
      )}
    </div>
  )
}

function ShipmentDrawer({
  shipment,
  canHold,
  canReassign,
  canResolveAnomaly,
  anomalyPending,
  onClose,
  onAction,
}: {
  shipment: Shipment
  canHold: boolean
  canReassign: boolean
  canResolveAnomaly: boolean
  anomalyPending: boolean
  onClose: () => void
  onAction: (kind: ActionKind) => void
}) {
  const [tab, setTab] = useState<'overview' | 'custody'>('overview')
  return (
    <DetailDrawer title={<span className="mono-strong">{shipment.shipmentNumber}</span>} onClose={onClose}>
      <div className="tabs" role="tablist" aria-label="Shipment details">
        <button type="button" className={`tab${tab === 'overview' ? ' active' : ''}`} onClick={() => setTab('overview')}>
          Overview
        </button>
        <button type="button" className={`tab${tab === 'custody' ? ' active' : ''}`} onClick={() => setTab('custody')}>
          Custody
        </button>
      </div>
      {tab === 'overview' ? (
        <OverviewTab
          shipment={shipment}
          canHold={canHold}
          canReassign={canReassign}
          canResolveAnomaly={canResolveAnomaly}
          anomalyPending={anomalyPending}
          onAction={onAction}
        />
      ) : (
        <CustodyTab shipment={shipment} />
      )}

      <AuditTrailSection entityType="shipment" entityId={shipment.id} label="Audit" />
    </DetailDrawer>
  )
}

function OverviewTab({
  shipment,
  canHold,
  canReassign,
  canResolveAnomaly,
  anomalyPending,
  onAction,
}: {
  shipment: Shipment
  canHold: boolean
  canReassign: boolean
  canResolveAnomaly: boolean
  anomalyPending: boolean
  onAction: (kind: ActionKind) => void
}) {
  const s = shipment
  return (
    <>
      <div className="meta-grid">
        <div className="meta-item">
          <span className="meta-label">ID</span>
          <span className="meta-value mono">{s.id}</span>
        </div>
        <div className="meta-item">
          <span className="meta-label">Shipment number</span>
          <span className="meta-value mono">{s.shipmentNumber}</span>
        </div>
        <div className="meta-item">
          <span className="meta-label">Order</span>
          <span className="meta-value mono">{s.orderId}</span>
        </div>
        <div className="meta-item">
          <span className="meta-label">Packages</span>
          <span className="meta-value">{s.packages?.length ?? '—'}</span>
        </div>
        <div className="meta-item">
          <span className="meta-label">Container</span>
          <span className="meta-value">{s.containerId ?? '—'}</span>
        </div>
        <div className="meta-item">
          <span className="meta-label">Status</span>
          <span className="meta-value">
            <StatusPill status={s.status} tone={toneFor(s.status)} />
          </span>
        </div>
        <div className="meta-item">
          <span className="meta-label">Frozen reason</span>
          <span className="meta-value">{s.frozenReason ?? '—'}</span>
        </div>
        <div className="meta-item">
          <span className="meta-label">Frozen at</span>
          <span className="meta-value">{toLocal(s.frozenAt)}</span>
        </div>
        <div className="meta-item">
          <span className="meta-label">Current leg</span>
          <span className="meta-value mono">{s.currentLegId ?? '—'}</span>
        </div>
        <div className="meta-item">
          <span className="meta-label">Declared value</span>
          <span className="meta-value">{formatTZS(s.declaredValueTZS)}</span>
        </div>
        <div className="meta-item">
          <span className="meta-label">Created</span>
          <span className="meta-value">{toLocal(s.createdAt)}</span>
        </div>
      </div>

      {canHold || canReassign ? (
        <div className="detail-section">
          <h3>Actions</h3>
          <div className="form-actions">
            {canHold && s.status !== 'frozen' && (
              <button type="button" className="btn btn-danger" onClick={() => onAction('freeze')}>
                Freeze
              </button>
            )}
            {canHold && s.status === 'frozen' && (
              <button type="button" className="btn" onClick={() => onAction('unfreeze')}>
                Initiate unfreeze approval
              </button>
            )}
            {canReassign && (
              <button type="button" className="btn" onClick={() => onAction('reassign')}>
                Reassign
              </button>
            )}
            {canReassign && (
              <button type="button" className="btn btn-danger" onClick={() => onAction('escalate')}>
                Escalate
              </button>
            )}
          </div>
        </div>
      ) : null}

      {s.status === 'exception' && canResolveAnomaly && (
        <>
          <div className="detail-section">
            <h3>Anomaly decision</h3>
            <div className="form-actions">
              <button type="button" className="btn" onClick={() => onAction('anomaly_dismiss')}>
                Dismiss
              </button>
              <button type="button" className="btn btn-danger" onClick={() => onAction('anomaly_freeze')}>
                Freeze with evidence
              </button>
            </div>
          </div>
          <p className="muted small">
            Anomalies are machine-fed; decisions are audited (anomaly.*) and freeze holds custody.
          </p>
        </>
      )}

      {anomalyPending && (
        <div className="state-card">
          <div className="state-title">
            <span className="mono">{PENDING_ENDPOINT_CODE}</span>
          </div>
          <div className="state-message">{pendingEndpointNotice('anomaly_resolve')}</div>
          <p className="muted small">This action is documented for backend implementation — nothing was sent.</p>
        </div>
      )}

      <p className="muted small">
        Freeze holds custody for investigation; all actions are audited (shipment.*).
      </p>
    </>
  )
}

function CustodyTab({ shipment }: { shipment: Shipment }) {
  const [entries, setEntries] = useState<CustodyEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [retryKey, setRetryKey] = useState(0)

  useEffect(() => {
    setError(null)
    getShipmentCustody(shipment.id).then((res) => {
      if (res.status === 200) setEntries(res.data)
      else setError(`Failed to load custody (${res.status})`)
    })
  }, [shipment.id, retryKey])

  if (error) {
    return (
      <ErrorState
        title="Failed to load custody"
        message={error}
        onRetry={() => setRetryKey((k) => k + 1)}
      />
    )
  }
  if (!entries) return <LoadingSkeleton kind="table" rows={4} />
  if (entries.length === 0)
    return <EmptyState title="No custody entries" hint="Scans and handoffs for this shipment will appear here." />

  return (
    <div className="timeline">
      {entries.map((e) => (
        <div key={e.id} className="timeline-item">
          <div className="timeline-dot" />
          <div>
            <div className="small strong">{e.eventType}</div>
            <div className="muted small">
              {e.actorType ? `${e.actorType}${e.actorId ? ` · ${e.actorId}` : ''}` : e.actorId ?? 'system'}
              {e.deviceId ? ` · device ${e.deviceId}` : ''}
            </div>
            {(e.previousState != null || e.newState != null) && (
              <div className="mono small">
                {e.previousState ?? '—'} → {e.newState ?? '—'}
              </div>
            )}
            {e.evidence && <div className="muted small">{e.evidence}</div>}
            <div className="muted small">{toLocal(e.at)}</div>
          </div>
        </div>
      ))}
    </div>
  )
}

/** Unfreeze — reason plus an optional recovery plan. */
function UnfreezePrompt({
  busy,
  error,
  onSubmit,
  onClose,
}: {
  busy: boolean
  error: ApiErrorInfo | null
  onSubmit: (reason: string, resumePlan?: string) => void
  onClose: () => void
}) {
  const reasonRef = useRef<HTMLTextAreaElement>(null)
  const [resumePlan, setResumePlan] = useState('')

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
    onSubmit(reason, resumePlan.trim() || undefined)
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="Unfreeze shipment"
        onClick={(e) => e.stopPropagation()}
        onSubmit={handleSubmit}
      >
        <h3 className="modal-title">Unfreeze shipment</h3>
        <p className="muted small">
          Authorizes recovery and resumes movement. Releases a hold only after a second admin approves (release_hold).
        </p>
        <label className="field-label" htmlFor="unfreeze-reason">
          Reason
        </label>
        <textarea
          ref={reasonRef}
          id="unfreeze-reason"
          className="field"
          rows={3}
          maxLength={1000}
          required
          placeholder="Explain why this action is taken (audited)"
        />
        <label className="field-block">
          <span className="field-label">Resume plan</span>
          <textarea
            className="field"
            rows={2}
            maxLength={500}
            value={resumePlan}
            onChange={(e) => setResumePlan(e.target.value)}
            placeholder="Optional — how movement resumes"
          />
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

/** Reassign — reason plus an optional rider target. */
function ReassignPrompt({
  busy,
  error,
  onSubmit,
  onClose,
}: {
  busy: boolean
  error: ApiErrorInfo | null
  onSubmit: (reason: string, riderId?: string) => void
  onClose: () => void
}) {
  const reasonRef = useRef<HTMLTextAreaElement>(null)
  const [riderId, setRiderId] = useState('')

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
    onSubmit(reason, riderId.trim() || undefined)
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="Reassign shipment"
        onClick={(e) => e.stopPropagation()}
        onSubmit={handleSubmit}
      >
        <h3 className="modal-title">Reassign shipment</h3>
        <p className="muted small">Reassigns the shipment to a different rider or trip.</p>
        <label className="field-label" htmlFor="reassign-reason">
          Reason
        </label>
        <textarea
          ref={reasonRef}
          id="reassign-reason"
          className="field"
          rows={3}
          maxLength={500}
          required
          placeholder="Explain why this action is taken (audited)"
        />
        <label className="field-block">
          <span className="field-label">Rider ID</span>
          <input
            type="text"
            className="field"
            value={riderId}
            onChange={(e) => setRiderId(e.target.value)}
            placeholder="Optional rider to assign"
          />
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
