import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:8082';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 2 : 1,
  timeout: 90_000,
  expect: { timeout: 15_000, toHaveScreenshot: { maxDiffPixels: 300, threshold: 0.2 } },
  use: {
    baseURL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    navigationTimeout: 60_000,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],
  // When PLAYWRIGHT_BASE_URL is set (staging/preview), no webServer — test against deployed web.
  // Otherwise spawn Expo web locally. Each EXPO_PUBLIC_MOCK_* can be overridden via env for
  // staged rollout: set EXPO_PUBLIC_MOCK_AUTH=false (etc) one-by-one against staging.
  // Example: EXPO_PUBLIC_MOCK_AUTH=false PLAYWRIGHT_BASE_URL=https://staging... npx playwright test
  ...(process.env.PLAYWRIGHT_BASE_URL
    ? {}
    : {
        webServer: {
          command: 'npx expo start --web --port 8082 --non-interactive --offline',
          url: 'http://localhost:8082',
          reuseExistingServer: !process.env.CI,
          timeout: 180_000,
          env: {
            EXPO_PUBLIC_ENV: process.env.EXPO_PUBLIC_ENV ?? 'development',
            EXPO_PUBLIC_API_URL: process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:8081',
            EXPO_PUBLIC_MOCK_AUTH: process.env.EXPO_PUBLIC_MOCK_AUTH ?? 'true',
            EXPO_PUBLIC_MOCK_PROFILE: process.env.EXPO_PUBLIC_MOCK_PROFILE ?? 'true',
            EXPO_PUBLIC_MOCK_BOOKINGS: process.env.EXPO_PUBLIC_MOCK_BOOKINGS ?? 'true',
            EXPO_PUBLIC_MOCK_DISPATCH: process.env.EXPO_PUBLIC_MOCK_DISPATCH ?? 'true',
            EXPO_PUBLIC_MOCK_SERVICES: process.env.EXPO_PUBLIC_MOCK_SERVICES ?? 'true',
            EXPO_PUBLIC_MOCK_TECHNICIANS: process.env.EXPO_PUBLIC_MOCK_TECHNICIANS ?? 'true',
            EXPO_PUBLIC_MOCK_EARNINGS: process.env.EXPO_PUBLIC_MOCK_EARNINGS ?? 'true',
            EXPO_PUBLIC_MOCK_NOTIFICATIONS: process.env.EXPO_PUBLIC_MOCK_NOTIFICATIONS ?? 'true',
            EXPO_PUBLIC_MOCK_SUPPORT: process.env.EXPO_PUBLIC_MOCK_SUPPORT ?? 'true',
            EXPO_PUBLIC_MOCK_CATALOG: process.env.EXPO_PUBLIC_MOCK_CATALOG ?? 'true',
          },
        },
      }),
});
