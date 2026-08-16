import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  listConsignments,
  listDeliveryExceptions,
  reconcileConsignment,
  replanConsignment,
  type Consignment,
  type ConsignmentStatus,
  type DeliveryException,
} from '@hudumika/contract'
import { DetailDrawer } from '../../components/DetailDrawer'
import { EmptyState } from '../../components/EmptyState'
import { ErrorState } from '../../components/ErrorState'
import { Toast } from '../../components/FormBits'
import { LoadingSkeleton } from '../../components/LoadingSkeleton'
import { ReasonPrompt } from '../../components/ReasonPrompt'
import { StatusPill } from '../../components/StatusPill'
import { parseApiError, type ApiErrorInfo } from '../../lib/api-error'
import { toLocal } from '../../lib/time'

type Tab = 'outcomes' | 'anomalies'
type PromptMode = 'reconcile' | 'replan'

const GPS_ANOMALY_KINDS: string[] = [
  'scan_gps_mismatch',
  'scan_vehicle_static',
  'wrong_hub_scan',
  'scan_before_pickup',
]

function toneFor(status: ConsignmentStatus): 'ok' | 'bad' | 'info' | 'warn' | 'brand' {
  if (status === 'delivered') return 'ok'
  if (status === 'cancelled') return 'bad'
  if (status === 'in_transit') return 'info'
  if (status === 'manifesting') return 'warn'
  return 'brand'
}

function expectedCount(c: Consignment): number | null {
  if (c.orderCount != null) return c.orderCount
  if (c.manifest != null) return c.manifest.length
  return null
}

function scannedCount(c: Consignment): number | null {
  if (!c.manifest) return null
  return c.manifest.filter((m) => m.scannedIn || m.scannedOut).length
}

function missingCount(c: Consignment): number | null {
  const expected = expectedCount(c)
  const scanned = scannedCount(c)
  if (expected == null || scanned == null) return null
  return expected - scanned
}

function isTerminal(c: Consignment): boolean {
  return c.status === 'delivered' || c.status === 'cancelled'
}

