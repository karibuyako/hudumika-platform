// TomTom API service layer
// Docs: https://developer.tomtom.com/

const TOMTOM_API_KEY = import.meta.env.VITE_TOMTOM_API_KEY || '';
const TOMTOM_BASE = 'https://api.tomtom.com';

// ============ GEOCODING ============

export interface GeocodeResult {
  address: string;
  lat: number;
  lon: number;
  score: number;
  type: string;
}

export async function geocode(query: string, limit = 5): Promise<GeocodeResult[]> {
  if (!TOMTOM_API_KEY) return [];
  const url = `${TOMTOM_BASE}/search/2/geocode/${encodeURIComponent(query)}.json?key=${TOMTOM_API_KEY}&limit=${limit}&countrySet=TZ`;
  const res = await fetch(url);
  const data = await res.json();
  return (data.results || []).map((r: any) => ({
    address: r.address?.freeformAddress || '',
    lat: r.position?.lat || 0,
    lon: r.position?.lon || 0,
    score: r.score || 0,
    type: r.type || '',
  }));
}

export async function reverseGeocode(lat: number, lon: number): Promise<string> {
  if (!TOMTOM_API_KEY) return '';
  const url = `${TOMTOM_BASE}/search/2/reverseGeocode/${lat},${lon}.json?key=${TOMTOM_API_KEY}`;
  const res = await fetch(url);
  const data = await res.json();
  return data.addresses?.[0]?.address?.freeformAddress || '';
}

// ============ ROUTING ============

export interface RouteResult {
  distance: number; // meters
  duration: number; // seconds
  geometry: any; // GeoJSON LineString
  legs: any[];
}

export async function calculateRoute(
  origin: { lat: number; lon: number },
  destination: { lat: number; lon: number },
  options?: { avoid?: string[]; traffic?: boolean }
): Promise<RouteResult | null> {
  if (!TOMTOM_API_KEY) return null;
  const points = `${origin.lon},${origin.lat}:${destination.lon},${destination.lat}`;
  let url = `${TOMTOM_BASE}/routing/1/calculateRoute/${points}/json?key=${TOMTOM_API_KEY}&instructionsType=text&routeType=fastest&language=en-US`;
  if (options?.traffic !== false) url += '&traffic=true';
  if (options?.avoid?.length) url += `&avoid=${options.avoid.join(',')}`;
  const res = await fetch(url);
  const data = await res.json();
  const route = data.routes?.[0];
  if (!route) return null;
  return {
    distance: route.summary?.lengthInMeters || 0,
    duration: route.summary?.travelTimeInSeconds || 0,
    geometry: {
      type: 'LineString',
      coordinates: route.legs?.flatMap((leg: any) =>
        leg.points?.map((p: any) => [p.longitude, p.latitude]) || []
      ) || [],
    },
    legs: route.legs || [],
  };
}

// ============ MATRIX ROUTING ============

export interface MatrixResult {
  distances: number[][]; // meters
  durations: number[][]; // seconds
}

export async function calculateMatrix(
  origins: { lat: number; lon: number }[],
  destinations: { lat: number; lon: number }[]
): Promise<MatrixResult> {
  if (!TOMTOM_API_KEY) return { distances: [], durations: [] };
  const origStr = origins.map(o => `${o.lon},${o.lat}`).join(':');
  const destStr = destinations.map(d => `${d.lon},${d.lat}`).join(':');
  const url = `${TOMTOM_BASE}/routing/1/matrix/${origStr}/${destStr}/json?key=${TOMTOM_API_KEY}&travelMode=car&traffic=true`;
  const res = await fetch(url);
  const data = await res.json();
  return {
    distances: data.distances || [],
    durations: data.durations || [],
  };
}

// ============ SNAP TO ROADS ============

export interface SnapResult {
  snappedPoints: any[];
  route: any;
}

export async function snapToRoads(
  points: { lat: number; lon: number }[],
  headings?: number[]
): Promise<SnapResult | null> {
  if (!TOMTOM_API_KEY || points.length < 2) return null;
  const pointsStr = points.map(p => `${p.lon},${p.lat}`).join(';');
  let url = `${TOMTOM_BASE}/snapToRoads/1?key=${TOMTOM_API_KEY}&points=${pointsStr}&fields={projectedPoints{type,geometry{type,coordinates},properties{routeIndex,snapResult}},route{type,geometry{type,coordinates}}}`;
  if (headings?.length) url += `&headings=${headings.join(';')}`;
  const res = await fetch(url);
  return await res.json();
}

// ============ TRAFFIC ============

export interface TrafficFlow {
  currentSpeed: number;
  freeFlowSpeed: number;
  currentTravelTime: number;
  freeFlowTravelTime: number;
  confidence: number;
  roadClosure: boolean;
}

export async function getTrafficFlow(
  lat: number, lon: number,
  radius = 1000
): Promise<TrafficFlow | null> {
  if (!TOMTOM_API_KEY) return null;
  const url = `${TOMTOM_BASE}/traffic/services/4/flowSegmentData/absolute/10/json?key=${TOMTOM_API_KEY}&point=${lat},${lon}`;
  const res = await fetch(url);
  const data = await res.json();
  return data.flowSegmentData || null;
}

// ============ TRAFFIC INCIDENTS ============

export interface TrafficIncident {
  id: string;
  type: string;
  severity: string;
  description: string;
  lat: number;
  lon: number;
  startTime: string;
  endTime: string;
}

export async function getTrafficIncidents(
  lat: number, lon: number,
  radius = 10000
): Promise<TrafficIncident[]> {
  if (!TOMTOM_API_KEY) return [];
  const bbox = `${lon - 0.1},${lat - 0.1},${lon + 0.1},${lat + 0.1}`;
  const url = `${TOMTOM_BASE}/traffic/services/5/incidentDetails?key=${TOMTOM_API_KEY}&bbox=${bbox}&fields={incidents{type,severity,iconCategory,messages{description},geometry{bowtieWrappers{geometry{type,coordinates}}},startTime,endTime}}`;
  const res = await fetch(url);
  const data = await res.json();
  return (data.incidents || []).map((i: any) => ({
    id: i.id || '',
    type: i.type || '',
    severity: i.severity || '',
    description: i.messages?.[0]?.description || '',
    lat: i.geometry?.bowtieWrappers?.[0]?.geometry?.coordinates?.[0]?.[1] || 0,
    lon: i.geometry?.bowtieWrappers?.[0]?.geometry?.coordinates?.[0]?.[0] || 0,
    startTime: i.startTime || '',
    endTime: i.endTime || '',
  }));
}

// ============ MAP STYLE ============

export const TOMTOM_MAP_STYLE = `https://api.tomtom.com/style/1/document/standard?key=${TOMTOM_API_KEY}`;
export const TOMTOM_DARK_STYLE = `https://api.tomtom.com/style/1/document/night?key=${TOMTOM_API_KEY}`;
