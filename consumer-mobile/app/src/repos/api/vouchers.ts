/* Live API vouchers repository — GET /vouchers/me. */
import { api } from '@/api/client';
import type { VouchersRepository } from '../index';
import type { Voucher } from '@hudumika/contract';

export class ApiVouchersRepository implements VouchersRepository {
  async list(status?: string): Promise<Voucher[]> {
    return api.get<Voucher[]>(`/vouchers/me${status ? `?status=${encodeURIComponent(status)}` : ''}`);
  }
}
