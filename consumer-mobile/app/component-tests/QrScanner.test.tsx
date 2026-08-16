/* QrScanner: expo-camera is lazy-imported inside an effect via a real dynamic
 * import — jest.config.js maps 'expo-camera' to component-tests/mocks/
 * expo-camera.js (Node-safe CJS shim; same module instance for the static
 * test import and the component's dynamic import). Tests configure its
 * useCameraPermissions jest.fn() per scenario:
 *   - permission not granted → explainer + Allow
 *   - permission denied (canAskAgain false) → denied copy + manual-entry hint
 * The scanner opens under `--experimental-vm-modules` (see package.json
 * test:unit) so the component's dynamic import resolves in the jest runtime. */
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import * as expoCamera from 'expo-camera';

import { QrScanner } from '@/components/QrScanner';
import { t } from '@/i18n';

type PermissionTuple = [
  { granted: boolean; status: string; canAskAgain: boolean },
  () => Promise<{ granted: boolean }>,
  () => Promise<{ granted: boolean }>,
];

const useCameraPermissions = expoCamera.useCameraPermissions as unknown as jest.Mock<PermissionTuple>;

const undeterminedPermission: PermissionTuple[0] = { granted: false, status: 'undetermined', canAskAgain: true };
const deniedPermission: PermissionTuple[0] = { granted: false, status: 'denied', canAskAgain: false };
const requestPermission = jest.fn().mockResolvedValue({ granted: false });

describe('QrScanner', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    requestPermission.mockResolvedValue({ granted: false });
  });

  it('renders the manual-fallback explainer when permission is not granted', async () => {
    useCameraPermissions.mockReturnValue([undeterminedPermission, requestPermission, jest.fn()]);
    const { getByText } = await render(<QrScanner visible onScan={jest.fn()} onClose={jest.fn()} />);

    await waitFor(() => expect(getByText(t('camera.explain'))).toBeTruthy());
    expect(getByText(t('camera.allow'))).toBeTruthy();
    expect(getByText(t('common.cancel'))).toBeTruthy();
  });

  it('requests permission when Allow is pressed', async () => {
    useCameraPermissions.mockReturnValue([undeterminedPermission, requestPermission, jest.fn()]);
    const { getByText } = await render(<QrScanner visible onScan={jest.fn()} onClose={jest.fn()} />);

    await waitFor(() => expect(getByText(t('camera.allow'))).toBeTruthy());
    await fireEvent.press(getByText(t('camera.allow')));
    expect(requestPermission).toHaveBeenCalledTimes(1);
  });

  it('renders the denied copy with retry and manual-entry hint when permission is permanently denied', async () => {
    useCameraPermissions.mockReturnValue([deniedPermission, requestPermission, jest.fn()]);
    const { getByText } = await render(<QrScanner visible onScan={jest.fn()} onClose={jest.fn()} />);

    await waitFor(() => expect(getByText(t('camera.denied'))).toBeTruthy());
    expect(getByText(t('camera.retry'))).toBeTruthy();
    expect(getByText(t('dineIn.manualHint'))).toBeTruthy();
  });

  it('fires onClose when Cancel is pressed', async () => {
    useCameraPermissions.mockReturnValue([undeterminedPermission, requestPermission, jest.fn()]);
    const onClose = jest.fn();
    const { getByText } = await render(<QrScanner visible onScan={jest.fn()} onClose={onClose} />);

    await waitFor(() => expect(getByText(t('common.cancel'))).toBeTruthy());
    await fireEvent.press(getByText(t('common.cancel')));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
