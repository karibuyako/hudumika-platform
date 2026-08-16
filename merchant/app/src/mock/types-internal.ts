import type { Staff } from '@/api/types';

export interface Session {
  id: string;
  token: string;
  refreshToken: string;
  merchantId: string;
  staffId: string;
  role: 'owner' | 'manager' | 'staff' | 'cashier' | 'kitchen' | 'waiter';
  createdAt: number;
  expiresAt: number;
  revoked: boolean;
  /* Device attribution (P8b risk engine): fingerprint + source IP recorded at
   * login so the sweeper can flag new-device logins (TASKS-RISK.md). */
  device?: string;
  ip?: string;
}

export interface OtpCode {
  id: string;
  phone: string;
  code: string;
  purpose: 'login' | 'register';
  expiresAt: number;
  used: boolean;
}

export type StaffRow = Staff;
export type { Staff };
