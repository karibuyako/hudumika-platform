export type FacilityPolicy = 'whitelist_only' | 'whitelist_or_otp' | 'open';

export interface FacilityWhitelistEntry {
  facilityId: string;
  facilityName: string;
  policy: FacilityPolicy;
  grantedAt: string | null;
  revokedAt: string | null;
  status: 'granted' | 'revoked';
  lastScanOutcome?: { at: string; scanType: string; result: 'granted' | 'blocked'; requestId?: string; code?: string } | null;
}

export interface FacilityScan {
  facilityId: string;
  facilityName: string;
  at: string;
  result: 'granted' | 'blocked';
  requestId?: string;
  code?: string;
}
