/* Jest config for component tests (Jest + React Native Testing Library).
 * Deliberately separate from the node:test contract suites (tests/run.mjs —
 * `npm test` runs those; this config never sees tests/).
 *
 * preset: jest-expo (SDK 57) — the Expo-shipped React Native jest preset. It
 * wires babel (babel-preset-expo), the RN jest environment, asset
 * transformers, native-module mocks and, via withTypescriptMapping, the
 * `@/*` → `./src/*` alias from tsconfig.json paths (kept explicit below too).
 *
 * transformIgnorePatterns: the pattern from node_modules/jest-expo/jest-preset.js
 * with @hudumika appended — the file: workspace packages (@hudumika/tokens,
 * @hudumika/contract) ship TypeScript sources and must be babel-transformed.
 */
module.exports = {
  preset: 'jest-expo',
  testMatch: ['<rootDir>/component-tests/**/*.test.tsx'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
    // QrScanner lazy-imports expo-camera with a real dynamic import — point
    // it at a Node-safe CJS shim (see component-tests/mocks/expo-camera.js).
    '^expo-camera$': '<rootDir>/component-tests/mocks/expo-camera.js',
  },
  transformIgnorePatterns: [
    '/node_modules/(?!(.pnpm|react-native|@react-native|@react-native-community|expo|@expo|@expo-google-fonts|@hudumika|react-navigation|@react-navigation|@sentry/react-native|native-base|standard-navigation))',
    '/node_modules/react-native-reanimated/plugin/',
    '/node_modules/@react-native/babel-preset/',
  ],
  setupFilesAfterEnv: ['<rootDir>/component-tests/jest-setup.ts'],
};
