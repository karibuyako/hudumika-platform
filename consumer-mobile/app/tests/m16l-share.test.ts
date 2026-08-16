/* M16l — Share order/booking (OPERATIONS-COVERAGE #138): the share payload
 * carries the hudumika:// deep link (deep-link.ts allow-list scheme) plus the
 * ref and detail, and shareContent is node-safe (no share surface in the
 * unit-test env — it resolves false without touching react-native). */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildSharePayload, shareContent, shareLink } from '@/lib/share';

test('buildSharePayload embeds the deep link and ref for an order', () => {
  const payload = buildSharePayload({
    kind: 'order',
    id: 'ord_active_001',
    title: 'HD-OR-0001',
    detail: 'Delivered · TZS 12,500',
  });
  assert.ok(payload.includes('hudumika://order/ord_active_001'), 'the hudumika deep link is present');
  assert.ok(payload.includes('HD-OR-0001'), 'the order ref is present');
  assert.ok(payload.includes('Delivered'), 'the detail rides the payload');
  assert.ok(payload.includes('Hudumika'), 'the message names the platform');
});

test('buildSharePayload embeds the deep link and ref for a booking', () => {
  const payload = buildSharePayload({
    kind: 'booking',
    id: 'bk_active_01',
    title: 'BK-001234',
    detail: 'Scheduled · TZS 8,000',
  });
  assert.ok(payload.includes('hudumika://booking/bk_active_01'), 'the hudumika deep link is present');
  assert.ok(payload.includes('BK-001234'), 'the booking ref is present');
});

test('the share link mirrors the deep-link allow-list scheme hudumika://route/id', () => {
  assert.equal(shareLink('order', 'ord_1'), 'hudumika://order/ord_1');
  assert.equal(shareLink('booking', 'bk_1'), 'hudumika://booking/bk_1');
});

test('shareContent is node-safe: resolves false with no share surface', async () => {
  assert.equal(await shareContent('hudumika://order/ord_active_001'), false);
});
