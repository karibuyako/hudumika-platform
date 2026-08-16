/* Shared helpers for the Detox E2E suite (TESTING.md §4).
 *
 * All specs run against the MSW-backed mock build (mocks default ON in debug
 * builds). The mock seed (src/repos/mock/mockState.ts, MOCK_SEED 20260813) is
 * deterministic and module-local, so `device.reloadApp()` gives every spec a
 * pristine seed; `device.launchApp({ delete: true })` additionally wipes the
 * persisted session/city for the true cold-start path.
 *
 * Boot facts the helpers rely on (verified against src/store/session.ts,
 * src/app/(onboarding)/onboarding.tsx, src/app/(auth)/*.tsx):
 *   - restore() always resolves the mock user, so a cold start lands on the
 *     city picker (no persisted city → status 'onboarding'), NOT on login.
 *   - The city picker is step 5 of onboarding (the seeded user has a name).
 *   - "Continue" opens the one-time push-permission sheet on first session
 *     ("Not now" dismisses it and goes home).
 *   - The mock OTP flow shows the 6-digit demo code on the verify screen.
 */
import { by, device, element, expect, waitFor } from 'detox';

export const DEMO_PHONE = '+255700000000';
export const CITY_DAR = 'Dar es Salaam';

/** True cold start: app data (session, city, onboarding flags) wiped. */
export async function launchClean(): Promise<void> {
  await device.launchApp({ newInstance: true, delete: true });
}

/** Relaunch the app keeping the persisted session/city (mock state re-seeds
 * with the fresh JS bundle). A successful bootToHome() leaves the city
 * persisted, so this lands on home directly — the fast clean-ish path for
 * specs that don't need a cold start. */
export async function relaunchToHome(): Promise<void> {
  await device.relaunchApp({ newInstance: true });
  await waitForHome();
}

/** From the city picker: pick Dar es Salaam → Continue → dismiss the one-time
 * push sheet if it appears → wait for the home screen. */
export async function completeCityPicker(): Promise<void> {
  await waitFor(element(by.text('Choose your city'))).toBeVisible().withTimeout(20000);
  await element(by.text(CITY_DAR)).tap();
  await element(by.text('Continue')).tap();
  // First-session push prompt — "Not now" on every screen that can show it.
  // Flag is persisted, so later boots never see the sheet again.
  try {
    await waitFor(element(by.text('Not now'))).toBeVisible().withTimeout(4000);
    await element(by.text('Not now')).tap();
  } catch {
    /* sheet already dismissed or never shown */
  }
  await waitForHome();
}

/** Cold start → city picker → home (the standard per-file beforeAll). */
export async function bootToHome(): Promise<void> {
  await launchClean();
  await completeCityPicker();
}

/** Home screen is up: the "Home" tab label + the categories section.
 * The section title "Services" (t('home.categories')) duplicates the tab bar
 * label, hence atIndex(0) for the section header. */
export async function waitForHome(): Promise<void> {
  await waitFor(element(by.text('Home'))).toBeVisible().withTimeout(20000);
  await waitFor(element(by.text('Services')).atIndex(0)).toBeVisible().withTimeout(20000);
}

/** Tap a bottom tab by its accessibility label (react-navigation bottom tabs
 * expose the tab title as the button's accessibilityLabel; the screen titles
 * are plain Text and never carry that label, so by.label is unambiguous —
 * by.text would also match e.g. the home "Services" section header). */
export async function tapTab(label: string): Promise<void> {
  await element(by.label(label)).tap();
}

/** Read the on-screen mock OTP demo code (6 digits, shown on verify-otp). */
export async function readDemoCode(): Promise<string> {
  await waitFor(element(by.text(/^\d{6}$/))).toBeVisible().withTimeout(15000);
  const attrs = (await element(by.text(/^\d{6}$/)).getAttributes()) as unknown as {
    text?: string;
  };
  const code = attrs.text;
  if (!code || !/^\d{6}$/.test(code)) {
    throw new Error(`E2E: could not read the demo OTP code (got ${JSON.stringify(attrs)})`);
  }
  return code;
}

/** Full OTP login: phone → Get code → demo code → Sign in. Lands on the city
 * picker (fresh logins always run it — session store sets 'onboarding'). */
export async function loginDemo(): Promise<void> {
  await waitFor(element(by.text('Hudumika'))).toBeVisible().withTimeout(20000);
  await element(by.label('Phone')).tap();
  await element(by.label('Phone')).typeText(DEMO_PHONE);
  await element(by.text('Get code')).tap();

  const code = await readDemoCode();
  await element(by.label('Verification code')).tap();
  await element(by.label('Verification code')).typeText(code);
  await element(by.text('Sign in')).tap();

  await waitFor(element(by.text('Choose your city'))).toBeVisible().withTimeout(20000);
}

/** Simple visible-with-timeout helper to keep specs terse. `index` disambiguates
 * texts that legitimately render more than once (e.g. repeated status pills). */
export async function expectVisible(text: string | RegExp, timeout = 15000, index?: number): Promise<void> {
  const matcher = index === undefined ? element(by.text(text)) : element(by.text(text)).atIndex(index);
  await waitFor(matcher).toBeVisible().withTimeout(timeout);
}

/** Save the first delivery address via the /addresses sheet. Caller must be
 * on the addresses screen with the sheet open ("Add address" tapped).
 * The store starts empty and checkout/book forms require a service-area-
 * valid address, so every flow that pays needs this. */
export async function addHomeAddress(): Promise<void> {
  await element(by.label('Label')).tap();
  await element(by.label('Label')).typeText('Home');
  await element(by.label('Street, building')).tap();
  await element(by.label('Street, building')).typeText('Mahando Street, Dar es Salaam');
  await element(by.label('Contact phone')).tap();
  await element(by.label('Contact phone')).typeText('+255700000000');
  await element(by.text('Kinondoni')).tap(); // service-area chip (required)
  await element(by.text('Save address')).tap();
  await waitFor(element(by.text('Add address'))).toBeVisible().withTimeout(10000);
}

export { by, device, element, expect, waitFor };
