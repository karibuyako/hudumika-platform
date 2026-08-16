/* Live API group-ordering repository — POST /group-orders,
 * GET /group-orders/{id}, POST /group-orders/{id}/items,
 * DELETE /group-orders/{id}/items, POST /group-orders/{id}/finalize.
 *
 * Mock-only until the contract ships a shared-cart resource (verified against
 * the generated endpoints: no /group-orders surface exists), so every path is
 * mock-only-until-adopted (docs/CONTRACT-ADDITIONS.md #11, parity harness
 * allow-list). A live backend without the endpoints 404s/405s and the screen
 * falls back to its error state. */
import { api } from '@/api/client';
import type { OrderCreate, OrderDetail } from '@hudumika/contract';
import type { GroupOrder, GroupOrderFinalizedOrder, GroupOrdersRepository } from '../index';

export class ApiGroupOrdersRepository implements GroupOrdersRepository {
  async create(input: { merchantId: string; title?: string; expiresInMinutes?: number }, idempotencyKey: string): Promise<GroupOrder> {
    return api.post<GroupOrder>('/group-orders', input, { idempotencyKey });
  }

  async get(groupOrderId: string): Promise<GroupOrder> {
    return api.get<GroupOrder>(`/group-orders/${groupOrderId}`);
  }

  async addItem(groupOrderId: string, memberName: string, item: { catalogueItemId: string; quantity: number; unitPriceTZS?: number; options?: string[] }, idempotencyKey: string): Promise<GroupOrder> {
    return api.post<GroupOrder>(`/group-orders/${groupOrderId}/items`, { memberName, ...item }, { idempotencyKey });
  }

  async removeItem(groupOrderId: string, memberName: string, catalogueItemId: string, idempotencyKey: string): Promise<GroupOrder> {
    return api.delete<GroupOrder>(`/group-orders/${groupOrderId}/items`, { body: { memberName, catalogueItemId }, idempotencyKey });
  }

  async finalize(groupOrderId: string, paymentMethod: OrderCreate['paymentMethod'], deliveryAddress: OrderDetail['deliveryAddress'], idempotencyKey: string): Promise<GroupOrderFinalizedOrder> {
    return api.post<GroupOrderFinalizedOrder>(`/group-orders/${groupOrderId}/finalize`, { paymentMethod, deliveryAddress }, { idempotencyKey });
  }
}
