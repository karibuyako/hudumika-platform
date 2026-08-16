/* Jest config for the Detox E2E suite (TESTING.md §4).
 *
 * Deliberately independent from the component-tests config (jest.config.js,
 * preset jest-expo): E2E runs on emulators/simulators through the Detox jest
 * runner (detox test), never through `npm run test:unit`. The two configs
 * never see each other's files (testMatch scopes each tree), so the presets
 * cannot conflict.
 *
 * testEnvironment: Detox 20's circus environment — it extends jest's node
 * environment and drives device launch/teardown per test file (the modern
 * replacement for the old detox-jest-adapter setup; no globalSetup
 * hand-wiring of `detox` is needed).
 *
 * transform: specs are plain TypeScript — babel-jest with babel-preset-expo
 * (already installed via jest-expo) handles TS without ts-jest.
 */
module.exports = {
  testEnvironment: 'detox/runners/jest/testEnvironment',
  testMatch: ['<rootDir>/e2e/**/*.e2e.ts'],
  reporters: ['detox/runners/jest/reporter'],
  globalSetup: 'detox/runners/jest/globalSetup',
  globalTeardown: 'detox/runners/jest/globalTeardown',
  transform: {
    '^.+\\.ts$': ['babel-jest', { presets: ['babel-preset-expo'] }],
  },
};
