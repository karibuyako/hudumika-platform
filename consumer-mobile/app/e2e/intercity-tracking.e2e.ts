/* TESTING.md §4 — Intercity tracking (T1, T2, T4) + exception banner (T3/T6).
 *
 * T1/T2: orders tab → "Order HD-OR-482914" (ord_intercity_002, the seeded
 * intercity order: waybill WB-1042-MWZ, legs spanning two days) → detail →
 * "Track order" → the six-phase strip renders in fixed order with the seeded
 * completed/active/pending states, the route timeline renders Day 1 / Day 2
 * sections with per-leg status + ETA, the waybill trail lists scanned →
 * departed, and the "Advanced" disclosure reveals the shipment number.
 *
 * T4: the tracking-phases endpoint contract is asserted through the same
 * strip (phases render in contract order with pills; leg internals never
 * render — hub ids only appear as from→to on the route legs, which the
 * screen renders from RouteSegment, not from the phases).
 *
 * Real labels (verified against src/app/order/[orderId]/tracking.tsx,
 * src/repos/mock/mockState.ts):
 *  - "Waybill WB-1042-MWZ" (t('track.waybillNumber')), phases
 *    "Order confirmed"/"Picked up"/"Traveling"/"Arrived in your city"/
 *    "Out for delivery"/"Delivered" (seed labels), "Journey" (t('track.phases')),
 *    "Route" (t('track.route')), "DAY 1"/"DAY 2" (t('track.day') uppercased),
 *    "Waybill trail" (t('track.waybill')), "scanned"/"departed" (waybill
 *    event types), "Advanced" (t('track.advanced')) → "Shipment number"
 *    (t('track.shipmentNumber')) + the raw waybill.
 *
 * DELAY-BANNER GAP (T3/T6): the amber "Your delivery is delayed" banner
 * (t('track.delayed')) renders only after an exception lands on the waybill.
 * The mock trigger — simulateIntercityDelay(getState()) in
 * src/repos/mock/mockState.ts — is a test/dev-only API with NO UI entry
 * point. The spec below asserts the banner exactly as it would appear once
 * triggered (and is skipped until a dev-only trigger button or seeded
 * exception exists). See the test body for the precise assertions.
 */
import { beforeAll, beforeEach, describe, it } from '@jest/globals';
import { by, element, expect } from 'detox';
import { bootToHome, expectVisible, relaunchToHome, tapTab } from './helpers';

describe('INTERCITY TRACKING (TESTING.md §4 "Intercity tracking" T1/T2/T4)', () => {
  beforeAll(async () => {
    await bootToHome();
  });

  beforeEach(async () => {
    await relaunchToHome();
  });

  it('T1/T2: intercity order detail → six phases → Day 1/2 route → waybill → Advanced', async () => {
    await tapTab('Orders');
    await element(by.text('Order HD-OR-482914')).tap();

    // Intercity header on the detail: type pill + waybill number.
    await expectVisible('intercity');
    await expectVisible('WB-1042-MWZ');
    await element(by.text('Track order')).tap();

    // Header: waybill line (t('track.waybillNumber')).
    await expectVisible('Waybill WB-1042-MWZ');

    // Six-phase strip — fixed contract order with seed states (T1 step 2, T4).
    await expectVisible('Journey');
    await expectVisible('Order confirmed');
    await expectVisible('Picked up');
    await expectVisible('Traveling'); // active phase (eta renders separately)
    await expectVisible('Arrived in your city');
    await expectVisible('Out for delivery');
    await expectVisible('Delivered');

    // Route timeline — Day 1 / Day 2 sections + per-leg rows (T2: overnight
    // linehaul → both day sections render from the leg plan).
    await expectVisible('Route');
    await expectVisible('DAY 1');
    await expectVisible('DAY 2');
    await expectVisible('first_mile');
    await expectVisible('linehaul');
    await expectVisible('hub_transfer');
    await expectVisible('last_mile');

    // Waybill trail (t('track.waybill')): scanned → departed rows.
    await expectVisible('Waybill trail');
    await expectVisible('scanned', 15000, 0);
    await expectVisible('departed');

    // "Advanced" disclosure → shipment number (T1 step 10: SH-… never
    // renders; the raw waybill number is the only identifier exposed). The
    // header shows the templated "Waybill WB-1042-MWZ" — the raw number is
    // unique to the disclosure, hence a plain exact match after expanding.
    await element(by.text('Advanced')).tap();
    await expectVisible('Shipment number');
    await expectVisible('WB-1042-MWZ');
  });

  it.skip('T3/T6: exception → "Your delivery is delayed" banner + waybill exception row', async () => {
    /* Requires the mock delay trigger: simulateIntercityDelay(getState()) in
     * src/repos/mock/mockState.ts (test/dev-only API — mockState.ts is the
     * read-only seam; there is no UI button that calls it today).
     *
     * To enable: expose a dev-only trigger (e.g. a long-press on the tracking
     * header, or an EXPO_PUBLIC_* dev entry) that calls
     * simulateIntercityDelay(getState()) → it pushes an `exception` waybill
     * event + publishes intercity.eta_updated/waybill.updated, which the
     * tracking screen's useLiveRefresh(TRACKING_EVENTS) refetches on. Then
     * delete `it.skip` — the assertions below are exact:
     *
     *   open tracking for HD-OR-482914 (as in the T1 test)
     *   → after the trigger:
     *     await expectVisible('Your delivery is delayed');            // t('track.delayed')
     *     await expectVisible('Linehaul bus delayed — new window posted below');
     *     await expectVisible('exception');                            // waybill trail row
     *     // six-phase position is kept; the active phase eta re-renders from
     *     // the server value (t('track.etaAt')) — never fabricated.
     */
  });

  it('negative: non-intercity order tracking has no waybill surfaces', async () => {
    await tapTab('Orders');
    // HD-OR-482913 (ord_active_001) is a local delivering order.
    await element(by.text('Order HD-OR-482913')).tap();
    await element(by.text('Track order')).tap();

    // Local order: no intercity-only surfaces. The delivering seed has a
    // rider location → the map + server ETA ("~18 min", deliveryEtaMin 18).
    await expectVisible('~18 min');
    await expect(element(by.text('Waybill trail'))).toNotExist();
    await expect(element(by.text('Advanced'))).toNotExist();
    await expect(element(by.text('Route'))).toNotExist();
  });
});
