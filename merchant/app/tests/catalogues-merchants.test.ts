import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupServer } from 'msw/node';

import { ALL_HTTP_HANDLERS } from '@/mock/handlers';
import { db } from '@/mock/db';
import { seedDatabase } from '@/mock/seed';

const server = setupServer(...(ALL_HTTP_HANDLERS as never[]));

const base = 'http://localhost';
let token: string | null = null;

async function call(
  method: string,
  path: string,
  opts: { body?: unknown; auth?: boolean; idem?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: any }> {
  const url = path.startsWith('/api') ? path : `/api${path}`;
  const headers: Record<string, string> = { 'content-type': 'application/json', ...opts.headers };
  if (opts.auth !== false) headers.authorization = `Bearer ${token ?? ''}`;
  if (opts.idem) headers['idempotency-key'] = opts.idem;
  const res = await fetch(`${base}${url}`, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* empty */
  }
  return { status: res.status, body };
}

let ownerToken: string | null = null;

async function loginAs(phone: string) {
  const req = await call('POST', '/auth/request-otp', { auth: false, body: { channel: 'phone', destination: phone, purpose: 'login' } });
  assert.equal(req.status, 200);
  const ok = await call('POST', '/auth/verify-otp', { auth: false, body: { requestId: req.body.requestId, code: req.body.debugCode, purpose: 'login' } });
  assert.equal(ok.status, 200);
  return ok.body.accessToken;
}

before(async () => {
  server.listen({ onUnhandledRequest: 'bypass' });
  db.reset();
  seedDatabase();
  ownerToken = await loginAs('+255700000000');
});

beforeEach(() => {
  token = ownerToken;
});

after(() => {
  server.close();
});

/* ================= Catalogues: export / me / public ================= */

test('catalogue export: downloadUrl + expiresInSeconds; session required', async () => {
  const res = await call('GET', '/catalogues/export');
  assert.equal(res.status, 200);
  assert.match(res.body.downloadUrl, /^https:\/\/\S+$/);
  assert.equal(res.body.expiresInSeconds, 900);

  const unauth = await call('GET', '/catalogues/export', { auth: false });
  assert.equal(unauth.status, 401);
});

test('GET /catalogues/me: seeded items with category names', async () => {
  const res = await call('GET', '/catalogues/me');
  assert.equal(res.status, 200);
  assert.equal(res.body.merchantId, 'm_demo');
  assert.ok(Array.isArray(res.body.items));
  assert.ok(res.body.items.length >= 10);
  const first = res.body.items[0];
  assert.equal(typeof first.name, 'string');
  assert.equal(typeof first.priceTZS, 'number');
  assert.ok(Number.isInteger(first.priceTZS));
  assert.ok(['Grilled Skewers', 'Platters & Combo', 'Drinks & Sides'].includes(first.category));
});

test('GET /catalogues/{merchantId}: public catalogue; unknown merchant 404', async () => {
  const res = await call('GET', '/catalogues/m_demo', { auth: false });
  assert.equal(res.status, 200);
  assert.equal(res.body.merchantId, 'm_demo');
  assert.ok(res.body.items.length >= 10);
  for (const item of res.body.items) assert.equal(item.available, true, 'public catalogue exposes available items only');

  const missing = await call('GET', '/catalogues/m_unknown', { auth: false });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, 'NOT_FOUND');
});

