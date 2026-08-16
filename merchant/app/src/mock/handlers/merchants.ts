import { http } from 'msw';
import type {
  ChainStore,
  LeadCreated,
  MerchantLeadRow,
  MerchantPayoutAccountRow,
  MerchantPublic,
  MerchantSettingsRow,
  P1Event,
  PayoutAccount,
  ServerEvent,
  StoreServer,
  StoreSettings,
  StoreSettingsBusinessHoursItem,
  StoreSettingsUpdate,
} from '@/api/types';
import { db, uid } from '@/mock/db';
import { emit } from '@/mock/events';
import { audit, json, ok, requireSession } from '@/mock/security';
import { ApiHttpError, h, readJson } from '@/mock/handlers/common';
import type { Session } from '@/mock/types-internal';

const BASE = typeof location !== 'undefined' ? location.origin : 'http://localhost';

/* h has no put wrapper; same wrap/json error filter as h.get/post/patch. */
function put(
  path: string,
  fn: (args: { request: Request; params: Record<string, string> }) => Promise<Response> | Response,
) {
  return http.put(`${BASE}${path}`, async (info) => {
    try {
      return await fn({ request: info.request, params: (info.params ?? {}) as Record<string, string> });
    } catch (e) {
      if (e instanceof ApiHttpError) {
        return json(e.status, { error: { code: e.code, message: e.message, retriable: e.retriable, details: e.details } });
      }
      throw e;
    }
  });
}

const p1Emit = (event: P1Event) => emit(event as unknown as ServerEvent);

const BUSINESS_TYPES = ['restaurant', 'shop', 'grocery', 'pharmacy', 'retail', 'tickets', 'other'];
const PAYMENT_METHODS = ['mpesa', 'tigo_pesa', 'airtel_money', 'ezy_pesa', 'halotel', 'card', 'cod', 'bank'];
const NOTIFICATION_CHANNELS = ['push', 'sms', 'in_app'];
const HOUR_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

function leadDto(row: MerchantLeadRow): LeadCreated {
  return { id: row.id, status: row.status, createdAt: row.createdAt };
}

/** Contract MerchantPublic from the (mock) merchants + stores rows. */
function merchantPublic(merchantId: string): MerchantPublic {
  const m = db.table('merchants').find(merchantId);
  if (!m) throw new ApiHttpError(404, 'NOT_FOUND', 'Merchant not found');
  const stores = db.table<StoreServer>('stores').where((s) => s.merchantId === merchantId);
  const primary = stores[0];
  const categoryNames = db
    .table('categories')
    .where((c) => c.merchantId === merchantId)
    .map((c) => c.name);
  return {
    id: merchantId,
    businessName: primary?.name ?? String(m.name ?? ''),
    logoUrl: null,
    city: 'Dar es Salaam',
    serviceAreas: stores.map((s) => s.name),
    categories: categoryNames,
    rating: primary?.rating ?? 4.5,
    reviewCount: 128,
    isOpen: primary?.open ?? true,
    deliveryMinutes: primary?.deliveryEtaMin ?? 30,
  };
}

function mySettingsRow(session: Session): MerchantSettingsRow {
  const rows = db.table<MerchantSettingsRow>('merchantSettings').where((s) => s.merchantId === session.merchantId);
  if (rows[0]) return rows[0];
  // A freshly registered merchant has no settings row yet — the contract
  // surface returns defaults (create-on-read) instead of 404.
  const defaultDay = (dow: number) => ({ dayOfWeek: dow, open: '10:00', close: '22:00', closed: false });
  const row: MerchantSettingsRow = {
    id: uid('ms'),
    merchantId: session.merchantId,
    settings: {
      businessHours: [0, 1, 2, 3, 4, 5, 6].map(defaultDay),
      acceptanceMethod: 'manual',
      isOpen: true,
      phoneOrderingHours: { enabled: false, open: '08:00', close: '20:00' },
      orderNotificationChannels: ['push', 'in_app'],
      acceptedPaymentMethods: ['mpesa', 'card', 'cod'],
      deliverySettings: { radiusKm: 4, deliveryFeeTZS: 3000, minimumOrderTZS: 30000, sameDayCutoff: '20:00' },
      printSettings: { autoPrint: true, copies: 1, labelPrinter: false },
    },
    updatedAt: Date.now(),
  };
  db.table<MerchantSettingsRow>('merchantSettings').insert(row);
  return row;
}

