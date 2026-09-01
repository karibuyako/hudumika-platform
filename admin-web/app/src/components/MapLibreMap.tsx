import React, { useRef, useEffect } from 'react';
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

interface MapLibreMapProps {
  center?: [number, number]; // [lon, lat]
  zoom?: number;
  height?: number;
  style?: string;
  children?: React.ReactNode;
  onMapLoad?: (map: maplibregl.Map) => void;
}

export function MapLibreMap({
  center = [39.2083, -6.7924],
  zoom = 12,
  height = 500,
  style = 'https://tiles.openfreemap.org/styles/liberty',
  onMapLoad,
}: MapLibreMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style,
      center,
      zoom,
    });

    map.addControl(new maplibregl.NavigationControl(), 'top-right');
    map.addControl(new maplibregl.ScaleControl(), 'bottom-left');
    map.addControl(new maplibregl.GeolocateControl({ trackUserLocation: false }), 'top-right');

    map.on('load', () => {
      if (onMapLoad) onMapLoad(map);
    });

    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  return (
    <div ref={containerRef} style={{ width: '100%', height, borderRadius: 8, overflow: 'hidden' }} />
  );
}

export function addTrafficLayer(map: maplibregl.Map, apiKey: string) {
  if (!apiKey) return;
  map.addSource('tomtom-traffic', {
    type: 'raster',
    tiles: [`https://api.tomtom.com/traffic/map/4/tile/flow/absolute/10/{z}/{x}/{y}.png?key=${apiKey}`],
    tileSize: 256,
    maxzoom: 22,
  });
  map.addLayer({
    id: 'tomtom-traffic-layer',
    type: 'raster',
    source: 'tomtom-traffic',
    paint: { 'raster-opacity': 0.4 },
  }, map.getStyle().layers?.[0]?.id);
}

export function addGeoJsonLayer(
  map: maplibregl.Map,
  id: string,
  data: any,
  paint: any,
  layout?: any,
  beforeId?: string
) {
  if (map.getSource(id)) map.removeSource(id);
  if (map.getLayer(id)) map.removeLayer(id);
  map.addSource(id, { type: 'geojson', data });
  map.addLayer({ id, type: 'fill', source: id, paint, layout }, beforeId);
  map.addLayer({
    id: `${id}-outline`,
    type: 'line',
    source: id,
    paint: { 'line-color': paint['fill-color'] || '#3b82f6', 'line-width': 1 },
  }, beforeId);
}

export function fitToMarkers(map: maplibregl.Map, markers: { lat: number; lon: number }[]) {
  if (!markers.length) return;
  const bounds = new maplibregl.LngLatBounds();
  markers.forEach(m => bounds.extend([m.lon, m.lat]));
  map.fitBounds(bounds, { padding: 50, maxZoom: 15 });
}
