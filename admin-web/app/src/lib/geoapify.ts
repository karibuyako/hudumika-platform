// Geoapify API service layer
// Docs: https://apidocs.geoapify.com/

const GEOAPIFY_KEY = import.meta.env.VITE_GEOAPIFY_API_KEY || '';
const GEOAPIFY_BASE = 'https://api.geoapify.com';

// ============ ROUTE PLANNER (VRP) ============

export interface RoutePlannerAgent {
  id: string;
  startLocation: [number, number]; // [lon, lat]
  endLocation?: [number, number];
  timeWindows?: [number, number][];
  deliveryCapacity?: number;
}

export interface RoutePlannerShipment {
  id: string;
  pickup: { locationIndex?: number; location?: [number, number]; duration: number };
  delivery: { locationIndex?: number; location?: [number, number]; duration: number };
  amount?: number;
  priority?: number;
}

export interface RoutePlannerResult {
  type: string;
  features: any[];
  properties: any;
}

export async function optimizeRoutes(params: {
  agents: RoutePlannerAgent[];
  shipments: RoutePlannerShipment[];
  locations?: { id: string; location: [number, number] }[];
  mode?: string;
  traffic?: string;
}): Promise<RoutePlannerResult> {
  if (!GEOAPIFY_KEY) return { type: 'FeatureCollection', features: [], properties: {} };
  const body = {
    mode: params.mode || 'drive',
    traffic: params.traffic || 'approximated',
    type: 'balanced',
    agents: params.agents.map(a => ({
      id: a.id,
      start_location: a.startLocation,
      end_location: a.endLocation,
      time_windows: a.timeWindows,
      delivery_capacity: a.deliveryCapacity,
    })),
    shipments: params.shipments.map(s => ({
      id: s.id,
      pickup: {
        location_index: s.pickup.locationIndex,
        location: s.pickup.location,
        duration: s.pickup.duration,
      },
      delivery: {
        location_index: s.delivery.locationIndex,
        location: s.delivery.location,
        duration: s.delivery.duration,
      },
      amount: s.amount,
      priority: s.priority,
    })),
    locations: params.locations || [],
  };
  const res = await fetch(`${GEOAPIFY_BASE}/v1/routeplanner?apiKey=${GEOAPIFY_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return await res.json();
}

// ============ SINGLE ROUTE ============

export async function calculateGeoapifyRoute(
  waypoints: [number, number][], // [lon, lat] pairs
  mode = 'drive'
): Promise<any> {
  if (!GEOAPIFY_KEY || waypoints.length < 2) return null;
  const coords = waypoints.map(w => w.join(',')).join('|');
  const url = `${GEOAPIFY_BASE}/v1/routing?waypoints=${coords}&mode=${mode}&apiKey=${GEOAPIFY_KEY}`;
  const res = await fetch(url);
  return await res.json();
}

// ============ ISOCHRONE (SERVICE AREAS) ============

export interface IsochroneResult {
  type: string;
  features: any[];
}

export async function calculateIsochrone(
  lat: number, lon: number,
  type: 'time' | 'distance',
  range: number[], // seconds for time, meters for distance
  mode = 'drive'
): Promise<IsochroneResult> {
  if (!GEOAPIFY_KEY) return { type: 'FeatureCollection', features: [] };
  const rangeStr = range.join(',');
  const url = `${GEOAPIFY_BASE}/v1/isoline?lat=${lat}&lon=${lon}&type=${type}&mode=${mode}&range=${rangeStr}&apiKey=${GEOAPIFY_KEY}`;
  const res = await fetch(url);
  return await res.json();
}

// ============ BATCH GEOCODING ============

export async function batchGeocode(
  addresses: string[]
): Promise<{ query: string; lat: number; lon: number; formatted: string }[]> {
  if (!GEOAPIFY_KEY || !addresses.length) return [];
  const body = {
    batch: addresses.map(addr => ({
      params: { text: addr, lang: 'en', filter: 'countrycode:TZ' },
    })),
  };
  const res = await fetch(`${GEOAPIFY_BASE}/v1/geocode/search/batch?apiKey=${GEOAPIFY_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  return (data.batch || []).map((r: any, i: number) => ({
    query: addresses[i],
    lat: r.features?.[0]?.geometry?.coordinates?.[1] || 0,
    lon: r.features?.[0]?.geometry?.coordinates?.[0] || 0,
    formatted: r.features?.[0]?.properties?.formatted || '',
  }));
}

// ============ MAP TILES ============

export const GEOAPIFY_MAP_STYLE = `https://maps.geoapify.com/v1/styles/osm-bright/style.json?apiKey=${GEOAPIFY_KEY}`;
export const GEOAPIFY_DARK_STYLE = `https://maps.geoapify.com/v1/styles/dark-matter/style.json?apiKey=${GEOAPIFY_KEY}`;
