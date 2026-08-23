/* Enterprise: per-trade requirements (P3 contract addition tradeRequirements).
 * Until the contract exposes this, the client renders from this config — never hardcoded
 * in screens. Mirrors the ONBOARDING.md promise: "per-trade requirement lists are
 * not yet exposed on the contract" — this is the interim source of truth.
 */

export interface TradeRequirement {
  trade: string;
  requiredDocuments: Array<{ type: string; label: string; gov?: boolean }>;
  requiredCertifications: string[];
  sanctionsScreening: boolean;
  uboThresholdPct: number;
}

export const TRADE_REQUIREMENTS: Record<string, TradeRequirement> = {
  plumbing: {
    trade: 'plumbing',
    requiredDocuments: [
      { type: 'identity', label: 'Government ID (NIDA) + selfie', gov: true },
      { type: 'license', label: 'Plumbing License', gov: true },
      { type: 'insurance', label: 'Liability Insurance' },
    ],
    requiredCertifications: ['Plumbing License'],
    sanctionsScreening: true,
    uboThresholdPct: 25,
  },
  electrical: {
    trade: 'electrical',
    requiredDocuments: [
      { type: 'identity', label: 'Government ID (NIDA) + selfie', gov: true },
      { type: 'license', label: 'Electrical Safety Certificate', gov: true },
      { type: 'insurance', label: 'Liability Insurance' },
      { type: 'background_check', label: 'Background Check' },
    ],
    requiredCertifications: ['Electrical Safety Certificate'],
    sanctionsScreening: true,
    uboThresholdPct: 25,
  },
  cleaning: {
    trade: 'cleaning',
    requiredDocuments: [
      { type: 'identity', label: 'Government ID (NIDA) + selfie', gov: true },
    ],
    requiredCertifications: [],
    sanctionsScreening: false,
    uboThresholdPct: 25,
  },
  repairs: {
    trade: 'repairs',
    requiredDocuments: [
      { type: 'identity', label: 'Government ID (NIDA) + selfie', gov: true },
      { type: 'certificate', label: 'Trade Certificate' },
    ],
    requiredCertifications: ['Trade Certificate'],
    sanctionsScreening: true,
    uboThresholdPct: 25,
  },
  carpentry: {
    trade: 'carpentry',
    requiredDocuments: [{ type: 'identity', label: 'Government ID (NIDA) + selfie', gov: true }],
    requiredCertifications: [],
    sanctionsScreening: false,
    uboThresholdPct: 25,
  },
};

export function requirementsFor(trade: string): TradeRequirement {
  return TRADE_REQUIREMENTS[trade] ?? {
    trade,
    requiredDocuments: [{ type: 'identity', label: 'Government ID (NIDA) + selfie', gov: true }],
    requiredCertifications: [],
    sanctionsScreening: true,
    uboThresholdPct: 25,
  };
}

// NIDA (Tanzania National ID) format: 20 digits (placeholder validation; real check calls gov API)
export function isValidNIDA(nida: string): boolean {
  return /^\d{20}$/.test(nida.replace(/\D/g, ''));
}

// UBO (Ultimate Beneficial Owner) — enterprise 25% threshold
export interface UboOwner {
  name: string;
  idNumber: string;
  ownershipPct: number;
  sanctionsChecked: boolean;
}

export function validateUbo(owners: UboOwner[]): string | null {
  const total = owners.reduce((s, o) => s + o.ownershipPct, 0);
  if (total > 100) return 'Total ownership exceeds 100%';
  const over = owners.filter((o) => o.ownershipPct >= 25);
  if (over.some((o) => !o.sanctionsChecked)) return 'Owners ≥25% must pass sanctions screening';
  return null;
}
