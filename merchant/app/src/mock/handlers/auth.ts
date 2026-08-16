
import { db, uid, type AnyRow } from '@/mock/db';
import { emit } from '@/mock/events';
import {
  ApiHttpError,
  audit,
  createSession,
  deviceOf,
  ok,
  permissionsForStaff,
  rateLimit,
  revokeSession,
  requireSession,
} from '@/mock/security';
import { h, readJson } from '@/mock/handlers/common';
import type { OtpCode, Session } from '@/mock/types-internal';
import type {
  MerchantDocumentStatus,
  MerchantDocumentType,
  MerchantPayoutAccountRow,
  MerchantStaff,
  MerchantVerificationStatus,
  NotificationDto,
  OnboardingStatusResponse,
  OnboardingStepStatus,
  P10ExtEvent,
  ServerEvent,
  StoreServer,
  VerificationState,
  UserProfile,
} from '@/api/types';
import { DEMO_MERCHANT } from '@/mock/seed';
import { COMMISSION_RATE } from '@/data/seed';

const PHONE_RE = /^\+255[67]\d{8}$/;

const p10Emit = (event: P10ExtEvent) => emit(event as unknown as ServerEvent);

/* ---- Onboarding verification state (docs/ONBOARDING.md — server-owned) ---- */

const ONBOARDING_DOC_TYPES: MerchantDocumentType[] = [
  'business_registration',
  'trading_license',
  'tin_certificate',
  'owner_id',
  'payout_account',
];

/** Server-configured commission in basis points — derived once from the
 *  shared frontend constant (I11-owned); the API, never the UI, states terms. */
const DEFAULT_COMMISSION_BPS = Math.round(COMMISSION_RATE * 10000);

function docTypeFromFileName(fileName: string): MerchantDocumentType {
  const f = fileName.toLowerCase();
  if (f.includes('license')) return 'trading_license';
  if (f.includes('owner') || f.includes('id')) return 'owner_id';
  if (f.includes('tin') || f.includes('tax')) return 'tin_certificate';
  if (f.includes('bank') || f.includes('payout') || f.includes('mobile-money')) return 'payout_account';
  return 'business_registration';
}

function onboardingVerification(merchant: AnyRow): MerchantVerificationStatus {
  const documents = Array.isArray(merchant.documents)
    ? (merchant.documents as MerchantDocumentStatus[])
    : [];
  const status: VerificationState =
    merchant.verification === 'documents_review' ||
    merchant.verification === 'rejected' ||
    merchant.verification === 'changes_requested' ||
    merchant.verification === 'suspended' ||
    merchant.verification === 'approved' ||
    merchant.verification === 'pending'
      ? merchant.verification
      : merchant.status === 'active'
        ? 'approved'
        : merchant.status === 'suspended'
          ? 'suspended'
          : 'pending';
  return {
    status,
    documents,
    reason: merchant.rejectionReason ? String(merchant.rejectionReason) : merchant.changesRequested ? String(merchant.changesRequested) : null,
    reviewedAt: merchant.reviewedAt ? Number(merchant.reviewedAt) : null,
    submittedAt: merchant.onboardingSubmittedAt ? Number(merchant.onboardingSubmittedAt) : null,
  };
}

function onboardingStatus(merchant: AnyRow, store?: StoreServer | undefined): OnboardingStatusResponse {
  const verification = onboardingVerification(merchant);
  const profileDone = !!(store?.name && store?.address);
  const documentsDone = verification.documents.some((d) => d.status !== 'missing');
  const submitted = !!merchant.onboardingSubmittedAt;
  const steps: OnboardingStepStatus[] = [
    { key: 'profile', status: profileDone ? 'done' : 'current' },
    { key: 'documents', status: !profileDone ? 'pending' : documentsDone ? 'done' : 'current' },
    { key: 'submit', status: !documentsDone ? 'pending' : submitted ? 'done' : 'current' },
  ];
  const currentStep = steps.find((s) => s.status === 'current')?.key ?? 'submit';
  return {
    verification,
    steps,
    currentStep,
    completed: submitted || verification.status === 'approved',
    submittedAt: verification.submittedAt,
  };
}

