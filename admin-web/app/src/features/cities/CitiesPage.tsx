import { useEffect, useState, type FormEvent } from 'react'
import { adminUpsertCity, listCities, type City, type ServiceArea } from '@hudumika/contract'
import { parseApiError } from '../../lib/api-error'
import { DataTable, type DataTableColumn } from '../../components/DataTable'
import { DetailDrawer } from '../../components/DetailDrawer'
import { ErrorState } from '../../components/ErrorState'
import { Field, InlineError, Toast } from '../../components/FormBits'
import { LoadingSkeleton } from '../../components/LoadingSkeleton'

const COLUMNS: DataTableColumn<City>[] = [
  { key: 'name', header: 'Name', render: (c) => c.name, sortValue: (c) => c.name },
  { key: 'country', header: 'Country', render: (c) => c.country },
  {
    key: 'areas',
    header: 'Service areas',
    render: (city) => {
      const areas = city.serviceAreas ?? []
      return areas.length === 0 ? (
        '—'
      ) : (
        <>
          <span className="muted">{areas.length}</span>{' '}
          {areas.slice(0, 3).map((a) => (
            <span key={a.id} className="tag">
              {a.name}
            </span>
          ))}
          {areas.length > 3 && <span className="muted small">+{areas.length - 3}</span>}
        </>
      )
    },
  },
  { key: 'id', header: 'ID', render: (c) => c.id, className: 'mono' },
]

interface CityForm {
  id: string
  name: string
  country: string
  serviceAreas: string
}

function toCityForm(city: City | null): CityForm {
  return city
    ? {
        id: city.id,
        name: city.name,
        country: city.country,
        serviceAreas: (city.serviceAreas ?? []).map((a) => a.name).join(', '),
      }
    : { id: '', name: '', country: '', serviceAreas: '' }
}

function toServiceAreas(raw: string): ServiceArea[] {
  const names = [...new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))]
  return names.map((name) => ({ id: name.toLowerCase().replace(/\s+/g, '_'), name }))
}

export function CitiesPage() {
  const [cities, setCities] = useState<City[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [retryKey, setRetryKey] = useState(0)
  const [selected, setSelected] = useState<City | null>(null)
  const [modal, setModal] = useState<{ city: City | null } | null>(null)
  const [modalError, setModalError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState<string | null>(null)

  useEffect(() => {
    setError(null)
    listCities().then((res) => {
      if (res.status === 200) setCities(res.data)
      else setError(parseApiError(res, 'Failed to load cities').message)
    })
  }, [retryKey])

  function submit(form: CityForm) {
    setBusy(true)
    setModalError(null)
    const payload: City = {
      id: form.id,
      name: form.name.trim(),
      country: form.country.trim(),
      serviceAreas: toServiceAreas(form.serviceAreas),
    }
    adminUpsertCity(payload).then((res) => {
      if (res.status === 200) {
        setCities((prev) => {
          const list = prev ?? []
          const idx = list.findIndex((c) => c.id === res.data.id)
          return idx === -1 ? [...list, res.data] : list.map((c) => (c.id === res.data.id ? res.data : c))
        })
        setToast('City saved')
        setModal(null)
        setRetryKey((k) => k + 1)
      } else {
        setModalError(parseApiError(res, 'Could not save city').message)
      }
      setBusy(false)
    })
  }

  return (
    <div className="page">
      <div className="page-title-row">
        <h1>Cities &amp; service areas</h1>
        {toast && (
          <div className="page-actions">
            <Toast message={toast} />
          </div>
        )}
      </div>

      {error ? (
        <ErrorState title="Failed to load cities" message={error} onRetry={() => setRetryKey((k) => k + 1)} />
      ) : !cities ? (
        <LoadingSkeleton kind="table" />
      ) : (
        <>
          <div className="toolbar">
            <button
              type="button"
              className="btn"
              onClick={() => {
                setToast(null)
                setModalError(null)
                setModal({ city: null })
              }}
            >
              New city
            </button>
          </div>
          <DataTable
            rows={cities}
            columns={COLUMNS}
            rowKey={(c) => c.id}
            onRowClick={setSelected}
            exportable
            exportFileName="cities"
            emptyTitle="No cities configured"
            ariaLabel="Cities"
          />
          <p className="muted small">City changes are audited (configuration.*) and feed dispatch + map coverage.</p>
        </>
      )}

      {modal && (
        <CityModal
          initial={modal.city}
          busy={busy}
          error={modalError}
          onSubmit={submit}
          onClose={() => {
            if (!busy) setModal(null)
          }}
        />
      )}

      {selected && (
        <CityDrawer
          city={selected}
          onClose={() => setSelected(null)}
          onEdit={() => {
            setModal({ city: selected })
            setSelected(null)
          }}
        />
      )}
    </div>
  )
}

function CityModal({
  initial,
  busy,
  error,
  onSubmit,
  onClose,
}: {
  initial: City | null
  busy: boolean
  error: string | null
  onSubmit: (form: CityForm) => void
  onClose: () => void
}) {
  const [form, setForm] = useState<CityForm>(() => toCityForm(initial))

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (!form.name.trim() || !form.country.trim()) return
    onSubmit(form)
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={initial ? 'Edit city' : 'New city'}
        onClick={(e) => e.stopPropagation()}
        onSubmit={handleSubmit}
      >
        <h3 className="modal-title">{initial ? 'Edit city' : 'New city'}</h3>
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
          <Field label="Country">
            <input
              className="field"
              value={form.country}
              onChange={(e) => setForm({ ...form, country: e.target.value })}
              required
              maxLength={80}
            />
          </Field>
          <Field label="Service areas">
            <input
              className="field"
              value={form.serviceAreas}
              onChange={(e) => setForm({ ...form, serviceAreas: e.target.value })}
              placeholder="Comma-separated area names, e.g. Kinondoni, Ilala"
            />
          </Field>
        </div>
        {error && <InlineError message={error} />}
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn" disabled={busy}>
            {busy ? 'Working…' : initial ? 'Save changes' : 'Create city'}
          </button>
        </div>
      </form>
    </div>
  )
}

function CityDrawer({ city, onClose, onEdit }: { city: City; onClose: () => void; onEdit: () => void }) {
  const areas = city.serviceAreas ?? []
  return (
    <DetailDrawer title={city.name} onClose={onClose}>
      <div className="detail-section">
        <h3>City</h3>
        <div className="meta-grid">
          <div className="meta-item">
            <span className="meta-label">ID</span>
            <span className="meta-value mono">{city.id}</span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Name</span>
            <span className="meta-value">{city.name}</span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Country</span>
            <span className="meta-value">{city.country}</span>
          </div>
        </div>
      </div>
      <div className="detail-section">
        <h3>Service areas</h3>
        {areas.length === 0 && <p className="muted small">No service areas</p>}
        <div className="meta-grid">
          {areas.map((area) => (
            <div key={area.id} className="meta-item">
              <span className="meta-label">
                <span className="tag">{area.name}</span>
              </span>
              <span className="meta-value">
                {area.polygon && area.polygon.length > 0 ? `${area.polygon.length} polygon points` : '—'}
              </span>
            </div>
          ))}
        </div>
      </div>
      <div className="detail-section">
        <button type="button" className="btn" onClick={onEdit}>
          Edit city
        </button>
      </div>
    </DetailDrawer>
  )
}
