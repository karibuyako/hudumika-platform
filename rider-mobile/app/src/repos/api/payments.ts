/* Live API payment repository. Thin typed wrapper over the hardened client.
 *
 * Paths (API-CONTRACT.yaml):
 *   POST /payments/qr   {provider, amountTZS?, description?, orderId?} → PaymentQr
 */
import { api } from '@/api/client';
import type { PaymentQrResult, PaymentRepository } from '../index';
import type { PaymentQr } from '@hudumika/contract';

export class ApiPaymentRepository implements PaymentRepository {
  async createCollectionQr(orderId: string, opts?: { amountTZS?: number }): Promise<PaymentQrResult> {
    const qr = await api.post<PaymentQr>('/payments/qr', {
      provider: 'mpesa',
      amountTZS: opts?.amountTZS ?? null,
      orderId,
    });
    return {
      qrPayload: qr.qrPayload,
      provider: qr.provider,
      amountTZS: qr.amountTZS ?? null,
      merchantRef: qr.merchantRef ?? '',
      expiresAt: qr.expiresAt,
    };
  }
}