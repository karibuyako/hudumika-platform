import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  getDispatchHeatmap,
  listCities,
  listFacilities,
  listVehicles,
  type City,
  type Facility,
  type HeatmapZone,
  type HeatmapZoneDemandLevel,
  type Vehicle,
} from '@hudumika/contract'
import { EmptyState } from '../../components/EmptyState'
import { ErrorState } from '../../components/ErrorState'
import { LoadingSkeleton } from '../../components/LoadingSkeleton'
import { parseApiError, type ApiErrorInfo } from '../../lib/api-error'
import { toLocal } from '../../lib/time'

const MAP_W = 1000
const MAP_H = 700
const PADDING = 0.05

export interface XY {
  x: number
  y: number
}

export interface Fit {
  scale: number
  offsetX: number
  offsetY: number
  minX: number
  minY: number
}

/**
 * Contract polygons are 'lon,lat' strings; x is longitude, y is latitude.
 */
export function parseCoord(raw: string): XY {
  const [lon, lat] = raw.split(',').map((part) => parseFloat(part))
  return { x: lon, y: lat }
}

/**
 * Fit a set of lon/lat points into a w×h viewBox with 5% padding on every
 * side, preserving aspect ratio. Degenerate inputs fall back to centered.
 */
export function fitViewBox(coords: XY[], w: number, h: number): Fit {
  if (coords.length === 0) return { scale: 1, offsetX: 0, offsetY: 0, minX: 0, minY: 0 }
  const xs = coords.map((c) => c.x)
  const ys = coords.map((c) => c.y)
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const minY = Math.min(...ys)
  const maxY = Math.max(...ys)
  const spanX = maxX - minX
  const spanY = maxY - minY
  if (spanX === 0 && spanY === 0) {
    return { scale: 1, offsetX: w / 2, offsetY: h / 2, minX, minY }
  }
  const usableW = w * (1 - 2 * PADDING)
  const usableH = h * (1 - 2 * PADDING)
  const scale = Math.min(usableW / (spanX || 1), usableH / (spanY || 1))
  return { scale, offsetX: (w - spanX * scale) / 2, offsetY: (h - spanY * scale) / 2, minX, minY }
}

export function project(coord: XY, fit: Fit): XY {
  return {
    x: fit.offsetX + (coord.x - fit.minX) * fit.scale,
    y: fit.offsetY + (coord.y - fit.minY) * fit.scale,
  }
}

function isFiniteXY(c: XY): boolean {
  return Number.isFinite(c.x) && Number.isFinite(c.y)
}

function pointsAttr(coords: XY[], fit: Fit): string {
  return coords.map((c) => project(c, fit)).map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')
}

function zoneStyle(level: HeatmapZoneDemandLevel): { fill: string; fillOpacity: number; stroke: string } {
  if (level === 'high' || level === 'critical') {
    return { fill: 'var(--color-accent-soft)', fillOpacity: 0.85, stroke: 'var(--color-warning)' }
  }
  if (level === 'medium') {
    return { fill: 'var(--color-brand-50)', fillOpacity: 0.75, stroke: 'var(--color-brand-500)' }
  }
  return { fill: 'var(--color-paper)', fillOpacity: 0.6, stroke: 'var(--color-line-strong)' }
}

function zonePillTone(level: HeatmapZoneDemandLevel): string {
  if (level === 'high' || level === 'critical') return 'pill-warn'
  if (level === 'medium') return 'pill-brand'
  return 'pill-muted'
}

type LayerKey = 'heatmap' | 'facilities' | 'cities' | 'vehicles'

const LAYER_LABELS: Record<LayerKey, string> = {
  heatmap: 'Heatmap zones',
  facilities: 'Facilities',
  cities: 'City areas',
  vehicles: 'Vehicles',
}

const LAYER_KEYS = Object.keys(LAYER_LABELS) as LayerKey[]

type Selection =
  | { kind: 'zone'; zone: HeatmapZone }
  | { kind: 'facility'; facility: Facility }
  | { kind: 'vehicle'; vehicle: Vehicle }

interface PlottableFacility {
  facility: Facility
  point: XY
}

interface PlottableVehicle {
  vehicle: Vehicle
  point: XY
}

