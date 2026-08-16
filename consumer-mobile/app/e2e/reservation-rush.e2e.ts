/* TESTING.md §4 — Reservation + Rush + Favorites.
 *
 * Reservations: profile → Reservations → seeded rows render ("Party of 4" +
 * Pending, "Party of 2" + Confirmed — the reservations mock seeds two on
 * first list()) → "New" → pick a restaurant ("Coastline Grill" — unique
 * within the sheet's first-6 merchant slice) → party size (default 2) →
 * slot chip ("Tomorrow 13:00") → "Confirm reservation" → the new pending row
 * tops the list.
 *
 * Favorites: home merchant heart (accessibilityLabel "Add to favorites" /
 * "Remove from favorites" — the seed has no favorites) → profile →
 * Favorites lists the merchant → unfavorite → empty state
 * ("No favorites yet — tap the heart to save").
 *
 * RUSH GAP: isRushable() allows merchant_accepted/preparing only
 * (src/lib/order.ts) — mockState.ts seeds NO order in either state (the
 * active seed is delivering, the rest paid/picked_up), and the "Hurry up"
 * button only renders for rushable orders, so the positive rush path cannot
 * run against the current seed. The negative path IS asserted (a paid order
 * renders no "Hurry up"); the positive flow is written below as a skipped
 * test with the exact assertions, pending a rushable seed.
 *
 * Real labels (verified against src/app/reservations.tsx, src/app/favorites.tsx,
 * src/app/(tabs)/home/index.tsx, src/app/order/[orderId].tsx).
 */
import { beforeAll, beforeEach, describe, it } from '@jest/globals';
import { by, element, expect, waitFor } from 'detox';
import { bootToHome, expectVisible, relaunchToHome, tapTab } from './helpers';

describe('RESERVATION + RUSH + FAVORITES (TESTING.md §4 "Reservation", "Rush", "Favorites")', () => {
  beforeAll(async () => {
    await bootToHome();
  });

  beforeEach(async () => {
    await relaunchToHome();
  });

  it('reservations — seeded rows render; create → pending row appears', async () => {
    await tapTab('Me');
    await element(by.text('Reservations')).tap();

    // Seeded reservations (mock seeds on first list()).
    await expectVisible('Party of 4');
    await expectVisible('Pending', 15000, 0);
    await expectVisible('Confirmed', 15000, 0);

    // Create flow.
    await element(by.text('New')).tap();
    await element(by.text('Coastline Grill')).tap();
    await element(by.text('Tomorrow 13:00')).tap();
    await element(by.text('Confirm reservation')).tap();

    // New pending row tops the active-first list (party size defaults to 2).
    await waitFor(element(by.text('Pending')).atIndex(0)).toBeVisible().withTimeout(15000);
    await expectVisible('Party of 2', 15000, 0);
  });

  it('favorites — heart on home → favorites list → unfavorite → empty state', async () => {
    // Heart the first merchant card (by accessibilityLabel — no visible text
    // on the icon button).
    await element(by.label('Add to favorites')).atIndex(0).tap();
    await expectVisible('Remove from favorites', 5000, 0); // a11y flips

    await tapTab('Me');
    await element(by.text('Favorites')).tap();
    await expectVisible('Kilimanjaro Eats'); // first seed merchant card

    // Unfavorite from home, then the favorites screen empties.
    await tapTab('Home');
    await element(by.label('Remove from favorites')).atIndex(0).tap();
    await tapTab('Me');
    await element(by.text('Favorites')).tap();
    await expectVisible('No favorites yet — tap the heart to save');
  });

  it('rush — negative path: a paid order renders no "Hurry up"', async () => {
    await tapTab('Orders');
    // HD-OR-482914 is paid — not rushable (isRushable: accepted/preparing).
    await element(by.text('Order HD-OR-482914')).tap();
    await expectVisible('Paid', 15000, 0);
    await expect(element(by.text('Hurry up'))).toNotExist();
  });

  it.skip('rush — positive path on a merchant_accepted/preparing order', async () => {
    /* REQUIRES a seeded (or dev-advanced) order in merchant_accepted or
     * preparing — mockState.ts seeds none (the active seed is delivering).
     * To enable: seed such an order (or reuse ord_active_001 with status
     * 'preparing'), then delete `it.skip` — the assertions are exact:
     *
     *   open the rushable order detail
     *   → "Hurry up" (t('order.rush')) renders (variant outline, flash icon)
     *   → tap it → the mock rush() 204 → refetch → "Rush requested · …"
     *     (t('order.rushed') + timestamp) renders in the order card and the
     *     button disappears (rushRequestedAt set).
     *   The ORDER_RUSH_NOT_ALLOWED path (409) is the server-side guard — the
     *     screen refetches and the error copy surfaces.
     */
  });
});
