/* Jest setup for component tests (component-tests/**). Runs after the
 * jest-expo preset setup: RNTL v14 auto-registers its matchers on import,
 * and we add Node-safe mocks for native modules the components import at
 * module scope (react-native-safe-area-context). expo modules under test
 * (expo-camera) are mocked per test file — see QrScanner.test.tsx.
 */
import type { StyleProp, ViewStyle } from 'react-native';

import '@testing-library/react-native';

jest.mock('react-native-safe-area-context', () => {
  const React = jest.requireActual('react') as typeof import('react');
  const { View } = jest.requireActual('react-native');
  return {
    SafeAreaProvider: ({ children }: { children?: React.ReactNode }) => children ?? null,
    SafeAreaView: ({ children, ...rest }: { children?: React.ReactNode; style?: StyleProp<ViewStyle>; edges?: unknown }) =>
      React.createElement(View, { style: rest.style }, children),
    useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
    useSafeAreaFrame: () => ({ x: 0, y: 0, width: 390, height: 844 }),
    initialWindowMetrics: {
      frame: { x: 0, y: 0, width: 390, height: 844 },
      insets: { top: 0, right: 0, bottom: 0, left: 0 },
    },
  };
});
