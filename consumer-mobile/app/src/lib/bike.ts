/* Bike pure helpers — QR payload parsing shared by the manual entry field
 * and the camera scanner. Meituan bike QR payload format:
 * `hudumika:bike:{code}` where code is the bike's printed QR (e.g. BK-8F3K-4D2A).
 * The scanner also accepts `hudumika:ebike:{code}` for backwards compatibility
 * and plain bike ids for dev entry (e.g. bike_001). All payloads are validated
 * server-side; the client only extracts the identifier.
 */
export const BIKE_QR_PATTERN = /^hudumika:(?:bike|ebike):([a-zA-Z0-9_-]+)$/;
export const BIKE_QR_EXAMPLE = 'hudumika:bike:BK-8F3K-4D2A';

export interface BikeQr {
  code: string;
}

/** Parse a bike QR payload → {code}, or null for anything that is not an
 * exact hudumika:bike:{code} payload. The caller resolves the bike via the
 * repository — the QR names the bike only. */
export function parseBikeQr(payload: string): BikeQr | null {
  const trimmed = payload.trim();
  const match = BIKE_QR_PATTERN.exec(trimmed);
  if (match) return { code: match[1] };
  // Plain code fallback for dev manual entry (e.g. BK-XXXX or bike_001)
  if (/^(?:BK-[A-Z0-9-]+|bike_[a-z0-9_]+)$/i.test(trimmed)) return { code: trimmed };
  return null;
}

/** Geofence: Dar es Salaam allowed zone center + radius. Rides finishing
 * outside this radius incur a surcharge and are flagged as violations.
 * The server is authority; this is a client-side hint for the preview. */
export const GEOFENCE_CENTER = { lat: -6.7924, lon: 39.2083 };
export const GEOFENCE_RADIUS_KM = 7;

/** Fare constants — integer TZS. The server recomputes authoritatively;
 * the client uses these for the preview breakdown. */
export const BIKE_UNLOCK_FEE_TZS = 500;
export const BIKE_PER_MINUTE_TZS = 100;
export const EBIKE_PER_MINUTE_TZS = 150;
export const GEOFENCE_SURCHARGE_TZS = 5000;
