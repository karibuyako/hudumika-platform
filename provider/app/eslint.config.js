// ESLint flat config for the provider app (expo lint needs eslint.config.js).
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ['tests/.build/**', 'node_modules/**', 'dist/**', '.expo/**'],
  },
  {
    rules: {
      'no-console': ['error', { allow: ['warn', 'error'] }],
      // House data-loading pattern (rider-mobile): load() sets `loading` on
      // mount/focus effects. The compiler rule targets cascading-render
      // anti-patterns; our effects run once and guard with length checks.
      'react-hooks/set-state-in-effect': 'off',
    },
  },
  {
    // Dev-time scripts and tests are not shipped app code.
    files: ['tests/**', 'scripts/**'],
    rules: {
      'no-console': 'off',
    },
  },
]);
