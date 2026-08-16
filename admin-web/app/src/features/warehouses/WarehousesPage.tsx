import { useEffect, useMemo, useState, type FormEvent } from 'react'
import {
  WarehouseStatus as WarehouseStatusConst,
  adjustWarehouseStock,
  createWarehouse,
  getWarehouse,
  listWarehouses,
  updateWarehouse,
  type Warehouse,
  type WarehouseStatus,
  type WarehouseStockItem,
} from '@hudumika/contract'
import { DataTable, type DataTableColumn } from '../../components/DataTable'
import { DetailDrawer } from '../../components/DetailDrawer'
import { ErrorState } from '../../components/ErrorState'
import { Field, InlineError, Toast } from '../../components/FormBits'
import { FilterChips } from '../../components/FilterChips'
import { LoadingSkeleton } from '../../components/LoadingSkeleton'
import { StatusPill } from '../../components/StatusPill'
import { parseApiError } from '../../lib/api-error'
import { toLocal } from '../../lib/time'

type StatusFilter = 'all' | WarehouseStatus

const STATUSES = Object.values(WarehouseStatusConst)

const STATUS_OPTIONS: Array<{ key: StatusFilter; label: string }> = [
  { key: 'all', label: 'All' },
  ...STATUSES.map((s) => ({ key: s as StatusFilter, label: s })),
]

const LOW_STOCK_THRESHOLD = 5

const LOW_STOCK_DETAIL_CAP = 5

interface StockLowRow {
  warehouseName: string
  catalogueItemId: string
  quantity: number
}

function toneFor(status: WarehouseStatus | undefined): 'ok' | 'warn' | 'muted' {
  if (status === 'active') return 'ok'
  if (status === 'full') return 'warn'
  return 'muted'
}

function stockUnits(w: Warehouse): number | null {
  if (!w.stock || w.stock.length === 0) return null
  return w.stock.reduce((sum, item) => sum + item.quantity, 0)
}

const COLUMNS: DataTableColumn<Warehouse>[] = [
  { key: 'name', header: 'Name', render: (w) => w.name },
  { key: 'city', header: 'City', render: (w) => w.cityId },
  { key: 'address', header: 'Address', render: (w) => w.address ?? '—' },
  {
    key: 'status',
    header: 'Status',
    render: (w) => <StatusPill status={w.status ?? '—'} tone={toneFor(w.status)} />,
  },
  {
    key: 'stockUnits',
    header: 'Stock units',
    render: (w) => stockUnits(w) ?? '—',
    sortValue: (w) => stockUnits(w),
    className: 'mono',
  },
  {
    key: 'servingCities',
    header: 'Serving cities',
    render: (w) =>
      (w.servingCities ?? []).length === 0 ? (
        '—'
      ) : (
        <>
          {(w.servingCities ?? []).map((c) => (
            <span key={c} className="tag">
              {c}
            </span>
          ))}
        </>
      ),
  },
  {
    key: 'createdAt',
    header: 'Created',
    render: (w) => toLocal(w.createdAt),
    sortValue: (w) => w.createdAt ?? null,
    className: 'muted',
  },
]

const STOCK_COLUMNS: DataTableColumn<WarehouseStockItem>[] = [
  { key: 'item', header: 'Item', render: (s) => s.catalogueItemId, className: 'mono' },
  { key: 'quantity', header: 'Quantity', render: (s) => s.quantity, sortValue: (s) => s.quantity, className: 'mono' },
]

const STOCK_LOW_COLUMNS: DataTableColumn<StockLowRow>[] = [
  { key: 'warehouse', header: 'Warehouse', render: (r) => r.warehouseName },
  { key: 'item', header: 'Catalogue item', render: (r) => <span className="mono">{r.catalogueItemId}</span> },
  {
    key: 'quantity',
    header: 'Quantity',
    render: (r) => <span className={`mono tag${r.quantity === 0 ? ' bad' : ' warn'}`}>{r.quantity}</span>,
  },
]

interface WarehouseForm {
  name: string
  cityId: string
  address: string
  status: WarehouseStatus
}

