/* TESTING.md §4 — auth + cold start.
 *
 * Covers:
 *  - "Order happy path" OTP-login leg: cold start → city picker → home.
 *  - Logout path (profile → "Sign out") landing back on the login screen.
 *  - Full OTP login: phone → request code → verify with the on-screen demo
 *    code → city picker → home.
 *
 * Boot facts (verified against src/store/session.ts, src/app/index.tsx,
 * src/app/(onboarding)/onboarding.tsx, src/app/(auth)/login.tsx,
 * src/app/(auth)/verify-otp.tsx):
 *  - The mock restore() always resolves the seeded user, so a cold start
 *    lands on the city picker (no persisted city) — NOT on login.
 *  - "Continue" on the city picker opens the one-time push-permission sheet;
 *    "Not now" dismisses it and routes home.
 *  - verify-otp shows the mock demo code on screen; the spec reads it via
 *    getAttributes() (by.text(/^\d{6}$/)) — the only honest way to obtain it.
 *  - Home is asserted with the real labels: tab "Home", categories section
 *    "Services" (t('home.categories')), "Flash deals" (t('home.flashDeals')),
 *    "Nearby merchants" (t('home.nearby')). NOTE: the audit brief mentioned
 *    "Categories" — the app's real section title is "Services" (en.ts).
 */
import { beforeEach, describe, it } from '@jest/globals';
import { by, element, waitFor } from 'detox';
import {
  completeCityPicker,
  expectVisible,
  launchClean,
  loginDemo,
  tapTab,
} from './helpers';

describe('AUTH / cold start + OTP login (TESTING.md §4 order happy path)', () => {
  beforeEach(async () => {
    // True cold start for every test — app data (session, city, flags) wiped.
    await launchClean();
  });

  it('cold start → city picker → home', async () => {
    await waitFor(element(by.text('Choose your city'))).toBeVisible().withTimeout(20000);

    await element(by.text('Dar es Salaam')).tap();
    await element(by.text('Continue')).tap();

    // First-session push prompt — dismiss it.
    await waitFor(element(by.text('Not now'))).toBeVisible().withTimeout(4000);
    await element(by.text('Not now')).tap();

    // Home loads: tab bar + real section titles.
    await expectVisible('Home');
    await expectVisible('Services', 15000, 0); // categories header (tab dup)
    await expectVisible('Nearby merchants');
    await expectVisible('Flash deals');
    await expectVisible('Dar es Salaam'); // city name in the location header
  });

  it('logout path — profile "Sign out" returns to the login screen', async () => {
    await completeCityPicker();

    await tapTab('Me');
    await expectVisible('Account', 15000, 0); // section header (renders per section)
    await element(by.text('Sign out')).tap();

    // Login screen: title + the send-code CTA.
    await expectVisible('Hudumika');
    await expectVisible('Get code');
    await expectVisible('Demo account: +255700000000 · code is shown on screen');
  });

  it('OTP login with the on-screen demo code → city picker → home', async () => {
    await completeCityPicker();
    await tapTab('Me');
    await element(by.text('Sign out')).tap();

    await loginDemo();
    await completeCityPicker();

    await expectVisible('Home');
    await expectVisible('Flash deals');
  });

  it('OTP validation error surfaces the real copy', async () => {
    await completeCityPicker();
    await tapTab('Me');
    await element(by.text('Sign out')).tap();

    await waitFor(element(by.text('Hudumika'))).toBeVisible().withTimeout(20000);
    await element(by.label('Phone')).tap();
    await element(by.label('Phone')).typeText('+255700000000');
    await element(by.text('Get code')).tap();

    // Wrong code on purpose — the demo code is read but never entered as-is.
    await waitFor(element(by.text(/^\d{6}$/))).toBeVisible().withTimeout(15000);
    await element(by.label('Verification code')).tap();
    await element(by.label('Verification code')).typeText('000000');
    await element(by.text('Sign in')).tap();

    await expectVisible('Incorrect code — try again');
  });
});
