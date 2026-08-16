/* Detox E2E configuration (TESTING.md §4).
 *
 * Expo SDK 57 / RN 0.86 app — debug builds via `npx expo run:android` /
 * `npx expo run:ios` (expo prebuild must have generated the android/ + ios/
 * directories first). Mirrors the standard expo-detox config: a jest test
 * runner (config: e2e/jest.config.js), an android emulator config named
 * `android.emu` and an ios simulator config named `ios.sim`, both pointing at
 * the platform debug build artifacts.
 *
 * The specs run against the MSW-backed mock build (mocks default ON in debug,
 * see README "Mock switches"), which is what TESTING.md §4 prescribes for CI;
 * release candidates run the same suite against staging by flipping the
 * EXPO_PUBLIC_MOCK_* switches off.
 *
 * Run:
 *   npm run e2e:build   # detox build --configuration android.emu
 *   npm run e2e:test    # detox test --configuration android.emu
 */
/** @type {Detox.DetoxConfig} */
module.exports = {
  testRunner: {
    args: {
      $0: 'jest',
      config: 'e2e/jest.config.js',
    },
    jest: {
      /* Long per-test budget: city picker + MSW-mock refetch cycles on a cold
       * emulator routinely take >60s for the first test. */
      setupTimeout: 120000,
    },
  },

  apps: {
    /* Debug APK built by `npx expo run:android` (expo prebuild → gradle).
     * Build is deliberately the expo CLI (task guidance), not raw gradle, so
     * android/ remains a generated artifact. */
    'android.debug': {
      type: 'android.apk',
      binaryPath: 'android/app/build/outputs/apk/debug/app-debug.apk',
      build: 'npx expo run:android',
    },
    /* Debug .app built by `npx expo run:ios`. The derivedDataPath keeps the
     * binary in-tree so the binaryPath above stays stable. */
    'ios.debug': {
      type: 'ios.app',
      binaryPath: 'ios/build/Build/Products/Debug-iphonesimulator/Hudumika.app',
      build: 'npx expo run:ios',
    },
  },

  devices: {
    emulator: {
      type: 'android.emulator',
      device: {
        avdName: 'Pixel_7_API_36',
      },
    },
    simulator: {
      type: 'ios.simulator',
      device: {
        type: 'iPhone 15',
      },
    },
  },

  configurations: {
    'android.emu': {
      device: 'emulator',
      app: 'android.debug',
    },
    'ios.sim': {
      device: 'simulator',
      app: 'ios.debug',
    },
  },

  behavior: {
    init: {
      /* The specs import device/by/element/expect/waitFor from 'detox'
       * explicitly, so Detox must not shadow jest's global `expect`. */
      exposeGlobals: false,
      /* Keep the app installed between runs — launchApp({delete: true}) in
       * e2e/helpers.ts is what gives specs their true cold start. */
      reinstallApp: false,
    },
  },
};
