/* Environment-driven config — the ONLY place URLs/behaviour knobs come from.
 *
 * Rule (INSTRUCTIONS.md 3.5): no hardcoded URLs, phones, emails or ratings in
 * screens. Every EXPO_PUBLIC_* variable used here is registered in
 * docs/ENV-VARS.md and the app .env.example.
 */

/** Base API URL (no /api/v1 suffix — the client appends /api). */
export const API_URL = (process.env.EXPO_PUBLIC_API_URL ?? '').replace(/\/$/, '');

/** Navigation deep-link template for "Navigate to job" ({lat},{lon} placeholders). */
export const NAV_URL = process.env.EXPO_PUBLIC_NAV_URL ?? 'https://maps.google.com/?q={lat},{lon}';

export function navigateToCoords(lat: number, lon: number): string {
  return NAV_URL.replace('{lat}', String(lat)).replace('{lon}', String(lon));
}