export function ReconciliationPage() {
  const [tab, setTab] = useState<Tab>('outcomes')
  const [consignments, setConsignments] = useState<Consignment[] | null>(null)
  const [exceptions, setExceptions] = useState<DeliveryException[] | null>(null)
  const [selected, setSelected] = useState<Consignment | null>(null)
  const [selectedAnomaly, setSelectedAnomaly] = useState<DeliveryException | null>(null)
  const [promptMode, setPromptMode] = useState<PromptMode | null>(null)
  const [promptError, setPromptError] = useState<ApiErrorInfo | string | null>(null)
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [retryKey, setRetryKey] = useState(0)

  useEffect(() => {
    setError(null)
    Promise.all([listConsignments(), listDeliveryExceptions()]).then(([c, e]) => {
      if (c.status !== 200 || e.status !== 200) {
        setError(`Failed to load reconciliation data (${c.status === 200 ? e.status : c.status})`)
        return
      }
      setConsignments(c.data)
      setExceptions(e.data)
    })
  }, [retryKey])

  const anomalies = useMemo(
    () =>
      (exceptions ?? [])
        .filter((e) => GPS_ANOMALY_KINDS.includes(e.kind))
        .sort((a, b) => {
          const ar = a.status === 'resolved' ? 1 : 0
          const br = b.status === 'resolved' ? 1 : 0
          if (ar !== br) return ar - br
          return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
        }),
    [exceptions],
  )

  async function reconcile(_reason: string) {
    const target = selected
    if (!target) return
    setBusy(true)
    setPromptError(null)
    const scannedOrderIds = (target.manifest ?? [])
      .filter((m) => m.scannedIn || m.scannedOut)
      .map((m) => m.orderId)
    const res = await reconcileConsignment(target.id, { scannedOrderIds })
    if (res.status === 200) {
      setToast('Consignment reconciled')
      setPromptMode(null)
      setSelected(null)
      setRetryKey((k) => k + 1)
    } else {
      setPromptError(parseApiError(res))
    }
    setBusy(false)
  }

  async function replan(reason: string) {
    const target = selected
    if (!target) return
    setBusy(true)
    setPromptError(null)
    const res = await replanConsignment(target.id, { reason })
    if (res.status === 200) {
      setToast('Replan requested')
      setPromptMode(null)
      setSelected(null)
      setRetryKey((k) => k + 1)
    } else {
      setPromptError(parseApiError(res))
    }
    setBusy(false)
  }

  if (error) {
    return (
      <ErrorState title="Failed to load reconciliation data" message={error} onRetry={() => setRetryKey((k) => k + 1)} />
    )
  }
  if (!consignments || !exceptions) return <LoadingSkeleton kind="table" />
  if (consignments.length === 0)
    return (
      <div className="page">
        <div className="page-title-row">
          <h1>Reconciliation &amp; Custody Audit</h1>
        </div>
        <EmptyState title="No consignments to reconcile" />
      </div>
    )

  return (
    <div className="page">
      <div className="page-title-row">
        <h1>Reconciliation &amp; Custody Audit</h1>
        {toast && (
          <div className="page-actions">
            <Toast message={toast} />
          </div>
        )}
      </div>

      <div className="tabs" role="tablist" aria-label="Reconciliation and custody audit">
        <button
          type="button"
          className={`tab${tab === 'outcomes' ? ' active' : ''}`}
          onClick={() => setTab('outcomes')}
        >
          Reconcile outcomes
        </button>
        <button
          type="button"
          className={`tab${tab === 'anomalies' ? ' active' : ''}`}
          onClick={() => setTab('anomalies')}
        >
          Anomalies
        </button>
      </div>

      {tab === 'outcomes' ? (
        <OutcomesTable consignments={consignments} onSelect={setSelected} />
      ) : (
        <AnomaliesTable anomalies={anomalies} onSelect={setSelectedAnomaly} />
      )}

      <p className="muted small">
        {tab === 'outcomes'
          ? 'Reconciliation is audited (reconciliation.*); TRIP_CANNOT_CLOSE applies until matched.'
          : 'Anomalies are machine-fed and never resolved client-side (anomaly.*).'}
      </p>

      {selected && (
        <ConsignmentDrawer
          consignment={selected}
          onClose={() => setSelected(null)}
          onReconcile={() => {
            setToast(null)
            setPromptError(null)
            setPromptMode('reconcile')
          }}
          onReplan={() => {
            setToast(null)
            setPromptError(null)
            setPromptMode('replan')
          }}
        />
      )}

      {selectedAnomaly && <AnomalyDrawer exception={selectedAnomaly} onClose={() => setSelectedAnomaly(null)} />}

      {promptMode && selected && (
        <ReasonPrompt
          title={promptMode === 'reconcile' ? 'Reconcile consignment' : 'Replan consignment'}
          description={
            promptMode === 'reconcile'
              ? 'Re-run reconciliation after the found package is re-scanned; the reason is collected for the audit trail.'
              : 'Move the consignment to an alternate trip/vehicle; recorded as a trip approval (trip.*).'
          }
          busy={busy}
          error={promptError}
          onSubmit={(reason) => {
            if (promptMode === 'reconcile') void reconcile(reason)
            else void replan(reason)
          }}
          onClose={() => {
            setPromptMode(null)
            setPromptError(null)
          }}
        />
      )}
    </div>
  )
}

