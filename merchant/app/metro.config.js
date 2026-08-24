const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const config = getDefaultConfig(__dirname);

// The @hudumika/contract package imports @faker-js/faker (and msw) from its own
// source. Metro resolves those imports from the *contract* package's ancestor
// node_modules, which are not populated in CI/EAS builds (deps install in the
// app dir). Alias them to this app's node_modules so the bundle resolves.
config.resolver.extraNodeModules = {
  ...(config.resolver.extraNodeModules || {}),
  '@faker-js/faker': path.resolve(__dirname, 'node_modules/@faker-js/faker'),
  msw: path.resolve(__dirname, 'node_modules/msw'),
};

config.watchFolders = [
  path.resolve(__dirname, '../../packages/contract'),
  path.resolve(__dirname, '../../packages/tokens'),
];

module.exports = config;
