import { useEffect, useMemo, useState, useCallback, useRef } from 'react'
import * as maplibregl from 'maplibre-gl'
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
import { MapLibreMap, addGeoJsonLayer } from '../../components/MapLibreMap'
import { parseApiError, type ApiErrorInfo } from '../../lib/api-error'
import { toLocal } from '../../lib/time'
import { calculateIsochrone, optimizeRoutes } from '../../lib/geoapify'

export interface XY {
  x: number
  y: number
}

export function parseCoord(raw: string): XY {
  const [lon, lat] = raw.split(',').map((part) => parseFloat(part))
  return { x: lon, y: lat }
}

export function project(c: XY, bounds: { minLon: number; maxLon: number; minLat: number; maxLat: number }, width = 1000, height = 700): XY {
  const pad = 50
  const x = pad + ((c.x - bounds.minLon) / (bounds.maxLon - bounds.minLon)) * (width - 2 * pad)
  const y = pad + ((bounds.maxLat - c.y) / (bounds.maxLat - bounds.minLat)) * (height - 2 * pad)
  return { x, y }
}

export function fitViewBox(coords: XY[], width = 1000, height = 700): { minLon: number; maxLon: number; minLat: number; maxLat: number } {
  const finite = coords.filter(isFiniteXY)
  if (finite.length === 0) return { minLon: 0, maxLon: 1, minLat: 0, maxLat: 1 }
  const xs = finite.map((c) => c.x)
  const ys = finite.map((c) => c.y)
  const minLon = Math.min(...xs)
  const maxLon = Math.max(...xs)
  const minLat = Math.min(...ys)
  const maxLat = Math.max(...ys)
  const padX = (maxLon - minLon) * padding
  const padY = (maxLat - minLat) * padding
  return { minLon: minLon - padX, maxLon: maxLon + padX, minLat: minLat - padY, maxLat: maxLat + padY }
}

function isFiniteXY(c: XY): boolean {
  return Number.isFinite(c.x) && Number.isFinite(c.y)
}

function zonePillTone(level: HeatmapZoneDemandLevel): string {
  if (level === 'high' || level === 'critical') return 'pill-warn'
  if (level === 'medium') return 'pill-brand'
  return 'pill-muted'
}

type LayerKey = 'heatmap' | 'facilities' | 'cities' | 'vehicles' | 'serviceAreas'