function OutcomesTable({
  consignments,
  onSelect,
}: {
  consignments: Consignment[]
  onSelect: (c: Consignment) => void
}) {
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>Consignment</th>
            <th>Corridor</th>
            <th>Status</th>
            <th>Expected</th>
            <th>Scanned</th>
            <th>Missing</th>
            <th>Trip closed</th>
          </tr>
        </thead>
        <tbody>
          {consignments.map((c) => (
            <tr key={c.id} className="row-click" onClick={() => onSelect(c)}>
              <td className="mono">{c.consignmentNumber}</td>
              <td className="mono">
                {c.fromHubId} → {c.toHubId}
              </td>
              <td>
                <StatusPill status={c.status} tone={toneFor(c.status)} />
              </td>
              <td>{expectedCount(c) ?? '—'}</td>
              <td>{scannedCount(c) ?? '—'}</td>
              <td>{missingCount(c) ?? '—'}</td>
              <td className="muted">—</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function AnomaliesTable({
  anomalies,
  onSelect,
}: {
  anomalies: DeliveryException[]
  onSelect: (e: DeliveryException) => void
}) {
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>ID</th>
            <th>Kind</th>
            <th>Severity</th>
            <th>Reference</th>
            <th>Resolved</th>
            <th>Created</th>
          </tr>
        </thead>
        <tbody>
          {anomalies.length === 0 && (
            <tr>
              <td colSpan={6} className="muted">
                <EmptyState title="No anomalies" />
              </td>
            </tr>
          )}
          {anomalies.map((e) => (
            <tr key={e.id} className="row-click" onClick={() => onSelect(e)}>
              <td className="mono">{e.id}</td>
              <td>
                <span className="tag">{e.kind.replace(/_/g, ' ')}</span>
              </td>
              <td>—</td>
              <td className="mono">{e.shipmentId ?? e.orderId ?? '—'}</td>
              <td>
                <StatusPill
                  status={e.status === 'resolved' ? 'resolved' : 'unresolved'}
                  tone={e.status === 'resolved' ? 'ok' : 'warn'}
                />
              </td>
              <td className="muted">{toLocal(e.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function ConsignmentDrawer({
  consignment,
  onClose,
  onReconcile,
  onReplan,
}: {
  consignment: Consignment
  onClose: () => void
  onReconcile: () => void
  onReplan: () => void
}) {
  const c = consignment
  const expected = expectedCount(c)
  const scanned = scannedCount(c)
  const missing = missingCount(c)
  return (
    <DetailDrawer title={<span className="mono-strong">{c.consignmentNumber}</span>} onClose={onClose}>
      <div className="meta-grid">
        <div className="meta-item">
          <span className="meta-label">ID</span>
          <span className="meta-value mono">{c.id}</span>
        </div>
        <div className="meta-item">
          <span className="meta-label">Consignment number</span>
          <span className="meta-value mono">{c.consignmentNumber}</span>
        </div>
        <div className="meta-item">
          <span className="meta-label">Status</span>
          <span className="meta-value">
            <StatusPill status={c.status} tone={toneFor(c.status)} />
          </span>
        </div>
        <div className="meta-item">
          <span className="meta-label">Corridor</span>
          <span className="meta-value mono">
            {c.fromHubId} → {c.toHubId}
          </span>
        </div>
        <div className="meta-item">
          <span className="meta-label">Transport mode</span>
          <span className="meta-value">
            <span className="tag">{c.transportMode}</span>
          </span>
        </div>
        <div className="meta-item">
          <span className="meta-label">Carrier</span>
          <span className="meta-value">{c.carrierId ?? '—'}</span>
        </div>
        <div className="meta-item">
          <span className="meta-label">Order count</span>
          <span className="meta-value">{c.orderCount ?? '—'}</span>
        </div>
        <div className="meta-item">
          <span className="meta-label">Expected</span>
          <span className="meta-value">{expected ?? '—'}</span>
        </div>
        <div className="meta-item">
          <span className="meta-label">Scanned</span>
          <span className="meta-value">{scanned ?? '—'}</span>
        </div>
        <div className="meta-item">
          <span className="meta-label">Missing</span>
          <span className="meta-value">{missing ?? '—'}</span>
        </div>
        <div className="meta-item">
          <span className="meta-label">Trip closed</span>
          <span className="meta-value">—</span>
        </div>
        <div className="meta-item">
          <span className="meta-label">Scheduled departure</span>
          <span className="meta-value">{toLocal(c.scheduledDeparture)}</span>
        </div>
        <div className="meta-item">
          <span className="meta-label">Departed</span>
          <span className="meta-value">{toLocal(c.departedAt)}</span>
        </div>
        <div className="meta-item">
          <span className="meta-label">Arrived</span>
          <span className="meta-value">{toLocal(c.arrivedAt)}</span>
        </div>
        <div className="meta-item">
          <span className="meta-label">Created by</span>
          <span className="meta-value">{c.createdBy ?? '—'}</span>
        </div>
        <div className="meta-item">
          <span className="meta-label">Created</span>
          <span className="meta-value">{toLocal(c.createdAt)}</span>
        </div>
      </div>

      {!isTerminal(c) && (
        <div className="detail-section">
          <h3>Actions</h3>
          <div className="form-actions">
            <button type="button" className="btn" onClick={onReconcile}>
              Reconcile
            </button>
            <button type="button" className="btn" onClick={onReplan}>
              Replan
            </button>
          </div>
        </div>
      )}

      <p className="muted small">
        Reconciliation is audited (reconciliation.*); TRIP_CANNOT_CLOSE applies until matched.
      </p>
    </DetailDrawer>
  )
}

function AnomalyDrawer({
  exception: e,
  onClose,
}: {
  exception: DeliveryException
  onClose: () => void
}) {
  return (
    <DetailDrawer title={<span className="mono-strong">{e.id}</span>} onClose={onClose}>
      <div className="meta-grid">
        <div className="meta-item">
          <span className="meta-label">ID</span>
          <span className="meta-value mono">{e.id}</span>
        </div>
        <div className="meta-item">
          <span className="meta-label">Kind</span>
          <span className="meta-value">
            <span className="tag">{e.kind.replace(/_/g, ' ')}</span>
          </span>
        </div>
        <div className="meta-item">
          <span className="meta-label">Status</span>
          <span className="meta-value">
            <StatusPill status={e.status} tone={e.status === 'resolved' ? 'ok' : 'warn'} />
          </span>
        </div>
        <div className="meta-item">
          <span className="meta-label">Shipment</span>
          <span className="meta-value mono">{e.shipmentId ?? '—'}</span>
        </div>
        <div className="meta-item">
          <span className="meta-label">Order</span>
          <span className="meta-value mono">{e.orderId ?? '—'}</span>
        </div>
        <div className="meta-item">
          <span className="meta-label">Trip</span>
          <span className="meta-value mono">{e.tripId ?? '—'}</span>
        </div>
        <div className="meta-item">
          <span className="meta-label">Description</span>
          <span className="meta-value">{e.description ?? '—'}</span>
        </div>
        <div className="meta-item">
          <span className="meta-label">Reported by</span>
          <span className="meta-value mono">{e.reportedBy ?? '—'}</span>
        </div>
        <div className="meta-item">
          <span className="meta-label">Outcome</span>
          <span className="meta-value">{e.outcome ?? '—'}</span>
        </div>
        <div className="meta-item">
          <span className="meta-label">Auto replanned</span>
          <span className="meta-value">{e.autoReplanned ? <span className="badge">replanned</span> : '—'}</span>
        </div>
        <div className="meta-item">
          <span className="meta-label">Created</span>
          <span className="meta-value">{toLocal(e.createdAt)}</span>
        </div>
        <div className="meta-item">
          <span className="meta-label">Resolved</span>
          <span className="meta-value">{toLocal(e.resolvedAt)}</span>
        </div>
      </div>

      <div className="detail-section">
        <h3>Actions</h3>
        <div className="form-actions">
          <Link className="btn" to="/operations/exceptions">
            Open exception
          </Link>
        </div>
      </div>

      <p className="muted small">Anomalies are machine-fed and never resolved client-side (anomaly.*).</p>
    </DetailDrawer>
  )
}
