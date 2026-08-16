/* TESTING.md §4 — Cancellation.
 *
 * Order detail → Cancel order → reason → confirm → "Cancelled" status.
 * The seed order "HD-OR-482914" (ord_intercity_002) is `paid` — the only
 * cancellable seeded order (lib/order.ts CANCELLABLE_STATUSES = pending_payment
 * | paid | merchant_accepted; the other active seeds are delivering/picked_up).
 *
 * Real labels (verified against src/app/order/[orderId].tsx):
 *  - "Cancel order" is t('order.cancel') — it renders on the detail AND as the
 *    confirm button inside the sheet, hence atIndex(1) for the sheet one.
 *  - The reason input carries accessibilityLabel "Reason (optional)"
 *    (t('order.cancelReason')).
 *  - After cancel the status pill shows "Cancelled" (t('status.cancelled')),
 *    the reason round-trips into the timeline note, and "Cancel order" +
 *    "Track order" are gone (order no longer active/cancellable).
 */
import { beforeAll, beforeEach, describe, it } from '@jest/globals';
import { by, element, expect, waitFor } from 'detox';
import { bootToHome, expectVisible, relaunchToHome, tapTab } from './helpers';

describe('CANCELLATION (TESTING.md §4 "Cancellation")', () => {
  beforeAll(async () => {
    await bootToHome();
  });

  beforeEach(async () => {
    await relaunchToHome();
  });

  it('paid intercity order → cancel with reason → Cancelled', async () => {
    await tapTab('Orders');
    await element(by.text('Order HD-OR-482914')).tap();

    // Detail sanity: paid + intercity header before cancellation.
    await expectVisible('Paid', 15000, 0);
    await expectVisible('WB-1042-MWZ');
    await element(by.text('Cancel order')).tap();

    // Sheet: title + reason input + confirm button.
    await expectVisible('Cancel this order?');
    await element(by.label('Reason (optional)')).tap();
    await element(by.label('Reason (optional)')).typeText('Changed my mind');
    await element(by.text('Cancel order')).atIndex(1).tap();

    // Status flips to Cancelled; the reason is the timeline note.
    await waitFor(element(by.text('Cancelled')).atIndex(0)).toBeVisible().withTimeout(15000);
    await expectVisible('Changed my mind');

    // Terminal order: no cancel, no track.
    await expect(element(by.text('Cancel order'))).toNotExist();
    await expect(element(by.text('Track order'))).toNotExist();
  });
});
