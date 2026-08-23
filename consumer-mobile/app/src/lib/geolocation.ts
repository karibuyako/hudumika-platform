/* Platform-agnostic geolocation wrapper.
 *
 * Browser-safe only: uses the Web Geolocation API (navigator.geolocation) with
 * no native modules (no expo-location), so the app keeps working on web. On
 * platforms without the API the wrapper fails fast with a typed GeoError
 * (UNSUPPORTED) and callers degrade gracefully.
 *
 * Reverse geocoding matches the nearest SEEDED city by haversine distance.
 * Live apps use a maps SDK / server-side reverse geocoding instead — this
 * table is a mock-friendly stand-in keyed to the seeded fixture cities
 * (mockState.buildCities), anchored on the seeded customerLocation
 * ({ lat: -6.7924, lon: 39.2083 } — Dar es Salaam, mockState.ts).
 */
import type { City } from '@hudumika/contract';

export type GeoErrorCode = 'PERMISSION_DENIED' | 'POSITION_UNAVAILABLE' | 'TIMEOUT' | 'UNSUPPORTED';

export class GeoError extends Error {
  constructor(
    public code: GeoErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'GeoError';
  }
}

export interface GeoPosition {
  lat: number;
  lon: number;
  /** meters — always from the platform, never fabricated */
  accuracy: number;
}

export function getCurrentPosition(opts: { timeoutMs?: number } = {}): Promise<GeoPosition> {
  return new Promise((resolve, reject) => {
    const geo = typeof navigator !== 'undefined' ? navigator.geolocation : undefined;
    if (!geo) {
      reject(new GeoError('UNSUPPORTED', 'Geolocation is not available on this device'));
      return;
    }
    const onSuccess = (pos: { coords: { latitude: number; longitude: number; accuracy: number } }) => {
      resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude, accuracy: pos.coords.accuracy });
    };
    const onError = (err: { code: number; message?: string }) => {
      const code: GeoErrorCode =
        err.code === 1 ? 'PERMISSION_DENIED' : err.code === 2 ? 'POSITION_UNAVAILABLE' : err.code === 3 ? 'TIMEOUT' : 'POSITION_UNAVAILABLE';
      reject(new GeoError(code, err.message ?? `Geolocation error code ${err.code}`));
    };
    geo.getCurrentPosition(onSuccess, onError, { enableHighAccuracy: true, timeout: opts.timeoutMs ?? 10_000, maximumAge: 0 });
  });
}

/** Great-circle distance in km between two WGS84 points (haversine). */
export function haversineKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(Math.min(1, h)));
}

export interface CityGeoRef {
  id: string;
  name: string;
  lat: number;
  lon: number;
  serviceAreas: { id: string; name: string; lat: number; lon: number }[];
}

/** Seed coordinate anchors for the fixture cities (see header comment).
 * In production, the city IDs are real UUIDs from GET /cities (e.g., 6fe36672-... for Dar).
 * The mock ids city_dar etc. are kept for dev with mockState. */
export function knownCityCoords(): CityGeoRef[] {
  const isProd = process.env.EXPO_PUBLIC_ENV === 'production';
  return [
    {
      id: isProd ? '6fe36672-54ff-4968-ac5e-b5e85b2a4838' : 'city_dar',
      name: 'Dar es Salaam',
      // Anchored to the seeded mockState.customerLocation.
      lat: -6.7924,
      lon: 39.2083,
      serviceAreas: [
        { id: 'area_kinondoni', name: 'Kinondoni', lat: -6.767, lon: 39.247 },
        { id: 'area_ilala', name: 'Ilala', lat: -6.8156, lon: 39.2464 },
        { id: 'area_ubungo', name: 'Ubungo', lat: -6.796, lon: 39.1968 },
      ],
    },
    {
      id: 'city_mwanza',
      name: 'Mwanza',
      lat: -2.5164,
      lon: 32.9175,
      serviceAreas: [{ id: 'area_nyamagana', name: 'Nyamagana', lat: -2.5204, lon: 32.892 }],
    },
    {
      id: 'city_arusha',
      name: 'Arusha',
      lat: -3.3869,
      lon: 36.683,
      serviceAreas: [{ id: 'area_arumeru', name: 'Arumeru', lat: -3.3, lon: 36.716 }],
    },
    {
      id: 'city_dodoma',
      name: 'Dodoma',
      lat: -6.163,
      lon: 35.7516,
      serviceAreas: [{ id: 'area_chamwino', name: 'Chamwino', lat: -6.193, lon: 35.771 }],
    },
  ];
}

export interface ReverseGeocodeResult {
  cityId?: string;
  cityName?: string;
  serviceAreaId?: string;
  serviceArea?: string;
  label: string;
}

/** Nearest seeded city (and its nearest service area) by haversine distance.
 * cities — the serviceable list from the home repo (GET /cities); refs not in
 * the seed table are skipped. Live apps use a maps SDK instead of this table. */
export async function reverseGeocode(lat: number, lon: number, cities?: City[]): Promise<ReverseGeocodeResult> {
  // cities omitted → full seed table; cities provided → only those serviceable
  // (an empty list means none of the seeded cities are serviceable).
  const pool = cities === undefined ? knownCityCoords() : knownCityCoords().filter((ref) => cities.some((c) => c.id === ref.id));
  if (!pool.length) return { label: '' };

  let best: CityGeoRef | null = null;
  let bestKm = Infinity;
  for (const ref of pool) {
    const d = haversineKm(lat, lon, ref.lat, ref.lon);
    if (d < bestKm) {
      bestKm = d;
      best = ref;
    }
  }
  if (!best) return { label: '' };

  let area: { id: string; name: string } | null = null;
  let areaKm = Infinity;
  for (const a of best.serviceAreas) {
    const d = haversineKm(lat, lon, a.lat, a.lon);
    if (d < areaKm) {
      areaKm = d;
      area = a;
    }
  }
  return {
    cityId: best.id,
    cityName: best.name,
    serviceAreaId: area?.id,
    serviceArea: area?.name,
    label: area ? `${best.name} · ${area.name}` : best.name,
  };
}

/** GPS fix → nearest seeded city (used by the city picker and home header). */
export async function detectCity(cities: City[]): Promise<ReverseGeocodeResult> {
  const position = await getCurrentPosition();
  return reverseGeocode(position.lat, position.lon, cities);
}

/** Service-area validation (ops #16 LIVE): an address is serviceable when its
 * area matches one of the selected city's serviceAreas (id or name). A city
 * with no areas, or an address with no area recorded, is treated as
 * serviceable — the server remains the authority at dispatch time. */
export function isServiceable(
  address: { serviceArea?: string },
  city: { serviceAreas?: { id?: string; name?: string }[] } | null | undefined,
): boolean {
  if (!city || !city.serviceAreas?.length) return true;
  const area = (address.serviceArea ?? '').trim().toLowerCase();
  if (!area) return true;
  return city.serviceAreas.some((a) => (a.name ?? '').trim().toLowerCase() === area || (a.id ?? '').trim().toLowerCase() === area);
}
