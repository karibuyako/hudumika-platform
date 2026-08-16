/* TESTING.md §4 — Booking happy path.
 *
 * Services tab → Electrical (svc_002; its questionnaire is chip-only — svc_001
 * Plumbing requires a photo question, which cannot be answered by an
 * automated run) → service detail → "Book this service" → questionnaire
 * ("No power") → schedule (ASAP default) → estimate renders → "Book & pay" →
 * M-Pesa intent (mock confirm) → booking detail ("Booking #…", status "Paid",
 * timeline "Paid via mobile money").
 *
 * Real labels (verified against src/app/(tabs)/services/index.tsx,
 * src/app/service/[serviceId].tsx, src/app/book.tsx,
 * src/app/booking/[bookingId].tsx, src/i18n/locales/en.ts):
 *  - Service cards carry accessibilityLabel "Booking" (all of them) — matched
 *    by visible category text ("Electrical").
 *  - Questionnaire answers are Chips (visible text); "Book & pay" is
 *    t('booking.confirm').
 *  - After payment the booking detail shows "Booking #<id-last-6>".
 *
 * COMPLETION-CONFIRMATION GAP: TESTING.md's full booking path ends with
 * awaiting_customer_confirmation → POST /bookings/{id}/complete. The mock
 * seed (mockState.ts) never creates/advances a booking into that state, so
 * the "Confirm completion" button cannot render against the current seed.
 * The completion test below is written against the exact flow and is skipped
 * until the seed (or a dev-only advance hook) provides the state — see the
 * test body for the precise assertions to run.
 */
import { beforeAll, beforeEach, describe, it } from '@jest/globals';
import { by, device, element, waitFor } from 'detox';
import { addHomeAddress, bootToHome, expectVisible, relaunchToHome, tapTab } from './helpers';

describe('BOOKING happy path (TESTING.md §4 "Booking happy path")', () => {
  beforeAll(async () => {
    await bootToHome();
  });

  beforeEach(async () => {
    await relaunchToHome();
  });

  it('services → Electrical → questionnaire → Book & pay → booking detail (Paid)', async () => {
    // Booking forms need a saved address ("Book & pay" is disabled without
    // one — book.tsx `disabled={... !address ...}`). Add it first via /addresses.
    await tapTab('Me');
    await element(by.text('Addresses')).tap();
    await element(by.text('Add address')).tap();
    await addHomeAddress();
    await device.pressBack();

    await tapTab('Services');
    await expectVisible('Electrical');
    await element(by.text('Electrical')).tap();

    await expectVisible('Book this service');
    await element(by.text('Book this service')).tap();

    // /book — booking form with questionnaire, schedule + estimate.
    await expectVisible('Book & pay');
    await element(by.text('No power')).tap(); // required question answer

    // Schedule: ASAP is the default — no interaction needed. Estimate renders
    // from the mock (GET /bookings/estimate).
    await expectVisible('Estimated');

    await element(by.text('Book & pay')).tap();

    // Payment intent → confirm resolves the STK wait → booking detail.
    await waitFor(element(by.text(/^Booking #/))).toBeVisible().withTimeout(30000);
    await expectVisible('Paid', 15000, 0); // status pill
    await expectVisible('Paid via mobile money'); // timeline event note
    await expectVisible('Cancel booking'); // paid bookings are cancellable
  });

  it('seeded quote booking — approve the issued quote', async () => {
    await tapTab('Orders');
    await element(by.text('Bookings')).tap();
    // Seeded quote booking (bk_quote_002 → "Booking #te_002").
    await element(by.text('Booking #te_002')).tap();

    await expectVisible('Quote');
    await element(by.text('Approve')).tap();

    // Status pill flips to "Quote approved" (t('status.quote_accepted')).
    await waitFor(element(by.text('Quote approved'))).toBeVisible().withTimeout(15000);
  });

  it.skip('completion confirmation — awaiting_customer_confirmation → complete', async () => {
    /* REQUIRES a seeded (or dev-advanced) booking in
     * awaiting_customer_confirmation — mockState.ts seeds none today.
     * To enable: seed such a booking (status: 'awaiting_customer_confirmation')
     * or expose a test hook to advance bk_active_001, then delete `it.skip`.
     *
     * Expected flow once the state exists:
     *   tapTab('Orders') → 'Bookings' → open the awaiting-confirmation row
     *     → booking detail renders "Confirm completion" (t('booking.complete'))
     *     alongside "Problem" (t('booking.problem'))
     *     → tap "Confirm completion" → toast "Booking completed"
     *     (t('booking.completed')) → refetch → status pill "Completed"
     *     (t('status.completed')) → "Rate your provider" CTA appears.
     *   The 409 conflict path (BOOKING_STATUS_CONFLICT) is the server-side
     *   guard — the app refetches (toast "The booking changed — reloaded").
     */
  });
});
