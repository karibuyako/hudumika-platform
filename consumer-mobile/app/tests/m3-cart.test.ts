/* M3 — Cart: per-merchant groups, quantity bounds (1–99), merge same item,
 * options keyed lines, remove/clear, advisory subtotal preview, per-group
 * checkout (groups not being checked out stay in the cart). */
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

import { groupSubtotal, useCartStore } from '@/store/cart';
import type { CartItem } from '@/store/cart';

beforeEach(() => useCartStore.setState({ groups: [] }));

const item = (id: string, price = 1000): CartItem => ({ catalogueItemId: id, name: id, unitPriceTZS: price, quantity: 1 });

test('items group per merchant and each group becomes its own order unit', () => {
  useCartStore.getState().addItem({ merchantId: 'm1', merchantName: 'Sunrise' }, item('a'));
  useCartStore.getState().addItem({ merchantId: 'm2', merchantName: 'Coastline' }, item('b'));
  const groups = useCartStore.getState().groups;
  assert.equal(groups.length, 2);
  assert.equal(groups[0].merchantName, 'Sunrise');
  assert.equal(groups[1].merchantName, 'Coastline');
});

test('adding the same item+options merges quantities instead of duplicating', () => {
  const add = () => useCartStore.getState().addItem({ merchantId: 'm1', merchantName: 'Sunrise' }, item('a'));
  add();
  add();
  const groups = useCartStore.getState().groups;
  assert.equal(groups[0].items.length, 1);
  assert.equal(groups[0].items[0].quantity, 2);
});

test('same catalogueItemId with different options stays a separate line', () => {
  const base = { merchantId: 'm1', merchantName: 'Sunrise' };
  useCartStore.getState().addItem(base, { ...item('a'), options: [{ group: 'Size', choice: 'Regular' }] });
  useCartStore.getState().addItem(base, { ...item('a'), options: [{ group: 'Size', choice: 'Large' }] });
  assert.equal(useCartStore.getState().groups[0].items.length, 2);
});

test('quantity bounds are clamped to 1..99', () => {
  const base = { merchantId: 'm1', merchantName: 'Sunrise' };
  useCartStore.getState().addItem(base, { ...item('a'), quantity: 99 });
  useCartStore.getState().updateQuantity('m1', 'a', 1);
  assert.equal(useCartStore.getState().groups[0].items[0].quantity, 99);
  useCartStore.getState().addItem(base, { ...item('b'), quantity: 200 });
  assert.equal(useCartStore.getState().groups[0].items[1].quantity, 99);
  // A large negative delta removes the line (quantity never goes below 1).
  useCartStore.getState().updateQuantity('m1', 'b', -1000);
  assert.equal(useCartStore.getState().groups[0].items.length, 1);
});

test('decrementing a single-quantity line removes it', () => {
  useCartStore.getState().addItem({ merchantId: 'm1', merchantName: 'Sunrise' }, item('a'));
  useCartStore.getState().updateQuantity('m1', 'a', -1);
  assert.equal(useCartStore.getState().groups.length, 0);
});

test('subtotal preview is integer TZS and advisory (server recomputes at checkout)', () => {
  const base = { merchantId: 'm1', merchantName: 'Sunrise' };
  useCartStore.getState().addItem(base, { ...item('a'), unitPriceTZS: 4500, quantity: 2 });
  useCartStore.getState().addItem(base, { ...item('b'), unitPriceTZS: 1500, quantity: 1 });
  const subtotal = groupSubtotal(useCartStore.getState().groups[0]);
  assert.equal(subtotal, 10500);
  assert.ok(Number.isInteger(subtotal));
});

test('clearGroup and clear reset the draft', () => {
  const base = { merchantId: 'm1', merchantName: 'Sunrise' };
  useCartStore.getState().addItem(base, item('a'));
  useCartStore.getState().addItem({ merchantId: 'm2', merchantName: 'Other' }, item('b'));
  useCartStore.getState().clearGroup('m1');
  assert.equal(useCartStore.getState().groups.length, 1);
  useCartStore.getState().clear();
  assert.equal(useCartStore.getState().groups.length, 0);
});

test('addToCart stores the BASE price with options keyed separately (never folded in)', () => {
  const base = { merchantId: 'm1', merchantName: 'Sunrise' };
  useCartStore.getState().addItem(base, {
    ...item('a', 12000),
    options: [{ group: 'Size', choice: 'Large' }],
    addons: ['Extra chips'],
    optionsPriceTZS: 5000,
  });
  const line = useCartStore.getState().groups[0].items[0];
  assert.equal(line.unitPriceTZS, 12000, 'unitPriceTZS is the base catalogue price only');
  assert.equal(line.optionsPriceTZS, 5000, 'option/addon price lives in the advisory preview field');
  assert.deepEqual(line.options, [{ group: 'Size', choice: 'Large' }]);
  assert.deepEqual(line.addons, ['Extra chips']);
});

test('same catalogueItemId with different addons stays a separate line', () => {
  const base = { merchantId: 'm1', merchantName: 'Sunrise' };
  useCartStore.getState().addItem(base, { ...item('a'), addons: ['Extra chips'] });
  useCartStore.getState().addItem(base, { ...item('a'), addons: ['Extra sauce'] });
  assert.equal(useCartStore.getState().groups[0].items.length, 2);
});

test('subtotal preview includes the option price but money stays integer TZS', () => {
  const base = { merchantId: 'm1', merchantName: 'Sunrise' };
  useCartStore.getState().addItem(base, { ...item('a', 12000), optionsPriceTZS: 3000, quantity: 2 });
  const subtotal = groupSubtotal(useCartStore.getState().groups[0]);
  assert.equal(subtotal, 30000);
  assert.ok(Number.isInteger(subtotal));
});

test('checking out one merchant group leaves the other groups in the cart', () => {
  const base = { merchantId: 'm1', merchantName: 'Sunrise' };
  useCartStore.getState().addItem(base, item('a'));
  useCartStore.getState().addItem({ merchantId: 'm2', merchantName: 'Coastline' }, item('b'));
  // Checkout clears exactly the group it created an order for (per-group flow).
  useCartStore.getState().clearGroup('m1');
  const remaining = useCartStore.getState().groups;
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].merchantId, 'm2');
  assert.equal(remaining[0].items.length, 1);
  assert.equal(remaining[0].items[0].catalogueItemId, 'b', 'unchecked groups keep their items');
});
