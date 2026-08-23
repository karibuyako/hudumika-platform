/* Power-bank pure helpers — QR payload parsing shared by the manual entry field
 * and the camera scanner. Payload format `hudumika:powerbank:{id}`; accept only
 * the exact prefix; anything else is rejected so a foreign QR never navigates
 * the app. Power-bank rental flow is map → scan → unlock → return → fee
 * (src/app/power-bank.tsx placeholder).
 */
export const POWER_BANK_QR_PATTERN = /^hudumika:powerbank:([a-zA-Z0-9_-]+)$/;

export const POWER_BANK_QR_EXAMPLE = 'hudumika:powerbank:pb_001';

export interface PowerBankQr {
  /** Power-bank / station slot identifier extracted from the QR payload. */
  id: string;
  /** Alias for `id` — compatibility with callers expecting powerBankId. */
  powerBankId: string;
}

/** Parse a power-bank QR payload → {id, powerBankId}, or null for anything
 * that is not an exact hudumika:powerbank:{id} payload (missing prefix,
 * trailing garbage, empty id). Trims surrounding whitespace like parseTableQr. */
export function parsePowerBankQr(payload: string): PowerBankQr | null {
  const match = POWER_BANK_QR_PATTERN.exec(payload.trim());
  return match ? { id: match[1], powerBankId: match[1] } : null;
}

/** Convenience: true when the payload is any supported power-bank QR. */
export function isPowerBankQr(payload: string): boolean {
  return POWER_BANK_QR_PATTERN.test(payload.trim());
}

/** Client-side fee hints — integer TZS. The server is authority; the
 * placeholder screen uses these for the preview breakdown only. */
export const POWER_BANK_HOURLY_FEE_TZS = 1000;
export const POWER_BANK_DEPOSIT_TZS = 5000;
export const POWER_BANK_DAILY_CAP_TZS = 8000;
