/* TESTING.md §4 — Order happy path (T1).
 *
 * home → merchant (open "Mama Nne Foods", merchants[1] of the deterministic
 * seed) → catalogue → add an item via the dish sheet → cart → checkout →
 * add a delivery address → M-Pesa intent (mock provider confirms) → "Order
 * confirmed" → track order.
 *
 * Real labels used (verified against src/app/(tabs)/home/index.tsx,
 * src/app/merchant/[merchantId].tsx, src/components/DishSheet.tsx,
 * src/app/cart.tsx, src/app/checkout.tsx, src/app/addresses.tsx,
 * src/app/order/confirmation/[orderId].tsx, src/app/order/[orderId]/tracking.tsx):
 *  - Merchant cards carry no accessibilityLabel — matched by their visible
 *    business name text. "Mama Nne Foods" appears on 3 seed cards; the first
 *    one (merchants[1]) is the only OPEN one, hence atIndex(0).
 *  - The dish sheet's add-to-cart button is labelled "Cart" (t('cart.title')).
 *  - NAVIGATION GAP: the app has no cart bar/icon on home or merchant screens;
 *    the only in-app route to /cart is the home "Reorder" quick action
 *    (router.push('/cart')). The spec documents this by reaching the cart
 *    through "Reorder" after adding the item; once the a11y/nav pass adds a
 *    cart bar, replace that step with tapping it.
 *  - Checkout address: the store starts empty (no seeded addresses), so the
 *    spec adds one via /addresses ("Add a delivery address" → "Add address").
 *  - Checkout "Pay {amount}" renders "Pay TZS 18,300" for a TZS 15,000
 *    "Fried Fish" + TZS 2,500 delivery + TZS 800 platform fee — asserted by
 *    regex so the exact amount can drift with the seed.
 */
import { beforeAll, beforeEach, describe, it } from '@jest/globals';
import { by, device, element, waitFor } from 'detox';
import { addHomeAddress, bootToHome, expectVisible, relaunchToHome } from './helpers';

describe('ORDER happy path (TESTING.md §4 "Order happy path")', () => {
  beforeAll(async () => {
    await bootToHome();
  });

  beforeEach(async () => {
    // Fresh mock seed per test; session/city persisted → straight to home.
    await relaunchToHome();
  });

  it('T1: merchant → catalogue → add to cart → checkout → paid → confirm → track', async () => {
    // --- Merchant (open seed merchant, first "Mama Nne Foods" card) --------
    await element(by.text('Mama Nne Foods')).atIndex(0).tap();
    await expectVisible('Menu');
    await expectVisible('Open'); // merchant.isOpen pill

    // --- Catalogue → dish sheet → add ("Cart" is the sheet's add button) ----
    await element(by.text('Fried Fish')).tap();
    await expectVisible('Cart');
    await element(by.text('Cart')).tap();

    // --- Back home → cart (only in-app /cart entry: "Reorder" quick action) -
    await element(by.text('Back')).tap();
    await waitFor(element(by.text('Home'))).toBeVisible().withTimeout(10000);
    await element(by.text('Reorder')).tap();

    // Cart: the added line is present; first group is our merchant's.
    await expectVisible('Fried Fish');
    await element(by.text('Go to checkout')).atIndex(0).tap();

    // --- Checkout: no saved address yet → add one ---------------------------
    await expectVisible('Checkout');
    await element(by.text('Add a delivery address')).tap();
    await element(by.text('Add address')).tap();
    await addHomeAddress();

    // Back to checkout — the address is now selected (addAddress selects it).
    await device.pressBack();
    await waitFor(element(by.text('Home — Mahando Street, Dar es Salaam'))).toBeVisible().withTimeout(10000);

    // --- Pay (M-Pesa intent → mock confirm = the STK-push wait resolves) ----
    await element(by.text(/^Pay TZS /)).tap();
    await waitFor(element(by.text('Order confirmed'))).toBeVisible().withTimeout(30000);

    // --- Track the fresh order ----------------------------------------------
    await element(by.text('Track order')).tap();
    // Paid order, no rider yet — the map + ETA rows both render the real
    // "Location unavailable" copy (t('track.locationUnavailable')).
    await expectVisible('Location unavailable', 15000, 0);
  });
});
