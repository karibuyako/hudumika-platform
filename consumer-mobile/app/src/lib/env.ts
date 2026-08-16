/* Environment configuration reader — EXPO_PUBLIC_* only (ENV-VARS.md).
 * Store/support links are environment-driven config, never hardcoded in
 * code (ARCHITECTURE.md env table). Parsing NEVER throws: missing or
 * malformed input falls back to empty-string defaults and logs a dev
 * warning, so a bad .env cannot crash the app. */

export interface AppLinksConfig {
  /** App Store URL (iOS) — "Rate the app" on iOS. */
  ios: string;
  /** Google Play URL (Android) — "Rate the app" on Android/web. */
  android: string;
  /** Support phone number (click-to-call). */
  supportPhone: string;
  /** Support email address (mailto target). */
  supportEmail: string;
  /** Privacy policy URL. */
  privacyUrl: string;
  /** Terms of service URL. */
  termsUrl: string;
}

/** Empty-string defaults — the documented shape of EXPO_PUBLIC_APP_LINKS
 * (ENV-VARS.md). Rows render only when their value is configured, so an
 * unset link simply hides the corresponding row. */
export const APP_LINKS_DEFAULTS: AppLinksConfig = {
  ios: '',
  android: '',
  supportPhone: '',
  supportEmail: '',
  privacyUrl: '',
  termsUrl: '',
};

const APP_LINKS_KEYS = Object.keys(APP_LINKS_DEFAULTS) as (keyof AppLinksConfig)[];

function warnDev(message: string): void {
  // EXPO_PUBLIC_ENV is `production` in store builds; every other channel
  // (development/staging/unset) is a dev surface where the warning helps.
  if (process.env.EXPO_PUBLIC_ENV !== 'production') {
    console.warn(`[env] ${message}`);
  }
}

/** Pure parser for the EXPO_PUBLIC_APP_LINKS JSON string. Valid string
 * fields are kept; missing fields, non-string values and malformed JSON
 * fall back to the defaults. Never throws. */
export function parseAppLinks(raw: string | undefined | null): AppLinksConfig {
  if (!raw) {
    warnDev('EXPO_PUBLIC_APP_LINKS is not set — falling back to default app links');
    return { ...APP_LINKS_DEFAULTS };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    warnDev('EXPO_PUBLIC_APP_LINKS is malformed JSON — falling back to default app links');
    return { ...APP_LINKS_DEFAULTS };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    warnDev('EXPO_PUBLIC_APP_LINKS is not a JSON object — falling back to default app links');
    return { ...APP_LINKS_DEFAULTS };
  }
  const record = parsed as Record<string, unknown>;
  const links: AppLinksConfig = { ...APP_LINKS_DEFAULTS };
  for (const key of APP_LINKS_KEYS) {
    if (typeof record[key] === 'string') {
      links[key] = record[key];
    }
  }
  return links;
}

/** Typed environment config accessors. Parsing is cheap and never throws;
 * callers use these instead of touching process.env directly. */
export const envConfig = {
  /** Store/support links — '' for any unconfigured link. */
  get appLinks(): AppLinksConfig {
    return parseAppLinks(process.env.EXPO_PUBLIC_APP_LINKS);
  },
};
