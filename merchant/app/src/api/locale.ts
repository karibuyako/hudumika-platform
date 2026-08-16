import { api } from '@/api/client';
import type { Locale } from '@/i18n';

/**
 * Persist the merchant locale server-side: `PATCH /users/me {locale}`
 * (LOCALIZATION.md — locale source is `User.locale`; the switch reflects
 * immediately and persists via the users endpoint).
 *
 * Fire-and-forget with graceful failure — the local `setLocale()` call already
 * updated the UI, so a failed PATCH is never surfaced as an error.
 *
 * WIRING (I10 — profile/settings.tsx pickLocale): after `setLocale(locale)`,
 * call `void persistLocale(locale)`; the auth handler already accepts `locale`
 * (`mock/handlers/auth.ts` PATCH /users/me) and the mock merchants row is
 * seeded with `locale: 'en'` — no other change needed.
 */
export function persistLocale(locale: Locale): Promise<void> {
  return api
    .patch<{ locale: string }>('/users/me', { locale }, { retries: 0 })
    .then(() => undefined)
    .catch(() => undefined);
}