function issueOtp(phone: string, purpose: 'login' | 'register'): { id: string; code: string; expiresInSec: number } {
  rateLimit(`otp:${phone}`, 5, 3600 * 1000);
  const code = String(Math.floor(100000 + Math.random() * 900000));
  const id = uid('o');
  db.table<OtpCode>('otpCodes').insert({
    id,
    phone,
    code,
    purpose,
    expiresAt: Date.now() + 5 * 60 * 1000,
    used: false,
  });
  return { id, code, expiresInSec: 300 };
}

function buildMe(merchantId: string, staffId: string) {
  const merchant = db.table('merchants').find(merchantId);
  const store = db.table('stores').find('s_demo');
  const staff = db.table('staff').find(staffId);
  if (!staff) throw new ApiHttpError(403, 'ACCOUNT_DISABLED', 'Staff account not found');
  // Additive RBAC: the roster row (5-role matrix + stored scopes) is merged
  // over the legacy role list — same resolution the authorization layer uses.
  const permissions = permissionsForStaff(merchantId, staffId);
  return { merchant, store, staff, permissions };
}

/** Contract User (GET/PATCH /users/me) — epoch-ms createdAt, merchantId extension. */
function buildUser(session: Session): UserProfile {
  const merchant = db.table('merchants').find(session.merchantId)!;
  const staff = db.table('staff').find(session.staffId);
  if (!staff || !staff.active) throw new ApiHttpError(403, 'ACCOUNT_DISABLED', 'Staff account not found');
  return {
    id: staff.id,
    phone: staff.phone,
    email: null,
    fullName: staff.name,
    avatarUrl: merchant.avatarUrl ?? null,
    activeRole: 'merchant',
    roles: [{ role: 'merchant', merchantId: session.merchantId }],
    locale: merchant.locale,
    createdAt: merchant.createdAt,
    merchantId: session.merchantId,
  };
}

