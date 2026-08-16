import { useState, type FormEvent } from 'react'
import {
  getOrderWaybill,
  getShipmentCustody,
  type CustodyEntry,
  type WaybillEvent,
} from '@hudumika/contract'
import { EmptyState } from '../../components/EmptyState'
import { ErrorState } from '../../components/ErrorState'
import { InlineError } from '../../components/FormBits'
import { LoadingSkeleton } from '../../components/LoadingSkeleton'
import { ReasonPrompt } from '../../components/ReasonPrompt'
import { PENDING_ENDPOINT_CODE, pendingEndpointNotice } from '../../lib/pending-endpoints'
import { toLocal } from '../../lib/time'

type Tab = 'waybill' | 'custody'

export function WaybillPage() {
  const [tab, setTab] = useState<Tab>('waybill')
  return (
    <div className="page">
      <div className="page-title-row">
        <h1>Waybill &amp; Custody Audit</h1>
      </div>
      <div className="tabs" role="tablist" aria-label="Waybill and custody audit">
        <button type="button" className={`tab${tab === 'waybill' ? ' active' : ''}`} onClick={() => setTab('waybill')}>
          Order waybill
        </button>
        <button type="button" className={`tab${tab === 'custody' ? ' active' : ''}`} onClick={() => setTab('custody')}>
          Shipment custody
        </button>
      </div>
      {tab === 'waybill' ? <OrderWaybillTool /> : <ShipmentCustodyTool />}
    </div>
  )
}

function OrderWaybillTool() {
  const [orderId, setOrderId] = useState('')
  const [submittedId, setSubmittedId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notFound, setNotFound] = useState(false)
  const [events, setEvents] = useState<WaybillEvent[] | null>(null)
  const [validation, setValidation] = useState<string | null>(null)

  async function load(id: string) {
    setBusy(true)
    setError(null)
    setNotFound(false)
    setValidation(null)
    setEvents(null)
    const res = await getOrderWaybill(id)
    if (res.status === 200) {
      setEvents(res.data.events)
    } else {
      const status = res.status as number
      if (status === 404) setNotFound(true)
      else setError(`Failed to load waybill (${status})`)
    }
    setBusy(false)
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    const id = orderId.trim()
    if (!id) {
      setValidation('Order ID is required')
      return
    }
    setSubmittedId(id)
    void load(id)
  }

  const sorted = events ? [...events].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime()) : []

  return (
    <>
      <div className="state-card">
        <div className="state-title">Order waybill</div>
        <div className="state-message">Full scan and event trail for an order across all legs.</div>
      </div>

      <form className="form-grid" onSubmit={handleSubmit}>
        <label className="field-label" htmlFor="waybill-order-id">
          Order ID
        </label>
        <input
          id="waybill-order-id"
          className="field"
          aria-label="Order ID"
          value={orderId}
          onChange={(e) => setOrderId(e.target.value)}
          placeholder="Order ID"
          required
        />
        <div className="toolbar">
          <button type="submit" className="btn" disabled={busy}>
            {busy ? 'Loading…' : 'Load waybill'}
          </button>
        </div>
      </form>

      {validation && <InlineError message={validation} />}

      {error && <ErrorState title="Failed to load waybill" message={error} onRetry={() => void load(submittedId)} />}
      {notFound && <EmptyState title="Waybill not found" hint="No order matched this ID." />}
      {busy && <LoadingSkeleton kind="table" rows={4} />}
      {events && events.length === 0 && <EmptyState title="No waybill events recorded" />}
      {events && events.length > 0 && (
        <>
          <div className="timeline">
            {sorted.map((ev, i) => (
              <div key={i} className="timeline-item">
                <div className="timeline-dot" />
                <div>
                  <div className="small strong">{ev.type.replace(/_/g, ' ')}</div>
                  <div className="muted small">{ev.location}</div>
                  <div className="muted small">{ev.actor ?? '—'}</div>
                  <div className="muted small">{ev.note ?? '—'}</div>
                  <div className="muted small">{toLocal(ev.at)}</div>
                </div>
              </div>
            ))}
          </div>
          {events.some((ev) => ev.type === 'exception') && (
            <p className="muted small">Exception on this trail — open the shipment for damage-claim review</p>
          )}
        </>
      )}
      <p className="muted small">Waybill trails are append-only and audited (waybill.*).</p>
    </>
  )
}

