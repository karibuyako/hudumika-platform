/* Live API dine-in repository — GET /dine-in/tables/{tableId}/qr,
 * /dine-in/orders/me, /dine-in/orders/{id}, POST /dine-in/orders, plus the
 * mock-only split-bill paths POST/GET /dine-in/orders/{id}/splits.
 *
 * The split surface is mock-only-until-adopted (docs/CONTRACT-ADDITIONS.md
 * #25): DINE-IN.md marks split-bill PLANNED and the generated contract has no
 * dine-in split paths, so these calls ride the parity harness allow-list. A
 * live backend without them 404s/405s and the split sheet/summary fall back
 * to their error/retry states. */
import { api } from '@/api/client';
import type { DineInOrder, GetDineInTableQr200 } from '@hudumika/contract';
import type { DineInRepository, DineInSplit, DineInTableQrContext } from '../index';

export class ApiDineInRepository implements DineInRepository {
  async listMyOrders(): Promise<DineInOrder[]> {
    return api.get<DineInOrder[]>('/dine-in/orders/me');
  }

  async resolveTable(tableId: string): Promise<DineInTableQrContext> {
    const res = await api.get<GetDineInTableQr200>(`/dine-in/tables/${tableId}/qr`);
    // The contract response omits the table's merchant; the server-provided
    // menuUrl (browser fallback — the app never orders through it) carries it
    // as /menu/{merchantId}/{tableId}. Parsed here, never from the raw table id.
    const segments = res.menuUrl.split('/').filter(Boolean);
    const merchantId = segments.at(-2) ?? '';
    return { qrPayload: res.qrPayload, menuUrl: res.menuUrl, merchantId };
  }

  async getOrder(dineInOrderId: string): Promise<DineInOrder> {
    return api.get<DineInOrder>(`/dine-in/orders/${dineInOrderId}`);
  }

  async openOrder(merchantId: string, tableId: string, items: { catalogueItemId: string; quantity: number; options?: string[] }[], idempotencyKey: string): Promise<DineInOrder> {
    return api.post<DineInOrder>('/dine-in/orders', { merchantId, tableId, items }, { idempotencyKey });
  }

  // Mock-only-until-adopted split paths (docs/CONTRACT-ADDITIONS.md #25).
  // splitBill and payMyShare share the POST /dine-in/orders/{id}/splits
  // literal (the parity harness is method-agnostic — one allow-list entry
  // covers both); the pay action rides the body so the surface stays at the
  // two named paths until Team 6 ships the real shape.

  async splitBill(dineInOrderId: string, input: { shares: { label: string; amountTZS: number }[] }, idempotencyKey: string): Promise<DineInSplit> {
    return api.post<DineInSplit>(`/dine-in/orders/${dineInOrderId}/splits`, input, { idempotencyKey });
  }

  async getSplit(dineInOrderId: string): Promise<DineInSplit> {
    return api.get<DineInSplit>(`/dine-in/orders/${dineInOrderId}/splits`);
  }

  async payMyShare(dineInOrderId: string, idempotencyKey: string): Promise<DineInSplit> {
    return api.post<DineInSplit>(`/dine-in/orders/${dineInOrderId}/splits`, { action: 'pay_my_share' }, { idempotencyKey });
  }
}
