/* Live KYC repository — hits the backend NIDA + liveness + sanctions stack.
 * Contract path is POST /providers/me/kyc/verify (enterprise KYC).
 * The mock stub in src/lib/kyc.ts is never called when MOCK_PROFILE is false.
 */
import { api } from '@/api/client';
import type { KycVerification } from '@/lib/kyc';
import type { KycRepository } from '../index';

export class ApiKycRepository implements KycRepository {
  async verify(input: { nidaNumber: string; selfieCaptured: boolean }): Promise<KycVerification> {
    return api.post<KycVerification>('/providers/me/kyc/verify', input);
  }
}