test('PUT /catalogues/me: full replace publish -> publishedAt; validation 422 + 403', async () => {
  const p3 = db.table('products').find('p3')!;
  const publish = await call('PUT', '/catalogues/me', {
    body: {
      merchantId: 'm_demo',
      items: [
        { name: 'Publish Special', priceTZS: 12000, category: 'Grilled Skewers' },
        { id: 'p3', name: 'P3 via publish', priceTZS: p3.price, category: 'Platters & Combo' },
      ],
    },
  });
  assert.equal(publish.status, 200);
  assert.ok(publish.body.publishedAt, 'publishedAt set on publish');
  assert.equal(publish.body.items.length, 2);
  const pub = db.table('products').find('p3');
  assert.equal(pub?.name, 'P3 via publish', 'existing item updated by the replace');

  const readBack = await call('GET', '/catalogues/me');
  assert.ok(readBack.body.publishedAt, 'publishedAt persisted');
  assert.ok(readBack.body.items.some((i: any) => i.name === 'Publish Special'));

  const badItem = await call('PUT', '/catalogues/me', {
    body: { merchantId: 'm_demo', items: [{ name: '', priceTZS: 100, category: 'Grilled Skewers' }] },
  });
  assert.equal(badItem.status, 422);
  assert.equal(badItem.body.error.code, 'VALIDATION_ERROR');
  assert.ok(badItem.body.error.details.errors[0].field.startsWith('items.'));

  const wrongMerchant = await call('PUT', '/catalogues/me', {
    body: { merchantId: 'm_other', items: [{ name: 'X', priceTZS: 100, category: 'Grilled Skewers' }] },
  });
  assert.equal(wrongMerchant.status, 403);
});

/* ================= Catalogue items: bulk + import ================= */

test('POST /catalogue-items/bulk: 202 counts, create + update, overwritePrices gate, per-row failures', async () => {
  const p1 = db.table('products').find('p1')!;
  const p2 = db.table('products').find('p2')!;
  const res = await call('POST', '/catalogue-items/bulk', {
    body: {
      items: [
        { name: 'Bulk Skewer', priceTZS: 8000, category: 'Grilled Skewers' },
        { id: 'p1', name: 'P1 renamed bulk', priceTZS: p1.price, category: 'Grilled Skewers' },
        { id: 'p2', name: 'P2 price bump', priceTZS: p2.price + 1000, category: 'Grilled Skewers' },
        { name: 'Bad category', priceTZS: 1000, category: 'Nope' },
        { id: 'p_missing', name: 'Missing item', priceTZS: 1000, category: 'Grilled Skewers' },
      ],
    },
  });
  assert.equal(res.status, 202);
  assert.ok(res.body.jobId);
  assert.equal(res.body.accepted, 2, 'created + same-price update accepted');
  assert.equal(res.body.rejected, 3);
  assert.equal(res.body.failures.length, 3);
  assert.ok(res.body.failures.some((f: any) => f.reason.includes('OVERWRITE_PRICES_REQUIRED')), 'price change without overwritePrices rejected');
  assert.equal(db.table('products').find('p1')?.name, 'P1 renamed bulk');

  const overwrite = await call('POST', '/catalogue-items/bulk', {
    body: { overwritePrices: true, items: [{ id: 'p2', name: 'P2 overwritten', priceTZS: p2.price + 1000, category: 'Grilled Skewers' }] },
  });
  assert.equal(overwrite.status, 202);
  assert.equal(overwrite.body.accepted, 1);
  assert.equal(overwrite.body.rejected, 0);
  assert.equal(db.table('products').find('p2')?.price, p2.price + 1000);

  const tooMany = await call('POST', '/catalogue-items/bulk', {
    body: { items: Array.from({ length: 501 }, (_, i) => ({ name: `Item ${i}`, priceTZS: 100, category: 'Grilled Skewers' })) },
  });
  assert.equal(tooMany.status, 400);
  assert.equal(tooMany.body.error.code, 'BULK_EXCEEDS_LIMIT');
});

