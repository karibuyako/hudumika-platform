import { useEffect, useMemo, useState } from 'react'
import {
  VehicleStatus as VehicleStatusConst,
  VehicleVehicleType as VehicleVehicleTypeConst,
  listVehicleMaintenance,
  listVehicles,
  type Vehicle,
  type VehicleMaintenance,
  type VehicleSecurityCapability,
  type VehicleStatus,
  type VehicleVehicleType,
} from '@hudumika/contract'
import { DataTable, type DataTableColumn } from '../../components/DataTable'
import { DetailDrawer } from '../../components/DetailDrawer'
import { ErrorState } from '../../components/ErrorState'
import { FilterChips } from '../../components/FilterChips'
import { LoadingSkeleton } from '../../components/LoadingSkeleton'
import { StatusPill } from '../../components/StatusPill'
import { parseApiError } from '../../lib/api-error'
import { formatTZS } from '../../lib/money'
import { toLocal } from '../../lib/time'

type TypeFilter = 'all' | VehicleVehicleType
type StatusFilter = 'all' | VehicleStatus
type Tab = 'fleet' | 'maintenance'

const VEHICLE_TYPES = Object.values(VehicleVehicleTypeConst)
const VEHICLE_STATUSES = Object.values(VehicleStatusConst)

const TYPE_OPTIONS: Array<{ key: TypeFilter; label: string }> = [
  { key: 'all', label: 'All' },
  ...VEHICLE_TYPES.map((t) => ({ key: t as TypeFilter, label: t })),
]

const STATUS_OPTIONS: Array<{ key: StatusFilter; label: string }> = [
  { key: 'all', label: 'All' },
  ...VEHICLE_STATUSES.map((s) => ({ key: s as StatusFilter, label: s })),
]

function statusTone(status: VehicleStatus | undefined): 'ok' | 'info' | 'warn' | 'muted' {
  if (status === 'active') return 'ok'
  if (status === 'on_trip') return 'info'
  if (status === 'maintenance') return 'warn'
  return 'muted'
}

function capacityUnits(v: Vehicle): number | null {
  return v.capacity?.totalUnits ?? null
}

function securityCapability(v: Vehicle): VehicleSecurityCapability | null {
  if (!v.securityCapability || v.securityCapability === 'none') return null
  return v.securityCapability
}

const FLEET_COLUMNS: DataTableColumn<Vehicle>[] = [
  { key: 'registration', header: 'Registration', render: (v) => v.registration || v.id, className: 'mono' },
  {
    key: 'type',
    header: 'Type',
    render: (v) => <span className="tag">{v.vehicleType}</span>,
    sortValue: (v) => v.vehicleType,
  },
  { key: 'operator', header: 'Operator', render: (v) => v.operatorId ?? '—', className: 'mono' },
  {
    key: 'status',
    header: 'Status',
    render: (v) => <StatusPill status={v.status ?? '—'} tone={statusTone(v.status)} />,
    sortValue: (v) => v.status ?? null,
  },
  { key: 'capacity', header: 'Capacity', render: (v) => capacityUnits(v) ?? '—', className: 'mono' },
  { key: 'cold', header: 'Cold', render: (v) => (v.temperatureCapable ? <span className="tag">cold</span> : '—') },
  {
    key: 'security',
    header: 'Security',
    render: (v) => (securityCapability(v) ? <span className="tag">{securityCapability(v)}</span> : '—'),
  },
  { key: 'trip', header: 'Trip', render: (v) => v.currentTripId ?? '—', className: 'mono' },
]

const MAINTENANCE_COLUMNS: DataTableColumn<VehicleMaintenance>[] = [
  { key: 'id', header: 'ID', render: (m) => m.id ?? '—', className: 'mono' },
  { key: 'rider', header: 'Rider', render: (m) => m.riderId ?? '—', className: 'mono' },
  { key: 'type', header: 'Type', render: (m) => <span className="tag">{m.type}</span> },
  { key: 'performed', header: 'Performed', render: (m) => toLocal(m.performedAt), className: 'muted' },
  { key: 'mileage', header: 'Mileage (km)', render: (m) => m.mileageKm ?? '—', className: 'mono' },
  { key: 'cost', header: 'Cost', render: (m) => formatTZS(m.costTZS), className: 'mono' },
  { key: 'nextDue', header: 'Next due', render: (m) => toLocal(m.nextDueAt), className: 'muted' },
  { key: 'notes', header: 'Notes', render: (m) => m.notes ?? '—', className: 'muted small' },
]

