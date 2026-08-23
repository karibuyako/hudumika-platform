/* Environment-driven config — the ONLY place URLs/behaviour knobs come from.
 *
 * Rule (INSTRUCTIONS.md 3.5): no hardcoded URLs, phones, emails or ratings in
 * screens. Every EXPO_PUBLIC_* variable used here is registered in
 * docs/ENV-VARS.md and the app .env.example.
 */

/** Base API URL (normalized: strips trailing /api or /api/v1 so the client can append /api consistently). */
export function normalizeApiBase(raw: string): string {
  return raw.replace(/\/$/, '').replace(/\/api(\/v1)?$/, '');
}

export const API_URL = normalizeApiBase(process.env.EXPO_PUBLIC_API_URL ?? '');

/** Navigation deep-link template for "Navigate to job" ({lat},{lon} placeholders). */
export const NAV_URL = process.env.EXPO_PUBLIC_NAV_URL ?? 'https://maps.google.com/?q={lat},{lon}';

export function navigateToCoords(lat: number, lon: number): string {
  return NAV_URL.replace('{lat}', String(lat)).replace('{lon}', String(lon));
}
