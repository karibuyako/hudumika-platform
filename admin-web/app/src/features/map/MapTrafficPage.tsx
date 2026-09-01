import { useCallback, useEffect, useRef, useState } from 'react'
import { adminGetMapTraffic, type AdminMapTrafficOverlay } from '@hudumika/contract'
import { useWebSocket } from '../../hooks/useWebSocket'
import { snapshotLabel, toLocal } from '../../lib/time'
import { useRefetchOnFocus } from '../../lib/use-refetch-on-focus'
import { useServerEvents } from '../../lib/use-server-events'
import { ErrorState } from '../../components/ErrorState'
import { LoadingSkeleton } from '../../components/LoadingSkeleton'
import { StatCard } from '../../components/StatCard'
import { StatusPill } from '../../components/StatusPill'
import { MapLibreMap, addTrafficLayer, addGeoJsonLayer } from '../../components/MapLibreMap'
import { geocode, calculateMatrix } from '../../lib/tomtom'
import * as maplibregl from 'maplibre-gl'

const TOMTOM_API_KEY = import.meta.env.VITE_TOMTOM_API_KEY || ''

function severityTone(s: string): 'bad' | 'warn' | 'info' | 'muted' {
  if (s === 'critical' || s === 'gridlock' || s === 'high') return 'bad'
  if (s === 'heavy' || s === 'medium') return 'warn'
  if (s === 'moderate') return 'info'
  return 'muted'
}

function incidentIcon(type: string | undefined): string {
  switch (type) {
    case 'accident': return '●'
    case 'road_closure': return '◆'
    case 'severe_weather': return '▲'
    case 'security_incident': return '●'
    case 'sos': return 'SOS'
    default: return '!'
  }
}

type LayerToggle = 'traffic' | 'riders' | 'incidents' | 'geofences'