test('POST /catalogues/import: 202 completed, valid rows land, invalid rows carry per-row failures', async () => {
  const before = db.table('products').where((p) => p.merchantId === 'm_demo').length;
  const res = await call('POST', '/catalogues/import', {
    body: {
      rows: [
        { name: 'Import Skewer A', priceTZS: 5000, category: 'Grilled Skewers' },
        { name: 'Import Skewer B', priceTZS: 7000, category: 'Drinks & Sides', description: 'cold drink', quantity: 12 },
        { name: '', priceTZS: 5000, category: 'Grilled Skewers' },
        { name: 'Negative price', priceTZS: -1, category: 'Grilled Skewers' },
        { name: 'Unknown category', priceTZS: 5000, category: 'Nope' },
      ],
    },
  });
  assert.equal(res.status, 202);
  assert.ok(res.body.jobId);
  assert.equal(res.body.status, 'completed');
  assert.equal(res.body.failures.length, 3, 'per-row failures carried on the response (app extension)');
  assert.equal(res.body.failures[0].row, 3, 'row numbers are 1-based');
  assert.ok(res.body.failures.some((f: any) => f.reason.includes('NAME_REQUIRED')));
  assert.ok(res.body.failures.some((f: any) => f.reason.includes('INVALID_PRICE_TZS')));
  assert.ok(res.body.failures.some((f: any) => f.reason.includes('CATEGORY_NOT_FOUND')));
  assert.equal(db.table('products').where((p) => p.merchantId === 'm_demo').length, before + 2);

  const imported = db.table('products').where((p) => p.name === 'Import Skewer B')[0];
  assert.equal(imported.stock, 12, 'quantity mapped to stock');

  const invalidRows = await call('POST', '/catalogues/import', { body: { rows: 'nope' } });
  assert.equal(invalidRows.status, 400);
  assert.equal(invalidRows.body.error.code, 'INVALID_ROWS');
});

/* ================= Product templates: PATCH + DELETE ================= */

test('PATCH /product-templates/{id}: rename + items; 404 for unknown', async () => {
  const created = await call('POST', '/templates', { body: { name: 'P1 template', productId: 'p1' } });
  assert.equal(created.status, 200);
  const id = created.body.template.id;

  const patched = await call('PATCH', `/product-templates/${id}`, {
    body: { name: 'Renamed template', items: [{ catalogueItemId: 'p1', priceTZS: 4500, available: false }], appliedStoreIds: ['s_demo'] },
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.template.name, 'Renamed template');
  assert.equal(patched.body.template.items.length, 1);
  assert.equal(patched.body.template.items[0].priceTZS, 4500);
  assert.deepEqual(patched.body.template.appliedStoreIds, ['s_demo']);
  assert.ok(patched.body.template.createdAt);

  const row = db.table('templates').find(id)!;
  assert.equal(row.name, 'Renamed template', 'template row updated');

  const blank = await call('PATCH', `/product-templates/${id}`, { body: { name: '   ' } });
  assert.equal(blank.status, 400);
  assert.equal(blank.body.error.code, 'NAME_REQUIRED');

  const missing = await call('PATCH', '/product-templates/tpl_nope', { body: { name: 'X' } });
  assert.equal(missing.status, 404);
});

test('DELETE /product-templates/{id}: 204 then 404', async () => {
  const created = await call('POST', '/templates', { body: { name: 'Delete me', productId: 'p1' } });
  const id = created.body.template.id;

  const del = await call('DELETE', `/product-templates/${id}`);
  assert.equal(del.status, 204);
  assert.equal(db.table('templates').find(id), undefined, 'template removed from db');

  const again = await call('DELETE', `/product-templates/${id}`);
  assert.equal(again.status, 404);
});

/* ================= Categories: DELETE (earlier wave — verify) ================= */

test('DELETE /categories/{id}: empty category removed; 404 unknown; 409 when products assigned', async () => {
  const created = await call('POST', '/categories', { body: { name: 'Temporary Cat' } });
  assert.equal(created.status, 200);
  const id = created.body.category.id;

  const del = await call('DELETE', `/categories/${id}`);
  assert.equal(del.status, 200);
  assert.equal(del.body.deleted, true);
  assert.equal(db.table('categories').find(id), undefined, 'category row removed');

  const missing = await call('DELETE', '/categories/c_nope');
  assert.equal(missing.status, 404);

  const blocked = await call('DELETE', '/categories/c1');
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.error.code, 'PRODUCTS_ASSIGNED');
});

