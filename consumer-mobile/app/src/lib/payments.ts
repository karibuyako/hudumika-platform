/* Payment helpers (rider pattern). Money lives in format.ts.
 *
 * Smart defaults (MASTER-BLUEPRINT §37): the checkout and booking forms
 * pre-select the customer's default payment method when the server list is
 * reachable. The contract ListPaymentMethods200Item has no isDefault field —
 * the app-layer PaymentMethodRecord adds it (mock marks one record default).
 */
import type { PaymentMethodRecord } from '@/repos';

/** Pick the method to pre-select: the flagged default first, else the first
 * available record, else the first record. Returns undefined for an empty
 * list so callers keep their hardcoded fallback. */
export function pickDefaultMethod(methods: PaymentMethodRecord[]): PaymentMethodRecord | undefined {
  if (methods.length === 0) return undefined;
  const flagged = methods.find((m) => m.isDefault === true);
  if (flagged) return flagged;
  return methods.find((m) => m.available !== false) ?? methods[0];
}
