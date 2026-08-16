import { useEffect, useMemo, useState, type FormEvent } from 'react'
import {
  CarrierModesItem as CarrierModesConst,
  CarrierStatus as CarrierStatusConst,
  createCarrier,
  listCarriers,
  listConsignments,
  updateCarrier,
  type Carrier,
  type CarrierModesItem,
  type CarrierStatus,
  type Consignment,
  type ConsignmentStatus,
} from '@hudumika/contract'
import { DetailDrawer } from '../../components/DetailDrawer'
import { DataTable, type DataTableColumn } from '../../components/DataTable'
import { ErrorState } from '../../components/ErrorState'
import { Field, InlineError, Toast } from '../../components/FormBits'
import { FilterChips } from '../../components/FilterChips'
import { LoadingSkeleton } from '../../components/LoadingSkeleton'
import { StatusPill } from '../../components/StatusPill'
import { parseApiError } from '../../lib/api-error'
import { toLocal } from '../../lib/time'

type StatusFilter = 'all' | CarrierStatus

const STATUSES = Object.values(CarrierStatusConst)

const STATUS_OPTIONS: Array<{ key: StatusFilter; label: string }> = [
  { key: 'all', label: 'All' },
  ...STATUSES.map((s) => ({ key: s as StatusFilter, label: s })),
]

const MODES = new Set<string>(Object.values(CarrierModesConst))

const COLUMNS: DataTableColumn<Carrier>[] = [
  { key: 'name', header: 'Name', render: (c) => c.name, sortValue: (c) => c.name },
  {
    key: 'modes',
    header: 'Modes',
    render: (c) => (
      <>
        {(c.modes ?? []).map((m) => (
          <span key={m} className="tag">
            {m}
          </span>
        ))}
      </>
    ),
  },
  {
    key: 'regions',
    header: 'Regions',
    render: (c) =>
      (c.regions ?? []).length === 0 ? (
        '—'
      ) : (
        <>
          {(c.regions ?? []).map((r) => (
            <span key={r} className="tag">
              {r}
            </span>
          ))}
        </>
      ),
  },
  { key: 'api', header: 'API integration', render: (c) => c.apiIntegration ?? '—', className: 'mono' },
  { key: 'status', header: 'Status', render: (c) => <StatusPill status={c.status ?? '—'} tone={toneFor(c.status)} /> },
  { key: 'createdAt', header: 'Created', render: (c) => toLocal(c.createdAt), className: 'muted' },
]

function toneFor(status: CarrierStatus | undefined): 'ok' | 'warn' | 'bad' {
  if (status === 'active') return 'ok'
  if (status === 'paused') return 'warn'
  return 'bad'
}

function handoffTone(status: ConsignmentStatus): 'ok' | 'bad' | 'info' | 'warn' | 'brand' {
  if (status === 'delivered') return 'ok'
  if (status === 'cancelled') return 'bad'
  if (status === 'in_transit') return 'info'
  if (status === 'manifesting') return 'warn'
  return 'brand'
}

const HANDOFF_COLUMNS: DataTableColumn<Consignment>[] = [
  {
    key: 'consignmentNumber',
    header: 'Consignment',
    render: (c) => <span className="mono">{c.consignmentNumber}</span>,
  },
  { key: 'status', header: 'Status', render: (c) => <StatusPill status={c.status} tone={handoffTone(c.status)} /> },
  {
    key: 'corridor',
    header: 'Corridor',
    render: (c) => (
      <span className="mono">
        {c.fromHubId} → {c.toHubId}
      </span>
    ),
  },
  { key: 'scheduled', header: 'Scheduled departure', render: (c) => toLocal(c.scheduledDeparture), className: 'muted' },
  { key: 'arrived', header: 'Arrived', render: (c) => toLocal(c.arrivedAt), className: 'muted' },
]