/* ================= Merchants: list / detail / apply / claim ================= */

test('GET /merchants: public approved list includes the demo merchant', async () => {
  const res = await call('GET', '/merchants', { auth: false });
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body));
  const demo = res.body.find((m: any) => m.id === 'm_demo');
  assert.ok(demo);
  assert.equal(demo.businessName, 'Skewer House BBQ · Kariakoo');
  assert.equal(typeof demo.rating, 'number');
  assert.equal(typeof demo.isOpen, 'boolean');
  assert.ok(Array.isArray(demo.categories));
});

test('GET /merchants/{id}: public profile; 404 unknown', async () => {
  const res = await call('GET', '/merchants/m_demo', { auth: false });
  assert.equal(res.status, 200);
  assert.equal(res.body.id, 'm_demo');
  assert.equal(res.body.businessName, 'Skewer House BBQ · Kariakoo');
  assert.equal(res.body.city, 'Dar es Salaam');

  const missing = await call('GET', '/merchants/m_unknown', { auth: false });
  assert.equal(missing.status, 404);
});

test('POST /merchants: application -> LeadCreated 201; validation 422', async () => {
  const res = await call('POST', '/merchants', {
    auth: false,
    body: { businessName: 'Kariakoo Greens', contactPhone: '+255712345678', city: 'Dar es Salaam', businessType: 'grocery', description: 'Fresh produce' },
  });
  assert.equal(res.status, 201);
  assert.ok(res.body.id);
  assert.ok(['submitted', 'under_review'].includes(res.body.status));
  assert.ok(res.body.createdAt);

  const missingFields = await call('POST', '/merchants', { auth: false, body: { contactPhone: '+255712345678' } });
  assert.equal(missingFields.status, 422);
  assert.equal(missingFields.body.error.code, 'VALIDATION_ERROR');
  const fields = missingFields.body.error.details.errors.map((e: any) => e.field);
  assert.ok(fields.includes('businessName') && fields.includes('city'));

  const badType = await call('POST', '/merchants', { auth: false, body: { businessName: 'X', contactPhone: '+255712345678', city: 'Dar es Salaam', businessType: 'airline' } });
  assert.equal(badType.status, 422);
  assert.ok(badType.body.error.details.errors.some((e: any) => e.code === 'INVALID_BUSINESS_TYPE'));
});

test('POST /merchants/claim: 201 with a fresh phone; 409 on owned listing, unknown listing, duplicate claim', async () => {
  const claimed = await call('POST', '/merchants/claim', {
    auth: false,
    body: { merchantId: 'm_demo', contactPhone: '+255713333333', documentsNote: 'I operate this store' },
  });
  assert.equal(claimed.status, 201);
  assert.equal(claimed.body.status, 'under_review');
  assert.ok(claimed.body.id);

  const owned = await call('POST', '/merchants/claim', {
    auth: false,
    body: { merchantId: 'm_demo', contactPhone: '+255700000000' },
  });
  assert.equal(owned.status, 409);
  assert.equal(owned.body.error.code, 'CLAIM_LISTING_OWNED');

  const unknown = await call('POST', '/merchants/claim', {
    auth: false,
    body: { merchantId: 'm_unknown', contactPhone: '+255713333333' },
  });
  assert.equal(unknown.status, 409);
  assert.equal(unknown.body.error.code, 'CLAIM_LISTING_NOT_FOUND');

  const dup = await call('POST', '/merchants/claim', {
    auth: false,
    body: { merchantId: 'm_demo', contactPhone: '+255713333333' },
  });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error.code, 'CLAIM_ALREADY_PENDING');

  const badNote = await call('POST', '/merchants/claim', {
    auth: false,
    body: { merchantId: 'm_demo', contactPhone: '+255714444444', documentsNote: 'x'.repeat(501) },
  });
  assert.equal(badNote.status, 422);
});

