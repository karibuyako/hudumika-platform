/* Playwright browser-test harness for the Hudumika consumer app.
 *
 * Resolution: playwright is installed at the platform root node_modules
 * (never the app's node_modules). createRequire anchors resolution there so
 * scripts run from any cwd.
 *
 * State: each test starts a fresh browser CONTEXT (clean storage) → the app
 * boots into the city picker/onboarding. completeOnboarding() walks the full
 * 5-step wizard through the real UI (this doubles as auth coverage) and lands
 * on /home. Tests reuse their context for all operations.
 */
import { createRequire } from 'node:module';
import { mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const PLATFORM_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const require = createRequire(resolve(PLATFORM_ROOT, 'package.json'));
const { chromium } = require('playwright');

export const APP_URL = 'http://localhost:8082';
export const DEMO_PHONE = '+255700000000';

export async function launchContext() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  return { browser, context, page };
}

export async function gotoApp(page, route = '/') {
  await page.goto(`${APP_URL}${route}`, { waitUntil: 'networkidle', timeout: 90000 });
  await page.waitForTimeout(6000);
}

export async function pageText(page) {
  return page.evaluate(() => document.body.innerText.replace(/\n+/g, ' | '));
}

export async function clickText(page, text, { exact = true } = {}) {
  await page.getByText(text, { exact }).first().click();
  await page.waitForTimeout(1200);
}

export async function fillPlaceholder(page, placeholder, value) {
  await page.getByPlaceholder(placeholder).fill(value);
  await page.waitForTimeout(500);
}

export async function screenshot(page, name) {
  const dir = resolve(PLATFORM_ROOT, 'consumer-mobile/app/e2e-browser/shots');
  mkdirSync(dir, { recursive: true });
  const p = resolve(dir, `${name}.png`);
  await page.screenshot({ path: p, fullPage: false });
  return p;
}

/** Full real-UI onboarding: login → OTP (on-screen debug code) → 5-step wizard → /home. */
export async function completeOnboarding(page) {
  // Land wherever we are; drive to the login screen.
  const body = await pageText(page);
  if (body.includes('Choose your city')) {
    // already past auth (restored session) — pick city and continue
    await clickText(page, 'Dar es Salaam');
    await clickText(page, 'Continue');
    await page.waitForTimeout(3000);
    return;
  }
  if (!body.includes('Send code')) {
    await gotoApp(page, '/login');
  }
  // Login screen → phone + Send code
  await page.getByPlaceholder(/\+255|phone|Phone/i).first().fill(DEMO_PHONE).catch(async () => {
    const inputs = page.locator('input');
    await inputs.nth(0).fill(DEMO_PHONE);
  });
  await page.waitForTimeout(500);
  await clickText(page, 'Send code');
  await page.waitForTimeout(2000);
  // Verify screen → read the demo debug code from the page
  const verifyBody = await pageText(page);
  const codeMatch = verifyBody.match(/\b(\d{6})\b/);
  if (!codeMatch) throw new Error(`no debug code found on verify screen: ${verifyBody.slice(0, 300)}`);
  const inputs = page.locator('input');
  await inputs.first().fill(codeMatch[1]);
  await page.waitForTimeout(500);
  await clickText(page, 'Sign in');
  await page.waitForTimeout(2500);
  // Onboarding wizard: skip carousel / next, profile, address, payment, city.
  const ob = await pageText(page);
  if (ob.includes('Order anything')) {
    await clickText(page, 'Skip');
    await page.waitForTimeout(1500);
  }
  // Profile step (name + language) → Save/Next
  const p2 = await pageText(page);
  if (/Full name|name/i.test(p2) && p2.includes('language') === false && !p2.includes('Choose your city')) {
    // name field present
    await page.locator('input').first().fill('Test User');
    await page.waitForTimeout(500);
    await clickText(page, 'Save');
    await page.waitForTimeout(1500);
  }
  const p3 = await pageText(page);
  if (!p3.includes('Choose your city') && /Address|address/i.test(p3)) {
    await clickText(page, 'Skip');
    await page.waitForTimeout(1500);
  }
  const p4 = await pageText(page);
  if (!p4.includes('Choose your city') && /Payment|pay/i.test(p4)) {
    await clickText(page, 'Skip');
    await page.waitForTimeout(1500);
  }
  const p5 = await pageText(page);
  if (p5.includes('Choose your city')) {
    await clickText(page, 'Dar es Salaam');
    await clickText(page, 'Continue');
    await page.waitForTimeout(3500);
  }
  // Push sheet may appear (first session) — Allow or Not now both continue.
  const after = await pageText(page);
  if (/notifications|Allow/i.test(after) && !after.includes('Recommended for you')) {
    await clickText(page, 'Not now').catch(() => {});
    await page.waitForTimeout(1500);
  }
  const home = await pageText(page);
  if (!/Recommended for you|Nearby|Categories/i.test(home)) {
    throw new Error(`onboarding did not land on home: ${home.slice(0, 300)}`);
  }
}

/** Navigate to a route and wait for render (no unmatched-route). */
export async function gotoRoute(page, route) {
  await page.goto(`${APP_URL}${route}`, { waitUntil: 'networkidle', timeout: 90000 });
  await page.waitForTimeout(5000);
  const t = await pageText(page);
  if (t.includes('Unmatched Route') || t.includes('Page could not be found')) {
    throw new Error(`unmatched route at ${route}`);
  }
  return t;
}

export async function expectText(page, text, label) {
  const t = await pageText(page);
  if (!t.includes(text)) throw new Error(`[${label}] expected "${text}" — got: ${t.slice(0, 400)}`);
  return t;
}