function parseList(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

function parseModes(value: string): CarrierModesItem[] {
  return parseList(value).filter((m): m is CarrierModesItem => MODES.has(m))
}

interface CarrierForm {
  name: string
  modes: string
  status: CarrierStatus
}

export function CarriersPage() {
  const [carriers, setCarriers] = useState<Carrier[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [retryKey, setRetryKey] = useState(0)

  const [status, setStatus] = useState<StatusFilter>('all')
  const [selected, setSelected] = useState<Carrier | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [editTarget, setEditTarget] = useState<Carrier | null>(null)
  const [formBusy, setFormBusy] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  const [consignments, setConsignments] = useState<Consignment[] | null>(null)
  const [handoffError, setHandoffError] = useState<string | null>(null)
  const [handoffRetryKey, setHandoffRetryKey] = useState(0)
  const [handoffCarrier, setHandoffCarrier] = useState('')

  useEffect(() => {
    setError(null)
    setHandoffError(null)
    Promise.all([listCarriers(), listConsignments()]).then(([carriersRes, handoffsRes]) => {
      if (carriersRes.status === 200) setCarriers(carriersRes.data)
      else setError(parseApiError(carriersRes, 'Failed to load carriers').message)
      if (handoffsRes.status === 200) setConsignments(handoffsRes.data)
      else setHandoffError(parseApiError(handoffsRes, 'Failed to load handoffs').message)
    })
  }, [retryKey, handoffRetryKey])

  const statusCounts = useMemo(() => {
    const map: Partial<Record<StatusFilter, number>> = { all: carriers?.length ?? 0 }
    for (const s of STATUSES) map[s] = (carriers ?? []).filter((c) => c.status === s).length
    return map
  }, [carriers])

  const visible = useMemo(
    () => (carriers ?? []).filter((c) => status === 'all' || c.status === status),
    [carriers, status],
  )

  const handoffs = useMemo(() => {
    const assigned = (consignments ?? []).filter((c) => c.carrierId != null)
    if (!handoffCarrier) return assigned
    return assigned.filter((c) => c.carrierId === handoffCarrier)
  }, [consignments, handoffCarrier])

  function submitCreate(form: CarrierForm) {
    setFormBusy(true)
    setFormError(null)
    createCarrier({
      id: '',
      name: form.name.trim(),
      modes: parseModes(form.modes),
    }).then((res) => {
      if (res.status === 201) {
        setToast('Carrier created')
        setCreateOpen(false)
        setRetryKey((k) => k + 1)
      } else {
        setFormError(parseApiError(res, 'Could not create carrier').message)
      }
      setFormBusy(false)
    })
  }

  function submitEdit(form: CarrierForm) {
    if (!editTarget) return
    setFormBusy(true)
    setFormError(null)
    updateCarrier(editTarget.id, {
      id: editTarget.id,
      name: form.name.trim(),
      modes: parseModes(form.modes),
      status: form.status,
    }).then((res) => {
      if (res.status === 200) {
        setToast('Carrier updated')
        setSelected(res.data)
        setEditTarget(null)
        setRetryKey((k) => k + 1)
      } else {
        setFormError(parseApiError(res, 'Could not update carrier').message)
      }
      setFormBusy(false)
    })
  }

  if (error) {
    return <ErrorState title="Failed to load carriers" message={error} onRetry={() => setRetryKey((k) => k + 1)} />
  }
  if (!carriers) return <LoadingSkeleton kind="table" />

  return (
    <div className="page">
      <div className="page-title-row">
        <h1>Carriers</h1>
        {toast && (
          <div className="page-actions">
            <Toast message={toast} />
          </div>
        )}
      </div>

      <div className="toolbar">
        <FilterChips
          options={STATUS_OPTIONS}
          value={status}
          onChange={setStatus}
          counts={statusCounts}
          ariaLabel="Carrier status"
        />
        <button
          type="button"
          className="btn"
          onClick={() => {
            setToast(null)
            setFormError(null)
            setCreateOpen(true)
          }}
        >
          New carrier
        </button>
      </div>

      <DataTable
        rows={visible}
        columns={COLUMNS}
        rowKey={(c) => c.id}
        onRowClick={setSelected}
        exportable
        exportFileName="carriers"
        emptyTitle="No carriers"
        ariaLabel="Carriers"
      />

      <section>
        <h2>Handoff monitor</h2>
        <p className="muted small">
          Pickup/drop-off scans are recorded by the carrier (carrier.*); missing scans past SLA surface in the
          exception queue.
        </p>
        {consignments && consignments.length > 0 && (
          <div className="toolbar">
            <label className="field-label" htmlFor="handoff-carrier">
              Filter carrier
            </label>
            <select
              id="handoff-carrier"
              className="field"
              value={handoffCarrier}
              onChange={(e) => setHandoffCarrier(e.target.value)}
            >
              <option value="">All carriers</option>
              {carriers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
        )}
        {handoffError ? (
          <div className="inline-error" role="alert">
            {handoffError}{' '}
            <button type="button" className="btn" onClick={() => setHandoffRetryKey((k) => k + 1)}>
              Retry
            </button>
          </div>
        ) : consignments === null ? (
          <LoadingSkeleton kind="table" rows={3} />
        ) : (
          <div className="table-wrap">
            <DataTable
              rows={handoffs}
              columns={HANDOFF_COLUMNS}
              rowKey={(c) => c.id}
              emptyTitle="No handoffs for this carrier"
              ariaLabel="Handoffs"
            />
          </div>
        )}
      </section>

      {selected && (
        <CarrierDrawer
          carrier={selected}
          onClose={() => setSelected(null)}
          onEdit={(c) => {
            setToast(null)
            setFormError(null)
            setEditTarget(c)
          }}
        />
      )}

      {createOpen && (
        <CarrierFormModal
          initial={null}
          busy={formBusy}
          error={formError}
          onSubmit={submitCreate}
          onClose={() => {
            if (!formBusy) setCreateOpen(false)
          }}
        />
      )}

      {editTarget && (
        <CarrierFormModal
          initial={editTarget}
          busy={formBusy}
          error={formError}
          onSubmit={submitEdit}
          onClose={() => {
            if (!formBusy) setEditTarget(null)
          }}
        />
      )}
    </div>
  )
}

function CarrierDrawer({
  carrier,
  onClose,
  onEdit,
}: {
  carrier: Carrier
  onClose: () => void
  onEdit: (c: Carrier) => void
}) {
  return (
    <DetailDrawer title={carrier.name} onClose={onClose}>
      <div className="detail-section">
        <h3>Overview</h3>
        <div className="meta-grid">
          <div className="meta-item">
            <span className="meta-label">ID</span>
            <span className="meta-value mono">{carrier.id}</span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Name</span>
            <span className="meta-value">{carrier.name}</span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Modes</span>
            <span className="meta-value">
              {(carrier.modes ?? []).map((m) => (
                <span key={m} className="tag">
                  {m}
                </span>
              ))}
            </span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Regions</span>
            <span className="meta-value">
              {(carrier.regions ?? []).length === 0 ? (
                '—'
              ) : (
                <>
                  {(carrier.regions ?? []).map((r) => (
                    <span key={r} className="tag">
                      {r}
                    </span>
                  ))}
                </>
              )}
            </span>
          </div>
          <div className="meta-item">
            <span className="meta-label">API integration</span>
            <span className="meta-value mono">{carrier.apiIntegration ?? '—'}</span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Status</span>
            <span className="meta-value">
              <StatusPill status={carrier.status ?? '—'} tone={toneFor(carrier.status)} />
            </span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Created</span>
            <span className="meta-value">{toLocal(carrier.createdAt)}</span>
          </div>
        </div>
      </div>

      <div className="page-actions">
        <button type="button" className="btn" onClick={() => onEdit(carrier)}>
          Edit
        </button>
      </div>

      <p className="muted small">Carrier changes are audited (carrier.*); pausing stops new handoffs.</p>
    </DetailDrawer>
  )
}

function CarrierFormModal({
  initial,
  busy,
  error,
  onSubmit,
  onClose,
}: {
  initial: Carrier | null
  busy: boolean
  error: string | null
  onSubmit: (form: CarrierForm) => void
  onClose: () => void
}) {
  const editing = initial !== null
  const [form, setForm] = useState<CarrierForm>(() => ({
    name: initial?.name ?? '',
    modes: (initial?.modes ?? []).join(', '),
    status: initial?.status ?? 'active',
  }))

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (!form.name.trim() || parseModes(form.modes).length === 0) return
    onSubmit(form)
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={editing ? 'Edit carrier' : 'New carrier'}
        onClick={(e) => e.stopPropagation()}
        onSubmit={handleSubmit}
      >
        <h3 className="modal-title">{editing ? 'Edit carrier' : 'New carrier'}</h3>
        <div className="form-grid">
          <Field label="Name">
            <input
              className="field"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              required
              maxLength={120}
            />
          </Field>
          <Field label="Modes">
            <input
              className="field"
              value={form.modes}
              onChange={(e) => setForm({ ...form, modes: e.target.value })}
              required
              placeholder="e.g. van, linehaul_truck"
            />
          </Field>
          {editing && (
            <Field label="Status">
              <select
                className="field"
                value={form.status}
                onChange={(e) => setForm({ ...form, status: e.target.value as CarrierStatus })}
              >
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </Field>
          )}
        </div>
        {error && <InlineError message={error} />}
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn" disabled={busy}>
            {busy ? 'Working…' : editing ? 'Save changes' : 'Create carrier'}
          </button>
        </div>
      </form>
    </div>
  )
}