function myPayoutRow(session: Session): MerchantPayoutAccountRow {
  const row = db.table<MerchantPayoutAccountRow>('merchantPayoutAccounts').where((p) => p.merchantId === session.merchantId)[0];
  if (!row) {
    throw new ApiHttpError(404, 'PAYOUT_ACCOUNT_NOT_SET', 'No payout account set yet');
  }
  return row;
}

/* Payout providers accepted by the mock (STORE-MANAGEMENT.md:51-62 —
 * PAYOUT_ACCOUNT_PROVIDER_UNSUPPORTED on anything else). */
const PAYOUT_PROVIDERS: Record<PayoutAccount['type'], string[]> = {
  mobile_money: ['mpesa', 'tigo_pesa', 'airtel_money', 'ezy_pesa', 'halotel'],
  bank: ['nmb', 'crdb', 'nbc', 'equity', 'dtb', 'kcb', 'stanbic', 'standard_chartered'],
};

function payoutDto(row: MerchantPayoutAccountRow): PayoutAccount {
  return {
    id: row.id,
    type: row.type,
    provider: row.provider,
    accountMasked: row.accountMasked,
    accountHolderName: row.accountHolderName,
    verified: row.verified,
    updatedAt: row.updatedAt,
  };
}

/** StoreSettings merge — partial StoreSettingsUpdate applied onto the stored settings. */
function mergeStoreSettings(current: StoreSettings, update: StoreSettingsUpdate): StoreSettings {
  const next: StoreSettings = { ...current };
  const fields: (keyof StoreSettingsUpdate)[] = [
    'businessHours',
    'announcement',
    'coverImageUrl',
    'recommendedItemIds',
    'isOpen',
    'acceptanceMethod',
    'phoneOrderingHours',
    'orderNotificationChannels',
    'acceptedPaymentMethods',
    'deliverySettings',
    'specialRules',
    'printSettings',
  ];
  for (const f of fields) {
    if ((update as Record<string, unknown>)[f] !== undefined) {
      (next as unknown as Record<string, unknown>)[f] = (update as Record<string, unknown>)[f];
    }
  }
  /* App extension: logoUrl + printSettings.paperSize ride on the settings
   * surface (the PATCH /merchants/me mock that owns logoUrl is frozen). */
  const ext = update as StoreSettingsUpdate & { logoUrl?: string | null };
  if (ext.logoUrl !== undefined) {
    (next as StoreSettings & { logoUrl?: string | null }).logoUrl = ext.logoUrl === null ? null : String(ext.logoUrl);
  }
  return next;
}