export function MapPage() {
  const [zones, setZones] = useState<HeatmapZone[] | null>(null)
  const [facilities, setFacilities] = useState<Facility[] | null>(null)
  const [cities, setCities] = useState<City[] | null>(null)
  const [vehicles, setVehicles] = useState<Vehicle[] | null>(null)
  const [layers, setLayers] = useState<Record<LayerKey, boolean>>({
    heatmap: true,
    facilities: true,
    cities: true,
    vehicles: true,
  })
  const [selected, setSelected] = useState<Selection | null>(null)
  const [error, setError] = useState<ApiErrorInfo | null>(null)
  const [retryKey, setRetryKey] = useState(0)

  useEffect(() => {
    setError(null)
    let cancelled = false
    Promise.all([getDispatchHeatmap(), listFacilities(), listCities(), listVehicles()]).then((res) => {
      if (cancelled) return
      const failed = res.find((r) => r.status !== 200)
      if (failed) {
        setError(parseApiError(failed, 'Failed to load map data'))
        return
      }
      setZones(res[0].data)
      setFacilities(res[1].data)
      setCities(res[2].data)
      setVehicles(res[3].data)
    })
    return () => {
      cancelled = true
    }
  }, [retryKey])

  const zonePolys = useMemo(
    () =>
      (zones ?? [])
        .map((zone) => ({ zone, coords: (zone.polygon ?? []).map(parseCoord).filter(isFiniteXY) }))
        .filter((p) => p.coords.length >= 3),
    [zones],
  )

  const facilityPoints = useMemo<PlottableFacility[]>(
    () =>
      (facilities ?? [])
        .map((facility) => {
          const pts = (facility.geofence ?? []).map(parseCoord).filter(isFiniteXY)
          if (pts.length === 0) return null
          const point = {
            x: pts.reduce((sum, p) => sum + p.x, 0) / pts.length,
            y: pts.reduce((sum, p) => sum + p.y, 0) / pts.length,
          }
          return { facility, point }
        })
        .filter((f): f is PlottableFacility => f !== null),
    [facilities],
  )

  const areaPolys = useMemo(
    () =>
      (cities ?? [])
        .flatMap((city) => (city.serviceAreas ?? []).map((area) => ({ area, cityName: city.name, coords: (area.polygon ?? []).map(parseCoord).filter(isFiniteXY) })))
        .filter((p) => p.coords.length >= 3),
    [cities],
  )

  const vehiclePoints = useMemo<PlottableVehicle[]>(
    () =>
      (vehicles ?? [])
        .map((vehicle) => {
          const loc = vehicle.currentLocation
          if (!loc || !Number.isFinite(loc.lon) || !Number.isFinite(loc.lat)) return null
          return { vehicle, point: { x: loc.lon, y: loc.lat } }
        })
        .filter((v): v is PlottableVehicle => v !== null),
    [vehicles],
  )

  const fit = useMemo(() => {
    const all: XY[] = [
      ...zonePolys.flatMap((p) => p.coords),
      ...facilityPoints.map((f) => f.point),
      ...areaPolys.flatMap((p) => p.coords),
      ...vehiclePoints.map((v) => v.point),
    ]
    return fitViewBox(all, MAP_W, MAP_H)
  }, [zonePolys, facilityPoints, areaPolys, vehiclePoints])

  const counts: Record<LayerKey, number> = {
    heatmap: zonePolys.length,
    facilities: facilityPoints.length,
    cities: areaPolys.length,
    vehicles: vehiclePoints.length,
  }

  const hasAnyData =
    zonePolys.length > 0 || facilityPoints.length > 0 || areaPolys.length > 0 || vehiclePoints.length > 0

  if (error) {
    return (
      <ErrorState
        title="Coverage map unavailable"
        message={error.message}
        requestId={error.requestId}
        onRetry={() => setRetryKey((k) => k + 1)}
      />
    )
  }
  if (!zones || !facilities || !cities || !vehicles) return <LoadingSkeleton kind="stats" />

  return (
    <div className="page">
      <div className="page-title-row">
        <h1>Coverage Map</h1>
      </div>

      {!hasAnyData ? (
        <EmptyState title="No map data" hint="Heatmap zones, facilities, service areas, and vehicles appear here once geodata is published." />
      ) : (
        <>
          <div className="filters" role="group" aria-label="Map layers">
            {LAYER_KEYS.map((key) => (
              <button
                key={key}
                type="button"
                className={`chip${layers[key] ? ' active' : ''}`}
                aria-pressed={layers[key]}
                onClick={() => setLayers((prev) => ({ ...prev, [key]: !prev[key] }))}
              >
                {LAYER_LABELS[key]} <span className="chip-count">{counts[key]}</span>
              </button>
            ))}
          </div>

          <svg
            viewBox={`0 0 ${MAP_W} ${MAP_H}`}
            role="img"
            aria-label="Coverage map"
            className="coverage-map"
            style={{
              width: '100%',
              height: 'auto',
              display: 'block',
              marginBottom: 14,
              background: 'var(--color-surface)',
              border: '1px solid var(--color-line)',
              borderRadius: 10,
            }}
          >
            {layers.cities &&
              areaPolys.map(({ area, coords }) => (
                <polygon
                  key={area.id}
                  points={pointsAttr(coords, fit)}
                  fill="none"
                  stroke="var(--color-line-strong)"
                  strokeWidth={1.5}
                >
                  <title>{area.name}</title>
                </polygon>
              ))}
            {layers.heatmap &&
              zonePolys.map(({ zone, coords }) => {
                const style = zoneStyle(zone.demandLevel)
                return (
                  <polygon
                    key={zone.zoneId}
                    points={pointsAttr(coords, fit)}
                    fill={style.fill}
                    fillOpacity={style.fillOpacity}
                    stroke={style.stroke}
                    strokeWidth={selected?.kind === 'zone' && selected.zone.zoneId === zone.zoneId ? 3 : 1.5}
                    style={{ cursor: 'pointer' }}
                    onClick={() => setSelected({ kind: 'zone', zone })}
                  >
                    <title>{zone.name}</title>
                  </polygon>
                )
              })}
            {layers.facilities &&
              facilityPoints.map(({ facility, point }) => {
                const p = project(point, fit)
                return (
                  <circle
                    key={facility.id}
                    cx={p.x}
                    cy={p.y}
                    r={7}
                    fill="var(--color-brand-500)"
                    stroke="var(--color-paper)"
                    strokeWidth={2}
                    style={{ cursor: 'pointer' }}
                    onClick={() => setSelected({ kind: 'facility', facility })}
                  >
                    <title>{facility.name}</title>
                  </circle>
                )
              })}
            {layers.vehicles &&
              vehiclePoints.map(({ vehicle, point }) => {
                const p = project(point, fit)
                return (
                  <circle
                    key={vehicle.id}
                    cx={p.x}
                    cy={p.y}
                    r={4}
                    fill="var(--color-info)"
                    stroke="var(--color-paper)"
                    strokeWidth={1}
                    style={{ cursor: 'pointer' }}
                    onClick={() => setSelected({ kind: 'vehicle', vehicle })}
                  >
                    <title>{vehicle.id}</title>
                  </circle>
                )
              })}
          </svg>

          {selected && <DetailPanel selection={selected} />}

          <p className="muted small">
            Contract geodata rendered client-side; live traffic, incidents, and merchant/provider layers land with
            the backend map milestone.
          </p>
        </>
      )}
    </div>
  )
}