export function VehiclesPage() {
  const [vehicles, setVehicles] = useState<Vehicle[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [retryKey, setRetryKey] = useState(0)

  const [type, setType] = useState<TypeFilter>('all')
  const [status, setStatus] = useState<StatusFilter>('all')
  const [tab, setTab] = useState<Tab>('fleet')
  const [selected, setSelected] = useState<Vehicle | null>(null)

  const [maintenance, setMaintenance] = useState<VehicleMaintenance[] | null>(null)
  const [maintenanceError, setMaintenanceError] = useState<string | null>(null)
  const [maintenanceRetryKey, setMaintenanceRetryKey] = useState(0)

  useEffect(() => {
    setError(null)
    listVehicles().then((res) => {
      if (res.status === 200) setVehicles(res.data)
      else setError(parseApiError(res, 'Failed to load vehicles').message)
    })
  }, [retryKey])

  useEffect(() => {
    if (tab !== 'maintenance') return
    setMaintenanceError(null)
    setMaintenance(null)
    listVehicleMaintenance().then((res) => {
      if (res.status === 200) setMaintenance(res.data)
      else setMaintenanceError(parseApiError(res, 'Failed to load maintenance records').message)
    })
  }, [tab, maintenanceRetryKey])

  const typeCounts = useMemo(() => {
    const map: Partial<Record<TypeFilter, number>> = { all: vehicles?.length ?? 0 }
    for (const t of VEHICLE_TYPES) map[t] = (vehicles ?? []).filter((v) => v.vehicleType === t).length
    return map
  }, [vehicles])

  const statusCounts = useMemo(() => {
    const map: Partial<Record<StatusFilter, number>> = { all: vehicles?.length ?? 0 }
    for (const s of VEHICLE_STATUSES) map[s] = (vehicles ?? []).filter((v) => v.status === s).length
    return map
  }, [vehicles])

  const visible = useMemo(
    () =>
      (vehicles ?? []).filter(
        (v) => (type === 'all' || v.vehicleType === type) && (status === 'all' || v.status === status),
      ),
    [vehicles, type, status],
  )

  if (error) {
    return <ErrorState title="Failed to load vehicles" message={error} onRetry={() => setRetryKey((k) => k + 1)} />
  }
  if (!vehicles) return <LoadingSkeleton kind="table" />

  return (
    <div className="page">
      <div className="page-title-row">
        <h1>Fleet</h1>
      </div>

      <div className="tabs">
        <button
          type="button"
          className={`tab${tab === 'fleet' ? ' active' : ''}`}
          aria-selected={tab === 'fleet'}
          onClick={() => setTab('fleet')}
        >
          Fleet
        </button>
        <button
          type="button"
          className={`tab${tab === 'maintenance' ? ' active' : ''}`}
          aria-selected={tab === 'maintenance'}
          onClick={() => setTab('maintenance')}
        >
          Maintenance
        </button>
      </div>

      {tab === 'fleet' ? (
        <>
          <div className="toolbar">
            <FilterChips
              options={TYPE_OPTIONS}
              value={type}
              onChange={setType}
              counts={typeCounts}
              ariaLabel="Vehicle type"
            />
            <FilterChips
              options={STATUS_OPTIONS}
              value={status}
              onChange={setStatus}
              counts={statusCounts}
              ariaLabel="Vehicle status"
            />
          </div>

          <DataTable
            rows={visible}
            columns={FLEET_COLUMNS}
            rowKey={(v) => v.id}
            onRowClick={setSelected}
            exportable
            exportFileName="vehicles"
            emptyTitle="No vehicles"
            ariaLabel="Vehicles"
          />

          <p className="muted small">
            Vehicle records are maintained by fleet operations; admin-web is view-only for vehicle state.
          </p>

          {selected && <VehicleDrawer vehicle={selected} onClose={() => setSelected(null)} />}
        </>
      ) : maintenanceError ? (
        <ErrorState
          title="Failed to load maintenance records"
          message={maintenanceError}
          onRetry={() => setMaintenanceRetryKey((k) => k + 1)}
        />
      ) : !maintenance ? (
        <LoadingSkeleton kind="table" />
      ) : (
        <DataTable
          rows={maintenance}
          columns={MAINTENANCE_COLUMNS}
          rowKey={(m) => m.id ?? `${m.riderId}-${m.performedAt}-${m.type}`}
          emptyTitle="No maintenance records"
          ariaLabel="Maintenance records"
        />
      )}
    </div>
  )
}

function VehicleDrawer({ vehicle, onClose }: { vehicle: Vehicle; onClose: () => void }) {
  return (
    <DetailDrawer title={vehicle.registration || vehicle.id} onClose={onClose}>
      <div className="detail-section">
        <h3>Overview</h3>
        <div className="meta-grid">
          <div className="meta-item">
            <span className="meta-label">ID</span>
            <span className="meta-value mono">{vehicle.id}</span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Registration</span>
            <span className="meta-value mono">{vehicle.registration}</span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Type</span>
            <span className="meta-value">
              <span className="tag">{vehicle.vehicleType}</span>
            </span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Operator</span>
            <span className="meta-value mono">{vehicle.operatorId ?? '—'}</span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Status</span>
            <span className="meta-value">
              <StatusPill status={vehicle.status ?? '—'} tone={statusTone(vehicle.status)} />
            </span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Capacity</span>
            <span className="meta-value mono">
              {vehicle.capacity?.totalUnits ?? '—'}
              {vehicle.capacity?.maxWeightKg != null && (
                <>
                  <br />
                  {`${vehicle.capacity.maxWeightKg} kg max`}
                </>
              )}
              {vehicle.capacity?.maxVolumeL != null && (
                <>
                  <br />
                  {`${vehicle.capacity.maxVolumeL} L max`}
                </>
              )}
            </span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Temperature capable</span>
            <span className="meta-value">
              {vehicle.temperatureCapable ? <span className="tag">cold</span> : '—'}
            </span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Security capability</span>
            <span className="meta-value">
              {securityCapability(vehicle) ? <span className="tag">{securityCapability(vehicle)}</span> : '—'}
            </span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Current trip</span>
            <span className="meta-value mono">{vehicle.currentTripId ?? '—'}</span>
          </div>
        </div>
      </div>

      <p className="muted small">
        Vehicle records are maintained by fleet operations; admin-web is view-only for vehicle state.
      </p>
    </DetailDrawer>
  )
}
