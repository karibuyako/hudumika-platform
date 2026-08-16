// Flat ESLint config wired to `npm run lint` (expo lint).
// House rule: eslint-config-expo, green in CI (docs/CONTRIBUTING.md).
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');
const globals = require('globals');

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ['tests/.build/**', 'dist/**', 'node_modules/**', 'jest.config.js'],
  },
  {
    // Component tests (component-tests/**) run under jest-expo — scoped here
    // so jest globals never leak into app code.
    files: ['component-tests/**/*.{ts,tsx}'],
    languageOptions: {
      globals: {
        ...globals.jest,
      },
    },
  },
  {
    rules: {
      // The house data-fetching pattern (docs/MOBILE-MOCK-PATTERN.md) loads
      // repositories from effects: screens call an async `load()` in
      // useEffect and setState after `await`. The React Compiler-era rule
      // cannot see the await boundary and flags every fetch-on-mount screen.
      // Kept off deliberately; all other hooks rules stay strict.
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/purity': 'off',
    },
  },
]);