export const authHandlers = [
  /* ---- OTP: request (contract: POST /auth/request-otp) ---- */
  h.post('/api/auth/request-otp', async ({ request }) => {
    const body = await readJson(request);
    const channel = String(body.channel ?? '');
    const destination = String(body.destination ?? '');
    const purpose = body.purpose === 'register' ? 'register' : 'login';
    if (channel !== 'phone') {
      throw new ApiHttpError(400, 'INVALID_CHANNEL', 'Only channel "phone" is supported');
    }
    if (!PHONE_RE.test(destination)) {
      throw new ApiHttpError(400, 'INVALID_PHONE', 'Enter a valid Tanzanian phone number, e.g. +255700000000');
    }
    const { id, code, expiresInSec } = issueOtp(destination, purpose);
    return ok({
      requestId: id,
      expiresInSeconds: expiresInSec,
      resendAfterSec: 60,
      debugCode: code,
      demo: true,
    });
  }),

  /* ---- OTP: verify (contract: POST /auth/verify-otp) ---- */
  h.post('/api/auth/verify-otp', async ({ request }) => {
    const body = await readJson(request);
    const requestId = String(body.requestId ?? '');
    const code = String(body.code ?? '');
    const purpose = body.purpose === 'register' ? 'register' : 'login';
    rateLimit(`otp-verify:${requestId}`, 10, 600 * 1000);

    const otp = db.table<OtpCode>('otpCodes').find(requestId);
    if (!otp || otp.used || otp.code !== code || otp.expiresAt < Date.now()) {
      throw new ApiHttpError(401, 'OTP_INVALID', 'Verification code is invalid or expired');
    }
    db.table<OtpCode>('otpCodes').update(otp.id, { used: true });
    const phone = otp.phone;

    if (purpose === 'register') {
      const merchant = db.table('merchants').find('m_demo');
      if (merchant?.phone === phone) {
        throw new ApiHttpError(409, 'MERCHANT_EXISTS', 'A merchant account already exists for this phone');
      }
      const merchantId = uid('m');
      const storeId = uid('s');
      db.table('merchants').insert({
        id: merchantId,
        phone,
        name: '',
        status: 'pending',
        plan: 'basic',
        country: 'TZ',
        currency: 'TZS',
        locale: 'en',
        consentAt: Date.now(),
        createdAt: Date.now(),
      });
      db.table('stores').insert({
        id: storeId,
        merchantId,
        name: '',
        category: '',
        phone,
        address: '',
        description: '',
        bannerColor: '#FFB300',
        featuredProductIds: [],
        open: false,
        hours: { open: '10:00', close: '22:00', closedDays: [] },
        deliveryRadiusKm: 3,
        deliveryFee: 3,
        minOrder: 20,
        rating: 0,
        rank: { current: 0, previous: 0, category: '', score: 0 },
        orderSettings: { autoAccept: false, autoAcceptDelaySec: 30, preOrderEnabled: true, voiceAnnounce: true, ringtone: 'beep' },
        decoration: { posterColor: '#FFB300', posterText: '', sign: '', brandStory: '', tagline: '' },
        promotion: { enabled: false, dailyBudget: 60, focus: 'ranking' },
      });
      const staffId = uid('s');
      db.table('staff').insert({
        id: staffId,
        merchantId,
        storeId,
        name: '',
        role: 'owner',
        phone,
        permissions: ['*'],
        active: true,
      });
      const session = createSession(merchantId, staffId, 'owner');
      return ok({
        accessToken: session.token,
        refreshToken: session.refreshToken,
        me: buildMe(merchantId, staffId),
        onboarding: { status: 'pending' },
      });
    }

    /* Login. The legacy `staff` table is the primary account; the contract
     * merchantStaff roster (matched by phone) adds the 5-role RBAC matrix.
     * Invited roster members (no legacy row yet) are activated on first
     * login: the roster flips invited → active, a backing legacy row is
     * created, and `staff.activated` is emitted (STAFF-AND-DEVICES.md §27). */
    const staffRows = db.table('staff').where((s) => s.phone === phone && s.active);
    const rosterRows = db
      .table<MerchantStaff & { merchantId: string }>('merchantStaff')
      .where((s) => s.phone === phone && (s.status === 'invited' || s.status === 'active'))
      .sort((a, b) => (a.status === b.status ? 0 : a.status === 'active' ? -1 : 1));
    const suspended = db
      .table<MerchantStaff & { merchantId: string }>('merchantStaff')
      .where((s) => s.phone === phone && s.status === 'suspended')[0];
    if (suspended) {
      throw new ApiHttpError(403, 'STAFF_SUSPENDED', 'This staff account is suspended — sign-in blocked', false, { status: 'suspended' });
    }
    if (!staffRows.length && !rosterRows.length) {
      throw new ApiHttpError(401, 'NO_MERCHANT', 'No merchant account found for this phone');
    }
    if (!staffRows.length) {
      const roster = rosterRows[0];
      const legacyRole: 'owner' | 'manager' | 'staff' =
        roster.role === 'owner' ? 'owner' : roster.role === 'manager' ? 'manager' : 'staff';
      db.table('staff').insert({
        id: roster.id,
        merchantId: roster.merchantId,
        storeId: roster.storeId ?? 's_demo',
        name: roster.name,
        role: legacyRole,
        phone: roster.phone,
        permissions: roster.permissions ?? [],
        active: true,
      });
      const activated = db
        .table<MerchantStaff & { merchantId: string }>('merchantStaff')
        .update(roster.id, { status: 'active' })!;
      emit({ type: 'staff.activated', staff: activated, at: Date.now() });
      const session = createSession(roster.merchantId, roster.id, roster.role, deviceOf(request));
      audit(roster.merchantId, roster.id, roster.role, 'auth:login', 'session', session.token, 'sign-in with OTP (first login — invited staff activated)');
      return ok({ accessToken: session.token, refreshToken: session.refreshToken, me: buildMe(roster.merchantId, roster.id) });
    }
    const staff = staffRows[0];
    const roster = rosterRows.find((r) => r.merchantId === staff.merchantId);
    if (roster && roster.status === 'invited') {
      const activated = db
        .table<MerchantStaff & { merchantId: string }>('merchantStaff')
        .update(roster.id, { status: 'active' })!;
      emit({ type: 'staff.activated', staff: activated, at: Date.now() });
    }
    const session = createSession(staff.merchantId, staff.id, staff.role, deviceOf(request));
    audit(staff.merchantId, staff.id, staff.role, 'auth:login', 'session', session.token, 'sign-in with OTP');
    return ok({ accessToken: session.token, refreshToken: session.refreshToken, me: buildMe(staff.merchantId, staff.id) });
  }),

  /* ---- Me ---- */
  h.get('/api/auth/me', ({ request }) => {
    const session = requireSession(request);
    return ok({ me: buildMe(session.merchantId, session.staffId) });
  }),

  /* ---- Contract GET /merchants/me — own merchant session bundle (alias of /auth/me)
   * plus the contract MerchantPrivate surface (verification + commercial). ---- */
  h.get('/api/merchants/me', ({ request }) => {
    const session = requireSession(request);
    const merchant = db.table('merchants').find(session.merchantId)!;
    const payout = db.table<MerchantPayoutAccountRow>('merchantPayoutAccounts').where((p) => p.merchantId === session.merchantId)[0];
    const verification = onboardingVerification(merchant);
    const commercial = (merchant.commercial as MerchantVerificationStatus & {
      commissionRateBps?: number;
      payoutCycleDays?: number;
      payoutAccount?: string | null;
    } | undefined) ?? {
      commissionRateBps: verification.status === 'approved' ? DEFAULT_COMMISSION_BPS : undefined,
      payoutCycleDays: verification.status === 'approved' ? 3 : undefined,
      payoutAccount: verification.status === 'approved' ? (payout?.accountMasked ?? null) : null,
    };
    return ok({ me: buildMe(session.merchantId, session.staffId), verification, commercial });
  }),

  /* ---- Users & profile (contract /users/me) ---- */
  h.get('/api/users/me', ({ request }) => {
    const session = requireSession(request);
    return ok(buildUser(session));
  }),

  h.get('/api/users/me/roles', ({ request }) => {
    requireSession(request);
    // The merchant app acts as a single platform role; contract /users/me/roles
    // lists the roles the current user can switch to (mock: the merchant role).
    return Response.json(['merchant'], { status: 200 });
  }),

  h.patch('/api/users/me', async ({ request }) => {
    const session = requireSession(request);
    const body = await readJson(request);
    if (body.fullName !== undefined) {
      const name = String(body.fullName).trim();
      if (name.length < 2 || name.length > 120) {
        throw new ApiHttpError(400, 'INVALID_NAME', 'fullName must be 2-120 characters');
      }
      db.table('merchants').update(session.merchantId, { name });
      db.table('staff').update(session.staffId, { name });
    }
    if (body.avatarUrl !== undefined) {
      const url = body.avatarUrl === null || String(body.avatarUrl).trim() === '' ? undefined : String(body.avatarUrl);
      if (url !== undefined && !/^https?:\/\/\S+$/.test(url)) {
        throw new ApiHttpError(400, 'INVALID_AVATAR', 'avatarUrl must be a valid http(s) URL');
      }
      db.table('merchants').update(session.merchantId, { avatarUrl: url });
    }
    if (body.locale !== undefined) {
      const locale = String(body.locale);
      if (locale !== 'en' && locale !== 'sw' && locale !== 'ar') {
        throw new ApiHttpError(400, 'INVALID_LOCALE', 'locale must be en, sw or ar');
      }
      db.table('merchants').update(session.merchantId, { locale });
    }
    if (!(body.fullName !== undefined || body.avatarUrl !== undefined || body.locale !== undefined)) {
      throw new ApiHttpError(400, 'EMPTY_UPDATE', 'Nothing to update');
    }
    audit(session.merchantId, session.staffId, session.role, 'profile:update', 'merchant', session.merchantId, `updated profile (${['fullName', 'avatarUrl', 'locale'].filter((k) => body[k] !== undefined).join(', ')})`);
    return ok(buildUser(session));
  }),

  /* ---- Change password (contract /auth/change-password) ---- */
  h.post('/api/auth/change-password', async ({ request }) => {
    const session = requireSession(request);
    const body = await readJson(request);
    const newPassword = String(body.newPassword ?? '');
    if (newPassword.length < 8) {
      throw new ApiHttpError(422, 'WEAK_PASSWORD', 'New password must be at least 8 characters');
    }
    if (newPassword.length > 128) {
      throw new ApiHttpError(400, 'PASSWORD_TOO_LONG', 'New password must be 128 characters or fewer');
    }
    const row = db.table<{ id: string; password: string }>('authPasswords').find(session.staffId);
    if (!row || row.password !== String(body.currentPassword ?? '')) {
      throw new ApiHttpError(400, 'WRONG_CURRENT_PASSWORD', 'Current password is incorrect');
    }
    db.table<{ id: string; password: string }>('authPasswords').update(session.staffId, { password: newPassword });
    audit(session.merchantId, session.staffId, session.role, 'auth:change-password', 'staff', session.staffId, 'changed password');
    return new Response(null, { status: 204 });
  }),

  /* ---- Token rotation (contract /auth/refresh) ---- */
  h.post('/api/auth/refresh', async ({ request }) => {
    const body = await readJson(request);
    const refreshToken = String(body.refreshToken ?? '');
    const row = db
      .table<Session>('sessions')
      .all()
      .find((s) => s.refreshToken === refreshToken && !s.revoked && s.expiresAt >= Date.now());
    if (!row) throw new ApiHttpError(401, 'UNAUTHORIZED', 'Refresh token missing or expired', true);
    const roster = db
      .table<MerchantStaff & { merchantId: string }>('merchantStaff')
      .where((s) => s.merchantId === row.merchantId && s.phone === db.table('staff').find(row.staffId)?.phone)[0];
    if (roster && roster.status === 'suspended') {
      throw new ApiHttpError(403, 'STAFF_SUSPENDED', 'This staff account is suspended — sign-in blocked', false, { status: 'suspended' });
    }
    db.table<Session>('sessions').update(row.id, { revoked: true });
    const session = createSession(row.merchantId, row.staffId, row.role);
    audit(row.merchantId, row.staffId, row.role, 'auth:refresh', 'session', session.token, 'rotated session tokens');
    return ok({ accessToken: session.token, refreshToken: session.refreshToken, me: buildMe(row.merchantId, row.staffId) });
  }),

  /* ---- Logout (revoke) ---- */
  h.post('/api/auth/logout', ({ request }) => {
    const session = requireSession(request);
    revokeSession(session.token);
    return ok({ revoked: true });
  }),

  /* ---- Onboarding: submit merchant profile ---- */
  h.post('/api/onboarding/profile', async ({ request }) => {
    const session = requireSession(request);
    const body = await readJson(request);
    const merchant = db.table('merchants').find(session.merchantId)!;
    const store = db.table<StoreServer>('stores').where((s) => s.merchantId === session.merchantId)[0];
    db.table('merchants').update(session.merchantId, {
      name: body.ownerName || merchant.name,
      businessType: body.businessType || merchant.businessType,
      consentAt: body.consent ? Date.now() : merchant.consentAt,
    });
    if (store) {
      db.table('stores').update(store.id, {
        name: body.storeName || undefined,
        category: body.category || undefined,
        address: body.address || undefined,
        description: body.description || undefined,
        phone: body.contactPhone || undefined,
      });
    }
    audit(session.merchantId, session.staffId, session.role, 'onboarding:profile', 'merchant', session.merchantId, 'submitted onboarding profile');
    return ok({ saved: true });
  }),

  /* ---- Onboarding: submit docs (simulated upload) ----
   * Contract body: [{type, url, ...}] (type + pre-signed url); legacy string
   * arrays are mapped by filename keyword so old callers keep working. The
   * per-document status is server-owned: upload/retake returns the doc to
   * `pending`. Client-side type/size validation happens in the wizard. */
  h.post('/api/onboarding/docs', async ({ request }) => {
    const session = requireSession(request);
    const body = await readJson(request);
    const docs = Array.isArray(body.docs) ? body.docs : [];
    if (!docs.length) {
      throw new ApiHttpError(400, 'DOCS_REQUIRED', 'Upload at least one document');
    }
    const merchant = db.table('merchants').find(session.merchantId)!;
    const current = Array.isArray(merchant.documents)
      ? (merchant.documents as MerchantDocumentStatus[])
      : [];
    const upserted: MerchantDocumentStatus[] = [];
    for (const raw of docs) {
      const entry = (typeof raw === 'string' ? { type: docTypeFromFileName(raw) } : raw) as {
        type?: string;
        fileName?: string | null;
        url?: string | null;
        mime?: string | null;
        sizeBytes?: number | null;
      };
      const type = String(entry.type ?? '').trim();
      if (!ONBOARDING_DOC_TYPES.includes(type as MerchantDocumentType)) {
        throw new ApiHttpError(422, 'INVALID_DOCUMENT_TYPE', `document type must be one of ${ONBOARDING_DOC_TYPES.join(' | ')}`);
      }
      const fileName = entry.fileName ?? entry.url ?? null;
      const next: MerchantDocumentStatus = {
        type: type as MerchantDocumentType,
        status: 'pending',
        fileName: fileName ? String(fileName) : null,
        mime: entry.mime ? String(entry.mime) : null,
        sizeBytes: entry.sizeBytes !== undefined && entry.sizeBytes !== null ? Number(entry.sizeBytes) : null,
        updatedAt: Date.now(),
      };
      const idx = current.findIndex((d) => d.type === type);
      if (idx >= 0) {
        current[idx] = next;
        upserted.push(current[idx]);
      } else {
        current.push(next);
        upserted.push(next);
      }
    }
    db.table('merchants').update(session.merchantId, { documents: current });
    p10Emit({ type: 'onboarding.verification_updated', verification: onboardingVerification(merchant), at: Date.now() });
    audit(session.merchantId, session.staffId, session.role, 'onboarding:docs', 'merchant', session.merchantId, `submitted ${upserted.length} document(s)`);
    return ok({ received: upserted.length, reviewEtaMin: 30, docs: current });
  }),

  /* ---- Onboarding: submit for review ---- */
  h.post('/api/onboarding/submit', async ({ request }) => {
    const session = requireSession(request);
    const merchant = db.table('merchants').find(session.merchantId)!;
    const store = db.table<StoreServer>('stores').where((s) => s.merchantId === session.merchantId)[0];
    if (!store?.name || !store.address) {
      throw new ApiHttpError(400, 'INCOMPLETE', 'Store name and address are required before submitting');
    }
    if (merchant.onboardingSubmittedAt && merchant.verification !== 'changes_requested') {
      throw new ApiHttpError(409, 'ONBOARDING_ALREADY_SUBMITTED', 'This application was already submitted and is under review');
    }
    const documents = Array.isArray(merchant.documents)
      ? (merchant.documents as MerchantDocumentStatus[])
      : [];
    const required = ['business_registration', 'trading_license'];
    const missing = required.filter((t) => !documents.some((d) => d.type === t && d.status !== 'missing'));
    if (missing.length) {
      throw new ApiHttpError(400, 'DOCS_REQUIRED', `Upload the required documents first: ${missing.join(', ')}`);
    }
    const verification: MerchantVerificationStatus = {
      status: documents.some((d) => d.status !== 'missing') ? 'documents_review' : 'pending',
      documents,
      submittedAt: Date.now(),
    };
    db.table('merchants').update(session.merchantId, {
      status: 'pending',
      verification: verification.status,
      onboardingSubmittedAt: Date.now(),
    });
    p10Emit({ type: 'onboarding.submitted', verification, at: Date.now() });
    const note: NotificationDto = {
      id: uid('n'),
      merchantId: session.merchantId,
      type: 'system',
      category: 'important',
      title: 'Onboarding submitted',
      body: 'Documents are under review — typical turnaround is under 30 minutes.',
      ts: Date.now(),
      read: false,
    };
    db.table<NotificationDto>('notifications').insert(note);
    emit({ type: 'notification.created', notification: note, at: Date.now() });
    audit(session.merchantId, session.staffId, session.role, 'onboarding:submit', 'merchant', session.merchantId, 'submitted store for review');
    return ok({ status: 'pending', reviewEtaMin: 30, verification });
  }),

  /* ---- Onboarding: status (steps + currentStep + completed/submittedAt) ---- */
  h.get('/api/onboarding/status', ({ request }) => {
    const session = requireSession(request);
    const merchant = db.table('merchants').find(session.merchantId)!;
    const store = db.table<StoreServer>('stores').where((s) => s.merchantId === session.merchantId)[0];
    return ok(onboardingStatus(merchant, store));
  }),

  /* ---- Simulate platform approving the merchant (demo convenience) ---- */
  h.post('/api/onboarding/demo-approve', ({ request }) => {
    const session = requireSession(request);
    const merchant = db.table('merchants').find(session.merchantId)!;
    if (merchant.status !== 'pending') throw new ApiHttpError(409, 'NOT_PENDING', 'Merchant is not pending review');
    const documents = Array.isArray(merchant.documents)
      ? (merchant.documents as MerchantDocumentStatus[]).map((d) => ({ ...d, status: 'approved' as const, updatedAt: Date.now() }))
      : [];
    const payout = db.table<MerchantPayoutAccountRow>('merchantPayoutAccounts').where((p) => p.merchantId === session.merchantId)[0];
    const verification: MerchantVerificationStatus = {
      status: 'approved',
      documents,
      reviewedAt: Date.now(),
      submittedAt: merchant.onboardingSubmittedAt ?? Date.now(),
    };
    db.table('merchants').update(session.merchantId, {
      status: 'active',
      plan: 'pro',
      verification: 'approved',
      documents,
      reviewedAt: Date.now(),
      commercial: {
        commissionRateBps: DEFAULT_COMMISSION_BPS,
        payoutCycleDays: 3,
        payoutAccount: payout?.accountMasked ?? null,
      },
    });
    p10Emit({ type: 'onboarding.verification_updated', verification, at: Date.now() });
    db.table<NotificationDto>('notifications').insert({
      id: uid('n'),
      merchantId: session.merchantId,
      type: 'system',
      category: 'important',
      title: 'Onboarding approved',
      body: 'Your store is live. Customers can now find and order from you.',
      ts: Date.now(),
      read: false,
    });
    audit(session.merchantId, session.staffId, session.role, 'onboarding:approved', 'merchant', session.merchantId, 'platform approved merchant');
    return ok({ status: 'active', verification });
  }),
];

/* Demo convenience: demo merchant phone/code hint used by the login screen */
export const DEMO_HINT = DEMO_MERCHANT;
