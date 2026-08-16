/* Live API payments repository — POST /payments/intent,
 * /payments/{id}/confirm, GET /payments/methods, /payments/history.
 *
 * GET /payments/methods returns contract ListPaymentMethods200Item[] =
 * { method, available } — no id/label/default fields exist yet, so the app
 * layer derives stable ids and human labels for the PaymentMethodRecord
 * surface (checkout renders the same list).
 */
import { api } from '@/api/client';
import type { ListPaymentMethods200Item, PaymentIntent, PaymentIntentCreate } from '@hudumika/contract';
import type { PaymentMethodRecord, PaymentsRepository } from '../index';

function labelFor(method: string): string {
  return method
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

export class ApiPaymentsRepository implements PaymentsRepository {
  async createIntent(orderId: string, method: string, idempotencyKey: string): Promise<PaymentIntent> {
    const body: PaymentIntentCreate = { orderId, method: method as PaymentIntentCreate['method'] };
    return api.post<PaymentIntent>('/payments/intent', body, { idempotencyKey });
  }

  async confirm(intentId: string, idempotencyKey: string): Promise<PaymentIntent> {
    return api.post<PaymentIntent>(`/payments/${intentId}/confirm`, {}, { idempotencyKey });
  }

  // Mock-only-until-adopted (docs/CONTRACT-ADDITIONS.md #7): POST /payments/methods,
  // DELETE /payments/methods/{methodId} and PUT /payments/methods/{methodId}/default
  // are NOT in the generated contract yet — the parity harness allow-lists the two
  // templated paths until Team 6 ships the mutations. A live backend that has not
  // adopted them 404s these calls; the payments screen treats failures as read-only
  // (the mock registry is what the demo mutates). The bare POST /payments/methods
  // needs no allow-list entry — the harness is method-agnostic and the contract
  // already declares the same literal path.
  async addPaymentMethod(method: string, idempotencyKey: string): Promise<PaymentMethodRecord> {
    return api.post<PaymentMethodRecord>('/payments/methods', { method }, { idempotencyKey });
  }

  async removePaymentMethod(methodId: string, idempotencyKey: string): Promise<void> {
    await api.delete<void>(`/payments/methods/${methodId}`, { idempotencyKey });
  }

  async setDefaultPaymentMethod(methodId: string, idempotencyKey: string): Promise<PaymentMethodRecord> {
    return api.put<PaymentMethodRecord>(`/payments/methods/${methodId}/default`, {}, { idempotencyKey });
  }

  async getPaymentMethods(): Promise<PaymentMethodRecord[]> {
    const list = await api.get<ListPaymentMethods200Item[]>('/payments/methods');
    return list.map((m) => ({
      id: `pm_${m.method}`,
      method: m.method,
      label: labelFor(m.method),
      available: m.available,
    }));
  }

  async getHistory(): Promise<PaymentIntent[]> {
    return api.get<PaymentIntent[]>('/payments/history');
  }
}
