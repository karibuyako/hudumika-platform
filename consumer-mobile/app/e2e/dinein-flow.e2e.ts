/* TESTING.md §4 — Dine-in.
 *
 * Dine-in → manual QR entry (hudumika:dinein:table:table_1 — the placeholder
 * the Field shows, DINE_IN_QR_EXAMPLE) → resolve → table menu → add items →
 * open bill → request bill / pay (M-Pesa intent) → "Paid" state.
 *
 * Real labels (verified against src/app/dine-in.tsx, src/lib/dineIn.ts):
 *  - The QR entry Field carries accessibilityLabel "Table QR payload"
 *    (t('dineIn.qrField')); its placeholder IS the example payload.
 *  - "Open bill" (t('dineIn.open')) resolves the QR; the basket CTA is
 *    "Open bill — {amount}" (t('dineIn.openBill')).
 *  - table_1 resolves to the seed merchant "Mama Nne Foods" (menu title
 *    "Menu — Mama Nne Foods").
 *  - Menu items render one "Add" (t('dineIn.add')) button each — atIndex(0)
 *    picks the first item ("Fried Fish").
 *  - Detail: "Request bill / Pay" (t('dineIn.requestBill')) runs the intent
 *    flow; the mock webhook flips the bill to paid → StatusPill "Paid" +
 *    "Paid {t}" (t('dineIn.paidAt')).
 *
 * NOTE: the seeded open bill on table_0 (dine_open_001) exists specifically
 * to exercise the DINE_IN_TABLE_IN_USE banner — that path is asserted in
 * component tests; the E2E uses table_1 to avoid the pre-existing bill.
 */
import { beforeAll, beforeEach, describe, it } from '@jest/globals';
import { by, element, waitFor } from 'detox';
import { bootToHome, expectVisible, relaunchToHome } from './helpers';

const TABLE_QR = 'hudumika:dinein:table:table_1';

describe('DINE-IN (TESTING.md §4 "Dine-in")', () => {
  beforeAll(async () => {
    await bootToHome();
  });

  beforeEach(async () => {
    await relaunchToHome();
  });

  it('manual QR entry → table menu → add → open bill → request bill/pay → Paid', async () => {
    // Home quick action "Scan QR" is the dine-in entry point.
    await element(by.text('Scan QR')).tap();
    await expectVisible('Dine-in');

    // Manual entry — paste the QR payload into the field.
    await element(by.label('Table QR payload')).tap();
    await element(by.label('Table QR payload')).typeText(TABLE_QR);
    await element(by.text('Open bill')).tap();

    // Table menu resolved by the server from the payload.
    await expectVisible('Menu — Mama Nne Foods');
    await element(by.text('Add')).atIndex(0).tap(); // Fried Fish
    await expectVisible('Fried Fish'); // basket line

    // Open the bill (footer CTA carries the total).
    await element(by.text(/^Open bill — /)).tap();
    await expectVisible('Bill');
    await expectVisible('Table table_1');
    await expectVisible('Open', 15000, 0); // status pill before payment

    // Pay: "Request bill / Pay" → intent + confirm → mock webhook flips paid.
    await element(by.text('Request bill / Pay')).tap();
    await waitFor(element(by.text('Paid')).atIndex(0)).toBeVisible().withTimeout(20000);
    await expectVisible(/^Paid /); // t('dineIn.paidAt') row
  });
});