export function WarehousesPage() {
  const [warehouses, setWarehouses] = useState<Warehouse[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [retryKey, setRetryKey] = useState(0)

  const [status, setStatus] = useState<StatusFilter>('all')
  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')

  const [selected, setSelected] = useState<Warehouse | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [editTarget, setEditTarget] = useState<Warehouse | null>(null)
  const [formBusy, setFormBusy] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  const [stockLow, setStockLow] = useState<StockLowRow[] | null>(null)
  const [stockLowError, setStockLowError] = useState<string | null>(null)
  const [stockLowRetryKey, setStockLowRetryKey] = useState(0)

  useEffect(() => {
    setError(null)
    listWarehouses().then((res) => {
      if (res.status === 200) setWarehouses(res.data)
      else setError(parseApiError(res, 'Failed to load warehouses').message)
    })
  }, [retryKey])

  useEffect(() => {
    if (warehouses === null) return
    if (warehouses.length === 0) {
      setStockLowError(null)
      setStockLow([])
      return
    }
    let cancelled = false
    setStockLowError(null)
    setStockLow(null)
    Promise.all(
      warehouses
        .slice(0, LOW_STOCK_DETAIL_CAP)
        .map((w) =>
          getWarehouse(w.id)
            .then((res) => {
              if (res.status === 200) return res.data
              if (res.status === 404) return null
              throw new Error(parseApiError(res, 'Failed to load stock').message)
            })
            .catch((err: unknown) => {
              if (cancelled) return null
              setStockLowError(err instanceof Error ? err.message : 'Failed to load stock')
              return null
            }),
        ),
    ).then((details) => {
      if (cancelled) return
      const rows: StockLowRow[] = []
      for (const detail of details) {
        if (!detail) continue
        for (const item of detail.stock ?? []) {
          if (item.quantity <= LOW_STOCK_THRESHOLD) {
            rows.push({ warehouseName: detail.name, catalogueItemId: item.catalogueItemId, quantity: item.quantity })
          }
        }
      }
      setStockLow(rows)
    })
    return () => {
      cancelled = true
    }
  }, [warehouses, stockLowRetryKey])

  const statusCounts = useMemo(() => {
    const map: Partial<Record<StatusFilter, number>> = { all: warehouses?.length ?? 0 }
    for (const s of STATUSES) map[s] = (warehouses ?? []).filter((w) => w.status === s).length
    return map
  }, [warehouses])

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return (warehouses ?? []).filter(
      (w) =>
        (status === 'all' || w.status === status) && (!q || (w.name ?? '').toLowerCase().includes(q)),
    )
  }, [warehouses, status, query])

  function submitCreate(form: WarehouseForm) {
    setFormBusy(true)
    setFormError(null)
    createWarehouse({
      id: '',
      name: form.name.trim(),
      cityId: form.cityId.trim(),
      ...(form.address.trim() ? { address: form.address.trim() } : {}),
      status: form.status,
    }).then((res) => {
      if (res.status === 201) {
        setToast('Warehouse created')
        setCreateOpen(false)
        setRetryKey((k) => k + 1)
      } else {
        setFormError(parseApiError(res, 'Could not create warehouse').message)
      }
      setFormBusy(false)
    })
  }

  function submitEdit(form: WarehouseForm) {
    if (!editTarget) return
    setFormBusy(true)
    setFormError(null)
    updateWarehouse(editTarget.id, {
      id: editTarget.id,
      name: form.name.trim(),
      cityId: form.cityId.trim(),
      ...(form.address.trim() ? { address: form.address.trim() } : {}),
      status: form.status,
    }).then((res) => {
      if (res.status === 200) {
        setToast('Warehouse updated')
        setSelected(res.data)
        setEditTarget(null)
        setRetryKey((k) => k + 1)
      } else {
        setFormError(parseApiError(res, 'Could not update warehouse').message)
      }
      setFormBusy(false)
    })
  }

  if (error) {
    return <ErrorState title="Failed to load warehouses" message={error} onRetry={() => setRetryKey((k) => k + 1)} />
  }
  if (!warehouses) return <LoadingSkeleton kind="table" />

  return (
    <div className="page">
      <div className="page-title-row">
        <h1>Warehouses</h1>
        {toast && (
          <div className="page-actions">
            <Toast message={toast} />
          </div>
        )}
      </div>

      <div className="toolbar">
        <form
          onSubmit={(e) => {
            e.preventDefault()
            setQuery(search.trim())
          }}
        >
          <input
            className="topbar-search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name"
            aria-label="Search warehouses"
          />
        </form>
        <FilterChips
          options={STATUS_OPTIONS}
          value={status}
          onChange={setStatus}
          counts={statusCounts}
          ariaLabel="Warehouse status"
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
          New warehouse
        </button>
      </div>

      <section>
        <h2>Stock-low monitor</h2>
        <p className="muted small">
          Stock-low alerts trigger warehouse.stock_low; bulk inbound replenishes via the stock adjust flow.
        </p>
        {stockLowError ? (
          <div className="inline-error" role="alert">
            {stockLowError}{' '}
            <button type="button" className="btn" onClick={() => setStockLowRetryKey((k) => k + 1)}>
              Retry
            </button>
          </div>
        ) : stockLow === null ? (
          <LoadingSkeleton kind="table" rows={3} />
        ) : (
          <div className="table-wrap">
            <DataTable
              rows={stockLow}
              columns={STOCK_LOW_COLUMNS}
              rowKey={(r) => `${r.warehouseName}:${r.catalogueItemId}`}
              emptyTitle="No stock-low items"
              ariaLabel="Stock-low monitor"
            />
          </div>
        )}
      </section>

      <DataTable
        rows={visible}
        columns={COLUMNS}
        rowKey={(w) => w.id}
        onRowClick={setSelected}
        exportable
        exportFileName="warehouses"
        emptyTitle="No warehouses"
        ariaLabel="Warehouses"
      />

      {selected && (
        <WarehouseDrawer
          warehouse={selected}
          onClose={() => setSelected(null)}
          onToast={setToast}
          onListChanged={() => setRetryKey((k) => k + 1)}
          onEdit={(w) => {
            setToast(null)
            setFormError(null)
            setEditTarget(w)
          }}
        />
      )}

      {createOpen && (
        <WarehouseFormModal
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
        <WarehouseFormModal
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

function WarehouseDrawer({
  warehouse,
  onClose,
  onToast,
  onListChanged,
  onEdit,
}: {
  warehouse: Warehouse
  onClose: () => void
  onToast: (message: string) => void
  onListChanged: () => void
  onEdit: (w: Warehouse) => void
}) {
  const [stock, setStock] = useState<WarehouseStockItem[] | null>(null)
  const [stockError, setStockError] = useState<string | null>(null)
  const [stockRetryKey, setStockRetryKey] = useState(0)
  const [adjustOpen, setAdjustOpen] = useState(false)
  const [adjustBusy, setAdjustBusy] = useState(false)
  const [adjustError, setAdjustError] = useState<string | null>(null)

  useEffect(() => {
    setStockError(null)
    getWarehouse(warehouse.id).then((res) => {
      if (res.status === 200) setStock(res.data.stock ?? [])
      else if (res.status === 404) setStock([])
      else setStockError(parseApiError(res, 'Failed to load stock').message)
    })
  }, [warehouse.id, stockRetryKey])

  function submitAdjust(payload: { catalogueItemId: string; delta: number }) {
    setAdjustBusy(true)
    setAdjustError(null)
    adjustWarehouseStock(warehouse.id, {
      items: [{ catalogueItemId: payload.catalogueItemId, delta: payload.delta }],
    }).then((res) => {
      if (res.status === 200) {
        setAdjustOpen(false)
        onToast('Stock adjusted')
        onListChanged()
        setStockRetryKey((k) => k + 1)
      } else {
        setAdjustError(parseApiError(res, 'Could not adjust stock').message)
      }
      setAdjustBusy(false)
    })
  }

  return (
    <DetailDrawer title={warehouse.name} onClose={onClose}>
      <div className="detail-section">
        <h3>Overview</h3>
        <div className="meta-grid">
          <div className="meta-item">
            <span className="meta-label">ID</span>
            <span className="meta-value mono">{warehouse.id}</span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Name</span>
            <span className="meta-value">{warehouse.name}</span>
          </div>
          <div className="meta-item">
            <span className="meta-label">City</span>
            <span className="meta-value">{warehouse.cityId}</span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Address</span>
            <span className="meta-value">{warehouse.address ?? '—'}</span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Coordinates</span>
            <span className="meta-value mono">
              {warehouse.lat != null && warehouse.lon != null ? `${warehouse.lat}, ${warehouse.lon}` : '—'}
            </span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Status</span>
            <span className="meta-value">
              <StatusPill status={warehouse.status ?? '—'} tone={toneFor(warehouse.status)} />
            </span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Serving cities</span>
            <span className="meta-value">
              {(warehouse.servingCities ?? []).length === 0 ? (
                '—'
              ) : (
                <>
                  {(warehouse.servingCities ?? []).map((c) => (
                    <span key={c} className="tag">
                      {c}
                    </span>
                  ))}
                </>
              )}
            </span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Created</span>
            <span className="meta-value">{toLocal(warehouse.createdAt)}</span>
          </div>
        </div>
      </div>

      <div className="page-actions">
        <button type="button" className="btn" onClick={() => onEdit(warehouse)}>
          Edit
        </button>
      </div>

      <div className="detail-section">
        <h3>Stock</h3>
        <button
          type="button"
          className="btn"
          onClick={() => {
            setAdjustError(null)
            setAdjustOpen(true)
          }}
        >
          Adjust stock
        </button>
        {stockError ? (
          <div className="inline-error" role="alert">
            {stockError}{' '}
            <button type="button" className="btn" onClick={() => setStockRetryKey((k) => k + 1)}>
              Retry
            </button>
          </div>
        ) : !stock ? (
          <LoadingSkeleton kind="table" rows={3} />
        ) : (
          <DataTable
            rows={stock}
            columns={STOCK_COLUMNS}
            rowKey={(s) => s.catalogueItemId}
            emptyTitle="No stock recorded"
            ariaLabel="Warehouse stock"
          />
        )}
      </div>

      {adjustOpen && (
        <AdjustStockModal
          busy={adjustBusy}
          error={adjustError}
          onSubmit={submitAdjust}
          onClose={() => {
            if (!adjustBusy) setAdjustOpen(false)
          }}
        />
      )}
    </DetailDrawer>
  )
}

function WarehouseFormModal({
  initial,
  busy,
  error,
  onSubmit,
  onClose,
}: {
  initial: Warehouse | null
  busy: boolean
  error: string | null
  onSubmit: (form: WarehouseForm) => void
  onClose: () => void
}) {
  const editing = initial !== null
  const [form, setForm] = useState<WarehouseForm>(() => ({
    name: initial?.name ?? '',
    cityId: initial?.cityId ?? '',
    address: initial?.address ?? '',
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
    if (!form.name.trim() || !form.cityId.trim()) return
    onSubmit(form)
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={editing ? 'Edit warehouse' : 'New warehouse'}
        onClick={(e) => e.stopPropagation()}
        onSubmit={handleSubmit}
      >
        <h3 className="modal-title">{editing ? 'Edit warehouse' : 'New warehouse'}</h3>
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
          <Field label="City ID">
            <input
              className="field"
              value={form.cityId}
              onChange={(e) => setForm({ ...form, cityId: e.target.value })}
              required
              maxLength={120}
            />
          </Field>
          <Field label="Address">
            <input
              className="field"
              value={form.address}
              onChange={(e) => setForm({ ...form, address: e.target.value })}
              maxLength={300}
            />
          </Field>
          <Field label="Status">
            <select
              className="field"
              value={form.status}
              onChange={(e) => setForm({ ...form, status: e.target.value as WarehouseStatus })}
            >
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </Field>
        </div>
        {error && <InlineError message={error} />}
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn" disabled={busy}>
            {busy ? 'Working…' : editing ? 'Save changes' : 'Create warehouse'}
          </button>
        </div>
      </form>
    </div>
  )
}

function AdjustStockModal({
  busy,
  error,
  onSubmit,
  onClose,
}: {
  busy: boolean
  error: string | null
  onSubmit: (payload: { catalogueItemId: string; delta: number }) => void
  onClose: () => void
}) {
  const [catalogueItemId, setCatalogueItemId] = useState('')
  const [quantity, setQuantity] = useState('')
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
    const id = catalogueItemId.trim()
    const qty = Number(quantity)
    if (!id || quantity.trim() === '' || !Number.isFinite(qty) || !reason.trim()) return
    onSubmit({ catalogueItemId: id, delta: qty })
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="Adjust stock"
        onClick={(e) => e.stopPropagation()}
        onSubmit={handleSubmit}
      >
        <h3 className="modal-title">Adjust stock</h3>
        <div className="form-grid">
          <Field label="Catalogue item ID">
            <input
              className="field mono"
              value={catalogueItemId}
              onChange={(e) => setCatalogueItemId(e.target.value)}
              required
            />
          </Field>
          <Field label="Quantity">
            <input
              className="field mono"
              type="number"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              required
            />
          </Field>
        </div>
        <label className="field-label" htmlFor="adjust-reason">
          Reason
        </label>
        <textarea
          id="adjust-reason"
          className="field"
          rows={3}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          required
          maxLength={500}
          placeholder="Why is this stock adjusted? (audited)"
        />
        <p className="muted small">Stock adjustments are audited (warehouse.*); negative quantities are write-offs.</p>
        {error && <InlineError message={error} />}
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn" disabled={busy}>
            {busy ? 'Working…' : 'Apply adjustment'}
          </button>
        </div>
      </form>
    </div>
  )
}
