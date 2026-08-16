/* Universal checkout shell dispatch (MASTER-BLUEPRINT §1/§2: the typed route
 * is /checkout/:transactionType and §12 says checkout is a universal shell per
 * transactionType — address → time → payment → coupon → price breakdown →
 * confirm). Screens pass the type as a query param; this module maps the
 * param to a typed value. Pure helpers only — the node test suite covers the
 * mapping without rendering the screen. */
export type TransactionType = 'commerce' | 'delivery' | 'service' | 'booking' | 'reservation' | 'hotel';

const TRANSACTION_TYPES: readonly TransactionType[] = ['commerce', 'delivery', 'service', 'booking', 'reservation', 'hotel'];

/** Route param → TransactionType. Absent or unknown values fall back to the
 * 'commerce' order flow so /checkout?merchantId= keeps its existing behavior. */
export function getTransactionType(param: string | string[] | undefined): TransactionType {
  const raw = Array.isArray(param) ? param[0] : param;
  return (TRANSACTION_TYPES as readonly string[]).includes(raw ?? '') ? (raw as TransactionType) : 'commerce';
}
