/* Maps abstraction — the app's single seam to map rendering (MASTER-BLUEPRINT
 * §26: "One Location/Maps SDK abstraction used by address selection, merchant
 * distance, delivery/provider/rider tracking … never embed a map provider
 * directly").
 *
 * THIS FILE IS THE WEB-SAFE PLACEHOLDER FOR THE NATIVE MAPS SDK. It is pure,
 * dependency-free math: no react-native-maps, no MapLibre, no Google Maps, no
 * tiles, no WebView. The web demo renders an honest schematic mini-map (a
 * bordered box + grid + pin — see src/components/MapView.tsx) instead of
 * fake map imagery.
 *
 * NATIVE SEAM: production swaps this file for a real SDK behind the same
 * interface. projectTo2D / renderMapSurface become thin adapters over
 * react-native-maps (MapView + Camera + Marker) or MapLibre; the app only
 * ever imports from '@/lib/maps' and '@/components/MapView' — nothing in the
 * app imports a native maps package directly.
 */
import type { GeoPosition } from '@/lib/geolocation';

/** WGS84 point. lat/lon — the app's canonical order (geolocation, contract). */
export interface Coordinate {
  lat: number;
  lon: number;
}

/** Rectangular viewport for a mini-map surface (px). */
export interface MapBounds {
  width: number;
  height: number;
}

/* ---------- default surface geometry ---------- */

export const MAP_DEFAULT_WIDTH = 280;
export const MAP_DEFAULT_HEIGHT = 180;
/** Default scale when no accuracy is given: px per km at zoom = 1. */
export const MAP_DEFAULT_ZOOM_PX_PER_KM = 80;
export const MAP_MIN_ZOOM_PX_PER_KM = 24;
export const MAP_MAX_ZOOM_PX_PER_KM = 320;
/** Smallest rendered accuracy disc (px) — an exact fix is still visible. */
export const ACCURACY_MIN_PX = 4;
/** Keep the accuracy disc inside the surface bounds. */
export const ACCURACY_PAD_PX = 8;

/* ---------- projection ---------- */

/** km per degree of latitude (equirectangular — constant). */
const KM_PER_DEG_LAT = 111.32;
const DEG_TO_RAD = Math.PI / 180;

/** Equirectangular projection around `center`, in px, at `zoom` px/km.
 *
 * Returns [x, y] with the origin AT the center point (x east, y north):
 *   x = Δlon · kmPerDegLon(center) · zoom
 *   y = −Δlat · kmPerDegLat · zoom
 *
 * Linear in distance, so local neighborhoods (the tracking map, the address
 * pin preview) render without distortion artifacts; fine for any viewport a
 * few km across. NATIVE SEAM: swap for the SDK camera's projected coordinates
 * — keep the same signature so tests and callers stay put.
 */
export function projectTo2D(coord: Coordinate, center: Coordinate, zoom: number): number[] {
  const kmPerDegLon = KM_PER_DEG_LAT * Math.cos(center.lat * DEG_TO_RAD);
  return [
    (coord.lon - center.lon) * kmPerDegLon * zoom,
    (center.lat - coord.lat) * KM_PER_DEG_LAT * zoom,
  ];
}

/* ---------- zoom ---------- */

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Scale (px/km) for a surface: fits the accuracy disc on screen when one is
 * given, defaults otherwise. Pure — the MapView derives its zoom from here. */
export function deriveZoom(accuracyKm?: number): number {
  if (!accuracyKm || accuracyKm <= 0) return MAP_DEFAULT_ZOOM_PX_PER_KM;
  return clamp(MAP_DEFAULT_ZOOM_PX_PER_KM / accuracyKm, MAP_MIN_ZOOM_PX_PER_KM, MAP_MAX_ZOOM_PX_PER_KM);
}

/* ---------- surface renderer (pure) ---------- */

export interface MapSurfaceInput {
  center: Coordinate;
  marker?: Coordinate | null;
  /** Accuracy in km (GeoPosition.accuracy is meters — divide by 1000). */
  accuracy?: number;
  width?: number;
  height?: number;
}