/* ================= Merchant settings: GET/PUT round-trip ================= */

test('GET /merchants/me/settings: seeded shape (businessHours + acceptanceMethod)', async () => {
  const res = await call('GET', '/merchants/me/settings');
  assert.equal(res.status, 200);
  assert.equal(res.body.acceptanceMethod, 'manual');
  assert.ok(Array.isArray(res.body.businessHours));
  assert.equal(res.body.businessHours.length, 7);
  assert.equal(res.body.businessHours[0].dayOfWeek, 0);
  assert.equal(typeof res.body.businessHours[0].open, 'string');
  assert.ok(res.body.specialRules);
});

test('PUT /merchants/me/settings: round-trip + isOpen propagates to stores; validation 422', async () => {
  const put = await call('PUT', '/merchants/me/settings', {
    body: {
      announcement: 'New seasonal menu',
      specialRules: 'Kitchen closes 30 minutes before the store.',
      acceptanceMethod: 'auto',
      orderNotificationChannels: ['push', 'sms'],
      acceptedPaymentMethods: ['mpesa', 'card', 'cod'],
      isOpen: false,
      businessHours: [{ dayOfWeek: 1, open: '10:00', close: '22:00', closed: false }],
    },
  });
  assert.equal(put.status, 200);
  assert.equal(put.body.announcement, 'New seasonal menu');
  assert.equal(put.body.acceptanceMethod, 'auto');
  assert.equal(put.body.isOpen, false);
  assert.deepEqual(put.body.orderNotificationChannels, ['push', 'sms']);

  const readBack = await call('GET', '/merchants/me/settings');
  assert.equal(readBack.body.specialRules, 'Kitchen closes 30 minutes before the store.', 'settings persisted');
  assert.equal(readBack.body.isOpen, false);
  assert.equal(db.table('stores').find('s_demo')?.open, false, 'isOpen=false propagates to the store row');

  const badMethod = await call('PUT', '/merchants/me/settings', { body: { acceptanceMethod: 'sometimes' } });
  assert.equal(badMethod.status, 422);
  assert.ok(badMethod.body.error.details.errors.some((e: any) => e.code === 'INVALID_ACCEPTANCE_METHOD'));

  const badHours = await call('PUT', '/merchants/me/settings', { body: { businessHours: [{ dayOfWeek: 9, open: '25:00', close: '22:00' }] } });
  assert.equal(badHours.status, 422);
  assert.ok(badHours.body.error.details.errors.length >= 2, 'dayOfWeek and hour validated');

  const longAnnouncement = await call('PUT', '/merchants/me/settings', { body: { announcement: 'x'.repeat(501) } });
  assert.equal(longAnnouncement.status, 422);

  const badChannel = await call('PUT', '/merchants/me/settings', { body: { orderNotificationChannels: ['push', 'telegram'] } });
  assert.equal(badChannel.status, 422);
  assert.ok(badChannel.body.error.details.errors.some((e: any) => e.code === 'INVALID_CHANNEL'));

  // restore
  await call('PUT', '/merchants/me/settings', {
    body: { announcement: 'Summer night BBQ every Friday — family platters 15% off', acceptanceMethod: 'manual', isOpen: true, orderNotificationChannels: ['push', 'in_app'], acceptedPaymentMethods: ['mpesa', 'airtel_money', 'cod'] },
  });
  assert.equal(db.table('stores').find('s_demo')?.open, true);
});

/* ================= Payout account: GET/PUT ================= */

test('GET /merchants/me/payout-account: seeded account is masked + verified', async () => {
  const res = await call('GET', '/merchants/me/payout-account');
  assert.equal(res.status, 200);
  assert.equal(res.body.type, 'mobile_money');
  assert.equal(res.body.provider, 'mpesa');
  assert.equal(res.body.accountMasked, '****1234');
  assert.equal(res.body.verified, true);
  assert.ok(res.body.updatedAt);
});

