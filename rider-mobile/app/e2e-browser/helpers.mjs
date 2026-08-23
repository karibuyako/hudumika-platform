import { createRequire } from 'node:module';
import { mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const PLATFORM_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const require = createRequire(resolve(PLATFORM_ROOT, 'package.json'));
let chromium;
try { ({ chromium } = require('playwright')); } catch { const { chromium: ch } = await import('playwright'); chromium = ch; }

export const APP_URL = process.env.APP_URL || 'http://localhost:8082';
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
  await page.waitForTimeout(5000);
}

export async function pageText(page) {
  return page.evaluate(() => document.body.innerText.replace(/\n+/g, ' | '));
}

export async function pageHtml(page) {
  return page.content();
}

export async function clickText(page, text, opts = {}) {
  const exact = opts.exact ?? false;
  try {
    await page.getByText(text, { exact }).first().click({ timeout: 8000 });
    await page.waitForTimeout(900);
    return true;
  } catch { return false; }
}

export async function fillPlaceholder(page, placeholder, value) {
  try {
    await page.getByPlaceholder(placeholder).first().fill(value, { timeout: 5000 });
    await page.waitForTimeout(500);
    return true;
  } catch { return false; }
}

export async function screenshot(page, name) {
  const dir = resolve(dirname(fileURLToPath(import.meta.url)), 'shots');
  mkdirSync(dir, { recursive: true });
  const p = resolve(dir, `${name}.png`);
  await page.screenshot({ path: p, fullPage: false }).catch(()=>{});
  return p;
}

export async function hasText(page, needle) {
  const t = await pageText(page);
  return t.includes(needle);
}

export async function expectText(page, needle, label) {
  const t = await pageText(page);
  if (!t.includes(needle)) throw new Error(`[${label}] expected "${needle}" — got: ${t.slice(0,600)}`);
}

export async function getComputed(page, selector, prop) {
  return page.evaluate(({ sel, prop }) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    return getComputedStyle(el)[prop];
  }, { sel: selector, prop });
}

// Rider-specific: complete OTP login via demo code shown on screen
export async function completeRiderLogin(page) {
  await gotoApp(page, '/login');
  let body = await pageText(page);
  // If already authed (restored), we may be on home
  if (body.includes('Home') && body.includes('Available orders')) return;
  if (!body.includes('Send code') && !body.includes('Get code')) {
    // Try to find phone input
    await page.waitForTimeout(1000);
    body = await pageText(page);
  }
  // Fill phone — rider login has Field with placeholder +255700000000
  try { await page.getByPlaceholder('+255700000000').first().fill(DEMO_PHONE, { timeout: 5000 }); } catch {
    try { await page.locator('input').first().fill(DEMO_PHONE); } catch {}
  }
  await page.waitForTimeout(600);
  // Get code button is Btn with role button name "Get code"
  try { await page.getByRole('button', { name: 'Get code' }).click({ timeout: 8000 }); } catch { await clickText(page, 'Get code'); }
  await page.waitForTimeout(2500);
  body = await pageText(page);
  // Demo code shown as DEMO MODE — your verification code is 100001
  let m = body.match(/\b(\d{6})\b/);
  if (!m) {
    const html = await pageHtml(page);
    m = html.match(/(\d{6})/);
  }
  if (!m) throw new Error(`no debug code found: ${body.slice(0,500)}`);
  const code = m[1];
  // Fill code — second input placeholder "6-digit code"
  try { await page.getByPlaceholder('6-digit code').first().fill(code, { timeout: 5000 }); } catch {
    try { await page.locator('input').nth(1).fill(code); } catch { await page.locator('input').first().fill(code); }
  }
  await page.waitForTimeout(600);
  try { await page.getByRole('button', { name: 'Sign in' }).click({ timeout: 8000 }); } catch { await clickText(page, 'Sign in'); }
  await page.waitForTimeout(3500);
  body = await pageText(page);
  // May land on onboarding if not verified
  if (body.includes('Set up your rider profile') || body.includes('Vehicle')) {
    // Fill name
    try { await page.getByPlaceholder(/Full name|Name/i).first().fill('Test Rider'); } catch { try { await page.locator('input').first().fill('Test Rider'); } catch {} }
    await page.waitForTimeout(500);
    // Select motorcycle if segmented exists
    await clickText(page, 'Motorcycle');
    await page.waitForTimeout(500);
    await clickText(page, 'Save & continue');
    await clickText(page, 'Save');
    await page.waitForTimeout(2500);
  }
  body = await pageText(page);
  if (!body.includes('Home') && !body.includes('Available orders') && !body.includes('Online')) {
    // Try direct home navigation
    await gotoApp(page, '/home');
    body = await pageText(page);
  }
  if (!body.includes('Home') && !body.includes('Available')) {
    throw new Error(`login did not land on home: ${body.slice(0,600)}`);
  }
}

export async function gotoRoute(page, route) {
  await page.goto(`${APP_URL}${route}`, { waitUntil: 'networkidle', timeout: 90000 });
  await page.waitForTimeout(4000);
  const t = await pageText(page);
  if (t.includes('Unmatched Route') || t.includes('Page could not be found')) throw new Error(`unmatched route ${route}`);
  return t;
}