/** Validate StoreSettingsUpdate fields; throws 422 VALIDATION_ERROR with field errors. */
function validateStoreSettingsUpdate(update: StoreSettingsUpdate): void {
  const errors: { field: string; code: string; message: string }[] = [];
  if (update.acceptanceMethod !== undefined && update.acceptanceMethod !== 'manual' && update.acceptanceMethod !== 'auto') {
    errors.push({ field: 'acceptanceMethod', code: 'INVALID_ACCEPTANCE_METHOD', message: 'acceptanceMethod must be manual or auto' });
  }
  if (update.businessHours !== undefined) {
    if (!Array.isArray(update.businessHours) || update.businessHours.length === 0) {
      errors.push({ field: 'businessHours', code: 'INVALID_BUSINESS_HOURS', message: 'businessHours must be a non-empty array' });
    } else {
      (update.businessHours as unknown as StoreSettingsBusinessHoursItem[]).forEach((h, i) => {
        if (typeof h.dayOfWeek !== 'number' || h.dayOfWeek < 0 || h.dayOfWeek > 6) {
          errors.push({ field: `businessHours[${i}].dayOfWeek`, code: 'INVALID_DAY_OF_WEEK', message: 'dayOfWeek must be 0–6' });
        }
        if (typeof h.open !== 'string' || !HOUR_RE.test(h.open) || typeof h.close !== 'string' || !HOUR_RE.test(h.close)) {
          errors.push({ field: `businessHours[${i}]`, code: 'INVALID_HOUR', message: 'open/close must use HH:MM' });
        }
      });
    }
  }
  if (update.announcement !== undefined && String(update.announcement).length > 500) {
    errors.push({ field: 'announcement', code: 'TOO_LONG', message: 'announcement must be ≤ 500 chars' });
  }
  if (update.specialRules !== undefined && String(update.specialRules).length > 1000) {
    errors.push({ field: 'specialRules', code: 'TOO_LONG', message: 'specialRules must be ≤ 1000 chars' });
  }
  if (update.orderNotificationChannels !== undefined) {
    const channels = update.orderNotificationChannels;
    if (!Array.isArray(channels) || channels.some((c) => !NOTIFICATION_CHANNELS.includes(c))) {
      errors.push({ field: 'orderNotificationChannels', code: 'INVALID_CHANNEL', message: 'channels must be push | sms | in_app' });
    }
  }
  if (update.acceptedPaymentMethods !== undefined) {
    const methods = update.acceptedPaymentMethods;
    if (!Array.isArray(methods) || methods.some((m) => !PAYMENT_METHODS.includes(m))) {
      errors.push({ field: 'acceptedPaymentMethods', code: 'INVALID_PAYMENT_METHOD', message: 'acceptedPaymentMethods contains an unknown method' });
    }
  }
  if (update.deliverySettings !== undefined) {
    const d = update.deliverySettings as unknown as {
      radiusKm?: unknown;
      deliveryFeeTZS?: unknown;
      minimumOrderTZS?: unknown;
      sameDayCutoff?: unknown;
    };
    if (d.radiusKm !== undefined && (!Number.isFinite(Number(d.radiusKm)) || Number(d.radiusKm) <= 0)) {
      errors.push({ field: 'deliverySettings.radiusKm', code: 'INVALID_RADIUS', message: 'radiusKm must be a positive number' });
    }
    if (d.deliveryFeeTZS !== undefined && (!Number.isInteger(Number(d.deliveryFeeTZS)) || Number(d.deliveryFeeTZS) < 0)) {
      errors.push({ field: 'deliverySettings.deliveryFeeTZS', code: 'INVALID_MONEY', message: 'deliveryFeeTZS must be a non-negative integer (TZS)' });
    }
    if (d.minimumOrderTZS !== undefined && (!Number.isInteger(Number(d.minimumOrderTZS)) || Number(d.minimumOrderTZS) < 0)) {
      errors.push({ field: 'deliverySettings.minimumOrderTZS', code: 'INVALID_MONEY', message: 'minimumOrderTZS must be a non-negative integer (TZS)' });
    }
    if (d.sameDayCutoff !== undefined && (typeof d.sameDayCutoff !== 'string' || !HOUR_RE.test(d.sameDayCutoff))) {
      errors.push({ field: 'deliverySettings.sameDayCutoff', code: 'INVALID_CUTOFF', message: 'sameDayCutoff must use HH:MM' });
    }
  }
  if (update.printSettings !== undefined) {
    const p = update.printSettings as unknown as {
      copies?: unknown;
      autoPrint?: unknown;
      labelPrinter?: unknown;
      paperSize?: unknown;
    };
    if (p.copies !== undefined && (!Number.isInteger(Number(p.copies)) || Number(p.copies) < 1 || Number(p.copies) > 5)) {
      errors.push({ field: 'printSettings.copies', code: 'INVALID_COPIES', message: 'copies must be an integer between 1 and 5' });
    }
    if (p.paperSize !== undefined && p.paperSize !== '58mm' && p.paperSize !== '80mm') {
      errors.push({ field: 'printSettings.paperSize', code: 'INVALID_PAPER_SIZE', message: 'paperSize must be 58mm or 80mm' });
    }
  }
  const ext = update as StoreSettingsUpdate & { logoUrl?: string | null };
  if (ext.logoUrl !== undefined && ext.logoUrl !== null && !/^https?:\/\/\S+$/.test(String(ext.logoUrl))) {
    errors.push({ field: 'logoUrl', code: 'INVALID_LOGO_URL', message: 'logoUrl must be an http(s) URL or null' });
  }
  if (errors.length) {
    throw new ApiHttpError(422, 'VALIDATION_ERROR', 'Store settings validation failed', false, { errors });
  }
}