function DetailPanel({ selection }: { selection: Selection }) {
  if (selection.kind === 'zone') {
    const { zone } = selection
    return (
      <div className="state-card">
        <h2>{zone.name}</h2>
        <div className="meta-grid">
          <div className="meta-item">
            <span className="meta-label">Demand level</span>
            <span className="meta-value">
              <span className={`pill ${zonePillTone(zone.demandLevel)}`}>{zone.demandLevel}</span>
            </span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Surge multiplier</span>
            <span className="meta-value">{zone.surgeMultiplier ?? '—'}</span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Active orders</span>
            <span className="meta-value">{zone.activeOrders ?? '—'}</span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Active riders</span>
            <span className="meta-value">{zone.activeRiders ?? '—'}</span>
          </div>
        </div>
        <Link className="btn" to="/operations/dispatch-monitor">
          Open dispatch monitor
        </Link>
      </div>
    )
  }

  if (selection.kind === 'facility') {
    const { facility } = selection
    return (
      <div className="state-card">
        <h2>{facility.name}</h2>
        <div className="meta-grid">
          <div className="meta-item">
            <span className="meta-label">Address</span>
            <span className="meta-value">{facility.address ?? '—'}</span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Access policy</span>
            <span className="meta-value">
              {facility.accessPolicy ? <span className="tag">{facility.accessPolicy}</span> : '—'}
            </span>
          </div>
          <div className="meta-item">
            <span className="meta-label">Whitelisted riders</span>
            <span className="meta-value">{(facility.whitelistRiderIds ?? []).length}</span>
          </div>
        </div>
        <Link className="btn" to="/facilities">
          Open facility
        </Link>
      </div>
    )
  }

  const { vehicle } = selection
  return (
    <div className="state-card">
      <h2 className="mono">{vehicle.id}</h2>
      <div className="meta-grid">
        <div className="meta-item">
          <span className="meta-label">Status</span>
          <span className="meta-value">
            {vehicle.status ? <span className="pill pill-info">{vehicle.status}</span> : '—'}
          </span>
        </div>
        <div className="meta-item">
          <span className="meta-label">Type</span>
          <span className="meta-value">{vehicle.vehicleType ?? '—'}</span>
        </div>
        <div className="meta-item">
          <span className="meta-label">Location updated</span>
          <span className="meta-value">{toLocal(vehicle.currentLocation?.updatedAt)}</span>
        </div>
      </div>
      <Link className="btn" to="/operations/fleet">
        Open fleet
      </Link>
    </div>
  )
}
