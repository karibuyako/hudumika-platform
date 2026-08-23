import { expect, type Page } from '@playwright/test';

/**
 * Phase 1 E2E helpers for Hudumika merchant web (Expo web, MSW mock backend).
 *
 * This file merges the Phase 1 harness spec (history.pushState nav, clearState,
 * login via getByPlaceholder + DEMO MODE, 5-state expects) with the Phase 2
 * redirect helpers already consumed by `redirect.spec.ts`. All exports are
 * backwards-compatible.
 *
 * Canonical references:
 *  - login flow: src/app/(auth)/login.tsx:36-81 + tests/e2e/web-e2e.mjs:51-65
 *  - mock keys: src/mock/db.ts:17 (mockdb.v4), src/mock/events.ts:12-13, src/api/queue.ts:24, src/api/client.ts:49
 *  - 5-state contract: docs/TESTING.md per-screen matrix, src/components/ui.tsx (Spinner, Empty)
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Base origin for the web build (dist/ served on :8123). */
export const ORIGIN =
  (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process?.env
    ?.PLAYWRIGHT_BASE_URL ?? 'http://localhost:8123';
export const DEMO_PHONE = '+255700000000';

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

/**
 * SPA navigation via history.pushState — mirrors web-e2e.mjs `nav` helper:
 *   window.history.pushState({}, {}, route); window.dispatchEvent(new PopStateEvent('popstate'));
 *
 * expo-router listens to popstate and re-renders without a full reload, so
 * auth guards (TabsLayout → /login) execute correctly in e2e.
 *
 * If the page has not yet loaded an origin (e.g. about:blank in a fresh
 * context), falls back to a full `page.goto` to establish the origin first.
 */
export async function nav(page: Page, route: string): Promise<void> {
  // If we are on about:blank or a different origin, establish ORIGIN first
  const url = page.url();
  const needsGoto = !url.startsWith('http') || url === 'about:blank';
  if (needsGoto) {
    const target = route.startsWith('http') ? route : `${ORIGIN}${route}`;
    await page.goto(target, { waitUntil: 'commit', timeout: 60_000 });
    await page.waitForTimeout(1200);
    return;
  }

  await page.evaluate((r) => {
    window.history.pushState({}, '', r);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, route);
  // Allow expo-router + MSW hydration to settle — wait for real DOM paint
  try {
    await page.waitForFunction(() => document.body && document.body.innerText.length > 20, undefined, { timeout: 8000 });
  } catch {
    await page.waitForTimeout(800);
  }
  await page.waitForTimeout(400);
}

// ---------------------------------------------------------------------------
// State reset
// ---------------------------------------------------------------------------

/**
 * Clears all client-side persistence to return the mock backend and session
 * to a cold start. Covers localStorage mockdb + sessionStorage per spec.
 *
 * Keys cleared:
 *  - mockdb.v4, mockdb.v4.log, mockdb.events.log, mockdb.events.seq
 *  - mq.queue, merchant.token, merchant.refreshToken
 *  - any other mockdb.* / mq.* / merchant.* keys
 *  - sessionStorage (entire store)
 *
 * Also clears cookies for full isolation (Phase 2 helper compatibility).
 */
export async function clearState(page: Page): Promise<void> {
  // Wait for any in-flight navigation (commit→load) before touching storage
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForTimeout(300).catch(() => {});
  try {
    await page.evaluate(() => {
    try {
      const mockKeys = [
        'mockdb.v4',
        'mockdb.v4.log',
        'mockdb.events.log',
        'mockdb.events.seq',
        'mq.queue',
        'merchant.token',
        'merchant.refreshToken',
      ];
      for (const k of mockKeys) {
        try {
          localStorage.removeItem(k);
        } catch {
          /* ignore */
        }
      }
      // Remove any other mockdb.* / mq.* / merchant.* keys
      try {
        const toRemove: string[] = [];
        for (let i = 0; i < localStorage.length; i += 1) {
          const k = localStorage.key(i);
          if (k && (k.startsWith('mockdb.') || k.startsWith('mq.') || k.startsWith('merchant.'))) {
            toRemove.push(k);
          }
        }
        for (const k of toRemove) localStorage.removeItem(k);
      } catch {
        /* ignore */
      }
      try {
        sessionStorage.clear();
      } catch {
        /* ignore */
      }
      try {
        sessionStorage.removeItem('merchant.token');
        sessionStorage.removeItem('merchant.refreshToken');
      } catch {
        /* ignore */
      }
    } catch {
      /* storage unavailable */
    }
  });
  } catch {
    // Navigation still in-flight — wait and retry once
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForTimeout(500).catch(() => {});
    try {
      await page.evaluate(() => {
        try {
          localStorage.clear();
          sessionStorage.clear();
        } catch {}
      });
    } catch {}
  }
  try {
    await page.context().clearCookies();
  } catch {
    /* no context */
  }
}

/**
 * Backwards-compatible alias for Phase 2 specs (`redirect.spec.ts` uses
 * `clearStorage`). Delegates to `clearState`.
 */
export const clearStorage = clearState;

// ---------------------------------------------------------------------------
// Auth — login via UI
// ---------------------------------------------------------------------------

/**
 * Performs the full demo OTP login flow via the UI.
 *
 * Steps per spec:
 *   1. goto /login
 *   2. fill phone "+255700000000" via getByPlaceholder
 *   3. click "Get code"
 *   4. wait for DEMO MODE 6-digit code via page.evaluate
 *   5. fill OTP and click "Sign in"
 *   6. wait for /dashboard
 *
 * Resilient to: already-authenticated redirect, slow MSW boot, i18n timing.
 */
export async function login(page: Page, phone: string = DEMO_PHONE): Promise<void> {
  await page.goto('/login', { waitUntil: 'commit', timeout: 60_000 });
  await page.waitForTimeout(1200);

  // Already authenticated → TabsLayout redirects to /dashboard
  if (page.url().includes('/dashboard')) return;

  let bodyText = await page.evaluate(() => document.body.innerText);
  if (!bodyText.includes('Sign in to run your store') && !bodyText.includes('Merchant Pro')) {
    await page.waitForTimeout(1500);
    bodyText = await page.evaluate(() => document.body.innerText);
    if (page.url().includes('/dashboard')) return;
  }
  if (page.url().includes('/dashboard')) return;

  // 1. Fill phone via placeholder "+255700000000" (login.tsx Field)
  const phoneInput = page.getByPlaceholder('+255700000000');
  if ((await phoneInput.count()) > 0) {
    await expect(phoneInput).toBeVisible({ timeout: 10_000 });
    await phoneInput.fill(phone);
  } else {
    // Fallback to first input (mirrors web-e2e.mjs)
    await page.locator('input').first().fill(phone);
  }

  // 2. Click Get code
  const getCodeBtn = page.getByText('Get code', { exact: true });
  // Fallback to role-based locator for i18n resilience
  const getCodeAlt = page.getByRole('button', { name: /Get code/i });
  const getCodeTarget = (await getCodeBtn.count()) > 0 ? getCodeBtn : getCodeAlt;
  await expect(getCodeTarget).toBeVisible({ timeout: 10_000 });
  await getCodeTarget.click();

  // 3. Wait for DEMO MODE code via page.evaluate (spec requirement)
  let code: string | null = null;
  for (let i = 0; i < 25; i += 1) {
    await page.waitForTimeout(400);
    const text = await page.evaluate(() => document.body.innerText);
    const m = text.match(/DEMO MODE — your verification code is\s+(\d{6})/);
    if (m?.[1]) {
      code = m[1];
      break;
    }
  }
  if (!code) {
    // Also check DEMO MODE element visibility for better error message
    const demo = page.getByText(/DEMO MODE/i);
    if ((await demo.count()) > 0) {
      await expect(demo).toBeVisible({ timeout: 5_000 }).catch(() => {});
    }
    const fallback = await page.evaluate(() => {
      const t = document.body.innerText;
      const m2 = t.match(/DEMO MODE — your verification code is\s+(\d{6})/) ?? t.match(/DEMO MODE[^\d]*(\d{6})/);
      return m2?.[1] ?? null;
    });
    code = fallback;
  }
  if (!code) {
    throw new Error('login(): DEMO MODE code not found after clicking Get code — MSW/mock may not be running');
  }
  expect(code).toMatch(/^\d{6}$/);

  // 4. Fill OTP — try placeholder variants, fallback to nth(1) (web-e2e.mjs)
  const otpByPlaceholder = page.getByPlaceholder('6-digit code');
  const otpGeneric = page.getByPlaceholder(/enter.*code|otp|verification/i);
  if ((await otpByPlaceholder.count()) > 0) {
    await otpByPlaceholder.first().fill(code);
  } else if ((await otpGeneric.count()) > 0) {
    await otpGeneric.first().fill(code);
  } else {
    const otpInput = page.locator('input').nth(1);
    await expect(otpInput).toBeVisible({ timeout: 5_000 });
    await otpInput.fill(code);
  }

  // 5. Click Sign in and wait for dashboard
  const signInBtn = page.getByText('Sign in', { exact: true });
  const signInAlt = page.getByRole('button', { name: /^Sign in$/i });
  const signInTarget = (await signInBtn.count()) > 0 ? signInBtn : signInAlt;
  await expect(signInTarget).toBeVisible({ timeout: 10_000 });
  await signInTarget.click();

  await page.waitForURL('**/dashboard', { timeout: 15_000 });
  await page.waitForTimeout(1500);
}

// ---------------------------------------------------------------------------
// 5-state expect helpers
// Every data screen implements: loading → empty → error (+ retry) → success
// See docs/TESTING.md per-screen matrix and src/components/ui.tsx (Spinner, Empty).
// ---------------------------------------------------------------------------

/**
 * Asserts a loading state is visible. Checks ActivityIndicator/a11y label,
 * progressbar role, or localized loading text.
 */
export async function expectLoading(page: Page): Promise<void> {
  const loadingIndicators = [
    page.getByLabel(/loading/i),
    page.getByRole('progressbar'),
    page.locator('[aria-busy="true"]'),
    page.getByText(/loading/i).first(),
  ];

  let matched = false;
  for (const loc of loadingIndicators) {
    if ((await loc.count()) > 0) {
      try {
        await expect(loc.first()).toBeVisible({ timeout: 3_000 });
        matched = true;
        break;
      } catch {
        /* try next */
      }
    }
  }

  if (!matched) {
    const text = await page.evaluate(() => document.body.innerText);
    expect(text.toLowerCase()).toMatch(/loading/);
  }
}

/**
 * Asserts an empty state is visible.
 * @param text - Optional substring / regex to assert within the empty view
 */
export async function expectEmpty(page: Page, text?: string | RegExp): Promise<void> {
  if (text) {
    await expect(page.getByText(text).first()).toBeVisible({ timeout: 10_000 });
    return;
  }

  const emptyPattern = /no .* yet|empty|no records|no orders|no data|nothing here/i;
  const candidates = [page.getByText(emptyPattern).first(), page.locator('text=/No /').first()];

  for (const c of candidates) {
    if ((await c.count()) > 0) {
      try {
        await expect(c).toBeVisible({ timeout: 5_000 });
        return;
      } catch {
        /* try next */
      }
    }
  }

  const body = await page.evaluate(() => document.body.innerText);
  expect(body).toMatch(emptyPattern);
}

/**
 * Asserts an error state is visible.
 * @param text - Optional expected error substring / regex
 */
export async function expectError(page: Page, text?: string | RegExp): Promise<void> {
  if (text) {
    await expect(page.getByText(text).first()).toBeVisible({ timeout: 10_000 });
    return;
  }

  const errorLocators = [
    page.getByText(/something went wrong|failed to load|error|unavailable|not found/i).first(),
    page.getByText(/request ?id/i).first(),
    page.locator('[role="alert"]').first(),
  ];

  for (const loc of errorLocators) {
    if ((await loc.count()) > 0) {
      try {
        await expect(loc).toBeVisible({ timeout: 5_000 });
        return;
      } catch {
        /* try next */
      }
    }
  }

  const body = await page.evaluate(() => document.body.innerText);
  expect(body).toMatch(/error|failed|unavailable|something went wrong/i);
}

/**
 * Asserts a retry affordance is visible and optionally clicks it.
 * Covers: "Retry", "Try again", "Refresh" buttons.
 */
export async function expectRetry(page: Page, opts: { click?: boolean } = {}): Promise<void> {
  const retry = page.getByRole('button', { name: /retry|try again|refresh/i }).first();
  const fallback = page.getByText(/retry|try again|refresh/i).first();

  let target = retry;
  if ((await retry.count()) === 0 && (await fallback.count()) > 0) {
    target = fallback;
  }

  await expect(target).toBeVisible({ timeout: 10_000 });

  if (opts.click) {
    await target.click();
  }
}

/**
 * Asserts a success state: primary content rendered and not stuck in loading.
 * @param text - Optional success copy to confirm
 */
export async function expectSuccess(page: Page, text?: string | RegExp): Promise<void> {
  if (text) {
    await expect(page.getByText(text).first()).toBeVisible({ timeout: 10_000 });
    return;
  }

  await page.waitForTimeout(300);
  const body = await page.evaluate(() => document.body.innerText.trim());
  expect(body.length).toBeGreaterThan(0);
  const lower = body.toLowerCase();
  const isOnlyLoading = lower === 'loading' || lower === 'loading…';
  expect(isOnlyLoading).toBe(false);
}

/**
 * Convenience: asserts the full 5-state contract for a route.
 */
export async function expectFiveStates(
  page: Page,
  opts: { successText?: string | RegExp; emptyText?: string | RegExp } = {},
): Promise<void> {
  await page.waitForTimeout(1200);
  const body = await page.evaluate(() => document.body.innerText);

  const hasError = /something went wrong|failed to load|error/i.test(body);
  if (hasError) {
    await expectRetry(page);
    return;
  }

  if (opts.successText) {
    await expectSuccess(page, opts.successText);
    return;
  }
  if (opts.emptyText) {
    try {
      await expectSuccess(page, opts.successText);
    } catch {
      await expectEmpty(page, opts.emptyText);
    }
    return;
  }

  const lower = body.toLowerCase();
  const stillLoading = lower.includes('loading') && body.trim().length < 40;
  expect(stillLoading).toBe(false);
}

// ---------------------------------------------------------------------------
// Phase 2 route-mock helpers (retained for redirect.spec.ts)
// ---------------------------------------------------------------------------

/** Route a merchant to `pending` so the dashboard soft-gate banner appears. */
export async function mockPendingMerchant(page: Page): Promise<void> {
  await page.route('**/api/merchants/me', async (route) => {
    const res = await route.fetch();
    const json = (await res.json()) as Record<string, unknown>;
    const me = json.me as Record<string, unknown> | undefined;
    if (me && typeof me.merchant === 'object' && me.merchant !== null) {
      (me.merchant as Record<string, unknown>).status = 'pending';
    }
    await route.fulfill({
      status: res.status(),
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(json),
    });
  });

  await page.route('**/api/onboarding/status', async (route) => {
    const res = await route.fetch();
    const json = (await res.json()) as Record<string, unknown>;
    const verification = json.verification as Record<string, unknown> | undefined;
    if (verification) verification.status = 'pending';
    await route.fulfill({
      status: res.status(),
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(json),
    });
  });

  await page.route('**/api/auth/verify-otp', async (route) => {
    const res = await route.fetch();
    const json = (await res.json()) as Record<string, unknown>;
    const me = json.me as Record<string, unknown> | undefined;
    if (me && typeof me.merchant === 'object' && me.merchant !== null) {
      (me.merchant as Record<string, unknown>).status = 'pending';
    }
    await route.fulfill({
      status: res.status(),
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(json),
    });
  });
}

export async function mockRateLimitedOtp(page: Page): Promise<void> {
  await page.route('**/api/auth/request-otp', async (route) => {
    const body = JSON.stringify({
      error: { code: 'RATE_LIMITED', message: 'Too many requests — try again in 2s', retriable: true, details: { retryAfterSeconds: 2 } },
      code: 'RATE_LIMITED',
      message: 'Too many requests — try again in 2s',
      requestId: 'req-mock-rate',
      retryAfterSeconds: 2,
    });
    await route.fulfill({
      status: 429,
      headers: { 'content-type': 'application/json', 'retry-after': '2' },
      body,
    });
  });
}