test('PUT /merchants/me/payout-account: masks new number, verification pending; validation 422', async () => {
  const put = await call('PUT', '/merchants/me/payout-account', {
    body: { type: 'bank', provider: 'nmb', accountNumber: '0123456789', accountHolderName: 'Juma Mwenda' },
  });
  assert.equal(put.status, 200);
  assert.equal(put.body.type, 'bank');
  assert.equal(put.body.provider, 'nmb');
  assert.equal(put.body.accountMasked, '****6789', 'only the last 4 digits are exposed');
  assert.equal(put.body.verified, false, 'changed account requires verification');
  assert.ok(put.body.updatedAt);

  const readBack = await call('GET', '/merchants/me/payout-account');
  assert.equal(readBack.body.accountMasked, '****6789', 'new account persisted');

  const missingNumber = await call('PUT', '/merchants/me/payout-account', { body: { type: 'mobile_money', provider: 'mpesa', accountHolderName: 'X' } });
  assert.equal(missingNumber.status, 422);
  assert.ok(missingNumber.body.error.details.errors.some((e: any) => e.field === 'accountNumber'));

  const badType = await call('PUT', '/merchants/me/payout-account', { body: { type: 'crypto', provider: 'x', accountNumber: '1', accountHolderName: 'X' } });
  assert.equal(badType.status, 422);
  assert.ok(badType.body.error.details.errors.some((e: any) => e.code === 'INVALID_TYPE'));

  // restore the seed account
  const restore = await call('PUT', '/merchants/me/payout-account', {
    body: { type: 'mobile_money', provider: 'mpesa', accountNumber: '255700001234', accountHolderName: 'Juma Mwenda' },
  });
  assert.equal(restore.status, 200);
  assert.equal(restore.body.accountMasked, '****1234');
});

/* ================= Chain stores: PATCH ================= */

test('PATCH /merchants/me/stores/{id}: ChainStore round-trip; 404 unknown/foreign store', async () => {
  const patched = await call('PATCH', '/merchants/me/stores/s_demo', {
    body: { isOpen: false, announcement: 'Closed for fumigation' },
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.id, 's_demo');
  assert.equal(patched.body.businessName, 'Skewer House BBQ · Kariakoo');
  assert.equal(patched.body.isOpen, false);
  assert.equal(patched.body.verification, 'approved');
  assert.equal(db.table('stores').find('s_demo')?.open, false, 'store row updated');
  assert.equal(db.table('stores').find('s_demo')?.announcement, 'Closed for fumigation');

  const unknown = await call('PATCH', '/merchants/me/stores/s_unknown', { body: { isOpen: true } });
  assert.equal(unknown.status, 404);

  const badMethod = await call('PATCH', '/merchants/me/stores/s_demo', { body: { acceptanceMethod: 'nope' } });
  assert.equal(badMethod.status, 422);

  const restored = await call('PATCH', '/merchants/me/stores/s_demo', { body: { isOpen: true } });
  assert.equal(restored.body.isOpen, true);
});

/* ================= P10: payout codes + settings extras (impl-10) ================= */

test('payout account: PAYOUT_ACCOUNT_NOT_SET on missing row; provider gate; verification-required 409', async () => {
  db.table('merchantPayoutAccounts').where((p) => p.merchantId === 'm_demo').forEach((p) => db.table('merchantPayoutAccounts').remove(p.id));

  const missing = await call('GET', '/merchants/me/payout-account');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, 'PAYOUT_ACCOUNT_NOT_SET');

  const badProvider = await call('PUT', '/merchants/me/payout-account', {
    body: { type: 'mobile_money', provider: 'wallet-x', accountNumber: '255700001234', accountHolderName: 'Juma Mwenda' },
  });
  assert.equal(badProvider.status, 422);
  assert.equal(badProvider.body.error.details.errors[0].code, 'PAYOUT_ACCOUNT_PROVIDER_UNSUPPORTED');

  const created = await call('PUT', '/merchants/me/payout-account', {
    body: { type: 'mobile_money', provider: 'mpesa', accountNumber: '255700009999', accountHolderName: 'Juma Mwenda' },
  });
  assert.equal(created.status, 200);
  assert.equal(created.body.verified, false, 'new account requires verification');

  const sameAgain = await call('PUT', '/merchants/me/payout-account', {
    body: { type: 'mobile_money', provider: 'mpesa', accountNumber: '255700009999', accountHolderName: 'Juma Mwenda' },
  });
  assert.equal(sameAgain.status, 409);
  assert.equal(sameAgain.body.error.code, 'PAYOUT_ACCOUNT_VERIFICATION_REQUIRED');

  // restore the seed account (verified)
  const restore = await call('PUT', '/merchants/me/payout-account', {
    body: { type: 'mobile_money', provider: 'mpesa', accountNumber: '255700001234', accountHolderName: 'Juma Mwenda' },
  });
  assert.equal(restore.status, 200);
  assert.equal(restore.body.accountMasked, '****1234');
});