function chainStoreDto(store: StoreServer): ChainStore {
  return {
    id: store.id,
    businessName: store.name,
    city: 'Dar es Salaam',
    serviceAreas: [store.address],
    isOpen: store.open,
    verification: 'approved',
  };
}

export const merchantHandlers = [
  /* ---- GET /merchants — public discovery (approved only) ---- */
  h.get('/api/merchants', () => {
    const list = db
      .table('merchants')
      .all()
      .filter((m) => (m as { status?: string }).status !== 'pending')
      .map((m) => merchantPublic(m.id));
    return Response.json(list);
  }),

  /* ---- POST /merchants — submit a merchant application ---- */
  h.post('/api/merchants', async ({ request }) => {
    const body = await readJson(request);
    const businessName = String(body.businessName ?? '').trim();
    const contactPhone = String(body.contactPhone ?? '').trim();
    const city = String(body.city ?? '').trim();
    const errors: { field: string; code: string; message: string }[] = [];
    if (!businessName) errors.push({ field: 'businessName', code: 'REQUIRED', message: 'businessName is required' });
    if (!contactPhone) errors.push({ field: 'contactPhone', code: 'REQUIRED', message: 'contactPhone is required' });
    if (!city) errors.push({ field: 'city', code: 'REQUIRED', message: 'city is required' });
    if (body.businessType !== undefined && body.businessType !== null && !BUSINESS_TYPES.includes(String(body.businessType))) {
      errors.push({ field: 'businessType', code: 'INVALID_BUSINESS_TYPE', message: `businessType must be one of ${BUSINESS_TYPES.join(' | ')}` });
    }
    if (errors.length) {
      throw new ApiHttpError(422, 'VALIDATION_ERROR', 'Merchant application validation failed', false, { errors });
    }
    const lead: MerchantLeadRow = {
      id: uid('lead'),
      merchantId: uid('m'),
      source: 'application',
      businessName,
      contactPhone,
      status: 'submitted',
      createdAt: new Date().toISOString(),
    };
    db.table<MerchantLeadRow>('merchantLeads').insert(lead);
    return json(201, leadDto(lead));
  }),

  h.post('/api/merchants/claim', async ({ request }) => {
    const body = await readJson(request);
    const merchantId = String(body.merchantId ?? '').trim();
    const contactPhone = String(body.contactPhone ?? '').trim();
    if (!merchantId) throw new ApiHttpError(422, 'VALIDATION_ERROR', 'merchantId is required');
    if (!contactPhone) throw new ApiHttpError(422, 'VALIDATION_ERROR', 'contactPhone is required');
    const documentsNote = body.documentsNote !== undefined && body.documentsNote !== null ? String(body.documentsNote).trim() : undefined;
    if (documentsNote !== undefined && documentsNote.length > 500) {
      throw new ApiHttpError(422, 'VALIDATION_ERROR', 'documentsNote must be ≤ 500 chars');
    }
    const listing = db.table('merchants').find(merchantId);
    if (!listing) {
      throw new ApiHttpError(409, 'CLAIM_LISTING_NOT_FOUND', 'The listing you tried to claim does not exist');
    }
    if (String((listing as { phone?: string }).phone ?? '') === contactPhone) {
      throw new ApiHttpError(409, 'CLAIM_LISTING_OWNED', 'This listing is already linked to an account');
    }
    const pending = db.table<MerchantLeadRow>('merchantLeads').where((l) => l.merchantId === merchantId && l.source === 'claim');
    if (pending.length > 0) {
      throw new ApiHttpError(409, 'CLAIM_ALREADY_PENDING', 'A claim for this listing is already under review');
    }
    const lead: MerchantLeadRow = {
      id: uid('lead'),
      merchantId,
      source: 'claim',
      contactPhone,
      documentsNote,
      status: 'under_review',
      createdAt: new Date().toISOString(),
    };
    db.table<MerchantLeadRow>('merchantLeads').insert(lead);
    return json(201, leadDto(lead));
  }),

  /* ---- GET /merchants/me/settings ---- */
  h.get('/api/merchants/me/settings', ({ request }) => {
    const session = requireSession(request);
    return ok(mySettingsRow(session).settings);
  }),

  /* ---- PUT /merchants/me/settings ---- */
  put('/api/merchants/me/settings', async ({ request }) => {
    const session = requireSession(request);
    const body = (await readJson(request)) as StoreSettingsUpdate;
    validateStoreSettingsUpdate(body);
    const row = mySettingsRow(session);
    const merged = mergeStoreSettings(row.settings, body);
    db.table<MerchantSettingsRow>('merchantSettings').update(row.id, { settings: merged, updatedAt: Date.now() });
    if (body.isOpen !== undefined) {
      const stores = db.table<StoreServer>('stores').where((s) => s.merchantId === session.merchantId);
      stores.forEach((s) => db.table<StoreServer>('stores').update(s.id, { open: body.isOpen === true }));
    }
    p1Emit({ type: 'merchant.settings_updated', settings: merged, at: Date.now() });
    audit(session.merchantId, session.staffId, session.role, 'merchant:settings', 'merchant', session.merchantId, 'updated store settings');
    return ok(merged);
  }),

  /* ---- GET /merchants/me/payout-account ---- */
  h.get('/api/merchants/me/payout-account', ({ request }) => {
    const session = requireSession(request);
    return ok(payoutDto(myPayoutRow(session)));
  }),

  /* ---- PUT /merchants/me/payout-account ---- */
  put('/api/merchants/me/payout-account', async ({ request }) => {
    const session = requireSession(request);
    const body = await readJson(request);
    const type = String(body.type ?? '');
    const provider = String(body.provider ?? '').trim();
    const accountNumber = String(body.accountNumber ?? '').trim();
    const accountHolderName = String(body.accountHolderName ?? '').trim();
    const errors: { field: string; code: string; message: string }[] = [];
    if (type !== 'mobile_money' && type !== 'bank') {
      errors.push({ field: 'type', code: 'INVALID_TYPE', message: 'type must be mobile_money or bank' });
    } else if (provider && !(PAYOUT_PROVIDERS[type as PayoutAccount['type']] ?? []).includes(provider)) {
      errors.push({ field: 'provider', code: 'PAYOUT_ACCOUNT_PROVIDER_UNSUPPORTED', message: `provider "${provider}" is not supported for ${type}` });
    }
    if (!provider) errors.push({ field: 'provider', code: 'REQUIRED', message: 'provider is required' });
    if (!accountNumber) errors.push({ field: 'accountNumber', code: 'REQUIRED', message: 'accountNumber is required' });
    if (!accountHolderName) errors.push({ field: 'accountHolderName', code: 'REQUIRED', message: 'accountHolderName is required' });
    if (accountHolderName.length > 120) {
      errors.push({ field: 'accountHolderName', code: 'TOO_LONG', message: 'accountHolderName must be ≤ 120 chars' });
    }
    if (errors.length) {
      throw new ApiHttpError(422, 'VALIDATION_ERROR', 'Payout account validation failed', false, { errors });
    }
    const existing = db.table<MerchantPayoutAccountRow>('merchantPayoutAccounts').where((p) => p.merchantId === session.merchantId)[0];
    if (existing && !existing.verified && existing.accountMasked === `****${accountNumber.slice(-4)}`) {
      throw new ApiHttpError(409, 'PAYOUT_ACCOUNT_VERIFICATION_REQUIRED', 'The current payout account change is pending verification');
    }
    const tail = accountNumber.slice(-4);
    const now = new Date().toISOString();
    const row: MerchantPayoutAccountRow = {
      id: existing?.id ?? uid('mpa'),
      merchantId: session.merchantId,
      type: type as MerchantPayoutAccountRow['type'],
      provider,
      accountMasked: `****${tail}`,
      accountHolderName,
      verified: existing ? existing.verified && existing.accountMasked === `****${tail}` : false,
      updatedAt: now,
    };
    if (existing) {
      db.table<MerchantPayoutAccountRow>('merchantPayoutAccounts').update(existing.id, row);
    } else {
      db.table<MerchantPayoutAccountRow>('merchantPayoutAccounts').insert(row);
    }
    const dto = payoutDto(row);
    p1Emit({ type: 'merchant.payout_updated', account: dto, at: Date.now() });
    audit(session.merchantId, session.staffId, session.role, 'merchant:payout', 'merchant', session.merchantId, `payout account ${row.type} ${row.accountMasked} (${row.verified ? 'verified' : 'verification pending'})`);
    return ok(dto);
  }),

  /* ---- PATCH /merchants/me/stores/{storeId} — chain store update ---- */
  h.patch('/api/merchants/me/stores/:storeId', async ({ request, params }) => {
    const session = requireSession(request);
    const store = db.table<StoreServer>('stores').find(String(params.storeId));
    if (!store || store.merchantId !== session.merchantId) {
      throw new ApiHttpError(404, 'NOT_FOUND', 'Store not found');
    }
    const body = (await readJson(request)) as StoreSettingsUpdate;
    validateStoreSettingsUpdate(body);
    const patch: Partial<StoreServer> = {};
    if (body.isOpen !== undefined) patch.open = body.isOpen === true;
    if (body.announcement !== undefined) patch.announcement = String(body.announcement);
    if (body.coverImageUrl !== undefined && body.coverImageUrl !== null) patch.coverImage = String(body.coverImageUrl);
    if (body.specialRules !== undefined) patch.description = String(body.specialRules);
    if (body.businessHours !== undefined && Array.isArray(body.businessHours) && body.businessHours.length > 0) {
      const first = (body.businessHours as unknown as StoreSettingsBusinessHoursItem[])[0];
      patch.hours = {
        open: String(first.open),
        close: String(first.close),
        closedDays: (body.businessHours as unknown as StoreSettingsBusinessHoursItem[])
          .filter((h) => h.closed === true)
          .map((h) => String(h.dayOfWeek)),
      };
    }
    if (Object.keys(patch).length) {
      db.table<StoreServer>('stores').update(store.id, patch);
    }
    const updated = db.table<StoreServer>('stores').find(store.id)!;
    audit(session.merchantId, session.staffId, session.role, 'merchant:store', 'store', updated.id, `updated chain store ${updated.name}`);
    return ok(chainStoreDto(updated));
  }),


  /* ---- GET /merchants/{merchantId} — public profile ----
   * Registered LAST: MSW matches in registration order, so the literal
   * /merchants/me/* routes (settings, payout, staff) are never swallowed
   * by the :merchantId param route. */
  h.get('/api/merchants/:merchantId', ({ params }) => {
    const merchantId = String(params.merchantId);
    return ok(merchantPublic(merchantId));
  }),
];