const LAYER_LABELS: Record<LayerKey, string> = {
  heatmap: 'Heatmap zones',
  facilities: 'Facilities',
  cities: 'City areas',
  vehicles: 'Vehicles',
  serviceAreas: 'Service areas',
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
    serviceAreas: false,
  })
  const [selected, setSelected] = useState<Selection | null>(null)
  const [error, setError] = useState<ApiErrorInfo | null>(null)
  const [retryKey, setRetryKey] = useState(0)
  const mapRef = useRef<maplibregl.Map | null>(null)
  const [serviceAreaPolygons, setServiceAreaPolygons] = useState<any[]>([])
  const [calculatingServiceArea, setCalculatingServiceArea] = useState(false)
  const [serviceCenter, setServiceCenter] = useState<{ lat: number; lon: number } | null>(null)
  const [showRouteModal, setShowRouteModal] = useState(false)
  const [routeResult, setRouteResult] = useState<any>(null)
  const [optimizing, setOptimizing] = useState(false)

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

  const allPoints = useMemo(() => {
    return [
      ...zonePolys.flatMap((p) => p.coords.map(c => ({ x: c.x, y: c.y }))),
      ...facilityPoints.map(f => f.point),
      ...areaPolys.flatMap(p => p.coords.map(c => ({ x: c.x, y: c.y }))),
      ...vehiclePoints.map(v => v.point),
    ]
  }, [zonePolys, facilityPoints, areaPolys, vehiclePoints])

  const center = useMemo(() => {
    if (allPoints.length === 0) return { lat: -6.7924, lon: 39.2083 }
    const avgLat = allPoints.reduce((s, p) => s + p.y, 0) / allPoints.length
    const avgLon = allPoints.reduce((s, p) => s + p.x, 0) / allPoints.length
    return { lat: avgLat, lon: avgLon }
  }, [allPoints])

  const counts: Record<LayerKey, number> = {
    heatmap: zonePolys.length,
    facilities: facilityPoints.length,
    cities: areaPolys.length,
    vehicles: vehiclePoints.length,
    serviceAreas: serviceAreaPolygons.length,
  }

  const hasAnyData =
    zonePolys.length > 0 || facilityPoints.length > 0 || areaPolys.length > 0 || vehiclePoints.length > 0

  // Update map layers when data or toggles change
  useEffect(() => {
    const map = mapRef.current
    if (!map || !map.loaded()) return

    // Clear old polygon layers
    const layerIds = ['heatmap-zones', 'city-areas', 'service-area-poly']
    layerIds.forEach(id => {
      if (map.getLayer(id)) map.removeLayer(id)
      if (map.getLayer(`${id}-outline`)) map.removeLayer(`${id}-outline`)
      if (map.getSource(id)) map.removeSource(id)
    })

    // Heatmap zones
    if (layers.heatmap) {
      zonePolys.forEach(({ zone, coords }) => {
        const color = zone.demandLevel === 'high' || zone.demandLevel === 'critical' ? '#ef4444' : zone.demandLevel === 'medium' ? '#f59e0b' : '#3b82f6'
        const id = `heatmap-${zone.zoneId}`
        if (map.getSource(id)) map.removeSource(id)
        if (map.getLayer(id)) map.removeLayer(id)
        if (map.getLayer(`${id}-outline`)) map.removeLayer(`${id}-outline`)
        map.addSource(id, {
          type: 'geojson',
          data: { type: 'Feature', properties: { name: zone.name }, geometry: { type: 'Polygon', coordinates: [coords.map(c => [c.x, c.y])] } },
        })
        map.addLayer({ id, type: 'fill', source: id, paint: { 'fill-color': color, 'fill-opacity': 0.2 } })
        map.addLayer({ id: `${id}-outline`, type: 'line', source: id, paint: { 'line-color': color, 'line-width': 1 } })
      })
    }

    // City areas
    if (layers.cities) {
      areaPolys.forEach(({ area, coords }) => {
        const id = `city-${area.id}`
        if (map.getSource(id)) map.removeSource(id)
        if (map.getLayer(id)) map.removeLayer(id)
        if (map.getLayer(`${id}-outline`)) map.removeLayer(`${id}-outline`)
        map.addSource(id, {
          type: 'geojson',
          data: { type: 'Feature', properties: { name: area.name }, geometry: { type: 'Polygon', coordinates: [coords.map(c => [c.x, c.y])] } },
        })
        map.addLayer({ id, type: 'fill', source: id, paint: { 'fill-color': '#6b7280', 'fill-opacity': 0.1 } })
        map.addLayer({ id: `${id}-outline`, type: 'line', source: id, paint: { 'line-color': '#6b7280', 'line-width': 1 } })
      })
    }

    // Service area isochrone polygons
    if (layers.serviceAreas) {
      serviceAreaPolygons.forEach((poly, i) => {
        const id = `service-area-${i}`
        if (map.getSource(id)) map.removeSource(id)
        if (map.getLayer(id)) map.removeLayer(id)
        if (map.getLayer(`${id}-outline`)) map.removeLayer(`${id}-outline`)
        map.addSource(id, { type: 'geojson', data: poly })
        map.addLayer({ id, type: 'fill', source: id, paint: { 'fill-color': '#8b5cf6', 'fill-opacity': 0.2 } })
        map.addLayer({ id: `${id}-outline`, type: 'line', source: id, paint: { 'line-color': '#8b5cf6', 'line-width': 2 } })
      })
    }

    // Facility + vehicle markers
    if (layers.facilities) {
      facilityPoints.forEach(({ facility, point }) => {
        const el = document.createElement('div')
        el.style.cssText = 'width:16px;height:16px;border-radius:50%;background:#6366f1;border:2px solid #fff;cursor:pointer;box-shadow:0 2px 4px rgba(0,0,0,0.3);'
        const label = document.createElement('div')
        label.style.cssText = 'position:absolute;top:-20px;left:50%;transform:translateX(-50%);white-space:nowrap;font-size:10px;color:#fff;background:rgba(0,0,0,0.7);padding:1px 4px;border-radius:3px;pointer-events:none;'
        label.textContent = facility.name
        el.appendChild(label)
        new maplibregl.Marker({ element: el }).setLngLat([point.x, point.y]).addTo(map)
      })
    }

    if (layers.vehicles) {
      vehiclePoints.forEach(({ vehicle, point }) => {
        const el = document.createElement('div')
        el.style.cssText = 'width:12px;height:12px;border-radius:50%;background:#06b6d4;border:2px solid #fff;cursor:pointer;box-shadow:0 2px 4px rgba(0,0,0,0.3);'
        const label = document.createElement('div')
        label.style.cssText = 'position:absolute;top:-18px;left:50%;transform:translateX(-50%);white-space:nowrap;font-size:10px;color:#fff;background:rgba(0,0,0,0.7);padding:1px 4px;border-radius:3px;pointer-events:none;'
        label.textContent = vehicle.id.slice(0, 8)
        el.appendChild(label)
        new maplibregl.Marker({ element: el }).setLngLat([point.x, point.y]).addTo(map)
      })
    }
  }, [zonePolys, areaPolys, serviceAreaPolygons, layers, facilityPoints, vehiclePoints])

  const handleMapLoad = useCallback((map: maplibregl.Map) => {
    mapRef.current = map
  }, [])

  // Handle map click for service area center
  const handleMapClick = useCallback((lat: number, lon: number) => {
    setServiceCenter({ lat, lon })
  }, [])

  // Calculate isochrone service area
  const handleCalculateServiceArea = useCallback(async () => {
    if (!serviceCenter) return
    setCalculatingServiceArea(true)
    try {
      const result = await calculateIsochrone(serviceCenter.lat, serviceCenter.lon, 'time', [300, 600, 900])
      if (result.features?.length) {
        const polys = result.features.map((f: any) => ({
          type: 'Feature',
          properties: {},
          geometry: f.geometry,
        }))
        setServiceAreaPolygons(polys)
        setLayers(prev => ({ ...prev, serviceAreas: true }))
      }
    } catch {
      // silent
    }
    setCalculatingServiceArea(false)
  }, [serviceCenter])

  // Handle route optimization
  const handleOptimizeRoutes = useCallback(async () => {
    setOptimizing(true)
    try {
      const riderPositions = (vehiclePoints ?? []).map((v, i) => ({
        id: `vehicle-${i}`,
        startLocation: [v.point.x, v.point.y] as [number, number],
      }))
      if (riderPositions.length === 0) {
        setOptimizing(false)
        return
      }
      const result = await optimizeRoutes({
        agents: riderPositions,
        shipments: [],
        mode: 'drive',
      })
      setRouteResult(result)
      setShowRouteModal(true)
    } catch {
      // silent
    }
    setOptimizing(false)
  }, [vehiclePoints])

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
          <div className="filters" role="group" aria-label="Map layers" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
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
            <button type="button" className="chip" onClick={handleCalculateServiceArea} disabled={calculatingServiceArea || !serviceCenter}>
              {calculatingServiceArea ? 'Calculating...' : 'Calculate Service Area'}
            </button>
            <button type="button" className="chip" onClick={handleOptimizeRoutes} disabled={optimizing}>
              {optimizing ? 'Optimizing...' : 'Optimize Routes'}
            </button>
            {serviceCenter && (
              <span className="muted small">Click map to set center · current: {serviceCenter.lat.toFixed(4)}, {serviceCenter.lon.toFixed(4)}</span>
            )}
          </div>

          <MapLibreMap
            center={[center.lon, center.lat]}
            zoom={11}
            height={600}
            onMapLoad={handleMapLoad}
          />

          {selected && <DetailPanel selection={selected} />}

          <p className="muted small">
            Interactive MapLibre map with heatmap zones, facility markers, service area isochrones, and route optimization. Click the map to set a center point for service area calculation.
          </p>
        </>
      )}

      {/* Route optimization result modal */}
      {showRouteModal && routeResult && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}
          onClick={() => setShowRouteModal(false)}>
          <div style={{ background: '#1a1a1a', border: '1px solid #333', borderRadius: 12, padding: 24, maxWidth: 600, maxHeight: '80vh', overflow: 'auto', width: '90%' }}
            onClick={(e) => e.stopPropagation()}>
            <h2 style={{ marginTop: 0 }}>Route Optimization Result</h2>
            <div className="muted small" style={{ marginBottom: 12 }}>
              {routeResult.features?.length ?? 0} routes · {routeResult.properties?.summary?.routes ?? '?'} vehicles
            </div>
            <pre style={{ fontSize: 11, color: '#aaa', whiteSpace: 'pre-wrap' }}>
              {JSON.stringify(routeResult.properties?.summary ?? routeResult, null, 2).slice(0, 2000)}
            </pre>
            <button className="btn" style={{ marginTop: 12 }} onClick={() => setShowRouteModal(false)}>Close</button>
          </div>
        </div>
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
