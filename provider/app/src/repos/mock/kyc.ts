/* Mock KYC repository — delegates to the deterministic stub in src/lib/kyc.ts.
 * Used only when MOCK_PROFILE is true (dev / test). Production uses the live
 * API implementation (src/repos/api/kyc.ts) so no mock verification ships.
 */
import { verifyKyc } from '@/lib/kyc';
import type { KycRepository } from '../index';

export class MockKycRepository implements KycRepository {
  verify(input: { nidaNumber: string; selfieCaptured: boolean }) {
    return verifyKyc(input);
  }
}
