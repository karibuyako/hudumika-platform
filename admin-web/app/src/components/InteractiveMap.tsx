import React, { useRef, useEffect, useState, useCallback } from 'react';
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

interface MapMarker {
  id: string;
  lat: number;
  lon: number;
  label?: string;
  color?: string;
  icon?: string;
  popup?: string;
}

interface MapPolygon {
  id: string;
  coordinates: number[][][];
  color?: string;
  label?: string;
  fillOpacity?: number;
}

interface MapLine {
  id: string;
  coordinates: number[][];
  color?: string;
  width?: number;
}

interface InteractiveMapProps {
  markers?: MapMarker[];
  polygons?: MapPolygon[];
  lines?: MapLine[];
  center?: { lat: number; lon: number };
  zoom?: number;
  onMarkerClick?: (marker: MapMarker) => void;
  onMapClick?: (lat: number, lon: number) => void;
  height?: number;
  style?: string;
  mapRef?: React.MutableRefObject<maplibregl.Map | null>;
}

const DEFAULT_STYLE = 'https://tiles.openfreemap.org/styles/liberty';
const DAR_ES_SALAAM = { lat: -6.7924, lon: 39.2083 };

export function InteractiveMap({
  markers = [],
  polygons = [],
  lines = [],
  center = DAR_ES_SALAAM,
  zoom = 12,
  onMarkerClick,
  onMapClick,
  height = 500,
  style = DEFAULT_STYLE,
  mapRef: externalMapRef,
}: InteractiveMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const internalMapRef = useRef<maplibregl.Map | null>(null);
  const markersRef = useRef<maplibregl.Marker[]>([]);

  // Initialize map
  useEffect(() => {
    if (!containerRef.current || internalMapRef.current) return;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style,
      center: [center.lon, center.lat],
      zoom,
    });

    map.addControl(new maplibregl.NavigationControl(), 'top-right');
    map.addControl(new maplibregl.ScaleControl(), 'bottom-left');

    map.on('click', (e: maplibregl.MapMouseEvent) => {
      if (onMapClick) onMapClick(e.lngLat.lat, e.lngLat.lng);
    });

    internalMapRef.current = map;
    if (externalMapRef) externalMapRef.current = map;

    return () => {
      map.remove();
      internalMapRef.current = null;
    };
  }, []);

  // Update center/zoom
  useEffect(() => {
    const map = internalMapRef.current;
    if (!map) return;
    map.flyTo({ center: [center.lon, center.lat], zoom, duration: 500 });
  }, [center.lat, center.lon, zoom]);

  // Update markers
  useEffect(() => {
    const map = internalMapRef.current;
    if (!map) return;

    // Remove old markers
    markersRef.current.forEach(m => m.remove());
    markersRef.current = [];

    // Add new markers
    markers.forEach(m => {
      const el = document.createElement('div');
      el.style.cssText = `width:14px;height:14px;border-radius:50%;background:${m.color || '#ef4444'};border:2px solid #fff;cursor:pointer;box-shadow:0 2px 4px rgba(0,0,0,0.3);`;

      if (m.label) {
        const label = document.createElement('div');
        label.style.cssText = 'position:absolute;top:-20px;left:50%;transform:translateX(-50%);white-space:nowrap;font-size:10px;color:#fff;background:rgba(0,0,0,0.7);padding:1px 4px;border-radius:3px;pointer-events:none;';
        label.textContent = m.label;
        el.appendChild(label);
      }

      const marker = new maplibregl.Marker({ element: el })
        .setLngLat([m.lon, m.lat])
        .addTo(map);

      if (m.popup) {
        marker.setPopup(new maplibregl.Popup().setHTML(`<div style="padding:4px 8px;font-size:12px;">${m.popup}</div>`));
      }

      if (onMarkerClick) {
        el.addEventListener('click', () => onMarkerClick(m));
      }

      markersRef.current.push(marker);
    });
  }, [markers]);

  // Update polygons
  useEffect(() => {
    const map = internalMapRef.current;
    if (!map) return;

    // Remove old polygon layers
    polygons.forEach(p => {
      if (map.getLayer(`polygon-fill-${p.id}`)) map.removeLayer(`polygon-fill-${p.id}`);
      if (map.getLayer(`polygon-outline-${p.id}`)) map.removeLayer(`polygon-outline-${p.id}`);
      if (map.getSource(`polygon-${p.id}`)) map.removeSource(`polygon-${p.id}`);
    });

    // Add new polygons
    polygons.forEach(p => {
      map.addSource(`polygon-${p.id}`, {
        type: 'geojson',
        data: {
          type: 'Feature',
          properties: { label: p.label },
          geometry: { type: 'Polygon', coordinates: p.coordinates },
        },
      });
      map.addLayer({
        id: `polygon-fill-${p.id}`,
        type: 'fill',
        source: `polygon-${p.id}`,
        paint: { 'fill-color': p.color || '#3b82f6', 'fill-opacity': p.fillOpacity || 0.2 },
      });
      map.addLayer({
        id: `polygon-outline-${p.id}`,
        type: 'line',
        source: `polygon-${p.id}`,
        paint: { 'line-color': p.color || '#3b82f6', 'line-width': 2 },
      });
    });
  }, [polygons]);

  // Update lines
  useEffect(() => {
    const map = internalMapRef.current;
    if (!map) return;

    lines.forEach(l => {
      if (map.getLayer(`line-${l.id}`)) map.removeLayer(`line-${l.id}`);
      if (map.getSource(`line-${l.id}`)) map.removeSource(`line-${l.id}`);
    });

    lines.forEach(l => {
      map.addSource(`line-${l.id}`, {
        type: 'geojson',
        data: { type: 'Feature', properties: null, geometry: { type: 'LineString', coordinates: l.coordinates } },
      });
      map.addLayer({
        id: `line-${l.id}`,
        type: 'line',
        source: `line-${l.id}`,
        paint: { 'line-color': l.color || '#f59e0b', 'line-width': l.width || 3 },
      });
    });
  }, [lines]);

  return (
    <div style={{ position: 'relative', borderRadius: 8, overflow: 'hidden' }}>
      <div ref={containerRef} style={{ width: '100%', height }} />
    </div>
  );
}
