/* Enterprise KYC: NIDA + selfie/liveness + sanctions stub (P3).
 * The real verification calls a gov NIDA API + liveness provider + sanctions list.
 * Here we model the enterprise flow with deterministic mocks so the app is
 * enterprise-ready without blocking on backend integration.
 */

export type KycStatus = 'unverified' | 'pending' | 'verified' | 'rejected' | 'expired';
export type LivenessResult = 'pass' | 'fail' | 'pending';

export interface KycVerification {
  nidaNumber: string;
  nidaVerified: boolean;
  selfieUrl?: string | null;
  livenessScore?: number | null; // 0-100
  livenessResult: LivenessResult;
  status: KycStatus;
  sanctionsStatus: 'clear' | 'flagged' | 'pending';
  uboStatus: 'not_required' | 'pending' | 'clear' | 'flagged';
  verifiedAt?: string | null;
  expiresAt?: string | null;
}

export function emptyKyc(): KycVerification {
  return {
    nidaNumber: '',
    nidaVerified: false,
    selfieUrl: null,
    livenessScore: null,
    livenessResult: 'pending',
    status: 'unverified',
    sanctionsStatus: 'pending',
    uboStatus: 'not_required',
  };
}

// Stubbed verification — in production this hits NIDA + liveness provider + sanctions list
// This mock must never be called when the app is running live (MOCK_PROFILE=false or production).
export async function verifyKyc(input: { nidaNumber: string; selfieCaptured: boolean }): Promise<KycVerification> {
  if (process.env.EXPO_PUBLIC_ENV === 'production') {
    throw new Error('verifyKyc mock must not be used in production — use getKycRepository()');
  }
  await new Promise((r) => setTimeout(r, 900));
  const nidaOk = /^\d{20}$/.test(input.nidaNumber.replace(/\D/g, ''));
  const livenessScore = input.selfieCaptured ? 92 : 0;
  return {
    nidaNumber: input.nidaNumber,
    nidaVerified: nidaOk,
    selfieUrl: input.selfieCaptured ? 'mock://selfie/captured.jpg' : null,
    livenessScore,
    livenessResult: livenessScore >= 75 ? 'pass' : 'fail',
    status: nidaOk && livenessScore >= 75 ? 'pending' : 'rejected',
    sanctionsStatus: nidaOk ? 'clear' : 'flagged',
    uboStatus: 'pending',
    verifiedAt: null,
    expiresAt: null,
  };
}
