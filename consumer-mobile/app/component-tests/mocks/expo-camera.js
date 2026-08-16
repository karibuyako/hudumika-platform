/* Node-safe stand-in for expo-camera (component tests only).
 *
 * QrScanner lazy-imports expo-camera via `import('expo-camera')` — a REAL
 * dynamic import, which jest (CJS test pipeline) cannot resolve to the
 * package's ESM/TS sources. jest.config.js maps 'expo-camera' here (plain
 * CJS, no import/export statements) so both the static test import and the
 * component's dynamic import hit the same module instance and share these
 * jest.fn()s — tests configure useCameraPermissions per scenario.
 */
module.exports = {
  useCameraPermissions: jest.fn(),
  CameraView: jest.fn(() => null),
};
