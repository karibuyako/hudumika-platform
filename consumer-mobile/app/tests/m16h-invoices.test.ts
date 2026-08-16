/* M16h — Invoices & receipts (finance): the seeded invoice list, the
 * contract-shaped download response for known ids, 404 for unknown ids, and
 * the seed references to REAL order/booking ids (the mock must never invent
 * references to rows that do not exist in the shared state). The invoice
 * surface is contract GET-only (listInvoices / getInvoice / downloadInvoice —
 * generated, READ-ONLY); money is integer TZS. */
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

import { resetMockState, getState } from '@/repos/mock/mockState';
import { MockFinanceRepository } from '@/repos/mock/finance';
import { rejectsApiError } from './helpers';
import type { Invoice } from '@hudumika/contract';

const finance = new MockFinanceRepository();

beforeEach(() => {
  resetMockState();
});

test('listInvoices returns the seeded set — issued order, paid booking, requested', async () => {
  const list = await finance.listInvoices();
  assert.equal(list.length, 3);

  const byId = new Map(list.map((i) => [i.id, i]));

  const orderInv = byId.get('inv_001');
  assert.ok(orderInv, 'the issued order invoice seed exists');
  assert.equal(orderInv.number, 'INV-2026-0142');
  assert.equal(orderInv.status, 'issued');
  assert.equal(orderInv.kind, 'vat');
  assert.equal(orderInv.amountTZS, 27300);
  assert.ok(Number.isInteger(orderInv.amountTZS), 'money is integer TZS');
  assert.equal(orderInv.taxRateBps, 1800);
  assert.ok(Number.isInteger(orderInv.taxAmountTZS ?? 0));
  assert.ok(typeof orderInv.taxId === 'string' && orderInv.taxId.length > 0);
  assert.ok(!Number.isNaN(Date.parse(orderInv.createdAt)), 'createdAt is a parseable ISO stamp');
  assert.ok(orderInv.issuedAt && !Number.isNaN(Date.parse(orderInv.issuedAt)));

  const bookingInv = byId.get('inv_002');
  assert.ok(bookingInv, 'the paid booking invoice seed exists');
  assert.equal(bookingInv.status, 'paid');
  assert.equal(bookingInv.kind, 'standard');
  assert.equal(bookingInv.amountTZS, 65000);
  assert.ok(Number.isInteger(bookingInv.amountTZS));

  const requested = byId.get('inv_003');
  assert.ok(requested, 'the requested invoice seed exists');
  assert.equal(requested.status, 'requested');
  assert.equal(requested.issuedAt, null, 'a requested invoice has not been issued yet');
});

test('the invoice seeds reference real seeded order and booking ids', async () => {
  const state = getState();
  const list = await finance.listInvoices();

  for (const inv of list) {
    const details = inv.buyerDetails ?? {};
    if (typeof details.orderId === 'string') {
      assert.ok(
        state.orders.some((o) => o.id === details.orderId),
        `order reference ${details.orderId} exists in the seeded orders`,
      );
    }
    if (typeof details.bookingId === 'string') {
      assert.ok(
        state.bookings.some((b) => b.id === details.bookingId),
        `booking reference ${details.bookingId} exists in the seeded bookings`,
      );
    }
  }

  const orderInv = list.find((i) => i.id === 'inv_001');
  assert.equal((orderInv?.buyerDetails ?? {}).orderId, 'ord_active_001');
  const bookingInv = list.find((i) => i.id === 'inv_002');
  assert.equal((bookingInv?.buyerDetails ?? {}).bookingId, 'bk_active_001');
});

test('getInvoice returns the contract Invoice for a known id', async () => {
  const inv = await finance.getInvoice('inv_002');
  assert.equal(inv.id, 'inv_002');
  assert.equal(inv.number, 'INV-2026-0103');
  assert.equal(inv.amountTZS, 65000);
  assert.equal(inv.status, 'paid');
  assert.equal(inv.buyerDetails?.name, 'Demo Customer');
});

test('downloadInvoice returns the contract DownloadInvoice200 shape for a known id', async () => {
  const res = await finance.downloadInvoice('inv_001');
  assert.equal(typeof res.downloadUrl, 'string');
  assert.ok(res.downloadUrl.length > 0, 'a document URL is always served');
  assert.match(res.downloadUrl, /INV-2026-0142\.pdf$/, 'the URL identifies the invoice');
  assert.ok(Number.isInteger(res.expiresInSeconds), 'expiresInSeconds is an integer');
  assert.ok(res.expiresInSeconds > 0);
});

test('downloadInvoice 404s with INVOICE_NOT_FOUND for an unknown id', async () => {
  await rejectsApiError(finance.downloadInvoice('inv_nope'), 404, 'INVOICE_NOT_FOUND');
});

test('getInvoice 404s with INVOICE_NOT_FOUND for an unknown id', async () => {
  await rejectsApiError(finance.getInvoice('inv_nope'), 404, 'INVOICE_NOT_FOUND');
});

test('every seeded invoice is contract-shaped', async () => {
  const list = await finance.listInvoices();
  for (const inv of list) {
    assert.ok(inv.id.length > 0);
    assert.ok(inv.number.length > 0);
    assert.equal(typeof inv.amountTZS, 'number');
    assert.ok(Number.isInteger(inv.amountTZS));
    assert.ok(['draft', 'requested', 'issued', 'paid'].includes(inv.status), `status ${inv.status} is a contract InvoiceStatus`);
    assert.ok(inv.kind === undefined || inv.kind === 'vat' || inv.kind === 'standard', `kind is a contract InvoiceKind`);
  }
  const cloneCheck: Invoice = await finance.listInvoices().then((l) => l[0]);
  cloneCheck.number = 'MUTATED';
  const after = await finance.listInvoices();
  assert.notEqual(after[0].number, 'MUTATED', 'reads return deep clones — the mock state cannot be mutated through a consumer');
});
