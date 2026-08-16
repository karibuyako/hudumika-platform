/* Dine-in pure helpers — QR payload parsing shared by the manual entry field
 * and the camera scanner (DINE-IN.md: payload format
 * `hudumika:dinein:table:{tableId}`; accept only the exact prefix; anything
 * else is rejected so a foreign QR never navigates the app). */
export const DINE_IN_QR_PATTERN = /^hudumika:dinein:table:([a-zA-Z0-9_-]+)$/;

export const DINE_IN_QR_EXAMPLE = 'hudumika:dinein:table:table_1';

export interface TableQr {
  tableId: string;
}

/** Parse a table QR payload → {tableId}, or null for anything that is not an
 * exact hudumika:dinein:table:{id} payload (missing prefix, trailing garbage,
 * empty table id). The caller resolves the table via the API — the QR names
 * the table only. */
export function parseTableQr(payload: string): TableQr | null {
  const match = DINE_IN_QR_PATTERN.exec(payload.trim());
  return match ? { tableId: match[1] } : null;
}
