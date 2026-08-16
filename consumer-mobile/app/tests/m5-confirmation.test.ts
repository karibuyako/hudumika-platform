/* M5 — Order confirmation: after placement the checkout success path lands on
 * /order/confirmation/{id}; the screen's data (order number, totals, items,
 * ETA, payment method via the linked intent) must be resolvable from the
 * repositories alone. */
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

import { idempotencyKey } from '@/lib/idempotency';
import { resetMockState } from './helpers';
import { MockOrdersRepository } from '@/repos/mock/orders';
import { MockPaymentsRepository } from '@/repos/mock/payments';
import { getState } from '@/repos/mock/mockState';

const orders = new MockOrdersRepository();
const payments = new MockPaymentsRepository();

beforeEach(() => resetMockState());

function validInput(paymentMethod: 'mpesa' | 'cod' = 'mpesa') {
  const merchant = getState().merchants.find((m) => m.isOpen)!;
  const item = getState().catalogues.get(merchant.id)!.items.find((i) => i.available !== false)!;
  return {
    merchantId: merchant.id,
    items: [{ catalogueItemId: item.id!, quantity: 2, unitPriceTZS: item.priceTZS }],
    paymentMethod,
    deliveryAddress: { label: 'Home', lines: '12 Makunganya St', contactPhone: '+255700000000' },
  };
}

test('confirmation data is retrievable after placement: order number, totals, items, ETA', async () => {
  const input = validInput();
  const created = await orders.create(input, idempotencyKey('cus_1', 'order'));
  const detail = await orders.get(created.id);
  // Order number + identity
  assert.equal(detail.id, created.id);
  assert.equal(detail.no, created.no);
  assert.match(detail.no!, /^HD-OR-\d+$/);
  // Totals are integer TZS satisfying the sum rule
  assert.deepEqual(detail.totals, created.totals);
  for (const v of Object.values(detail.totals)) assert.ok(Number.isInteger(v));
  assert.equal(detail.totals.subtotalTZS + detail.totals.deliveryFeeTZS + detail.totals.platformFeeTZS + detail.totals.taxTZS - detail.totals.discountTZS, detail.totals.totalTZS);
  // Items + delivery address + ETA (rendered verbatim, never client-computed)
  assert.equal(detail.items?.length, 1);
  assert.equal(detail.items![0].catalogueItemId, input.items[0].catalogueItemId);
  assert.equal(detail.items![0].quantity, 2);
  assert.equal(detail.items![0].unitPriceTZS, input.items[0].unitPriceTZS);
  assert.equal(detail.deliveryAddress.lines, '12 Makunganya St');
  assert.ok(typeof detail.deliveryEtaMin === 'number' && detail.deliveryEtaMin > 0, 'ETA is a server-provided positive integer');
});

test('the linked payment intent resolves from history by orderId (confirmation payment method)', async () => {
  const created = await orders.create(validInput(), idempotencyKey('cus_1', 'order'));
  const intent = await payments.createIntent(created.id, 'mpesa', idempotencyKey('cus_1', 'intent'));
  await payments.confirm(intent.id, idempotencyKey('cus_1', 'confirm'));
  const history = await payments.getHistory();
  const linked = history.find((i) => i.orderId === created.id);
  assert.ok(linked, 'history exposes the order→intent linkage for the confirmation screen');
  assert.equal(linked.method, 'mpesa');
  assert.equal(linked.status, 'paid');
  assert.ok(linked.providerReference, 'paid intents carry the provider reference');
  assert.ok(linked.paidAt && !Number.isNaN(Date.parse(linked.paidAt)), 'paidAt is a parseable UTC ISO string');
  assert.equal(linked.amountTZS, created.totals.totalTZS);
});

test('COD placement resolves straight to a paid linked intent (confirmation success path)', async () => {
  const input = validInput('cod');
  const created = await orders.create(input, idempotencyKey('cus_1', 'order-cod'));
  assert.equal((await orders.get(created.id)).status, 'paid');
  const history = await payments.getHistory();
  const linked = history.find((i) => i.orderId === created.id);
  assert.ok(linked, 'COD creates a linked paid intent');
  assert.equal(linked.method, 'cod');
  assert.equal(linked.status, 'paid');
  assert.ok(linked.providerReference);
  assert.ok(linked.paidAt && !Number.isNaN(Date.parse(linked.paidAt)));
});
