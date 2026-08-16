/* Idempotency keys (INSTRUCTIONS §3.4, PAYMENTS.md).
 *
 * Generated client-side per mutation attempt: customerId + action + nonce.
 * Retry after a network failure replays the SAME key (the caller keeps the
 * key for the attempt); a genuinely new action gets a fresh key. Keys are
 * never logged with request bodies.
 *
 * The customerId is resolved from the session store (the real signed-in
 * user), never from a caller-supplied placeholder — hardcoded 'cus_1'
 * sentinels in screens must not flow into keys (audit P1-7). The first
 * argument is kept for call-site compatibility but is intentionally ignored;
 * callers pass whatever string they historically did. Importing the session
 * store here is safe: session.ts never imports this module (no cycle).
 */
import { useSessionStore } from '@/store/session';

function currentCustomerId(): string {
  try {
    return useSessionStore.getState().user?.id ?? 'anon';
  } catch {
    return 'anon';
  }
}

export function idempotencyKey(_customerId: string, action: string): string {
  const customerId = currentCustomerId();
  const nonce = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  return `hk_${customerId.slice(0, 8)}_${action}_${nonce}`;
}

/** Stable per-attempt key: same inputs → same key (used for retry replay). */
export function retryKey(_customerId: string, action: string, attemptId: string): string {
  const customerId = currentCustomerId();
  return `hk_${customerId.slice(0, 8)}_${action}_${attemptId}`;
}
