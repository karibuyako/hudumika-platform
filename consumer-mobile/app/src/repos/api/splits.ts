/* Live API split-payments repository — POST /splits, GET /splits/{id},
 * POST /splits/{id}/pay, POST /splits/{id}/complete.
 *
 * Mock-only until the contract ships a split-payment resource (verified
 * against the generated endpoints: no /splits surface exists — the blueprint
 * marks split payments PLANNED, docs/CONTRACT-ADDITIONS.md #22), so every
 * path is mock-only-until-adopted (parity harness allow-list). A live backend
 * without the endpoints 404s/405s and the splits screen falls back to its
 * error/retry state. */
import { api } from '@/api/client';
import type { PaymentIntentCreateMethod } from '@hudumika/contract';
import type { SplitPaymentsRepository, SplitPlan } from '../index';

export class ApiSplitPaymentsRepository implements SplitPaymentsRepository {
  async createSplit(input: { orderId: string; shares: { label: string; amountTZS: number }[] }, idempotencyKey: string): Promise<SplitPlan> {
    return api.post<SplitPlan>('/splits', input, { idempotencyKey });
  }

  async getSplit(splitId: string): Promise<SplitPlan> {
    return api.get<SplitPlan>(`/splits/${splitId}`);
  }

  async payMyShare(splitId: string, method: PaymentIntentCreateMethod, idempotencyKey: string): Promise<SplitPlan> {
    return api.post<SplitPlan>(`/splits/${splitId}/pay`, { method }, { idempotencyKey });
  }

  async completeSplit(splitId: string, idempotencyKey: string): Promise<SplitPlan> {
    return api.post<SplitPlan>(`/splits/${splitId}/complete`, {}, { idempotencyKey });
  }
}
