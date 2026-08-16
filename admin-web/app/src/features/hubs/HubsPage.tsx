import { useEffect, useRef, useState } from 'react'
import { createHub, listHubs, type Hub } from '@hudumika/contract'
import { DataTable, type DataTableColumn } from '../../components/DataTable'
import { DetailDrawer } from '../../components/DetailDrawer'
import { ErrorState } from '../../components/ErrorState'
import { InlineError, Toast } from '../../components/FormBits'
import { LoadingSkeleton } from '../../components/LoadingSkeleton'
import { StatusPill } from '../../components/StatusPill'
import { parseApiError, type ApiErrorInfo } from '../../lib/api-error'
import { HubDashboardSection } from './HubDashboardPage'

const COLUMNS: DataTableColumn<Hub>[] = [
  { key: 'name', header: 'Name', render: (h) => h.name, sortValue: (h) => h.name },
  { key: 'city', header: 'City', render: (h) => h.cityId ?? '—' },
  { key: 'address', header: 'Address', render: (h) => h.address ?? '—' },
  { key: 'capacity', header: 'Capacity', render: (h) => h.capacity ?? '—', sortValue: (h) => h.capacity ?? null },
  {
    key: 'status',
    header: 'Status',
    render: (h) => <StatusPill status={h.active ? 'active' : 'inactive'} tone={h.active ? 'ok' : 'muted'} />,
  },
]

export function HubsPage() {
  const [hubs, setHubs] = useState<Hub[] | null>(null)
  const [selected, setSelected] = useState<Hub | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [retryKey, setRetryKey] = useState(0)

  useEffect(() => {
    setError(null)
    listHubs().then((res) => {
      if (res.status === 200) setHubs(res.data)
      else setError(`Failed to load hubs (${res.status})`)
    })
  }, [retryKey])

  if (error) {
    return <ErrorState title="Failed to load hubs" message={error} onRetry={() => setRetryKey((k) => k + 1)} />
  }
  if (!hubs) return <LoadingSkeleton kind="table" />

  return (
    <div className="page">
      <div className="page-title-row">
        <h1>Hubs</h1>
        <button type="button" className="btn" onClick={() => setCreating(true)}>
          New hub
        </button>
      </div>
      {notice && <Toast message={notice} />}
      <DataTable
        rows={hubs}
        columns={COLUMNS}
        rowKey={(h) => h.id}
        onRowClick={setSelected}
        exportable
        exportFileName="hubs"
        emptyTitle="No hubs"
        ariaLabel="Hubs"
      />

      {selected && <HubDrawer hub={selected} onClose={() => setSelected(null)} />}
      {creating && (
        <CreateHubModal
          onClose={() => setCreating(false)}
          onCreated={() => {
            setNotice('Hub created')
            setCreating(false)
            setRetryKey((k) => k + 1)
          }}
        />
      )}
    </div>
  )
}

function HubDrawer({ hub, onClose }: { hub: Hub; onClose: () => void }) {
  return (
    <DetailDrawer title={<span className="mono-strong">{hub.id}</span>} onClose={onClose}>
      <div className="meta-grid">
        <div className="meta-item">
          <span className="meta-label">ID</span>
          <span className="meta-value mono">{hub.id}</span>
        </div>
        <div className="meta-item">
          <span className="meta-label">Name</span>
          <span className="meta-value">{hub.name}</span>
        </div>
        <div className="meta-item">
          <span className="meta-label">City</span>
          <span className="meta-value">{hub.cityId ?? '—'}</span>
        </div>
        <div className="meta-item">
          <span className="meta-label">Address</span>
          <span className="meta-value">{hub.address ?? '—'}</span>
        </div>
        <div className="meta-item">
          <span className="meta-label">Capacity</span>
          <span className="meta-value">{hub.capacity ?? '—'}</span>
        </div>
        <div className="meta-item">
          <span className="meta-label">Status</span>
          <span className="meta-value">
            <StatusPill status={hub.active ? 'active' : 'inactive'} tone={hub.active ? 'ok' : 'muted'} />
          </span>
        </div>
      </div>

      <h3>Operations dashboard</h3>
      <HubDashboardSection hubId={hub.id} />
    </DetailDrawer>
  )
}

function CreateHubModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState('')
  const [city, setCity] = useState('')
  const [address, setAddress] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<ApiErrorInfo | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim() || !city.trim()) return
    setBusy(true)
    setError(null)
    const res = await createHub({
      id: `hub_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
      name: name.trim(),
      cityId: city.trim(),
      address: address.trim() || undefined,
    })
    if (res.status === 201) {
      onCreated()
    } else {
      setError(parseApiError(res, 'Create failed'))
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="New hub"
        onClick={(e) => e.stopPropagation()}
        onSubmit={handleSubmit}
      >
        <h3 className="modal-title">New hub</h3>
        <p className="muted small">Create a consolidation hub (city sorting center).</p>
        <div className="form-grid">
          <label className="field-block">
            <span className="field-label">Name</span>
            <input
              ref={inputRef}
              className="field"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Kinondoni Hub"
              required
              aria-required="true"
            />
          </label>
          <label className="field-block">
            <span className="field-label">City</span>
            <input
              className="field"
              value={city}
              onChange={(e) => setCity(e.target.value)}
              placeholder="city_…"
              required
              aria-required="true"
            />
          </label>
          <label className="field-block">
            <span className="field-label">Address</span>
            <input
              className="field"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="Optional street address"
            />
          </label>
        </div>
        {error && (
          <>
            <InlineError message={error.message} />
            <p className="muted small">{error.code}</p>
          </>
        )}
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn" disabled={busy}>
            {busy ? 'Creating…' : 'Create'}
          </button>
        </div>
      </form>
    </div>
  )
}
