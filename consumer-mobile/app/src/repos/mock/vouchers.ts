/* In-memory vouchers repository — GET /vouchers/me. */
import { clone, getState } from './mockState';
import type { VouchersRepository } from '../index';
import type { Voucher } from '@hudumika/contract';

export class MockVouchersRepository implements VouchersRepository {
  async list(status?: string): Promise<Voucher[]> {
    let list = getState().vouchers;
    if (status) list = list.filter((v) => v.status === status);
    return clone(list);
  }
}
