// Browser automation against LIVE Cloudflare Pages sites (production builds).
// - public hub: routes render, APK links present, lead form fills (no submit — avoids prod pollution)
// - merchant/provider/admin: OTP send-code reaches live Railway (proves prod auth path), code input appears
// Usage: node scripts/browser-live.mjs
import { mkdirSync } from 'node:fs';
import { chromium } from '@playwright/test';

const SHOTS = '/tmp/opencode/shots';
mkdirSync(SHOTS, { recursive: true });
const results = [];
const rec = (n, ok, d = '') => { results.push({ n, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });

async function openPage(url) {
  const page = await ctx.newPage();
  const errors = [];
  const failed = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 160)); });
  page.on('requestfailed', (r) => failed.push(`${r.url().slice(0, 90)} ${r.failure()?.errorText ?? ''}`));
  const resp = await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(1500);
  return { page, errors, failed, status: resp?.status() ?? 0 };
}
const shot = (page, name) => page.screenshot({ path: `${SHOTS}/${name}.png` });

// ---- PUBLIC HUB ----
for (const route of ['/', '/services', '/consumer', '/merchant', '/provider', '/rider', '/faq', '/support', '/about', '/download']) {
  const { page, errors, failed, status } = await openPage(`https://hudumika-public.pages.dev${route}`);
  try {
    if (status !== 200) throw new Error(`HTTP ${status}`);
    const body = await page.locator('body').innerText();
    if (body.trim().length < 100) throw new Error('near-empty render');
    if (errors.length > 3) throw new Error(`console errors: ${errors[0]}`);
    rec(`public ${route} renders`, true, `${body.trim().length} chars`);
    if (route === '/') await shot(page, 'public-home');
  } catch (e) {
    rec(`public ${route} renders`, false, `${e.message} | failed-reqs=${failed.slice(0, 2).join(';')}`);
  }
  await page.close();
}
{ // download page APK links
  const { page, status } = await openPage('https://hudumika-public.pages.dev/download');
  try {
    if (status !== 200) throw new Error(`HTTP ${status}`);
    const hrefs = await page.locator('a[href*=".apk"]').evaluateAll((els) => els.map((e) => e.href));
    for (const app of ['consumer', 'merchant', 'provider', 'rider']) {
      if (!hrefs.some((h) => h.includes(`hudumika-${app}.apk`))) throw new Error(`missing ${app} apk link`);
    }
    rec('public /download APK links (4 apps)', true, hrefs.length + ' apk anchors');
    await shot(page, 'public-download');
  } catch (e) { rec('public /download APK links (4 apps)', false, e.message); }
  await page.close();
}
{ // merchant lead form fills (no submit — keeps prod clean)
  const { page } = await openPage('https://hudumika-public.pages.dev/merchant');
  try {
    const nameBox = page.getByLabel(/owner name/i).first();
    const phoneBox = page.getByLabel(/^phone/i).first();
    await nameBox.fill('Loop Test');
    await phoneBox.fill('+255700000090');
    const btn = page.getByRole('button', { name: /submit|send|apply|join/i }).first();
    if (!(await btn.isEnabled())) throw new Error('submit disabled after fill');
    rec('public merchant lead form fills + validates', true);
    await shot(page, 'public-merchant-form');
  } catch (e) { rec('public merchant lead form fills + validates', false, e.message.slice(0, 200)); }
  await page.close();
}

// ---- OTP SEND on merchant / provider / admin (1 live prod OTP each) ----
async function otpSend(site, name, testPhone) {
  const { page, errors } = await openPage(site);
  try {
    const phoneBox = page.getByLabel(/phone/i).first();
    await phoneBox.fill(testPhone);
    const sendBtn = page.getByRole('button', { name: /send code|sending/i }).first();
    await sendBtn.click();
    const codeBox = page.getByLabel(/one-time code/i).first();
    await codeBox.waitFor({ state: 'visible', timeout: 25000 });
    rec(`${name} OTP send → code input (live Railway)`, true);
    await shot(page, `${name}-otp`);
  } catch (e) {
    rec(`${name} OTP send → code input (live Railway)`, false, `${e.message.slice(0, 180)} | console=${errors.slice(0, 2).join(';')}`);
  }
  await page.close();
}
await otpSend('https://hudumika-merchant.pages.dev/', 'merchant-web', '+255700000091');
await otpSend('https://hudumika-provider.pages.dev/', 'provider-web', '+255700000092');
await otpSend('https://hudumika-admin.pages.dev/', 'admin-web', '+255700000093');

await browser.close();
const pass = results.filter((r) => r.ok).length;
console.log(`\nSIGNED browser-live: pass=${pass}/${results.length} failed=${results.length - pass} shots=${SHOTS}`);
process.exit(results.some((r) => !r.ok) ? 1 : 0);