export interface MapSurfaceMarker {
  /** px within the surface, origin top-left (projectTo2D output re-orientated). */
  x: number;
  y: number;
  /** False when the projected point falls outside the viewport. */
  visible: boolean;
}

export interface MapSurface {
  markers: MapSurfaceMarker[];
  /** The zoom (px/km) the surface rendered at. */
  zoom: number;
}

/** "Tile" renderer math: given a center, an optional marker and an accuracy,
 * returns the marker's position on the surface. Pure and Node-safe — tests
 * assert the projection here. A null marker renders an empty surface (the
 * caller shows the location-unavailable state). */
export function renderMapSurface(input: MapSurfaceInput): MapSurface {
  const zoom = deriveZoom(input.accuracy);
  if (!input.marker) return { markers: [], zoom };
  const width = input.width ?? MAP_DEFAULT_WIDTH;
  const height = input.height ?? MAP_DEFAULT_HEIGHT;
  const [x, y] = projectTo2D(input.marker, input.center, zoom);
  return {
    markers: [
      {
        x: width / 2 + x,
        y: height / 2 + y,
        visible: x >= -width / 2 && x <= width / 2 && y >= -height / 2 && y <= height / 2,
      },
    ],
    zoom,
  };
}

/* ---------- MapView props (pure) ---------- */

export interface MapProps {
  hasMarker: boolean;
  /** px within the surface, origin top-left — the marker pin's anchor point. */
  markerX: number;
  markerY: number;
  /** px radius of the accuracy disc (0 when no accuracy given). */
  accuracyRadius: number;
  /** The zoom (px/km) used for the projection. */
  zoomPxPerKm: number;
}

/** Pure render logic for MapView: marker placement + accuracy disc sizing.
 * Extracted from the component so tests can assert the positioning math
 * without rendering (and without react-native in the node bundle). */
export function mapProps(
  center: Coordinate,
  marker: Coordinate | null,
  accuracyKm?: number,
  width = MAP_DEFAULT_WIDTH,
  height = MAP_DEFAULT_HEIGHT,
): MapProps {
  const zoom = deriveZoom(accuracyKm);
  if (!marker) {
    return { hasMarker: false, markerX: width / 2, markerY: height / 2, accuracyRadius: 0, zoomPxPerKm: zoom };
  }
  const surface = renderMapSurface({ center, marker, accuracy: accuracyKm, width, height });
  const m = surface.markers[0];
  const maxRadius = Math.min(width, height) / 2 - ACCURACY_PAD_PX;
  const accuracyRadius = accuracyKm && accuracyKm > 0 ? clamp(accuracyKm * zoom, ACCURACY_MIN_PX, maxRadius) : 0;
  return { hasMarker: true, markerX: m.x, markerY: m.y, accuracyRadius, zoomPxPerKm: zoom };
}

/* ---------- labels ---------- */

/** "lat, lon" — 5 decimals (~1 m precision). Used for the surface caption and
 * the tracking/address a11y labels; the visible copy is prefixed by the
 * caller via the i18n map.coordinates key. */
export function coordinateLabel(coord: Coordinate): string {
  return `${coord.lat.toFixed(5)}, ${coord.lon.toFixed(5)}`;
}

/** Normalize a contract/mock position (possibly partial) to a Coordinate. */
export function toCoordinate(pos: { lat?: number; lon?: number } | null | undefined): Coordinate | null {
  if (!pos || pos.lat === undefined || pos.lon === undefined) return null;
  if (!Number.isFinite(pos.lat) || !Number.isFinite(pos.lon)) return null;
  return { lat: pos.lat, lon: pos.lon };
}

/** GeoPosition (meters accuracy) → surface accuracy in km. */
export function accuracyKmFor(position: Pick<GeoPosition, 'accuracy'>): number | undefined {
  return position.accuracy > 0 ? position.accuracy / 1000 : undefined;
}
