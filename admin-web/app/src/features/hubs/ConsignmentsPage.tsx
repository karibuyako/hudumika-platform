import { useEffect, useMemo, useState } from 'react'
import {
  ConsignmentStatus,
  adminConsignmentMissingDecision,
  adminListHandoffs,
  getConsignment,
  listConsignments,
  type Consignment,
  type ConsignmentStatus as Status,
  type AdminHandoff,
} from '@hudumika/contract'
import { DetailDrawer } from '../../components/DetailDrawer'
import { DataTable, type DataTableColumn } from '../../components/DataTable'
import { EmptyState } from '../../components/EmptyState'
import { ErrorState } from '../../components/ErrorState'
import { LoadingSkeleton } from '../../components/LoadingSkeleton'
import { StatusPill } from '../../components/StatusPill'
import { Toast } from '../../components/FormBits'
import { parseApiError, type ApiErrorInfo } from '../../lib/api-error'
import { toLocal } from '../../lib/time'

type Bucket = 'all' | Status

const STATUSES: Status[] = Object.values(ConsignmentStatus)

const BUCKETS: Bucket[] = ['all', ...STATUSES]

const MISSING_ORDER_CANDIDATE_STATUSES: Status[] = ['in_transit', 'at_hub']
const MISSING_ORDER_DETAIL_CAP = 10

interface MissingOrderRow {
  consignment: Consignment
  waybills: string[]
}

/**
 * Seal-broken incidents are derived from consignments whose manifest has been
 * loaded and contain unscanned items — indicating a potential seal-broken handoff.
 * The admin can then resolve via the handoff seal endpoint.
 */
function findSealBrokenIncidents(consignments: Consignment[], details: Map<string, Consignment>): Array<{ consignmentNumber: string; handoffId: string; consignmentId: string }> {
  const incidents: Array<{ consignmentNumber: string; handoffId: string; consignmentId: string }> = []
  for (const c of consignments) {
    if (c.status === 'delivered' || c.status === 'cancelled') continue
    const manifest = c.manifest && c.manifest.length > 0 ? c.manifest : details.get(c.id)?.manifest
    if (!manifest || manifest.length === 0) continue
    const unscanned = manifest.filter((m) => m.scannedIn === false)
    if (unscanned.length > 0) {
      incidents.push({
        consignmentNumber: c.consignmentNumber,
        handoffId: c.id,
        consignmentId: c.id,
      })
    }
  }
  return incidents
}

function toneFor(status: Status): 'ok' | 'bad' | 'info' | 'warn' | 'brand' {
  if (status === 'delivered') return 'ok'
  if (status === 'cancelled') return 'bad'
  if (status === 'in_transit') return 'info'
  if (status === 'manifesting') return 'warn'
  return 'brand'
}

const COLUMNS: DataTableColumn<Consignment>[] = [
  { key: 'id', header: 'ID', render: (c) => c.id, className: 'mono' },
  {
    key: 'corridor',
    header: 'Corridor',
    render: (c) => (
      <span className="mono">
        {c.fromHubId} → {c.toHubId}
      </span>
    ),
  },
  { key: 'mode', header: 'Mode', render: (c) => <span className="tag">{c.transportMode}</span> },
  { key: 'carrier', header: 'Carrier', render: (c) => c.carrierId ?? '—' },
  { key: 'orders', header: 'Orders', render: (c) => c.orderCount ?? '—', sortValue: (c) => c.orderCount ?? null },
  { key: 'status', header: 'Status', render: (c) => <StatusPill status={c.status} tone={toneFor(c.status)} /> },
  { key: 'scheduled', header: 'Scheduled departure', render: (c) => toLocal(c.scheduledDeparture), className: 'muted' },
  { key: 'departed', header: 'Departed', render: (c) => toLocal(c.departedAt), className: 'muted' },
  { key: 'arrived', header: 'Arrived', render: (c) => toLocal(c.arrivedAt), className: 'muted' },
]

