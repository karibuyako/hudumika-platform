const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const config = getDefaultConfig(__dirname);

// Keep fbjs for react-native-web static export
config.resolver.extraNodeModules = {
  ...(config.resolver.extraNodeModules || {}),
  fbjs: path.resolve(__dirname, 'node_modules/fbjs'),
};

config.watchFolders = [
  path.resolve(__dirname, '../../packages/contract'),
  path.resolve(__dirname, '../../packages/tokens'),
];

module.exports = config;