function ShipmentCustodyTool() {
  const [shipmentId, setShipmentId] = useState('')
  const [submittedId, setSubmittedId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notFound, setNotFound] = useState(false)
  const [entries, setEntries] = useState<CustodyEntry[] | null>(null)
  const [validation, setValidation] = useState<string | null>(null)

  async function load(id: string) {
    setBusy(true)
    setError(null)
    setNotFound(false)
    setValidation(null)
    setEntries(null)
    const res = await getShipmentCustody(id)
    if (res.status === 200) {
      setEntries(res.data)
    } else {
      const status = res.status as number
      if (status === 404) setNotFound(true)
      else setError(`Failed to load custody (${status})`)
    }
    setBusy(false)
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    const id = shipmentId.trim()
    if (!id) {
      setValidation('Shipment ID is required')
      return
    }
    setSubmittedId(id)
    void load(id)
  }

  const sorted = entries ? [...entries].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime()) : []
  const sealBroken =
    entries?.some(
      (e) => e.eventType === 'handoff' && (e.evidence ?? '').toLowerCase().includes('seal'),
    ) ?? false

  return (
    <>
      <div className="state-card">
        <div className="state-title">Shipment custody</div>
        <div className="state-message">Custody ledger — every handoff and scan for the shipment's packages.</div>
      </div>

      <form className="form-grid" onSubmit={handleSubmit}>
        <label className="field-label" htmlFor="custody-shipment-id">
          Shipment ID
        </label>
        <input
          id="custody-shipment-id"
          className="field"
          aria-label="Shipment ID"
          value={shipmentId}
          onChange={(e) => setShipmentId(e.target.value)}
          placeholder="Shipment ID"
          required
        />
        <div className="toolbar">
          <button type="submit" className="btn" disabled={busy}>
            {busy ? 'Loading…' : 'Load custody'}
          </button>
        </div>
      </form>

      {validation && <InlineError message={validation} />}

      {error && <ErrorState title="Failed to load custody" message={error} onRetry={() => void load(submittedId)} />}
      {notFound && <EmptyState title="Custody not found" hint="No shipment matched this ID." />}
      {busy && <LoadingSkeleton kind="table" rows={4} />}
      {entries && entries.length === 0 && <EmptyState title="No custody entries recorded" />}
      {entries && entries.length > 0 && (
        <>
          <div className="timeline">
            {sorted.map((e) => (
              <div key={e.id} className="timeline-item">
                <div className="timeline-dot" />
                <div>
                  <div className="small strong">{e.eventType}</div>
                  <div className="muted small">
                    {e.actorType ? `${e.actorType}${e.actorId ? ` · ${e.actorId}` : ''}` : e.actorId ?? '—'}
                  </div>
                  <div className="muted small">{e.deviceId ? `device ${e.deviceId}` : '—'}</div>
                  {(e.previousState != null || e.newState != null) && (
                    <div className="mono small">
                      {e.previousState ?? '—'} → {e.newState ?? '—'}
                    </div>
                  )}
                  <div className="muted small">{e.evidence ?? '—'}</div>
                  <div className="muted small">{toLocal(e.at)}</div>
                </div>
              </div>
            ))}
          </div>
          {sealBroken && <SealBrokenCallout shipmentId={submittedId} />}
        </>
      )}
      <p className="muted small">
        Custody chains answer 'where was the package at time X'; damage claims anchor to the last intact-seal handoff
        (handoff.*).
      </p>
    </>
  )
}

type SealAction = 'reseal' | 'damage_claim'

function SealBrokenCallout({ shipmentId }: { shipmentId: string }) {
  const [prompt, setPrompt] = useState<SealAction | null>(null)
  const [pending, setPending] = useState<SealAction | null>(null)

  return (
    <>
      <div className="state-card">
        <div className="state-title">Seal-broken handoff</div>
        <div className="state-message">
          A handoff evidence record for {shipmentId} references a broken seal — resolve before further
          movement (handoff.*).
        </div>
        <div className="form-actions">
          <button
            type="button"
            className="btn"
            onClick={() => {
              setPending(null)
              setPrompt('reseal')
            }}
          >
            Re-seal
          </button>
          <button
            type="button"
            className="btn btn-danger"
            onClick={() => {
              setPending(null)
              setPrompt('damage_claim')
            }}
          >
            Damage claim
          </button>
        </div>
      </div>

      {pending && (
        <div className="state-card">
          <div className="state-title">
            <span className="mono">{PENDING_ENDPOINT_CODE}</span>
          </div>
          <div className="state-message">{pendingEndpointNotice('seal_broken_resolve')}</div>
          <p className="muted small">This action is documented for backend implementation — nothing was sent.</p>
        </div>
      )}

      {prompt === 'reseal' && (
        <ReasonPrompt
          title="Re-seal handoff"
          description={`Records that the package was re-sealed after the broken-seal handoff on ${shipmentId}.`}
          tone="danger"
          onSubmit={() => {
            setPending('reseal')
            setPrompt(null)
          }}
          onClose={() => setPrompt(null)}
        />
      )}
      {prompt === 'damage_claim' && (
        <ReasonPrompt
          title="Damage claim"
          description={`Registers a damage claim anchored to the broken-seal handoff on ${shipmentId}.`}
          tone="danger"
          onSubmit={() => {
            setPending('damage_claim')
            setPrompt(null)
          }}
          onClose={() => setPrompt(null)}
        />
      )}
    </>
  )
}
