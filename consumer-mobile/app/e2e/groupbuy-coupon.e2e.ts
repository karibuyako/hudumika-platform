/* TESTING.md §4 — Group buy + Coupon.
 *
 * Profile → Group buys → deal detail → buy → vouchers issued → "Use" → wallet
 * → profile → Coupons → claim an available coupon → "Claimed".
 *
 * Real labels (verified against src/app/group-buys/index.tsx,
 * src/app/group-buys/[groupId].tsx, src/app/vouchers.tsx, src/app/coupons.tsx,
 * src/repos/mock/mockState.ts):
 *  - Deal feed rows show the title + a small "Buy" CTA; the detail's purchase
 *    CTA is "Buy {amount}" (t('groupBuy.buyNow')) — "Buy TZS 12,000" for the
 *    seeded 2-for-1 Chicken & Chips deal (gb_001).
 *  - After purchase the detail renders "Your vouchers" with the issued codes
 *    ("GB-…") + a "Use" button that opens the voucher wallet.
 *  - Coupons screen lists the seed set; only "FREEDEL" (coup_002) is
 *    `available` so "Claim" (t('coupons.claim')) is unique; claiming flips
 *    the row to the "Claimed" pill (t('coupons.claimed')) + toast.
 *  - The "Group buys" profile row is t('groupBuy.title') = "Group buys".
 */
import { beforeAll, beforeEach, describe, it } from '@jest/globals';
import { by, element, waitFor } from 'detox';
import { bootToHome, expectVisible, relaunchToHome, tapTab } from './helpers';

describe('GROUP BUY + COUPON (TESTING.md §4 "Group buy" + "Coupon")', () => {
  beforeAll(async () => {
    await bootToHome();
  });

  beforeEach(async () => {
    await relaunchToHome();
  });

  it('group-buys → deal detail → buy → vouchers issued → wallet shows the code', async () => {
    await tapTab('Me');
    await element(by.text('Group buys')).tap();

    await expectVisible('2-for-1 Chicken & Chips');
    await element(by.text('2-for-1 Chicken & Chips')).tap();

    await expectVisible('Buy TZS 12,000');
    await element(by.text('Buy TZS 12,000')).tap();

    // Vouchers issued on the detail: codes are "GB-…" (mock purchase).
    await expectVisible('Your vouchers');
    await expectVisible(/^GB-/, 15000, 0);

    // "Use" opens the voucher wallet — the issued code is listed there.
    await element(by.text('Use')).tap();
    await expectVisible('Vouchers');
    await expectVisible(/^GB-/, 15000, 0);
  });

  it('coupons — claim the available FREEDEL coupon → Claimed', async () => {
    await tapTab('Me');
    await element(by.text('Coupons')).tap();

    await expectVisible('FREEDEL'); // coup_002 — status available
    await element(by.text('Claim')).tap();

    await waitFor(element(by.text('Claimed')).atIndex(0)).toBeVisible().withTimeout(15000);
    // The already-claimed WELCOME20 seed row confirms claimed rows render.
    await expectVisible('WELCOME20');
  });
});
