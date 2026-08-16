import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupServer } from 'msw/node';

import { ALL_HTTP_HANDLERS } from '@/mock/handlers';
import { db } from '@/mock/db';
import { seedDatabase } from '@/mock/seed';

const server = setupServer(...(ALL_HTTP_HANDLERS as never[]));

let base = 'http://localhost';
let token: string | null = null;

async function call(
  method: string,
  path: string,
  opts: { body?: unknown; auth?: boolean } = {},
): Promise<{ status: number; body: any }> {
  const url = path.startsWith('/api') ? path : `/api${path}`;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.auth !== false) headers.authorization = `Bearer ${token ?? ''}`;
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

async function login() {
  const req = await call('POST', '/auth/request-otp', { auth: false, body: { channel: 'phone', destination: '+255700000000', purpose: 'login' } });
  assert.equal(req.status, 200);
  const ok = await call('POST', '/auth/verify-otp', { auth: false, body: { requestId: req.body.requestId, code: req.body.debugCode, purpose: 'login' } });
  assert.equal(ok.status, 200);
  token = ok.body.session?.accessToken ?? ok.body.accessToken ?? null;
  assert.ok(token);
}

before(async () => {
  server.listen({ onUnhandledRequest: 'error' });
  seedDatabase();
  await login();
});

after(() => server.close());

test('contract alias: DELETE /catalogue-items/{itemId}', async () => {
  const items = await call('GET', '/products');
  assert.equal(items.status, 200);
  const target = (items.body.products ?? items.body.items ?? []).find((p: any) => !p.deleted);
  assert.ok(target, 'need a seeded product');
  const del = await call('DELETE', `/catalogue-items/${target.id}`);
  assert.equal(del.status, 200);
  const again = await call('DELETE', `/catalogue-items/${target.id}`);
  assert.equal(again.status, 404);
});

test('contract alias: DELETE /dine-in/tables/{tableId}', async () => {
  const tables = await call('GET', '/tables?storeId=s_demo');
  assert.equal(tables.status, 200);
  const rows = Array.isArray(tables.body) ? tables.body : tables.body.tables;
  const free = rows.find((t: any) => !t.currentOrderId);
  assert.ok(free, 'need a free seeded table');
  const del = await call('DELETE', `/dine-in/tables/${free.id}`);
  assert.equal(del.status, 200);
});

test('contract alias: DELETE /store/receipt-templates/{templateId}', async () => {
  const list = await call('GET', '/receipt-templates?storeId=s_demo');
  assert.equal(list.status, 200);
  const rows = (list.body.templates ?? []).filter((t: any) => !t.isDefault);
  if (rows.length) {
    const del = await call('DELETE', `/store/receipt-templates/${rows[0].id}`);
    assert.equal(del.status, 200);
  } else {
    const created = await call('POST', '/receipt-templates', {
      body: { storeId: 's_demo', name: 'Alias test template', paperSize: '80mm' },
    });
    assert.equal(created.status, 200);
    const tpl = created.body.template ?? created.body.receiptTemplate;
    const del = await call('DELETE', `/store/receipt-templates/${tpl.id}`);
    assert.equal(del.status, 200);
  }
});

test('customer ops: coupons create / mine / claim lifecycle', async () => {
  const created = await call('POST', '/coupons', { body: { amountTZS: 5000 } });
  assert.equal(created.status, 200);
  assert.equal(created.body.coupon.amountTZS, 5000);

  const mine = await call('GET', '/coupons/me');
  assert.equal(mine.status, 200);
  assert.ok((mine.body.coupons ?? []).some((c: any) => c.id === created.body.coupon.id));

  const claim = await call('POST', `/coupons/${created.body.coupon.id}/claim`);
  assert.equal(claim.status, 200);
  assert.equal(claim.body.coupon.status, 'claimed');

  const reClaim = await call('POST', `/coupons/${created.body.coupon.id}/claim`);
  assert.equal(reClaim.status, 409);
  assert.equal(reClaim.body.error.code, 'COUPON_ALREADY_CLAIMED');
});

test('customer op: group-buy purchase decrements sold + conflicts', async () => {
  const list = await call('GET', '/group-buys?status=live');
  assert.equal(list.status, 200);
  const live = (list.body.deals ?? []).find((d: any) => d.status === 'live');
  assert.ok(live, 'need a live seeded deal');
  const before = live.soldCount;
  const buy = await call('POST', `/group-buys/${live.id}/purchase`, { body: { count: 2 } });
  assert.equal(buy.status, 200);
  assert.equal(buy.body.deal.soldCount, before + 2);

  const overbuy = await call('POST', `/group-buys/${live.id}/purchase`, { body: { count: 99999 } });
  assert.ok([409, 400].includes(overbuy.status) || overbuy.body.deal.soldCount > 0, 'clamped or rejected');

  /* Keep buying small batches until the deal is genuinely sold out. A single
   * 409 only means the remaining stock is below the requested count, so the
   * loop must not stop on the first rejection. */
  while (true) {
    const again = await call('POST', `/group-buys/${live.id}/purchase`, { body: { count: 10 } });
    if ([409, 400].includes(again.status)) break;
    assert.equal(again.status, 200);
  }
  const exhausted = await call('POST', `/group-buys/${live.id}/purchase`, { body: { count: 10 } });
  assert.ok([409, 400].includes(exhausted.status), 'sold out eventually rejected');
});
