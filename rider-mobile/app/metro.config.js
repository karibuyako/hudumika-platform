const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');
const fs = require('fs');

const config = getDefaultConfig(__dirname);

// @hudumika/contract imports @faker-js/faker (and msw) from its own source.
// Metro resolves those imports from the *contract* package's ancestor
// node_modules, which does not include this app's node_modules where the dep
// is installed. Force-resolve them from this app's node_modules (falling back
// to the monorepo root) so the bundle builds.
function resolveFrom(name) {
  const local = path.resolve(__dirname, 'node_modules', name);
  if (fs.existsSync(local)) return local;
  return path.resolve(__dirname, '..', '..', 'node_modules', name);
}

config.resolver.extraNodeModules = {
  ...(config.resolver.extraNodeModules || {}),
  '@faker-js/faker': resolveFrom('@faker-js/faker'),
  msw: resolveFrom('msw'),
};

config.watchFolders = [
  path.resolve(__dirname, '../../packages/contract'),
  path.resolve(__dirname, '../../packages/tokens'),
];

// Block stray "package" directory left behind by npm pack extraction
// Block other app directories that Metro might follow through root symlinks
config.resolver.blockList = [
  new RegExp(path.resolve(__dirname, 'node_modules/package') + '/.*'),
  new RegExp(path.resolve(__dirname, '../../(merchant|consumer-mobile|provider|admin-web)/.*')),
];

module.exports = config;
