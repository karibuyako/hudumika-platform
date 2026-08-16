/* In-memory payment repository. Mirrors POST /payments/qr (collection QR for
 * COD orders). The QR payload is a fake simulation — the live server renders
 * the real mobile-money QR; the rider app never collects payment details.
 */
import { ApiError } from '@/api/client';
import { getState } from './mockState';
import type { PaymentQrResult, PaymentRepository } from '../index';

export class MockPaymentRepository implements PaymentRepository {
  async createCollectionQr(orderId: string, opts?: { amountTZS?: number }): Promise<PaymentQrResult> {
    const state = getState();
    const order = state.orders.find((o) => o.id === orderId);
    if (!order) throw new ApiError(404, 'ORDER_NOT_FOUND', `Order ${orderId} not found`);
    const last4 = orderId.slice(-4);
    return {
      qrPayload: `mock-qr-payload-${orderId}`,
      provider: 'mpesa',
      amountTZS: opts?.amountTZS ?? order.totals.totalTZS,
      merchantRef: `MER-${last4}`,
      expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    };
  }
}