import { expect, type Page } from '@playwright/test';

export async function loginIfNeeded(page: Page) {
  // Provider app in mock dev mode starts at /login (OTP demo phone)
  // If already authed, _layout redirects to /home.
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  const loginTitle = page.getByText('Hudumika Provider');
  // Wait briefly to see which route we landed on
  await page.waitForTimeout(1500);
  const isLogin = await loginTitle.isVisible().catch(() => false);
  if (!isLogin) return;
  // OTP flow: demo account +255700000000, debugCode shown on screen
  const phoneInput = page.getByPlaceholder('+255').first().or(page.getByLabel(/phone/i).first());
  if (await phoneInput.isVisible().catch(() => false)) {
    await phoneInput.fill('+255700000000');
    const getCode = page.getByRole('button', { name: /get code/i });
    if (await getCode.isVisible().catch(() => false)) {
      await getCode.click();
      await page.waitForTimeout(800);
    }
  }
  // Try to locate debug code or 6-digit input
  const codeInput = page.getByPlaceholder(/code/i).first().or(page.getByLabel(/verification/i).first());
  if (await codeInput.isVisible().catch(() => false)) {
    // In mock, debugCode is shown in DEMO box — try to read it or use 123456
    const demoBox = page.getByText(/\d{6}/);
    let code = '123456';
    if (await demoBox.isVisible().catch(() => false)) {
      const txt = await demoBox.textContent();
      const m = txt?.match(/\d{6}/);
      if (m) code = m[0];
    }
    await codeInput.fill(code);
    const signIn = page.getByRole('button', { name: /sign in/i });
    if (await signIn.isVisible().catch(() => false)) {
      await signIn.click();
      await page.waitForTimeout(1500);
    }
  }
}

export async function expectTabsVisible(page: Page) {
  // Bottom tabs: Home | Jobs | Earnings | Profile
  await expect(page.getByRole('tab', { name: /home/i }).or(page.getByText('Home').first())).toBeVisible({ timeout: 15000 }).catch(async () => {
    // Expo tab bar may render as buttons not tabs — fallback
    await expect(page.getByText('Home').first()).toBeVisible({ timeout: 10000 });
  });
}