test('PUT /merchants/me/settings: logoUrl + printSettings.paperSize extras; delivery money validation', async () => {
  const put = await call('PUT', '/merchants/me/settings', {
    body: {
      logoUrl: 'https://cdn.example.com/logo.png',
      printSettings: { autoPrint: true, copies: 2, labelPrinter: true, paperSize: '58mm' },
      deliverySettings: { radiusKm: 5, deliveryFeeTZS: 3500, minimumOrderTZS: 20000, sameDayCutoff: '18:30' },
    },
  });
  assert.equal(put.status, 200);
  assert.equal(put.body.logoUrl, 'https://cdn.example.com/logo.png', 'logoUrl extension rides the settings surface');
  assert.equal(put.body.printSettings.paperSize, '58mm');
  assert.deepEqual(put.body.deliverySettings, { radiusKm: 5, deliveryFeeTZS: 3500, minimumOrderTZS: 20000, sameDayCutoff: '18:30' });

  const readBack = await call('GET', '/merchants/me/settings');
  assert.equal(readBack.body.logoUrl, 'https://cdn.example.com/logo.png');

  const badFee = await call('PUT', '/merchants/me/settings', { body: { deliverySettings: { deliveryFeeTZS: 3000.5 } } });
  assert.equal(badFee.status, 422);
  assert.ok(badFee.body.error.details.errors.some((e: any) => e.field === 'deliverySettings.deliveryFeeTZS' && e.code === 'INVALID_MONEY'));

  const badCutoff = await call('PUT', '/merchants/me/settings', { body: { deliverySettings: { sameDayCutoff: '25:00' } } });
  assert.equal(badCutoff.status, 422);
  assert.ok(badCutoff.body.error.details.errors.some((e: any) => e.code === 'INVALID_CUTOFF'));

  const badPaper = await call('PUT', '/merchants/me/settings', { body: { printSettings: { paperSize: '72mm' } } });
  assert.equal(badPaper.status, 422);
  assert.ok(badPaper.body.error.details.errors.some((e: any) => e.code === 'INVALID_PAPER_SIZE'));

  const badLogo = await call('PUT', '/merchants/me/settings', { body: { logoUrl: 'not-a-url' } });
  assert.equal(badLogo.status, 422);
  assert.ok(badLogo.body.error.details.errors.some((e: any) => e.code === 'INVALID_LOGO_URL'));

  // restore
  const restored = await call('PUT', '/merchants/me/settings', {
    body: { logoUrl: null, printSettings: { autoPrint: true, copies: 1, labelPrinter: false, paperSize: '80mm' } },
  });
  assert.equal(restored.status, 200);
  assert.equal(restored.body.logoUrl, null);
});
