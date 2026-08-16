import { useEffect, useMemo, useState } from 'react'
import {
  ConsignmentStatus,
  getConsignment,
  listConsignments,
  type Consignment,
  type ConsignmentStatus as Status,
} from '@hudumika/contract'
import { DetailDrawer } from '../../components/DetailDrawer'
import { DataTable, type DataTableColumn } from '../../components/DataTable'
import { EmptyState } from '../../components/EmptyState'
import { ErrorState } from '../../components/ErrorState'
import { LoadingSkeleton } from '../../components/LoadingSkeleton'
import { ReasonPrompt } from '../../components/ReasonPrompt'
import { StatusPill } from '../../components/StatusPill'
import { PENDING_ENDPOINT_CODE, pendingEndpointNotice } from '../../lib/pending-endpoints'
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
 * Module-spec state: seal integrity lives on handoffs (WORKFLOWS.md #22), which
 * the consignment endpoints do not expose yet. The queue is intentionally empty
 * until the handoff endpoint lands — never fabricated.
 */
const SEAL_BROKEN_INCIDENTS: Array<{ consignmentNumber: string; handoffId: string }> = []

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
  const [resolvedId, setResolvedId] = useState<string | null>(null)

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
                      setResolvedId(null)
                      setResolveTarget(row)
                    }}
                  >
                    Resolve
                  </button>
                  <span className="muted small">Resolved via the consignment runbook (workflow 21)</span>
                </div>
                {resolvedId === row.consignment.id && (
                  <div className="state-card">
                    <div className="state-title">
                      <span className="mono">{PENDING_ENDPOINT_CODE}</span>
                    </div>
                    <div className="state-message">{pendingEndpointNotice('consignment_missing_resolve')}</div>
                    <p className="muted small">This action is documented for backend implementation — nothing was sent.</p>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="queue">
        <h2>Seal-broken incidents</h2>
        {SEAL_BROKEN_INCIDENTS.length === 0 ? (
          <EmptyState title="No seal-broken incidents" hint="Seal integrity data lands with the handoffs endpoint." />
        ) : (
          <div className="queue-list">
            {SEAL_BROKEN_INCIDENTS.map((inc) => (
              <div key={inc.handoffId} className="queue-item">
                <div className="queue-main">
                  <div className="mono-strong">{inc.consignmentNumber}</div>
                </div>
                <div className="queue-actions">
                  <span className="muted small">Resolved via the consignment runbook (workflow 22)</span>
                </div>
              </div>
            ))}
          </div>
        )}
        <p className="muted small">Resolved via the consignment runbook (workflow 22).</p>
      </section>

      {resolveTarget && (
        <ReasonPrompt
          title="Resolve missing orders"
          description={`${resolveTarget.consignment.consignmentNumber} — ${resolveTarget.waybills.length} waybill(s) were never scanned in.`}
          tone="danger"
          onSubmit={() => {
            setResolvedId(resolveTarget.consignment.id)
            setResolveTarget(null)
          }}
          onClose={() => setResolveTarget(null)}
        />
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
