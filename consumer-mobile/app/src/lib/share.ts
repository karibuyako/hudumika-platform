/* Share helper (OPERATIONS-COVERAGE #138): order/booking share payloads
 * (message + hudumika:// deep link) and the guarded share sheet. The link
 * mirrors deep-link.ts's canonical route/id scheme, so a shared link opens
 * the same screen a push deep link would. The module stays Node-safe: the
 * react-native import is lazy and never resolved under node (tests/run.mjs
 * marks the package external), so unit tests can import it freely. */
import { t } from '@/i18n';

export type ShareKind = 'order' | 'booking';

export interface SharePayloadInput {
  kind: ShareKind;
  id: string;
  title: string;
  detail: string;
}

/** hudumika://order/{id} / hudumika://booking/{id} — the deep-link.ts scheme. */
export function shareLink(kind: ShareKind, id: string): string {
  return `hudumika://${kind}/${id}`;
}

/** Share message: "Check my order HD-OR-0001 on Hudumika! Delivered · TZS
 * 12,500 — hudumika://order/ord_active_001" (copy via share.message). */
export function buildSharePayload({ kind, id, title, detail }: SharePayloadInput): string {
  return t('share.message', { kind, ref: title, detail, link: shareLink(kind, id) });
}

/** Open the native share sheet with the payload; on web use the Web Share
 * API and fall back to a clipboard copy when that is unavailable or fails.
 * Returns false when no share surface exists (node/SSR — the caller then
 * renders the payload as selectable text). */
export async function shareContent(payload: string): Promise<boolean> {
  // Node/SSR (incl. the unit-test env): nothing to share into.
  if (typeof process !== 'undefined' && typeof process.versions?.node === 'string') return false;

  // Web (react-native-web): Web Share API, then clipboard copy.
  if (typeof document !== 'undefined') {
    try {
      if (typeof navigator !== 'undefined' && navigator.share) {
        await navigator.share({ text: payload });
        return true;
      }
    } catch {
      /* share dismissed or unsupported — clipboard fallback */
    }
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(payload);
        return true;
      }
    } catch {
      /* clipboard unavailable — the caller renders the payload as selectable text */
    }
    return false;
  }

  // Native: react-native Share sheet (lazy import — never resolved under
  // node, which keeps this module test-safe; tests/run.mjs marks it external).
  try {
    const { Share } = await import('react-native');
    await Share.share({ title: t('share.title'), message: payload, url: payload });
    return true;
  } catch {
    return false;
  }
}