export function MapTrafficPage() {
  const [overlay, setOverlay] = useState<AdminMapTrafficOverlay | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [retryKey, setRetryKey] = useState(0)
  const [selectedIncident, setSelectedIncident] = useState<number | null>(null)
  const requestIdRef = useRef(0)
  const mapRef = useRef<maplibregl.Map | null>(null)
  const markersRef = useRef<maplibregl.Marker[]>([])
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<{ address: string; lat: number; lon: number }[]>([])
  const [searching, setSearching] = useState(false)
  const [layers, setLayers] = useState<Record<LayerToggle, boolean>>({
    traffic: true,
    riders: true,
    incidents: true,
    geofences: true,
  })
  const [nearestRiders, setNearestRiders] = useState<any[] | null>(null)
  const [findingNearest, setFindingNearest] = useState(false)

  const load = useCallback(() => {
    const requestId = ++requestIdRef.current
    setError(null)
    setOverlay(null)
    adminGetMapTraffic().then((res) => {
      if (requestId !== requestIdRef.current) return
      if (res.status === 200) setOverlay(res.data)
      else setError(`Failed to load traffic overlay (${res.status})`)
    }).catch(() => {
      if (requestId !== requestIdRef.current) return
      setError('Network error loading traffic overlay')
    })
  }, [])

  useEffect(() => { load() }, [load, retryKey])
  useRefetchOnFocus(load)
  useServerEvents({ enabled: !!overlay, onEvent: () => load() })

  const handleRiderPositions = useCallback((positions: any[]) => {
    setOverlay((prev) => {
      if (!prev) return prev
      return { ...prev, livePositions: positions }
    })
  }, [])

  const { connected: wsConnected } = useWebSocket('map:rider-positions', handleRiderPositions)

  useEffect(() => {
    const interval = setInterval(() => load(), 5000)
    return () => clearInterval(interval)
  }, [load])

  // Update map layers when overlay or toggles change
  useEffect(() => {
    const map = mapRef.current
    if (!map || !map.loaded()) return

    // Clear old markers
    markersRef.current.forEach(m => m.remove())
    markersRef.current = []

    // Traffic layer
    if (layers.traffic && TOMTOM_API_KEY) {
      if (!map.getLayer('tomtom-traffic-layer')) {
        addTrafficLayer(map, TOMTOM_API_KEY)
      }
    } else {
      if (map.getLayer('tomtom-traffic-layer')) map.removeLayer('tomtom-traffic-layer')
      if (map.getSource('tomtom-traffic')) map.removeSource('tomtom-traffic')
    }

    // Rider markers
    if (layers.riders && overlay?.livePositions) {
      overlay.livePositions.forEach((pos: any) => {
        const el = document.createElement('div')
        const color = pos.status === 'busy' ? '#f59e0b' : '#10b981'
        el.style.cssText = `width:12px;height:12px;border-radius:50%;background:${color};border:2px solid #fff;cursor:pointer;box-shadow:0 2px 4px rgba(0,0,0,0.3);`
        const label = document.createElement('div')
        label.style.cssText = 'position:absolute;top:-18px;left:50%;transform:translateX(-50%);white-space:nowrap;font-size:10px;color:#fff;background:rgba(0,0,0,0.7);padding:1px 4px;border-radius:3px;pointer-events:none;'
        label.textContent = `R ${pos.entityId?.slice(0, 6) ?? '?'} ${(pos.speedKmh ?? 0).toFixed(0)}km/h`
        el.appendChild(label)
        const marker = new maplibregl.Marker({ element: el })
          .setLngLat([pos.lon, pos.lat])
          .addTo(map)
        markersRef.current.push(marker)
      })
    }

    // Incident markers
    if (layers.incidents && overlay?.incidents) {
      overlay.incidents.forEach((inc: any) => {
        const el = document.createElement('div')
        const color = inc.severity === 'critical' || inc.severity === 'high' ? '#ef4444' : inc.severity === 'medium' ? '#f59e0b' : '#3b82f6'
        el.style.cssText = `width:10px;height:10px;border-radius:50%;background:${color};border:2px solid #fff;cursor:pointer;box-shadow:0 2px 4px rgba(0,0,0,0.3);`
        const label = document.createElement('div')
        label.style.cssText = 'position:absolute;top:-16px;left:50%;transform:translateX(-50%);white-space:nowrap;font-size:9px;color:#fff;background:rgba(0,0,0,0.7);padding:1px 3px;border-radius:3px;pointer-events:none;'
        label.textContent = `${incidentIcon(inc.type)} ${String(inc.severity ?? '?')}`
        el.appendChild(label)
        const marker = new maplibregl.Marker({ element: el })
          .setLngLat([inc.lon ?? 39.2083, inc.lat ?? -6.7924])
          .addTo(map)
        markersRef.current.push(marker)
      })
    }

    // Geofence polygons
    if (layers.geofences && overlay?.trafficZones) {
      overlay.trafficZones.forEach((tz: any) => {
        const coords = (tz.polygon ?? []).map((p: string) => {
          const [lon, lat] = p.split(',').map(Number)
          return [lon, lat]
        }).filter((c: number[]) => c.length === 2 && Number.isFinite(c[0]) && Number.isFinite(c[1]))
        if (coords.length < 3) return
        addGeoJsonLayer(map, `geofence-${tz.zoneId}`, {
          type: 'Feature',
          properties: { label: tz.zoneId },
          geometry: { type: 'Polygon', coordinates: [coords] },
        }, {
          'fill-color': tz.severity === 'critical' || tz.severity === 'high' ? '#ef4444' : tz.severity === 'medium' ? '#f59e0b' : '#3b82f6',
          'fill-opacity': 0.15,
        })
      })
    }
  }, [overlay, layers])

  // Handle address search
  const handleSearch = useCallback(async () => {
    if (!searchQuery.trim()) { setSearchResults([]); return }
    setSearching(true)
    const results = await geocode(searchQuery, 5)
    setSearchResults(results)
    setSearching(false)
  }, [searchQuery])

  // Handle find nearest riders via TomTom matrix
  const handleFindNearest = useCallback(async () => {
    const map = mapRef.current
    if (!map) return
    setFindingNearest(true)
    const center = map.getCenter()
    const origin = { lat: center.lat, lon: center.lng }
    const riders = (overlay?.livePositions ?? []).map((p: any) => ({ lat: p.lat, lon: p.lon }))
    if (riders.length === 0) { setFindingNearest(false); return }
    const result = await calculateMatrix([origin], riders)
    const distances = result.distances?.[0] ?? []
    const withDist = riders.map((r: any, i: number) => ({ ...r, distanceM: distances[i] ?? Infinity }))
    withDist.sort((a: any, b: any) => a.distanceM - b.distanceM)
    setNearestRiders(withDist.slice(0, 10))
    setFindingNearest(false)
  }, [overlay])

  // Fly to search result
  const flyToResult = useCallback((result: { lat: number; lon: number }) => {
    const map = mapRef.current
    if (map) map.flyTo({ center: [result.lon, result.lat], zoom: 15, duration: 1000 })
    setSearchResults([])
  }, [])

  if (error) return <ErrorState title="Traffic overlay unavailable" message={error} onRetry={() => setRetryKey((k) => k + 1)} />
  if (!overlay) return <LoadingSkeleton kind="stats" />

  const criticalIncidents = overlay.incidents.filter((i) => i.severity === 'critical' || i.severity === 'high')

  const handleMapLoad = useCallback((map: maplibregl.Map) => {
    mapRef.current = map
  }, [])

  return (
    <div className="page">
      <div className="page-title-row">
        <h1>Live Map — Traffic & Incidents</h1>
      </div>
      <p className="muted small">{snapshotLabel(overlay.generatedAt)}</p>

      <div className="cards">
        <StatCard label="Total incidents" value={overlay.incidents.length} tone={overlay.incidents.length > 0 ? 'danger' : undefined} />
        <StatCard label="Critical/high" value={criticalIncidents.length} tone={criticalIncidents.length > 0 ? 'danger' : undefined} />
        <StatCard label="Traffic zones" value={overlay.trafficZones.length} />
        <StatCard label="Riders online" value={(overlay.livePositions ?? []).length} />
      </div>

      {/* Search bar + layer toggles + find nearest button */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
        <div style={{ position: 'relative', flex: '1 1 240px', maxWidth: 360 }}>
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
            placeholder="Search address..."
            style={{ width: '100%', padding: '6px 10px', borderRadius: 6, border: '1px solid #444', background: '#1a1a1a', color: '#fff', fontSize: 13 }}
          />
          {searching && <span className="muted small" style={{ position: 'absolute', right: 8, top: 6 }}>...</span>}
          {searchResults.length > 0 && (
            <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, background: '#222', border: '1px solid #444', borderRadius: 6, zIndex: 10, maxHeight: 200, overflow: 'auto' }}>
              {searchResults.map((r, i) => (
                <div key={i} onClick={() => flyToResult(r)} style={{ padding: '6px 10px', cursor: 'pointer', fontSize: 12, borderBottom: '1px solid #333' }}>
                  {r.address}
                </div>
              ))}
            </div>
          )}
        </div>
        {(['traffic', 'riders', 'incidents', 'geofences'] as LayerToggle[]).map((key) => (
          <button key={key} type="button" className={`chip${layers[key] ? ' active' : ''}`} onClick={() => setLayers((p) => ({ ...p, [key]: !p[key] }))}>
            {key.charAt(0).toUpperCase() + key.slice(1)}
          </button>
        ))}
        <button type="button" className="chip" onClick={handleFindNearest} disabled={findingNearest}>
          {findingNearest ? 'Finding...' : 'Find Nearest Riders'}
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 320px', gap: 16 }}>
        <MapLibreMap center={[39.2083, -6.7924]} zoom={12} height={500} onMapLoad={handleMapLoad} />
        <div>
          <h2>Online Riders</h2>
          {(overlay.livePositions ?? []).length === 0 ? (
            <div className="muted small">No riders online.</div>
          ) : (
            <div style={{ maxHeight: 400, overflow: 'auto' }}>
              {(overlay.livePositions ?? []).map((pos: any, i: number) => (
                <div key={pos.entityId ?? i} style={{ padding: '6px 8px', borderBottom: '1px solid #333', fontSize: 13 }}>
                  <div style={{ color: '#fff' }}>Rider {(pos.entityId ?? '').slice(0, 8)}</div>
                  <div className="muted small">{(pos.speedKmh ?? 0).toFixed(1)} km/h · heading {pos.heading ?? 0}°</div>
                  <div className="muted small">Status: {pos.status ?? 'unknown'}</div>
                </div>
              ))}
            </div>
          )}
          {nearestRiders && nearestRiders.length > 0 && (
            <>
              <h2 style={{ marginTop: 12 }}>Nearest Riders</h2>
              <div style={{ maxHeight: 250, overflow: 'auto' }}>
                {nearestRiders.map((r: any, i: number) => (
                  <div key={i} style={{ padding: '6px 8px', borderBottom: '1px solid #333', fontSize: 13 }}>
                    <div style={{ color: '#fff' }}>Rider {(r.entityId ?? '').slice(0, 8)}</div>
                    <div className="muted small">{(r.distanceM / 1000).toFixed(2)} km away</div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {overlay.incidents.length === 0 ? (
        <div className="state-card">
          <div className="state-title">No active incidents</div>
          <div className="state-message">No incidents on the live map right now.</div>
        </div>
      ) : (
        <>
          <h2>Active incidents</h2>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Type</th>
                  <th>Severity</th>
                  <th>Location</th>
                  <th>Description</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {overlay.incidents.map((inc, i) => (
                  <tr key={inc.id} className={selectedIncident === i ? 'row-selected' : undefined} onClick={() => setSelectedIncident(i === selectedIncident ? null : i)}>
                    <td>{incidentIcon(inc.type ?? 'unknown')} {String(inc.type ?? 'unknown').replace(/_/g, ' ')}</td>
                    <td><StatusPill status={String(inc.severity ?? 'unknown')} tone={severityTone(String(inc.severity ?? 'unknown'))} /></td>
                    <td className="mono small">{inc.lat?.toFixed(6)}, {inc.lon?.toFixed(6)}</td>
                    <td className="muted small">{inc.description}</td>
                    <td className="muted">{toLocal(inc.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <h2>Traffic zones</h2>
      {overlay.trafficZones.length === 0 ? (
        <div className="muted small">No traffic data available.</div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Zone</th>
                <th>Severity</th>
                <th>Avg speed</th>
              </tr>
            </thead>
            <tbody>
              {overlay.trafficZones.map((tz) => (
                <tr key={tz.zoneId}>
                  <td className="mono-strong">{tz.zoneId}</td>
                  <td><StatusPill status={String(tz.severity ?? 'unknown')} tone={severityTone(String(tz.severity ?? 'unknown'))} /></td>
                  <td className="mono">{tz.avgSpeedKmh != null ? `${tz.avgSpeedKmh.toFixed(1)} km/h` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="muted small">
        Traffic and incident data refreshes via long-polling and auto-refreshes every 5s. Rider positions update live via WebSocket{wsConnected ? ' (connected)' : ''}.
      </p>
    </div>
  )
}
