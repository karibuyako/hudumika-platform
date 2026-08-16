import { db, uid } from '@/mock/db';
import type { Session, Staff } from '@/mock/types-internal';

export class ApiHttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    public message: string,
    public retriable = false,
    public details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

/* ---------------- Error envelope ----------------
 * The mock emits BOTH error shapes additively:
 *   - `{error:{code,message,retriable,details}}` — legacy app adaptation
 *     (497+ tests assert it; store code reads `error.code`);
 *   - top-level `{code,message,requestId,retryAfterSeconds,errors?}` — the
 *     contract ErrorResponse / ValidationResponse (API-CONTRACT.yaml).
 * 429 responses also carry the `Retry-After` header (seconds), which the
 * client honors (capped at 30s). */

let requestSeq = 0;

export function newRequestId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  requestSeq += 1;
  return `req-${Date.now().toString(36)}-${requestSeq.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Contract-shaped error fields for an ApiHttpError. */
export function errorEnvelope(e: { status: number; code: string; message: string; retriable?: boolean; details?: Record<string, unknown> }): Record<string, unknown> {
  const body: Record<string, unknown> = {
    error: { code: e.code, message: e.message, retriable: e.retriable ?? false, details: e.details },
    code: e.code,
    message: e.message,
    requestId: newRequestId(),
  };
  const retryAfterSeconds = typeof e.details?.retryAfterSeconds === 'number' ? e.details.retryAfterSeconds : undefined;
  if (retryAfterSeconds !== undefined) body.retryAfterSeconds = retryAfterSeconds;
  if (e.status === 429 && retryAfterSeconds === undefined) body.retryAfterSeconds = 1;
  return body;
}

/** Any handler that responds with an error-shaped body gets the contract
 * top-level fields added (single choke point — feature handlers stay as-is). */
function augmentErrorEnvelope(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null) return body as Record<string, unknown>;
  const b = body as Record<string, unknown>;
  const err = b.error;
  if (!err || typeof err !== 'object') return b;
  const e = err as { code?: unknown; message?: unknown };
  if (typeof e.code !== 'string' || typeof e.message !== 'string') return b;
  const out: Record<string, unknown> = { ...b, code: e.code, message: e.message };
  if (out.requestId === undefined) out.requestId = newRequestId();
  return out;
}

export const json = (status: number, body: unknown): Response => {
  const out = augmentErrorEnvelope(body);
  const headers: Record<string, string> = {};
  const retryAfterSeconds = (out as { retryAfterSeconds?: unknown }).retryAfterSeconds;
  if (status === 429 && typeof retryAfterSeconds === 'number') {
    headers['retry-after'] = String(Math.max(1, Math.ceil(retryAfterSeconds)));
  }
  return Response.json(out as Parameters<typeof Response.json>[0], { status, headers });
};

export const ok = (body: unknown) => json(200, body);

/* ---------------- Sessions (opaque tokens, server-validated) ---------------- */

const SESSION_TTL_MS = 24 * 3600 * 1000;

function randomToken(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return `${crypto.randomUUID()}${crypto.randomUUID()}`.replace(/-/g, '');
  }
  return Array.from({ length: 48 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
}

export function createSession(
  merchantId: string,
  staffId: string,
  role: Staff['role'] | 'cashier' | 'kitchen' | 'waiter',
  device?: string,
  ip?: string,
): Session {
  const token = randomToken();
  const sessions = db.table<Session>('sessions');
  const session: Session = {
    id: token,
    token,
    refreshToken: randomToken(),
    merchantId,
    staffId,
    role,
    createdAt: Date.now(),
    expiresAt: Date.now() + SESSION_TTL_MS,
    revoked: false,
    device: device ?? 'Merchant Pro App',
    ip: ip ?? `203.0.113.${Math.floor(Math.random() * 200) + 1}`,
  };
  sessions.insert(session);
  return session;
}

/** Device fingerprint for a login request (sweeper new-device detection). */
export function deviceOf(request: Request): string {
  const ua = request.headers.get('user-agent');
  if (ua) {
    const mobile = /Mobile|Android|iPhone/i.test(ua) ? 'mobile' : 'desktop';
    const browser = /Edg\//i.test(ua) ? 'Edge' : /Chrome\//i.test(ua) ? 'Chrome' : /Firefox\//i.test(ua) ? 'Firefox' : /Safari\//i.test(ua) ? 'Safari' : 'Unknown';
    return `${browser} on ${mobile}`;
  }
  return 'Merchant Pro App';
}

export function revokeSession(token: string) {
  const sessions = db.table<Session>('sessions');
  const s = sessions.find(token);
  if (s) sessions.update(token, { revoked: true });
}

export function getSession(token?: string | null): Session | undefined {
  if (!token) return undefined;
  const s = db.table<Session>('sessions').find(token);
  if (!s || s.revoked || s.expiresAt < Date.now()) return undefined;
  return s;
}

/** Extract Bearer token from request headers. */
export function bearer(request: Request): string | undefined {
  const h = request.headers.get('authorization');
  if (!h) return undefined;
  return h.replace(/^Bearer\s+/i, '');
}

export function requireSession(request: Request): Session {
  const session = getSession(bearer(request));
  if (!session) throw new ApiHttpError(401, 'UNAUTHORIZED', 'Session missing or expired', true);
  return session;
}

/* ---------------- RBAC ----------------
 * Permission resolution is additive across two sources:
 *   - the legacy `staff` table (owner | manager | staff), and
 *   - the contract `merchantStaff` roster (owner | manager | cashier | kitchen
 *     | waiter, STAFF-AND-DEVICES.md) matched to the session by phone.
 * The session's effective permissions are the UNION of both, so legacy rows
 * keep their behavior while roster rows contribute the documented matrix and
 * any stored extra scopes ("granting beyond a role is PATCH with the
 * permission added"). Suspended roster rows lose ALL actions immediately. */

const ROLE_PERMS: Record<Staff['role'], string[]> = {
  owner: ['*'],
  manager: ['orders:manage', 'orders:accept', 'menu:manage', 'finance:view', 'redemption', 'campaigns:manage', 'team:manage', 'audit:view', 'support', 'store:manage', 'reviews:reply'],
  staff: ['orders:accept', 'redemption'],
};

/** Documented 5-role matrix (STAFF-AND-DEVICES.md §16–26). Owner = '*'. */
export const STAFF_ROLE_PERMS: Record<'owner' | 'manager' | 'cashier' | 'kitchen' | 'waiter', string[]> = {
  owner: ['*'],
  manager: ['orders:manage', 'orders:accept', 'menu:manage', 'finance:view', 'redemption', 'campaigns:manage', 'team:manage', 'audit:view', 'support', 'store:manage', 'reviews:reply'],
  cashier: ['redemption', 'dine_in:billing'],
  kitchen: ['dine_in:prep'],
  waiter: ['orders:view', 'dine_in:serve'],
};

type MerchantStaffRow = import('@/api/types').MerchantStaff & { merchantId: string };

/** Contract roster row for the session's staff account (matched by phone). */
export function rosterStaffRow(session: Session): MerchantStaffRow | undefined {
  const legacy = db.table<Staff>('staff').find(session.staffId);
  if (!legacy) return undefined;
  return db
    .table<MerchantStaffRow>('merchantStaff')
    .where((s) => s.merchantId === session.merchantId && s.phone === legacy.phone)[0];
}

/** Effective permissions for a staff account — shared by sessions and /auth/me.
 * Legacy base = the row's OWN stored scopes (all legacy rows are created and
 * kept in sync with their role defaults, so behavior is unchanged); roster
 * rows contribute the documented matrix + any stored extra scopes. */
export function permissionsForStaff(merchantId: string, staffId: string): string[] {
  const s = db.table<Staff>('staff').find(staffId);
  if (!s) return [];
  const legacyPerms = s.permissions.includes('*') ? ['*'] : s.permissions.length ? s.permissions : ROLE_PERMS[s.role];
  if (legacyPerms.includes('*')) return ['*'];
  const roster = db
    .table<MerchantStaffRow>('merchantStaff')
    .where((r) => r.merchantId === merchantId && r.phone === s.phone)[0];
  if (!roster) return legacyPerms;
  const rosterPerms = (roster.permissions?.includes('*') ? ['*'] : [...(STAFF_ROLE_PERMS[roster.role] ?? []), ...(roster.permissions ?? [])]);
  if (rosterPerms.includes('*')) return ['*'];
  return [...new Set([...legacyPerms, ...rosterPerms])];
}

export function staffOf(session: Session): Staff {
  const s = db.table<Staff>('staff').find(session.staffId);
  if (!s || !s.active) throw new ApiHttpError(403, 'ACCOUNT_DISABLED', 'Staff account is not active');
  const roster = rosterStaffRow(session);
  if (roster && roster.status === 'suspended') {
    throw new ApiHttpError(403, 'STAFF_SUSPENDED', 'This staff account is suspended — all actions are blocked', false, { status: 'suspended' });
  }
  return s;
}

export function permissionsOf(session: Session): string[] {
  const s = staffOf(session);
  return permissionsForStaff(session.merchantId, s.id);
}

export function requirePerm(session: Session, perm: string): Staff {
  const perms = permissionsOf(session);
  if (!perms.includes('*') && !perms.includes(perm)) {
    throw new ApiHttpError(403, 'STAFF_ROLE_FORBIDDEN', `Missing permission: ${perm}`, false, { perm, allowed: perms });
  }
  return staffOf(session);
}

/* ---------------- Audit trail ---------------- */

export function audit(
  merchantId: string,
  actorId: string,
  role: string,
  action: string,
  resource: string,
  resourceId: string,
  detail: string,
) {
  db.table('auditLogs').insert({
    id: uid('a'),
    merchantId,
    actor: actorId,
    role,
    action,
    resource,
    resourceId,
    detail,
    ts: Date.now(),
  });
}

/* ---------------- Rate limiting (fixed window per key) ---------------- */

const rateBuckets = new Map<string, { windowStart: number; count: number }>();

export function rateLimit(key: string, max: number, windowMs: number) {
  const now = Date.now();
  const b = rateBuckets.get(key);
  if (!b || b.windowStart + windowMs < now) {
    rateBuckets.set(key, { windowStart: now, count: 1 });
    return;
  }
  b.count += 1;
  if (b.count > max) {
    const retryAfterSeconds = Math.max(1, Math.ceil((b.windowStart + windowMs - now) / 1000));
    throw new ApiHttpError(429, 'RATE_LIMITED', `Too many requests — try again in ${retryAfterSeconds}s`, true, { retryAfterSeconds });
  }
}

/* ---------------- PII / privacy helpers ---------------- */

export function maskPhone(phone: string): string {
  return phone.length >= 7 ? `${phone.slice(0, 3)}****${phone.slice(-4)}` : phone;
}

export function maskName(name: string): string {
  return name.length >= 2 ? `${name[0]}**` : name;
}

/** Keep PII out of audit logs: orders are logged with masked customer. */
export function pii(customer: { name: string; phone: string }): { name: string; phone: string } {
  return { name: maskName(customer.name), phone: maskPhone(customer.phone) };
}