export function ConsignmentsPage() {
  const [consignments, setConsignments] = useState<Consignment[] | null>(null)
  const [bucket, setBucket] = useState<Bucket>('all')
  const [selected, setSelected] = useState<Consignment | null>(null)
  const [details, setDetails] = useState<Map<string, Consignment>>(() => new Map())
  const [error, setError] = useState<string | null>(null)
  const [retryKey, setRetryKey] = useState(0)
  const [resolveTarget, setResolveTarget] = useState<MissingOrderRow | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [consignmentDecision, setConsignmentDecision] = useState<'relocate' | 'declare_lost'>('relocate')
  const [consignmentReason, setConsignmentReason] = useState('')
  const [consignmentBusy, setConsignmentBusy] = useState(false)
  const [consignmentError, setConsignmentError] = useState<ApiErrorInfo | null>(null)

  useEffect(() => {
    setError(null)
    listConsignments().then((res) => {
      if (res.status === 200) setConsignments(res.data)
      else setError(`Failed to load consignments (${res.status})`)
    })
  }, [retryKey])

  useEffect(() => {
    if (!consignments) return
    const pending: string[] = []
    for (const c of consignments) {
      if (!MISSING_ORDER_CANDIDATE_STATUSES.includes(c.status)) continue
      if (c.manifest && c.manifest.length > 0) continue
      if (pending.length >= MISSING_ORDER_DETAIL_CAP) break
      pending.push(c.id)
    }
    if (pending.length === 0) return
    let cancelled = false
    for (const id of pending) {
      getConsignment(id).then((res) => {
        if (cancelled) return
        if (res.status === 200) setDetails((prev) => new Map(prev).set(id, res.data))
      })
    }
    return () => {
      cancelled = true
    }
  }, [consignments])

  const counts = useMemo(() => {
    if (!consignments) return new Map<string, number>()
    const map = new Map<string, number>()
    map.set('all', consignments.length)
    for (const s of STATUSES) map.set(s, consignments.filter((c) => c.status === s).length)
    return map
  }, [consignments])

  const visible = useMemo(
    () => (consignments ?? []).filter((c) => bucket === 'all' || c.status === bucket),
    [consignments, bucket],
  )

  const missingRows = useMemo<MissingOrderRow[]>(() => {
    if (!consignments) return []
    const rows: MissingOrderRow[] = []
    for (const c of consignments) {
      if (!MISSING_ORDER_CANDIDATE_STATUSES.includes(c.status)) continue
      const manifest =
        c.manifest && c.manifest.length > 0 ? c.manifest : details.get(c.id)?.manifest
      if (!manifest || manifest.length === 0) continue
      const waybills = manifest.filter((m) => m.scannedIn === false).map((m) => m.waybillNumber)
      if (waybills.length > 0) rows.push({ consignment: c, waybills })
    }
    return rows
  }, [consignments, details])

  async function handleConsignmentResolve(reason: string) {
    if (!resolveTarget) return
    setConsignmentBusy(true)
    setConsignmentError(null)
    const res = await adminConsignmentMissingDecision(resolveTarget.consignment.id, { decision: consignmentDecision, reason })
    setConsignmentBusy(false)
    if (res.status === 200) {
      setToast(`Consignment ${consignmentDecision === 'relocate' ? 'relocated' : 'declared lost'}`)
      setResolveTarget(null)
    } else {
      setConsignmentError(parseApiError(res, 'Resolve failed'))
    }
  }

  if (error) {
    return (
      <ErrorState
        title="Failed to load consignments"
        message={error}
        onRetry={() => setRetryKey((k) => k + 1)}
      />
    )
  }
  if (!consignments) return <LoadingSkeleton kind="table" />

  return (
    <div className="page">
      <div className="page-title-row">
        <h1>Consignments</h1>
        {toast && (
          <div className="page-actions">
            <Toast message={toast} />
          </div>
        )}
      </div>
      <div className="filters">
        {BUCKETS.map((b) => (
          <button
            key={b}
            type="button"
            className={`chip${bucket === b ? ' active' : ''}`}
            aria-pressed={bucket === b}
            onClick={() => setBucket(b)}
          >
            {b === 'all' ? 'All' : b.replace(/_/g, ' ')} <span className="chip-count">{counts.get(b) ?? 0}</span>
          </button>
        ))}
      </div>

      <DataTable
        rows={visible}
        columns={COLUMNS}
        rowKey={(c) => c.id}
        onRowClick={setSelected}
        exportable
        exportFileName="consignments"
        emptyTitle={consignments.length === 0 ? 'No consignments found' : 'No consignments in this bucket'}
        ariaLabel="Consignments"
      />

      <section className="queue">
        <h2>Missing-order queue</h2>
        <p className="muted small">Waybills on the manifest that were never scanned in.</p>
        {missingRows.length === 0 ? (
          <EmptyState title="No missing orders" hint="Consignments without scan gaps appear here." />
        ) : (
          <div className="queue-list">
            {missingRows.map((row) => (
              <div key={row.consignment.id} className="queue-item">
                <div className="queue-main">
                  <div className="mono-strong">{row.consignment.consignmentNumber}</div>
                  <div className="muted mono small">{row.waybills.join(', ')}</div>
                </div>
                <div className="queue-actions">
                  <button
                    type="button"
                    className="btn btn-danger"
                    onClick={() => {
                      setConsignmentError(null)
                      setResolveTarget(row)
                    }}
                  >
                    Resolve
                  </button>
                  <span className="muted small">Resolved via the consignment runbook (workflow 21)</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="queue">
        <h2>Seal-broken incidents</h2>
        {(() => {
          const incidents = findSealBrokenIncidents(consignments, details)
          if (incidents.length === 0) {
            return <EmptyState title="No seal-broken incidents" hint="No unscanned handoffs detected in active consignments." />
          }
          return (
            <div className="queue-list">
              {incidents.map((inc) => (
                <div key={inc.handoffId} className="queue-item">
                  <div className="queue-main">
                    <div className="mono-strong">{inc.consignmentNumber}</div>
                    <div className="muted small">Handoff ID: {inc.handoffId}</div>
                  </div>
                  <div className="queue-actions">
                    <span className="muted small">Resolve via handoff seal endpoint</span>
                  </div>
                </div>
              ))}
            </div>
          )
        })()}
        <p className="muted small">Resolved via the consignment runbook (workflow 22).</p>
      </section>

      <HandoffsSection />

      {resolveTarget && (
        <div className="modal-backdrop" onClick={() => !consignmentBusy && setResolveTarget(null)}>
          <form
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label="Resolve missing orders"
            onClick={(e) => e.stopPropagation()}
            onSubmit={(e) => {
              e.preventDefault()
              if (!consignmentReason.trim()) {
                setConsignmentError({ code: 'ADMIN_REASON_REQUIRED', message: 'reason is required', retriable: false } as ApiErrorInfo)
                return
              }
              void handleConsignmentResolve(consignmentReason.trim())
            }}
          >
            <h3 className="modal-title">Resolve missing orders</h3>
            <p className="muted small">
              {resolveTarget.consignment.consignmentNumber} — {resolveTarget.waybills.length} waybill(s) were never scanned in.
            </p>
            <label className="field-label" htmlFor="consignment-decision">
              Decision
            </label>
            <select
              id="consignment-decision"
              className="field"
              value={consignmentDecision}
              onChange={(e) => setConsignmentDecision(e.target.value as 'relocate' | 'declare_lost')}
            >
              <option value="relocate">relocate — place on next corridor</option>
              <option value="declare_lost">declare_lost — open damage claim</option>
            </select>
            <label className="field-label" htmlFor="consignment-reason">
              Reason
            </label>
            <textarea
              id="consignment-reason"
              className="field"
              rows={3}
              maxLength={500}
              required
              value={consignmentReason}
              onChange={(e) => setConsignmentReason(e.target.value)}
              placeholder="Explain why this action is taken (audited)"
            />
            {consignmentError && (
              <div className="inline-error" role="alert">
                <div>{consignmentError.message}</div>
                <div className="muted small">
                  {consignmentError.code}
                  {consignmentError.requestId ? ` · request ${consignmentError.requestId}` : ''}
                </div>
              </div>
            )}
            <div className="modal-actions">
              <button type="button" className="btn btn-ghost" onClick={() => setResolveTarget(null)} disabled={consignmentBusy}>
                Cancel
              </button>
              <button type="submit" className="btn btn-danger" disabled={consignmentBusy}>
                {consignmentBusy ? 'Working…' : 'Confirm'}
              </button>
            </div>
          </form>
        </div>
      )}

      {selected && <ConsignmentDrawer consignment={selected} onClose={() => setSelected(null)} />}
    </div>
  )
}

function ConsignmentDrawer({ consignment, onClose }: { consignment: Consignment; onClose: () => void }) {
  return (
    <DetailDrawer title={<span className="mono-strong">{consignment.id}</span>} onClose={onClose}>
      <div className="meta-grid">
        <div className="meta-item">
          <span className="meta-label">ID</span>
          <span className="meta-value mono">{consignment.id}</span>
        </div>
        <div className="meta-item">
          <span className="meta-label">Status</span>
          <span className="meta-value">
            <StatusPill status={consignment.status} tone={toneFor(consignment.status)} />
          </span>
        </div>
        <div className="meta-item">
          <span className="meta-label">Corridor</span>
          <span className="meta-value mono">
            {consignment.fromHubId} → {consignment.toHubId}
          </span>
        </div>
        <div className="meta-item">
          <span className="meta-label">Transport mode</span>
          <span className="meta-value">
            <span className="tag">{consignment.transportMode}</span>
          </span>
        </div>
        <div className="meta-item">
          <span className="meta-label">Carrier</span>
          <span className="meta-value">{consignment.carrierId ?? '—'}</span>
        </div>
        <div className="meta-item">
          <span className="meta-label">Order count</span>
          <span className="meta-value">{consignment.orderCount ?? '—'}</span>
        </div>
        <div className="meta-item">
          <span className="meta-label">Scheduled departure</span>
          <span className="meta-value">{toLocal(consignment.scheduledDeparture)}</span>
        </div>
        <div className="meta-item">
          <span className="meta-label">Departed</span>
          <span className="meta-value">{toLocal(consignment.departedAt)}</span>
        </div>
        <div className="meta-item">
          <span className="meta-label">Arrived</span>
          <span className="meta-value">{toLocal(consignment.arrivedAt)}</span>
        </div>
      </div>
      <p className="muted small">
        Missing-order and seal-broken incidents are resolved through the consignment runbooks; resolutions are
        audited (consignment.*).
      </p>
    </DetailDrawer>
  )
}

function HandoffsSection() {
  const [handoffs, setHandoffs] = useState<AdminHandoff[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  if (handoffs === null && !error) {
    return (
      <section className="queue">
        <h2>Handoff incidents</h2>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => {
            adminListHandoffs({}).then((res) => {
              if (res.status === 200) setHandoffs(res.data)
              else setError('Failed to load handoffs')
            })
          }}
        >
          Load handoffs
        </button>
      </section>
    )
  }

  return (
    <section className="queue">
      <h2>Handoff incidents</h2>
      {error && <p className="muted small">{error}</p>}
      {handoffs && handoffs.length === 0 && <EmptyState title="No handoffs" hint="No handoff incidents recorded." />}
      {handoffs && handoffs.length > 0 && (
        <div className="queue-list">
          {handoffs.map((h) => (
            <div key={h.id} className="queue-item">
              <div className="queue-main">
                <div className="mono-strong">{h.id}</div>
                <div className="muted small">{h.fromHubId} → {h.toHubId ?? '—'}</div>
                <div className="muted small">{h.carrierId ? `Carrier: ${h.carrierId}` : '—'}</div>
              </div>
              <div className="queue-actions">
                <StatusPill status={h.resolvedAt ? 'resolved' : 'open'} tone={h.resolvedAt ? 'ok' : 'warn'} />
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
