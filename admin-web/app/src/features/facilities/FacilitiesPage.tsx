import { useEffect, useMemo, useState, type FormEvent } from 'react'
import {
  FacilityAccessPolicy as FacilityAccessPolicyConst,
  createFacility,
  listFacilities,
  putFacilityWhitelist,
  type Facility,
  type FacilityAccessPolicy,
} from '@hudumika/contract'
import { DetailDrawer } from '../../components/DetailDrawer'
import { DataTable, type DataTableColumn } from '../../components/DataTable'
import { ErrorState } from '../../components/ErrorState'
import { Field, InlineError, Toast } from '../../components/FormBits'
import { FilterChips } from '../../components/FilterChips'
import { LoadingSkeleton } from '../../components/LoadingSkeleton'
import { parseApiError } from '../../lib/api-error'
import { toLocal } from '../../lib/time'

type PolicyFilter = 'all' | FacilityAccessPolicy

const POLICIES = Object.values(FacilityAccessPolicyConst)

const POLICY_OPTIONS: Array<{ key: PolicyFilter; label: string }> = [
  { key: 'all', label: 'All' },
  ...POLICIES.map((p) => ({ key: p as PolicyFilter, label: p })),
]

function parseList(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

function parseGeofence(value: string): string[] {
  const tokens = parseList(value)
  const pairs: string[] = []
  for (let i = 0; i + 1 < tokens.length; i += 2) pairs.push(`${tokens[i]},${tokens[i + 1]}`)
  return pairs
}

function geofenceLabel(f: Facility): string {
  const n = f.geofence?.length ?? 0
  return n === 0 ? '—' : `${n} vertices`
}

function whitelistCount(f: Facility): string {
  const n = f.whitelistRiderIds?.length ?? 0
  return n === 0 ? '—' : String(n)
}

const COLUMNS: DataTableColumn<Facility>[] = [
  { key: 'name', header: 'Name', render: (f) => f.name, sortValue: (f) => f.name },
  { key: 'address', header: 'Address', render: (f) => f.address },
  { key: 'policy', header: 'Access policy', render: (f) => <span className="tag">{f.accessPolicy ?? '—'}</span> },
  { key: 'riders', header: 'Whitelisted riders', render: (f) => whitelistCount(f) },
  { key: 'geofence', header: 'Geofence', render: (f) => geofenceLabel(f) },
  { key: 'createdAt', header: 'Created', render: (f) => toLocal(f.createdAt), className: 'muted' },
]

interface FacilityForm {
  name: string
  address: string
  accessPolicy: FacilityAccessPolicy
  geofence: string
}

export function FacilitiesPage() {
  const [facilities, setFacilities] = useState<Facility[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [retryKey, setRetryKey] = useState(0)

  const [policy, setPolicy] = useState<PolicyFilter>('all')
  const [selected, setSelected] = useState<Facility | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [formBusy, setFormBusy] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  useEffect(() => {
    setError(null)
    listFacilities().then((res) => {
      if (res.status === 200) setFacilities(res.data)
      else setError(parseApiError(res, 'Failed to load facilities').message)
    })
  }, [retryKey])

  const policyCounts = useMemo(() => {
    const map: Partial<Record<PolicyFilter, number>> = { all: facilities?.length ?? 0 }
    for (const p of POLICIES) map[p] = (facilities ?? []).filter((f) => f.accessPolicy === p).length
    return map
  }, [facilities])

  const visible = useMemo(
    () => (facilities ?? []).filter((f) => policy === 'all' || f.accessPolicy === policy),
    [facilities, policy],
  )

  function submitCreate(form: FacilityForm) {
    setFormBusy(true)
    setFormError(null)
    const geofence = parseGeofence(form.geofence)
    createFacility({
      id: '',
      name: form.name.trim(),
      address: form.address.trim(),
      accessPolicy: form.accessPolicy,
      ...(geofence.length ? { geofence } : {}),
    }).then((res) => {
      if (res.status === 201) {
        setToast('Facility created')
        setCreateOpen(false)
        setRetryKey((k) => k + 1)
      } else {
        setFormError(parseApiError(res, 'Could not create facility').message)
      }
      setFormBusy(false)
    })
  }

  if (error) {
    return <ErrorState title="Failed to load facilities" message={error} onRetry={() => setRetryKey((k) => k + 1)} />
  }
  if (!facilities) return <LoadingSkeleton kind="table" />

  return (
    <div className="page">
      <div className="page-title-row">
        <h1>Facilities</h1>
        {toast && (
          <div className="page-actions">
            <Toast message={toast} />
          </div>
        )}
      </div>

      <div className="toolbar">
        <FilterChips
          options={POLICY_OPTIONS}
          value={policy}
          onChange={setPolicy}
          counts={policyCounts}
          ariaLabel="Access policy"
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
          New facility
        </button>
      </div>

      <DataTable
        rows={visible}
        columns={COLUMNS}
        rowKey={(f) => f.id}
        onRowClick={setSelected}
        exportable
        exportFileName="facilities"
        emptyTitle="No facilities"
        ariaLabel="Facilities"
      />

      {selected && (
        <FacilityDrawer
          facility={selected}
          onClose={() => setSelected(null)}
          onToast={setToast}
          onListChanged={() => setRetryKey((k) => k + 1)}
        />
      )}

      {createOpen && (
        <FacilityFormModal
          busy={formBusy}
          error={formError}
          onSubmit={submitCreate}
          onClose={() => {
            if (!formBusy) setCreateOpen(false)
          }}
        />
      )}
    </div>
  )
}

function FacilityDrawer({
  facility,
  onClose,
  onToast,
  onListChanged,
}: {
  facility: Facility
  onClose: () => void
  onToast: (message: string) => void
  onListChanged: () => void
}) {
  const [whitelistOpen, setWhitelistOpen] = useState(false)
  const [whitelistBusy, setWhitelistBusy] = useState(false)
  const [whitelistError, setWhitelistError] = useState<string | null>(null)

  function submitWhitelist(riderIds: string[]) {
    setWhitelistBusy(true)
    setWhitelistError(null)
    putFacilityWhitelist(facility.id, { riderIds }).then((res) => {
      if (res.status === 200) {
        onToast('Whitelist updated')
        onListChanged()
        setWhitelistOpen(false)
      } else {
        setWhitelistError(parseApiError(res, 'Could not update whitelist').message)
      }
      setWhitelistBusy(false)
    })
  }

  return (
    <DetailDrawer title={facility.name} onClose={onClose}>
      <div className="detail-section">
        <h3>Overview</h3>
        <div className="meta-grid">
          <div className="meta-item">
            <span className="meta-label">ID</span>
            <span className="meta-value mono">{facility.id}</span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Name</span>
            <span className="meta-value">{facility.name}</span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Address</span>
            <span className="meta-value">{facility.address}</span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Access policy</span>
            <span className="meta-value">
              <span className="tag">{facility.accessPolicy ?? '—'}</span>
            </span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Geofence</span>
            <span className="meta-value">{geofenceLabel(facility)}</span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Whitelisted riders</span>
            <span className="meta-value">{whitelistCount(facility)}</span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Created</span>
            <span className="meta-value">{toLocal(facility.createdAt)}</span>
          </div>
        </div>
      </div>

      <div className="page-actions">
        <button
          type="button"
          className="btn"
          onClick={() => {
            setWhitelistError(null)
            setWhitelistOpen(true)
          }}
        >
          Manage whitelist
        </button>
      </div>

      <p className="muted small">
        Facility changes are audited (facility.*); NOT_WHITELISTED incidents are resolved via whitelist grants.
      </p>

      {whitelistOpen && (
        <WhitelistModal
          facility={facility}
          busy={whitelistBusy}
          error={whitelistError}
          onSubmit={submitWhitelist}
          onClose={() => {
            if (!whitelistBusy) setWhitelistOpen(false)
          }}
        />
      )}
    </DetailDrawer>
  )
}

function FacilityFormModal({
  busy,
  error,
  onSubmit,
  onClose,
}: {
  busy: boolean
  error: string | null
  onSubmit: (form: FacilityForm) => void
  onClose: () => void
}) {
  const [form, setForm] = useState<FacilityForm>({
    name: '',
    address: '',
    accessPolicy: 'whitelist_only',
    geofence: '',
  })

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (!form.name.trim() || !form.address.trim()) return
    onSubmit(form)
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="New facility"
        onClick={(e) => e.stopPropagation()}
        onSubmit={handleSubmit}
      >
        <h3 className="modal-title">New facility</h3>
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
          <Field label="Address">
            <input
              className="field"
              value={form.address}
              onChange={(e) => setForm({ ...form, address: e.target.value })}
              required
              maxLength={300}
            />
          </Field>
          <Field label="Access policy">
            <select
              className="field"
              value={form.accessPolicy}
              onChange={(e) => setForm({ ...form, accessPolicy: e.target.value as FacilityAccessPolicy })}
            >
              {POLICIES.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Geofence (lon,lat pairs)">
            <input
              className="field mono"
              value={form.geofence}
              onChange={(e) => setForm({ ...form, geofence: e.target.value })}
              placeholder="e.g. 39.28,-6.81, 39.29,-6.82"
            />
          </Field>
        </div>
        {error && <InlineError message={error} />}
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn" disabled={busy}>
            {busy ? 'Working…' : 'Create facility'}
          </button>
        </div>
      </form>
    </div>
  )
}

function WhitelistModal({
  facility,
  busy,
  error,
  onSubmit,
  onClose,
}: {
  facility: Facility
  busy: boolean
  error: string | null
  onSubmit: (riderIds: string[]) => void
  onClose: () => void
}) {
  const [riderIds, setRiderIds] = useState((facility.whitelistRiderIds ?? []).join(', '))
  const [reason, setReason] = useState('')

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (!reason.trim()) return
    onSubmit(parseList(riderIds))
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="Manage whitelist"
        onClick={(e) => e.stopPropagation()}
        onSubmit={handleSubmit}
      >
        <h3 className="modal-title">Manage whitelist</h3>
        <div className="form-grid">
          <Field label="Rider IDs">
            <textarea
              className="field mono"
              rows={4}
              value={riderIds}
              onChange={(e) => setRiderIds(e.target.value)}
              placeholder="e.g. rider_123, rider_456"
            />
          </Field>
        </div>
        <label className="field-label" htmlFor="whitelist-reason">
          Reason
        </label>
        <textarea
          id="whitelist-reason"
          className="field"
          rows={3}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          required
          maxLength={500}
          placeholder="Why is this whitelist updated? (audited)"
        />
        <p className="muted small">
          Facility changes are audited (facility.*); NOT_WHITELISTED incidents are resolved via whitelist grants.
        </p>
        {error && <InlineError message={error} />}
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn" disabled={busy}>
            {busy ? 'Working…' : 'Save whitelist'}
          </button>
        </div>
      </form>
    </div>
  )
}
